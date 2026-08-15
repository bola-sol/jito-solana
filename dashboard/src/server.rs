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
    std::{io, sync::Arc},
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

pub async fn serve(listener: TcpListener, publisher: Arc<Publisher>) {
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
        tokio::spawn(async move {
            if let Err(err) = handle(socket, publisher, clients).await {
                log::debug!("dashboard: connection from {peer} ended: {err}");
            }
        });
    }
}

async fn handle(
    mut socket: TcpStream,
    publisher: Arc<Publisher>,
    clients: Arc<Semaphore>,
) -> Result<(), ConnectionError> {
    let (head, head_len) = timeout(REQUEST_TIMEOUT, peek_request_head(&socket))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "request head"))??;

    if is_websocket_upgrade(&head) {
        // Held for the lifetime of the websocket below, and released when this
        // function returns.
        let Ok(_permit) = clients.try_acquire_owned() else {
            log::info!(
                "dashboard: refusing a websocket, {MAX_WEBSOCKET_CLIENTS} clients already \
                 connected"
            );
            return refuse_websocket(socket, head_len).await;
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

/// Turns away a websocket that would exceed the client cap.
///
/// Refused before the upgrade, so the caller is still speaking HTTP and gets a
/// status it can act on rather than a socket that closes for no stated reason.
async fn refuse_websocket(mut socket: TcpStream, head_len: usize) -> Result<(), ConnectionError> {
    // Same reason the HTTP path drains here: closing a socket with unread data
    // makes the kernel send RST, which discards the response we just wrote.
    let mut consumed = vec![0u8; head_len];
    socket.read_exact(&mut consumed).await?;
    socket
        .write_all(&response(
            503,
            "text/plain; charset=utf-8",
            b"too many dashboard clients",
            false,
        ))
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
        404 => "Not Found",
        405 => "Method Not Allowed",
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
                handle(socket, publisher, clients).await
            }
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(request).await.unwrap();
        let mut reply = String::new();
        client.read_to_string(&mut reply).await.unwrap();
        server.await.unwrap().unwrap();
        reply
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
