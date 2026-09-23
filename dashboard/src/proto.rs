//! Wire protocol: JSON envelopes of `topic`, `key` and `value`. Retained
//! messages keep their newest value per key for clients connecting late;
//! ephemeral ones reach only the clients connected at the time. A request
//! carries an `id` and its reply goes to that `id` alone.

use {
    flate2::{Compression, write::ZlibEncoder},
    serde::{Deserialize, Serialize},
    std::{
        collections::BTreeMap,
        io::Write,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    },
    tokio::sync::broadcast,
};

/// Ceiling on a websocket message in either direction, soketto having one
/// limit per connection. The largest server message is under half of it.
pub const MAX_MESSAGE: usize = 1024 * 1024;

/// Messages buffered per client before it counts as too slow and is dropped.
const BROADCAST_CAPACITY: usize = 8192;

/// JSON this long or longer also travels deflated, as a binary frame to a
/// client that offered the subprotocol. Below it the framing and the decode
/// outweigh the saving.
pub const DEFLATE_FROM: usize = 512;

/// The websocket subprotocol a client offers to be sent deflated frames.
pub const DEFLATE_PROTOCOL: &str = "deflate";

/// How often the bytes published per key are logged, at debug level.
const TRAFFIC_REPORT: Duration = Duration::from_secs(60);

/// Keys named in a traffic report, heaviest first.
const TRAFFIC_TOP: usize = 8;

/// The topics a client can receive. Here because they are part of the wire
/// format.
pub const TOPIC_SUMMARY: &str = "summary";
pub const TOPIC_EPOCH: &str = "epoch";
pub const TOPIC_SLOT: &str = "slot";
pub const TOPIC_PEERS: &str = "peers";

#[derive(Serialize)]
struct Envelope<'a, T> {
    topic: &'a str,
    key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    value: T,
}

/// A request sent by a client. Unknown fields are ignored, so a client may send
/// arguments alongside these once a request exists that takes any.
#[derive(Deserialize)]
pub struct Request {
    pub topic: String,
    pub key: String,
    #[serde(default)]
    pub id: Option<u64>,
    /// Whatever the request carries, left unparsed: each request knows the shape
    /// of its own parameters.
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A serialized, ready-to-send message. Serialization happens once, on the
/// publishing thread, and the resulting bytes are shared by every client.
#[derive(Clone)]
pub struct Message {
    text: Arc<str>,
    /// The same JSON deflated, kept when the message is long enough to be
    /// worth it.
    deflated: Option<Arc<[u8]>>,
    /// The retained key this carries a newer value of, so an older value still
    /// queued for a slow client can be dropped in its favour.
    supersedes: Option<(&'static str, &'static str)>,
}

/// What goes on the wire to one client.
pub enum Frame<'a> {
    Text(&'a str),
    Binary(&'a [u8]),
}

impl Message {
    fn new(json: String) -> Self {
        let deflated = if json.len() >= DEFLATE_FROM {
            deflate(json.as_bytes()).map(Arc::from)
        } else {
            None
        };
        Self {
            text: Arc::from(json.as_str()),
            deflated,
            supersedes: None,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The frame a client is sent: deflated when it offered to take that and
    /// the message is long enough.
    pub fn frame(&self, deflate: bool) -> Frame<'_> {
        match &self.deflated {
            Some(bytes) if deflate => Frame::Binary(bytes),
            _ => Frame::Text(&self.text),
        }
    }

    /// Bytes on the wire to a client, given whether it takes deflated frames.
    pub fn wire_len(&self, deflate: bool) -> usize {
        match &self.deflated {
            Some(bytes) if deflate => bytes.len(),
            _ => self.text.len(),
        }
    }

    pub fn supersedes(&self) -> Option<(&'static str, &'static str)> {
        self.supersedes
    }
}

/// The JSON, as the string it is; the deflated form is a cache of it.
impl std::ops::Deref for Message {
    type Target = str;

    fn deref(&self) -> &str {
        &self.text
    }
}

impl std::fmt::Display for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

/// zlib-wrapped deflate, the format a browser's `DecompressionStream`
/// reads as "deflate".
fn deflate(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).ok()?;
    encoder.finish().ok()
}

/// A burst of queued messages with every superseded value dropped: a retained
/// key queued more than once is sent once, with its newest value, in the newest
/// one's place. Everything else is kept in order.
pub fn coalesce(burst: Vec<Message>) -> Vec<Message> {
    let mut seen = std::collections::HashSet::new();
    let mut kept: Vec<Message> = burst
        .into_iter()
        .rev()
        .filter(|message| match message.supersedes() {
            Some(key) => seen.insert(key),
            None => true,
        })
        .collect();
    kept.reverse();
    kept
}

pub fn encode<T: Serialize>(topic: &str, key: &str, value: &T) -> Message {
    encode_with_id(topic, key, None, value)
}

pub fn encode_with_id<T: Serialize>(topic: &str, key: &str, id: Option<u64>, value: &T) -> Message {
    let envelope = Envelope {
        topic,
        key,
        id,
        value,
    };
    // The only failure is a `Serialize` impl that errors. Falling back to null
    // keeps a bug in one topic from taking the feed down.
    match serde_json::to_string(&envelope) {
        Ok(json) => Message::new(json),
        Err(err) => {
            log::error!("dashboard: failed to encode {topic}.{key}: {err}");
            Message::new(format!(
                r#"{{"topic":"{topic}","key":"{key}","value":null}}"#
            ))
        }
    }
}

/// The envelope [`encode_with_id`] writes, around a value serialised already,
/// so a reply every viewer may ask for is encoded once.
pub fn encode_json_with_id(topic: &str, key: &str, id: Option<u64>, value: &str) -> Message {
    let topic = serde_json::Value::from(topic);
    let key = serde_json::Value::from(key);
    let id = id.map(|id| format!(r#""id":{id},"#)).unwrap_or_default();
    Message::new(format!(
        r#"{{"topic":{topic},"key":{key},{id}"value":{value}}}"#
    ))
}

/// What one key has been sent since the last traffic report.
#[derive(Clone, Copy, Default)]
struct Volume {
    messages: usize,
    bytes: usize,
}

/// Bytes published per key, as a client taking deflated frames receives them.
struct Traffic {
    since: Instant,
    by_key: BTreeMap<(&'static str, String), Volume>,
}

impl Traffic {
    fn new() -> Self {
        Self {
            since: Instant::now(),
            by_key: BTreeMap::new(),
        }
    }

    /// The report's one line: the total, then the heaviest keys.
    fn describe(self) -> String {
        let seconds = self.since.elapsed().as_secs();
        let total = self
            .by_key
            .values()
            .fold(0usize, |sum, volume| sum.saturating_add(volume.bytes));
        let mut keys: Vec<_> = self.by_key.into_iter().collect();
        keys.sort_by_key(|(_, volume)| std::cmp::Reverse(volume.bytes));
        let top = keys
            .iter()
            .take(TRAFFIC_TOP)
            .map(|((topic, key), volume)| {
                format!(
                    "{topic}.{key} {} in {}",
                    bytes_text(volume.bytes),
                    volume.messages
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("published {} in {seconds} s: {top}", bytes_text(total))
    }
}

fn bytes_text(bytes: usize) -> String {
    let bytes = bytes as f64;
    if bytes >= 1e6 {
        format!("{:.1} MB", bytes / 1e6)
    } else if bytes >= 1e3 {
        format!("{:.0} KB", bytes / 1e3)
    } else {
        format!("{bytes:.0} B")
    }
}

/// Fans messages out to connected clients and remembers the latest value of
/// every retained key so new connections can be caught up in one shot.
pub struct Publisher {
    retained: Mutex<BTreeMap<(&'static str, &'static str), Message>>,
    sender: broadcast::Sender<Message>,
    traffic: Mutex<Traffic>,
}

impl Default for Publisher {
    fn default() -> Self {
        Self::new()
    }
}

impl Publisher {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            retained: Mutex::new(BTreeMap::new()),
            sender,
            traffic: Mutex::new(Traffic::new()),
        }
    }

    /// Publish a value that should be replayed to clients connecting later.
    pub fn publish<T: Serialize>(&self, topic: &'static str, key: &'static str, value: &T) {
        let mut message = encode(topic, key, value);
        message.supersedes = Some((topic, key));
        self.retained
            .lock()
            .unwrap()
            .insert((topic, key), message.clone());
        self.note(topic, key, &message);
        // An error here only means nobody is listening yet.
        let _ = self.sender.send(message);
    }

    /// Publish a point-in-time event. Not replayed to future connections.
    pub fn publish_ephemeral<T: Serialize>(&self, topic: &'static str, key: &str, value: &T) {
        let message = encode(topic, key, value);
        self.note(topic, key, &message);
        let _ = self.sender.send(message);
    }

    /// Counts a message toward the minute's traffic and logs the minute once it
    /// is up. Only while this module's log is at debug.
    fn note(&self, topic: &'static str, key: &str, message: &Message) {
        if !log::log_enabled!(log::Level::Debug) {
            return;
        }
        let mut traffic = self.traffic.lock().unwrap();
        let volume = traffic.by_key.entry((topic, key.to_owned())).or_default();
        volume.messages = volume.messages.saturating_add(1);
        volume.bytes = volume.bytes.saturating_add(message.wire_len(true));
        if traffic.since.elapsed() < TRAFFIC_REPORT {
            return;
        }
        let report = std::mem::replace(&mut *traffic, Traffic::new());
        drop(traffic);
        log::debug!("dashboard: {}", report.describe());
    }

    /// Updates what a future connection receives without sending anything now,
    /// for bulk snapshots whose incremental changes go out separately.
    pub fn retain_only<T: Serialize>(&self, topic: &'static str, key: &'static str, value: &T) {
        let message = encode(topic, key, value);
        self.retained.lock().unwrap().insert((topic, key), message);
    }

    /// Everything a freshly connected client needs to render a full view.
    pub fn snapshot(&self) -> Vec<Message> {
        self.retained.lock().unwrap().values().cloned().collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Message> {
        self.sender.subscribe()
    }

    /// Websocket clients currently attached, so collection that only exists to be
    /// looked at can be skipped when nobody is.
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

/// The last published value of a key, so collectors publish only on change.
pub struct Debounced<T> {
    last: Option<T>,
}

impl<T> Default for Debounced<T> {
    fn default() -> Self {
        Self { last: None }
    }
}

impl<T> Debounced<T> {
    /// The value most recently published, if any.
    pub fn last(&self) -> Option<&T> {
        self.last.as_ref()
    }
}

impl<T: Serialize + PartialEq> Debounced<T> {
    pub fn publish(
        &mut self,
        publisher: &Publisher,
        topic: &'static str,
        key: &'static str,
        value: T,
    ) {
        if self.last.as_ref() == Some(&value) {
            return;
        }
        publisher.publish(topic, key, &value);
        self.last = Some(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A value whose `Serialize` impl fails, standing in for a bug in one
    /// topic's payload.
    struct Unserializable;

    impl Serialize for Unserializable {
        fn serialize<S: serde::Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("this value cannot be encoded"))
        }
    }

    #[test]
    fn test_unencodable_payload_keeps_the_feed_up() {
        // One broken topic costs that topic and nothing else.
        let message = encode("summary", "broken", &Unserializable);
        assert_eq!(
            message.text(),
            r#"{"topic":"summary","key":"broken","value":null}"#
        );
    }

    #[test]
    fn test_a_value_encoded_ahead_is_enveloped_as_encode_would() {
        let value = serde_json::json!({ "rows": [1, 2], "name": "a \"quoted\" name" });
        let json = serde_json::to_string(&value).unwrap();
        for id in [None, Some(0), Some(u64::MAX)] {
            assert_eq!(
                encode_json_with_id("summary", "misses", id, &json).text(),
                encode_with_id("summary", "misses", id, &value).text(),
            );
        }
    }

    #[test]
    fn test_a_publisher_defaults_to_an_empty_one() {
        let publisher = Publisher::default();
        assert!(publisher.snapshot().is_empty());
        assert_eq!(publisher.subscriber_count(), 0);
    }

    #[test]
    fn test_a_debounce_remembers_what_it_last_sent() {
        // The collector reads this back to notice a vote that has moved, so it
        // has to hold the published value rather than merely a hash of it.
        let publisher = Publisher::new();
        let mut debounced: Debounced<u64> = Debounced::default();
        assert_eq!(debounced.last(), None);

        debounced.publish(&publisher, "summary", "root_slot", 7);
        assert_eq!(debounced.last(), Some(&7));

        debounced.publish(&publisher, "summary", "root_slot", 9);
        assert_eq!(debounced.last(), Some(&9));
    }

    #[test]
    fn test_retained_snapshot_replays_latest_value_only() {
        let publisher = Publisher::new();
        publisher.publish("summary", "root_slot", &1u64);
        publisher.publish("summary", "root_slot", &2u64);
        let snapshot = publisher.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].text().contains(r#""value":2"#));
    }

    #[test]
    fn test_ephemeral_messages_are_not_replayed() {
        let publisher = Publisher::new();
        publisher.publish_ephemeral("slot", "update", &1u64);
        assert!(publisher.snapshot().is_empty());
    }

    #[test]
    fn test_retain_only_updates_snapshot_without_broadcasting() {
        let publisher = Publisher::new();
        let mut receiver = publisher.subscribe();
        publisher.retain_only("peers", "all", &[1u64, 2]);
        assert_eq!(publisher.snapshot().len(), 1);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn test_subscribers_are_counted_while_they_are_attached() {
        let publisher = Publisher::new();
        assert_eq!(publisher.subscriber_count(), 0);
        let first = publisher.subscribe();
        let second = publisher.subscribe();
        assert_eq!(publisher.subscriber_count(), 2);
        drop(first);
        assert_eq!(publisher.subscriber_count(), 1);
        drop(second);
        assert_eq!(publisher.subscriber_count(), 0);
    }

    #[test]
    fn test_debounce_suppresses_unchanged_values() {
        let publisher = Publisher::new();
        let mut receiver = publisher.subscribe();
        let mut debounced = Debounced::default();
        debounced.publish(&publisher, "summary", "root_slot", 7u64);
        debounced.publish(&publisher, "summary", "root_slot", 7u64);
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn test_envelope_has_topic_key_and_value() {
        let message = encode("summary", "cluster", &"testnet");
        assert_eq!(
            message.text(),
            r#"{"topic":"summary","key":"cluster","value":"testnet"}"#
        );
    }

    #[test]
    fn test_query_responses_carry_the_request_id() {
        let message = encode_with_id("summary", "ping", Some(42), &());
        assert_eq!(
            message.text(),
            r#"{"topic":"summary","key":"ping","id":42,"value":null}"#
        );
    }

    #[test]
    fn test_a_long_message_is_also_kept_deflated_and_a_short_one_is_not() {
        let long = encode("summary", "host", &vec![7u64; 400]);
        assert!(long.text().len() >= DEFLATE_FROM);
        assert!(matches!(long.frame(true), Frame::Binary(_)));
        assert!(long.wire_len(true) < long.wire_len(false));
        // A client that did not offer the subprotocol gets the text either way.
        assert!(matches!(long.frame(false), Frame::Text(_)));

        let short = encode("summary", "root_slot", &7u64);
        assert!(matches!(short.frame(true), Frame::Text(_)));
        assert_eq!(short.wire_len(true), short.text().len());
    }

    #[test]
    fn test_deflated_bytes_inflate_back_to_the_text() {
        use std::io::Read;
        let message = encode("summary", "host", &vec!["abc"; 300]);
        let Frame::Binary(bytes) = message.frame(true) else {
            panic!("a long message should deflate");
        };
        let mut text = String::new();
        flate2::read::ZlibDecoder::new(bytes)
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, message.text());
    }

    #[test]
    fn test_a_burst_sends_a_retained_key_once_with_its_newest_value() {
        let publisher = Publisher::new();
        let mut receiver = publisher.subscribe();
        publisher.publish("summary", "root_slot", &1u64);
        publisher.publish_ephemeral("slot", "update", &10u64);
        publisher.publish("summary", "root_slot", &2u64);
        publisher.publish_ephemeral("slot", "update", &11u64);
        publisher.publish("summary", "cluster", &"testnet");
        let mut burst = Vec::new();
        while let Ok(message) = receiver.try_recv() {
            burst.push(message);
        }
        let kept = coalesce(burst);
        let sent: Vec<&str> = kept.iter().map(Message::text).collect();
        // Every ephemeral message, in order; the older root slot gone, the
        // newer in its own place.
        assert_eq!(
            sent,
            [
                r#"{"topic":"slot","key":"update","value":10}"#,
                r#"{"topic":"summary","key":"root_slot","value":2}"#,
                r#"{"topic":"slot","key":"update","value":11}"#,
                r#"{"topic":"summary","key":"cluster","value":"testnet"}"#,
            ]
        );
    }

    #[test]
    fn test_traffic_report_names_the_heaviest_keys_first() {
        let mut traffic = Traffic::new();
        traffic.by_key.insert(
            ("summary", "host".to_owned()),
            Volume {
                messages: 3,
                bytes: 1_500,
            },
        );
        traffic.by_key.insert(
            ("slot", "update".to_owned()),
            Volume {
                messages: 40,
                bytes: 2_500_000,
            },
        );
        let line = traffic.describe();
        assert!(line.starts_with("published 2.5 MB in "), "{line}");
        assert!(
            line.ends_with("slot.update 2.5 MB in 40, summary.host 2 KB in 3"),
            "{line}"
        );
    }
}
