//! Wire protocol for the dashboard websocket.
//!
//! Every message is a JSON envelope carrying a `topic`, a `key` within that
//! topic, and a `value`:
//!
//! ```json
//! { "topic": "summary", "key": "cluster", "value": "testnet" }
//! ```
//!
//! Messages fall into two classes. Retained messages carry validator state that
//! changes over time. The newest value for each `(topic, key)` is kept, so a
//! client that connects late is brought up to date immediately. Ephemeral
//! messages describe an event at a point in time, such as a slot changing
//! status, and only reach the clients connected when they happen.
//!
//! A client can also issue a query by sending an envelope with an `id`. The
//! response goes back to that `id` alone and is never broadcast.

use {
    serde::{Deserialize, Serialize},
    std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    },
    tokio::sync::broadcast,
};

/// Ceiling on a single websocket message, applied in both directions.
///
/// soketto takes one limit per connection, so this bounds what a client may
/// send as much as what the server does — and the client's frame is buffered
/// whole before any smaller limit can be applied to it. Sixty-four clients at
/// the previous 32MB was two gigabytes of caller-controlled buffering.
///
/// The largest message the server sends is the 512-slot overview. Its entries
/// carry a base58 identity and, at worst, a name and icon URL bounded together
/// by the 642-byte validator-info account, which puts the message near 430KB.
/// A megabyte leaves headroom without leaving room to abuse.
pub const MAX_MESSAGE: usize = 1024 * 1024;

/// Messages buffered per client before it counts as too slow and gets
/// disconnected. The server drops laggards rather than slowing itself down for
/// them.
const BROADCAST_CAPACITY: usize = 8192;

#[derive(Serialize)]
struct Envelope<'a, T> {
    topic: &'a str,
    key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    value: T,
}

/// A request sent by a client.
#[derive(Deserialize)]
pub struct Request {
    pub topic: String,
    pub key: String,
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A serialized, ready-to-send message. Serialization happens once, on the
/// publishing thread, and the resulting bytes are shared by every client.
pub type Message = Arc<str>;

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
    // The only way this fails is a `Serialize` impl that itself errors, which
    // none of ours do. Falling back to a null value keeps a bug in one topic
    // from taking down the whole dashboard.
    match serde_json::to_string(&envelope) {
        Ok(json) => Arc::from(json.as_str()),
        Err(err) => {
            log::error!("dashboard: failed to encode {topic}.{key}: {err}");
            Arc::from(format!(r#"{{"topic":"{topic}","key":"{key}","value":null}}"#).as_str())
        }
    }
}

/// Fans messages out to connected clients and remembers the latest value of
/// every retained key so new connections can be caught up in one shot.
pub struct Publisher {
    retained: Mutex<BTreeMap<(&'static str, String), Message>>,
    sender: broadcast::Sender<Message>,
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
        }
    }

    /// Publish a value that should be replayed to clients connecting later.
    pub fn publish<T: Serialize>(&self, topic: &'static str, key: &str, value: &T) {
        let message = encode(topic, key, value);
        self.retained
            .lock()
            .unwrap()
            .insert((topic, key.to_string()), message.clone());
        // An error here only means nobody is listening yet.
        let _ = self.sender.send(message);
    }

    /// Publish a point-in-time event. Not replayed to future connections.
    pub fn publish_ephemeral<T: Serialize>(&self, topic: &'static str, key: &str, value: &T) {
        let _ = self.sender.send(encode(topic, key, value));
    }

    /// Update what a future connection will receive without sending anything to
    /// current ones. This is for bulk snapshots such as the full peer list and
    /// the slot overview. Their incremental changes go out separately, so
    /// resending the whole thing would be wasted bandwidth.
    pub fn retain_only<T: Serialize>(&self, topic: &'static str, key: &str, value: &T) {
        let message = encode(topic, key, value);
        self.retained
            .lock()
            .unwrap()
            .insert((topic, key.to_string()), message);
    }

    /// Everything a freshly connected client needs to render a full view.
    pub fn snapshot(&self) -> Vec<Message> {
        self.retained.lock().unwrap().values().cloned().collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Message> {
        self.sender.subscribe()
    }
}

/// Tracks the last published value of a key so collectors can publish only on
/// change. Most of the dashboard's data is sampled on a timer but changes far
/// less often than it is sampled.
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

    pub fn is_unset(&self) -> bool {
        self.last.is_none()
    }
}

impl<T: Serialize + PartialEq> Debounced<T> {
    pub fn publish(&mut self, publisher: &Publisher, topic: &'static str, key: &str, value: T) {
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

    #[test]
    fn retained_snapshot_replays_latest_value_only() {
        let publisher = Publisher::new();
        publisher.publish("summary", "root_slot", &1u64);
        publisher.publish("summary", "root_slot", &2u64);
        let snapshot = publisher.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].contains(r#""value":2"#));
    }

    #[test]
    fn ephemeral_messages_are_not_replayed() {
        let publisher = Publisher::new();
        publisher.publish_ephemeral("slot", "update", &1u64);
        assert!(publisher.snapshot().is_empty());
    }

    #[test]
    fn retain_only_updates_snapshot_without_broadcasting() {
        let publisher = Publisher::new();
        let mut receiver = publisher.subscribe();
        publisher.retain_only("peers", "all", &[1u64, 2]);
        assert_eq!(publisher.snapshot().len(), 1);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn debounce_suppresses_unchanged_values() {
        let publisher = Publisher::new();
        let mut receiver = publisher.subscribe();
        let mut debounced = Debounced::default();
        debounced.publish(&publisher, "summary", "root_slot", 7u64);
        debounced.publish(&publisher, "summary", "root_slot", 7u64);
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn envelope_has_topic_key_and_value() {
        let message = encode("summary", "cluster", &"testnet");
        assert_eq!(
            &*message,
            r#"{"topic":"summary","key":"cluster","value":"testnet"}"#
        );
    }

    #[test]
    fn query_responses_carry_the_request_id() {
        let message = encode_with_id("summary", "ping", Some(42), &());
        assert_eq!(
            &*message,
            r#"{"topic":"summary","key":"ping","id":42,"value":null}"#
        );
    }
}
