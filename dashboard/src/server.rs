//! One port serving two things: the embedded single-page app over HTTP, and
//! the state feed over a websocket at `/websocket`.
//!
//! Both share a listener so that turning the dashboard on stays a single flag.
//! Routing works by peeking at the request head. Peeking leaves the bytes in
//! the socket, so a websocket connection still reaches soketto's handshake with
//! nothing consumed.

use {
    crate::proto::{MAX_MESSAGE, Message, Publisher, Request, encode_with_id},
    soketto::handshake::{Server, server},
    std::{io, net::IpAddr, sync::Arc},
    thiserror::Error,
    tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        pin, select,
        sync::{
            Semaphore,
            broadcast::error::{RecvError, TryRecvError},
        },
        time::{Duration, timeout},
    },
    tokio_util::compat::TokioAsyncReadCompatExt,
};

const WEBSOCKET_PATH: &str = "/websocket";

/// Cap on the request head we are willing to buffer before giving up.
const MAX_REQUEST_HEAD: usize = 8192;

/// How long a client has to send its request head before being dropped.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Clients only send small control frames. Anything larger is either a client
/// bug or an attempt to make the server allocate, so the connection is closed.
const MAX_CLIENT_MESSAGE: usize = 4096;

/// How long one send may block before the client is treated as gone.
///
/// A viewer that stops reading — a closed laptop, a dropped link, or a caller
/// that never meant to read — leaves the server parked on a write while still
/// holding one of the limited connection slots. TCP alone takes minutes to
/// notice, and sixty-four such connections deny the dashboard to real viewers.
///
/// This is deliberately not an inbound-idle timeout: the client never sends
/// anything, so idleness on that side is what a healthy viewer looks like.
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);

/// Websocket clients served at once.
///
/// Only websockets are capped. They are the long-lived resource: each holds a
/// task, a socket and a broadcast receiver for as long as the viewer keeps the
/// page open, and nothing else bounds how many a caller may open. HTTP requests
/// are short and deliberately uncapped, since refusing those would stop the
/// page loading at all under exactly the conditions where a cap matters.
///
/// The dashboard is meant for a handful of operators, so this is generous
/// enough that a legitimate viewer with several tabs never notices it.
const MAX_WEBSOCKET_CLIENTS: usize = 64;

/// Served when the crate was built without `frontend/dist` present.
const MISSING_FRONTEND: &str = include_str!("missing_frontend.html");

mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}

#[derive(Debug, Error)]
enum ConnectionError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("handshake error: {0}")]
    Handshake(#[from] soketto::handshake::Error),
    #[error("connection error: {0}")]
    Connection(#[from] soketto::connection::Error),
    #[error("client fell too far behind and was disconnected")]
    Lagged,
    #[error("client sent an oversized message of {0} bytes")]
    Oversized(usize),
}

pub async fn serve(listener: TcpListener, publisher: Arc<Publisher>, allowed_hosts: Arc<[String]>) {
    let clients = Arc::new(Semaphore::new(MAX_WEBSOCKET_CLIENTS));
    loop {
        let (socket, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(err) => {
                log::warn!("dashboard: accept failed: {err}");
                continue;
            }
        };
        let publisher = publisher.clone();
        let clients = clients.clone();
        let allowed_hosts = allowed_hosts.clone();
        tokio::spawn(async move {
            if let Err(err) = handle(socket, publisher, clients, &allowed_hosts).await {
                log::debug!("dashboard: connection from {peer} ended: {err}");
            }
        });
    }
}

async fn handle(
    mut socket: TcpStream,
    publisher: Arc<Publisher>,
    clients: Arc<Semaphore>,
    allowed_hosts: &[String],
) -> Result<(), ConnectionError> {
    let (head, head_len) = timeout(REQUEST_TIMEOUT, peek_request_head(&socket))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request head"))??;

    // Checked before anything is served, so a rebound name cannot reach the
    // page either. Serving the document to an attacker's origin would make
    // their page same-origin with the dashboard and undo the origin check.
    if !host_is_allowed(&head, allowed_hosts) {
        log::debug!(
            "dashboard: refusing host {:?}; add it with --dashboard-allowed-host",
            header(&head, "host").unwrap_or("(absent)")
        );
        return refuse(socket, head_len, 421, b"unrecognised host").await;
    }

    if is_websocket_upgrade(&head) {
        if !origin_is_allowed(&head) {
            log::debug!(
                "dashboard: refusing websocket from origin {:?}",
                header(&head, "origin").unwrap_or("(absent)")
            );
            return refuse(socket, head_len, 403, b"origin not allowed").await;
        }
        // Held for the lifetime of the websocket below, and released when this
        // function returns.
        let Ok(_permit) = clients.try_acquire_owned() else {
            log::info!(
                "dashboard: refusing a websocket, {MAX_WEBSOCKET_CLIENTS} clients already \
                 connected"
            );
            return refuse(socket, head_len, 503, b"too many dashboard clients").await;
        };
        let path = request_path(&head).to_string();
        serve_websocket(socket, publisher, &path).await
    } else {
        // Consume the bytes that were only peeked at. Closing a socket that
        // still has unread data makes the kernel send RST rather than FIN,
        // which discards anything left in the send buffer and truncates the
        // response. Small files survive that; a large asset does not.
        let mut consumed = vec![0u8; head_len];
        socket.read_exact(&mut consumed).await?;
        serve_http(socket, &head)
            .await
            .map_err(ConnectionError::from)
    }
}

/// Turns a request away with a status rather than a silent close.
///
/// Every refusal happens before any upgrade, so the caller is still speaking
/// HTTP and gets something it can act on.
async fn refuse(
    mut socket: TcpStream,
    head_len: usize,
    status: u16,
    body: &[u8],
) -> Result<(), ConnectionError> {
    // Same reason the HTTP path drains here: closing a socket with unread data
    // makes the kernel send RST, which discards the response we just wrote.
    let mut consumed = vec![0u8; head_len];
    socket.read_exact(&mut consumed).await?;
    socket
        .write_all(&response(status, "text/plain; charset=utf-8", body, false))
        .await?;
    socket.flush().await?;
    socket.shutdown().await?;
    Ok(())
}

/// Reads the request head without consuming it, so that a websocket connection
/// can still be handed to soketto for its own handshake. Returns the head and
/// its exact length in bytes, which the HTTP path needs in order to drain it.
async fn peek_request_head(socket: &TcpStream) -> io::Result<(String, usize)> {
    let mut buffer = vec![0u8; MAX_REQUEST_HEAD];
    loop {
        socket.readable().await?;
        let peeked = match socket.peek(&mut buffer).await {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "no request")),
            Ok(peeked) => peeked,
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => continue,
            Err(err) => return Err(err),
        };
        // `from_utf8_lossy` can change the byte count, so the length comes from
        // what was actually peeked rather than from the string.
        let head = String::from_utf8_lossy(&buffer[..peeked]);
        if head.contains("\r\n\r\n") || peeked == MAX_REQUEST_HEAD {
            return Ok((head.into_owned(), peeked));
        }
    }
}

/// Reads a request header, case-insensitively.
fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines()
        .skip(1) // the request line is not a header
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
}

/// The host part of an authority or origin, without scheme, port or brackets.
///
/// Ports are dropped deliberately. A dashboard reached on one port and proxied
/// on another is the same machine, and refusing that would break more real
/// deployments than the distinction protects.
fn host_of(value: &str) -> &str {
    let value = value
        .rsplit_once("//")
        .map(|(_, rest)| rest)
        .unwrap_or(value);
    // IPv6 authorities are bracketed, so the port colon is the one outside.
    if let Some(rest) = value.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    value.split(':').next().unwrap_or(value)
}

/// Whether the request names a host this dashboard answers to.
///
/// A request with no `Host` at all is rejected: every HTTP/1.1 client sends
/// one, so its absence says more about the caller than about the deployment.
fn host_is_allowed(head: &str, allowed: &[String]) -> bool {
    let Some(host) = header(head, "host") else {
        return false;
    };
    let host = host_of(host);

    // An address literal is always accepted, and costs nothing to accept.
    // Rebinding works by resolving a name the attacker owns to this machine,
    // so the browser sends that name — never a bare address. Requiring one to
    // be configured would only mean an operator testing on an IP is turned
    // away by a defence that was never protecting them.
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }

    allowed
        .iter()
        .any(|candidate| host_of(candidate).eq_ignore_ascii_case(host))
}

/// Whether a websocket upgrade comes from a page served by this dashboard.
///
/// Websockets are exempt from the same-origin policy, so without this any page
/// a browser visits could open a socket here and read the whole feed —
/// including against a dashboard bound to loopback, which is otherwise assumed
/// to be private.
///
/// A missing `Origin` is allowed: browsers always send one on a websocket
/// handshake, so its absence means the caller is not a browser and is not
/// acting on some other page's behalf. A literal `null`, which is what a
/// sandboxed frame sends, is refused.
fn origin_is_allowed(head: &str) -> bool {
    let Some(origin) = header(head, "origin") else {
        return true;
    };
    if origin.eq_ignore_ascii_case("null") {
        return false;
    }
    match header(head, "host") {
        Some(host) => host_of(origin).eq_ignore_ascii_case(host_of(host)),
        None => false,
    }
}

fn is_websocket_upgrade(head: &str) -> bool {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
        })
}

fn request_path(head: &str) -> &str {
    head.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .map(|target| target.split(['?', '#']).next().unwrap_or("/"))
        .unwrap_or("/")
}

// ---- static assets ------------------------------------------------------

async fn serve_http(mut socket: TcpStream, head: &str) -> io::Result<()> {
    let path = request_path(head);
    let is_read = head.starts_with("GET ") || head.starts_with("HEAD ");

    let response = if !is_read {
        response(
            405,
            "text/plain; charset=utf-8",
            b"method not allowed",
            false,
        )
    } else if assets::ASSETS.is_empty() {
        // Built without a frontend. Saying so beats a 404, which would read as
        // the server being broken.
        response(
            200,
            "text/html; charset=utf-8",
            MISSING_FRONTEND.as_bytes(),
            false,
        )
    } else {
        match lookup(path) {
            // Hashed asset filenames are safe to cache forever. The entry
            // document is not, or a redeploy would never be picked up.
            Some((content_type, body)) => {
                response(200, content_type, body, path.starts_with("/assets/"))
            }
            // Unknown paths fall through to the SPA so client-side routes
            // survive a hard refresh.
            None => match lookup("/index.html") {
                Some((content_type, body)) => response(200, content_type, body, false),
                None => response(404, "text/plain; charset=utf-8", b"not found", false),
            },
        }
    };

    socket.write_all(&response).await?;
    socket.flush().await?;
    // Shut the write half down explicitly so the peer sees a clean FIN after
    // the whole body, instead of whatever dropping the socket produces.
    socket.shutdown().await
}

fn lookup(path: &str) -> Option<(&'static str, &'static [u8])> {
    let path = if path == "/" { "/index.html" } else { path };
    assets::ASSETS
        .iter()
        .find(|(route, _, _)| *route == path)
        .map(|(_, content_type, body)| (*content_type, *body))
}

fn response(status: u16, content_type: &str, body: &[u8], immutable: bool) -> Vec<u8> {
    let reason = match status {
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        421 => "Misdirected Request",
        503 => "Service Unavailable",
        _ => "OK",
    };
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut out = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {content_type}\r\ncontent-length: \
         {}\r\ncache-control: {cache}\r\nconnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

// ---- websocket ----------------------------------------------------------

/// Fails the connection if a send cannot complete promptly.
///
/// Cancelling a partially written frame leaves the stream in an indeterminate
/// state, so every caller treats a timeout as fatal and drops the connection
/// rather than sending anything further over it.
macro_rules! send_or_timeout {
    ($expr:expr) => {
        timeout(WRITE_TIMEOUT, $expr)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "websocket send"))??
    };
}

async fn serve_websocket(
    socket: TcpStream,
    publisher: Arc<Publisher>,
    path: &str,
) -> Result<(), ConnectionError> {
    let mut server = Server::new(socket.compat());
    // The request borrows the server, so the key is copied out and the borrow
    // dropped before the response goes back over that same server.
    let key = server.receive_request().await?.key();

    if path != WEBSOCKET_PATH {
        server
            .send_response(&server::Response::Reject { status_code: 404 })
            .await?;
        return Ok(());
    }
    server
        .send_response(&server::Response::Accept {
            key,
            protocol: None,
        })
        .await?;

    // Subscribing before taking the snapshot means a value that changes between
    // the two arrives as an update instead of going missing.
    let mut updates = publisher.subscribe();
    let snapshot = publisher.snapshot();

    // One limit, both directions. It has to clear the largest message the
    // server sends, and every byte above that is buffering a caller can make
    // the validator do.
    let mut builder = server.into_builder();
    builder.set_max_message_size(MAX_MESSAGE);
    builder.set_max_frame_size(MAX_MESSAGE);
    let (mut sender, mut receiver) = builder.finish();

    let total: usize = snapshot.iter().map(|message| message.len()).sum();
    for (index, message) in snapshot.iter().enumerate() {
        let sent = timeout(WRITE_TIMEOUT, sender.send_text(&**message))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "snapshot send"))?;
        if let Err(err) = sent {
            // Losing the snapshot leaves the client with a blank dashboard, so
            // report exactly where it stopped rather than letting it look like
            // missing data.
            log::warn!(
                "dashboard: snapshot send failed on message {} of {} ({} bytes, {total} bytes \
                 total, starts {:.120}): {err}",
                index.saturating_add(1),
                snapshot.len(),
                message.len(),
                message,
            );
            return Err(err.into());
        }
        // Flushing per message keeps one oversized entry from taking the whole
        // snapshot down with it.
        send_or_timeout!(sender.flush());
    }

    let mut incoming = Vec::new();
    loop {
        // soketto's `receive_data` is not cancel safe, so it is polled to
        // completion in an inner loop rather than dropped by `select!`.
        {
            let receive = receiver.receive_data(&mut incoming);
            pin!(receive);
            loop {
                select! {
                    // Client frames are handled first so that pings and closes
                    // are not starved by a busy update stream.
                    biased;

                    received = &mut receive => match received {
                        Ok(_) => break,
                        Err(soketto::connection::Error::Closed) => return Ok(()),
                        Err(err) => return Err(err.into()),
                    },

                    update = updates.recv() => match update {
                        Ok(message) => {
                            send_or_timeout!(sender.send_text(&*message));
                            // Drain whatever else is already queued before
                            // flushing, so a burst costs one write, not one per
                            // message.
                            loop {
                                match updates.try_recv() {
                                    Ok(message) => {
                                        send_or_timeout!(sender.send_text(&*message))
                                    }
                                    Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => break,
                                    // A client that cannot keep up gets
                                    // dropped. The server never slows down to
                                    // wait for one.
                                    Err(TryRecvError::Lagged(_)) => {
                                        return Err(ConnectionError::Lagged);
                                    }
                                }
                            }
                            send_or_timeout!(sender.flush());
                        }
                        Err(RecvError::Lagged(_)) => return Err(ConnectionError::Lagged),
                        Err(RecvError::Closed) => return Ok(()),
                    },
                }
            }
        }

        // The connection-level limit has to be large enough for what the server
        // sends, so the bound on client messages is applied here instead.
        if incoming.len() > MAX_CLIENT_MESSAGE {
            return Err(ConnectionError::Oversized(incoming.len()));
        }
        if let Some(reply) = respond(&incoming) {
            send_or_timeout!(sender.send_text(&*reply));
            send_or_timeout!(sender.flush());
        }
        incoming.clear();
    }
}

/// Handles a client request. Even unknown requests get an answer, so a client
/// is never left waiting on an id that will never come back.
fn respond(payload: &[u8]) -> Option<Message> {
    let request: Request = serde_json::from_slice(payload).ok()?;
    let id = request.id;
    match (request.topic.as_str(), request.key.as_str()) {
        ("summary", "ping") => Some(encode_with_id("summary", "ping", id, &())),
        (topic, key) => {
            log::debug!("dashboard: unhandled request {topic}.{key}");
            Some(encode_with_id(
                topic,
                key,
                id,
                &serde_json::json!({ "error": "unsupported request" }),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_a_websocket_upgrade() {
        assert!(is_websocket_upgrade(
            "GET /websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\r\n"
        ));
        assert!(is_websocket_upgrade(
            "GET / HTTP/1.1\r\nupgrade:  WebSocket \r\n\r\n"
        ));
        assert!(!is_websocket_upgrade("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    }

    fn req(headers: &str) -> String {
        format!("GET /websocket HTTP/1.1\r\n{headers}\r\n\r\n")
    }

    fn allowed() -> Vec<String> {
        vec![
            "localhost".into(),
            "127.0.0.1".into(),
            "dash.example.com".into(),
        ]
    }

    #[test]
    fn a_page_this_dashboard_served_may_open_a_socket() {
        assert!(origin_is_allowed(&req(
            "Host: dash.example.com\r\nOrigin: https://dash.example.com"
        )));
        // Behind a proxy the visitor's port and the dashboard's differ.
        assert!(origin_is_allowed(&req(
            "Host: dash.example.com\r\nOrigin: https://dash.example.com:443"
        )));
    }

    #[test]
    fn another_site_may_not() {
        // The whole point: a websocket is exempt from the same-origin policy,
        // so without this any page a browser visits could read the feed.
        assert!(!origin_is_allowed(&req(
            "Host: dash.example.com\r\nOrigin: https://evil.example"
        )));
        // Including against a dashboard assumed private for being on loopback.
        assert!(!origin_is_allowed(&req(
            "Host: 127.0.0.1:10999\r\nOrigin: https://evil.example"
        )));
    }

    #[test]
    fn a_sandboxed_frame_is_refused() {
        assert!(!origin_is_allowed(&req(
            "Host: dash.example.com\r\nOrigin: null"
        )));
    }

    #[test]
    fn a_client_that_is_not_a_browser_is_allowed() {
        // curl and monitoring send no Origin, and cannot be acting for a page.
        assert!(origin_is_allowed(&req("Host: dash.example.com")));
    }

    #[test]
    fn only_known_hosts_are_answered() {
        assert!(host_is_allowed(&req("Host: localhost:10999"), &allowed()));
        assert!(host_is_allowed(&req("Host: DASH.EXAMPLE.COM"), &allowed()));
        assert!(!host_is_allowed(&req("Host: rebind.evil"), &allowed()));
        assert!(!host_is_allowed(&req("Origin: x"), &allowed()));
    }

    #[test]
    fn an_address_literal_needs_no_configuration() {
        // Testing on a public IP before any domain exists must just work: an
        // address cannot be rebound, so nothing is being relaxed here.
        assert!(host_is_allowed(&req("Host: 111.1.1.1:10999"), &allowed()));
        assert!(host_is_allowed(&req("Host: 127.0.0.1:10999"), &allowed()));
        assert!(host_is_allowed(&req("Host: [::1]:10999"), &allowed()));
        assert!(host_is_allowed(&req("Host: [2001:db8::1]"), &allowed()));
        // With an empty allowlist too, since the defaults name only localhost.
        assert!(host_is_allowed(&req("Host: 111.1.1.1"), &[]));
    }

    #[test]
    fn a_name_still_has_to_be_named() {
        // The rebinding defence survives the concession above: what an
        // attacker controls is a name, and a name is still checked.
        assert!(!host_is_allowed(&req("Host: rebind.evil"), &[]));
        assert!(!host_is_allowed(
            &req("Host: 111.1.1.1.evil.com"),
            &allowed()
        ));
        assert!(!host_is_allowed(&req("Host: 999.999.999.999"), &allowed()));
    }

    #[test]
    fn more_than_one_name_can_be_allowed() {
        let hosts = vec!["a.example.com".to_string(), "b.example.com".to_string()];
        assert!(host_is_allowed(&req("Host: a.example.com"), &hosts));
        assert!(host_is_allowed(&req("Host: b.example.com"), &hosts));
        assert!(!host_is_allowed(&req("Host: c.example.com"), &hosts));
    }

    #[test]
    fn rebinding_defeats_the_origin_check_and_is_caught_by_the_host_check() {
        let rebound = req("Host: rebind.evil:10999\r\nOrigin: http://rebind.evil");
        assert!(
            origin_is_allowed(&rebound),
            "origin matches host under rebinding, which is why the host check exists"
        );
        assert!(!host_is_allowed(&rebound, &allowed()));
    }

    #[test]
    fn hosts_are_compared_without_scheme_or_port() {
        assert_eq!(host_of("https://dash.example.com:443"), "dash.example.com");
        assert_eq!(host_of("dash.example.com:10999"), "dash.example.com");
        assert_eq!(host_of("[::1]:10999"), "::1");
        assert_eq!(host_of("http://[::1]"), "::1");
    }

    #[test]
    fn headers_are_read_case_insensitively_and_stop_at_the_body() {
        let head = "GET / HTTP/1.1\r\nHOST: x\r\n\r\nHost: injected\r\n";
        assert_eq!(header(head, "host"), Some("x"));
        assert_eq!(header(head, "missing"), None);
    }

    #[test]
    fn extracts_the_request_path() {
        assert_eq!(
            request_path("GET /assets/app.js HTTP/1.1\r\n"),
            "/assets/app.js"
        );
        assert_eq!(request_path("GET /?x=1 HTTP/1.1\r\n"), "/");
        assert_eq!(request_path("garbage"), "/");
    }

    /// Drives `handle` against a real socket with the cap already taken, which
    /// is the state a 65th viewer would arrive in.
    async fn request_with_no_permits_left(request: &[u8]) -> String {
        // These fixtures use `Host: x`, so the host policy is widened to match.
        // The cap is what is under test here, not which hosts are answered.
        let allowed_hosts = vec!["x".to_string()];
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let clients = Arc::new(Semaphore::new(1));
        // Stands in for a viewer already holding the only slot.
        let _held = clients.clone().try_acquire_owned().unwrap();

        let publisher = Arc::new(Publisher::new());
        let server = tokio::spawn({
            let clients = clients.clone();
            async move {
                let (socket, _) = listener.accept().await.unwrap();
                handle(socket, publisher, clients, &allowed_hosts).await
            }
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(request).await.unwrap();
        let mut reply = String::new();
        client.read_to_string(&mut reply).await.unwrap();
        server.await.unwrap().unwrap();
        reply
    }

    /// Drives `handle` end to end with a named host that is not allowed, which
    /// is what a rebinding attempt looks like on the wire.
    async fn request_with_hosts(request: &[u8], allowed_hosts: Vec<String>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let publisher = Arc::new(Publisher::new());
        let clients = Arc::new(Semaphore::new(1));
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            handle(socket, publisher, clients, &allowed_hosts).await
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(request).await.unwrap();
        let mut reply = String::new();
        client.read_to_string(&mut reply).await.unwrap();
        server.await.unwrap().unwrap();
        reply
    }

    #[tokio::test]
    async fn an_unrecognised_host_is_turned_away_before_anything_is_served() {
        let reply = request_with_hosts(
            b"GET / HTTP/1.1\r\nHost: rebind.evil\r\n\r\n",
            vec!["dash.example.com".to_string()],
        )
        .await;
        assert!(
            reply.starts_with("HTTP/1.1 421 Misdirected Request"),
            "expected a refusal, got {reply:?}"
        );
        // The page itself must not have gone out: serving it would make the
        // attacker's origin same-origin with the dashboard.
        assert!(!reply.contains("<!doctype"), "document was served anyway");
    }

    #[tokio::test]
    async fn a_websocket_from_another_origin_is_refused() {
        let reply = request_with_hosts(
            b"GET /websocket HTTP/1.1\r\nHost: dash.example.com\r\nUpgrade: websocket\r\nOrigin: https://evil.example\r\n\r\n",
            vec!["dash.example.com".to_string()],
        )
        .await;
        assert!(
            reply.starts_with("HTTP/1.1 403 Forbidden"),
            "expected a refusal, got {reply:?}"
        );
    }

    #[tokio::test]
    async fn a_websocket_over_the_cap_is_refused_with_a_status() {
        let reply = request_with_no_permits_left(
            b"GET /websocket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n\r\n",
        )
        .await;
        assert!(
            reply.starts_with("HTTP/1.1 503 Service Unavailable"),
            "expected a refusal, got {reply:?}"
        );
    }

    #[tokio::test]
    async fn http_is_still_served_when_the_websocket_cap_is_full() {
        // The point of capping websockets alone: a full pool must not stop the
        // page itself from loading.
        let reply = request_with_no_permits_left(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(
            reply.starts_with("HTTP/1.1 200 OK"),
            "expected the page, got {:?}",
            &reply[..reply.len().min(80)]
        );
    }

    #[test]
    fn ping_is_answered_with_its_id() {
        let reply = respond(br#"{"topic":"summary","key":"ping","id":7}"#).unwrap();
        assert!(reply.contains(r#""id":7"#));
    }

    #[test]
    fn unknown_requests_still_get_a_reply() {
        let reply = respond(br#"{"topic":"nope","key":"nope","id":1}"#).unwrap();
        assert!(reply.contains("unsupported request"));
    }

    #[test]
    fn malformed_requests_are_ignored() {
        assert!(respond(b"not json").is_none());
    }

    #[test]
    fn root_serves_the_entry_document() {
        // Only meaningful when the frontend was built; otherwise the server
        // serves the placeholder page and there is nothing to look up.
        if !assets::ASSETS.is_empty() {
            assert!(lookup("/").is_some());
        }
    }
}
