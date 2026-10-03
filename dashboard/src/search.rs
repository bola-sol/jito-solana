//! Turns in the held history that match a leader's name or key, a slot number, or this validator,
//! answered a page at a time for the schedule page's search.

use {
    crate::{
        collect::EpochInfo,
        history::{SlotHistory, SlotRange},
        validator_info::ValidatorInfoCache,
    },
    agave_votor_messages::reward_certificate::NUM_SLOTS_FOR_REWARD,
    serde::{Deserialize, Serialize},
    solana_clock::Slot,
    solana_leader_schedule::NUM_CONSECUTIVE_LEADER_SLOTS,
    solana_pubkey::Pubkey,
    std::{fmt::Write, str::FromStr, sync::RwLock},
};

const SLOTS_PER_TURN: u64 = NUM_CONSECUTIVE_LEADER_SLOTS.get() as u64;

/// A page of turns with their lead-in rows stays under half the message ceiling; a test holds it.
pub const MAX_SEARCH_TURNS: usize = 128;

/// Longer than any name, and it bounds the cost of each comparison.
const MAX_QUERY_CHARS: usize = 64;

/// Turns read per hold of the history lock: the span a range reply reads.
const TURNS_PER_LOCK: usize = 1024;

/// What the page asks for: text matched as the page matches it, and whether only ours count.
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub ours: bool,
    /// Turns starting below this slot are searched, newest first.
    pub before: Slot,
    #[serde(default)]
    pub limit: Option<usize>,
}

/// A page of matching turns, newest first.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct SearchReply {
    /// Each matching turn's rows, from the slot whose certificate its first row shows.
    pub turns: Vec<SlotRange>,
    /// Where to search below next; `None` once the history is read to its end.
    pub next: Option<Slot>,
}

/// One epoch's leaders, each marked for whether its name or key matches.
struct EpochLeaders<'a> {
    epoch: &'a EpochInfo,
    named: Vec<bool>,
    ours: Option<u16>,
}

impl<'a> EpochLeaders<'a> {
    fn new(epoch: &'a EpochInfo, info: &ValidatorInfoCache, needle: &str) -> Self {
        let named = epoch
            .leaders
            .iter()
            .map(|key| {
                !needle.is_empty()
                    && (key.to_lowercase().contains(needle)
                        || Pubkey::from_str(key)
                            .ok()
                            .and_then(|identity| {
                                info.get(&identity)?.name.as_deref().map(str::to_lowercase)
                            })
                            .is_some_and(|name| name.contains(needle)))
            })
            .collect();
        let ours = epoch
            .my_leader_slots
            .first()
            .and_then(|slot| leader_index(epoch, *slot));
        Self { epoch, named, ours }
    }

    /// Whether the turn's leader matches by name or key, and whether it is ours; `None` outside
    /// this epoch.
    fn at(&self, slot: Slot) -> Option<(bool, bool)> {
        let index = leader_index(self.epoch, slot)?;
        let named = self.named.get(usize::from(index)).copied().unwrap_or(false);
        Some((named, self.ours == Some(index)))
    }
}

fn leader_index(epoch: &EpochInfo, slot: Slot) -> Option<u16> {
    if slot < epoch.start_slot || slot > epoch.end_slot {
        return None;
    }
    let turn = slot
        .checked_sub(epoch.start_slot)?
        .checked_div(SLOTS_PER_TURN)?;
    epoch.turns.get(usize::try_from(turn).ok()?).copied()
}

/// What a search is for: text as the page matches it, lower-cased, and whether only ours count.
struct Wanted<'a> {
    needle: String,
    digits: bool,
    ours: bool,
    leaders: Vec<EpochLeaders<'a>>,
}

impl Wanted<'_> {
    /// `text` is scratch for writing slot numbers, kept across calls.
    fn turn(&self, history: &SlotHistory, start: Slot, text: &mut String) -> bool {
        let end = start.saturating_add(SLOTS_PER_TURN.saturating_sub(1));
        // A turn with no row held is not listed, as the page draws none.
        let Some(first) = (start..=end).find(|slot| history.get(*slot).is_some()) else {
            return false;
        };
        let leader = self.leaders.iter().find_map(|leaders| leaders.at(start));
        if self.ours && !leader.is_some_and(|(_, ours)| ours) {
            return false;
        }
        if self.needle.is_empty() || leader.is_some_and(|(named, _)| named) {
            return true;
        }
        // Only digits can be part of a slot number, so other text skips the formatting.
        self.digits
            && (first..=end).any(|slot| {
                text.clear();
                write!(text, "{slot}").is_ok() && text.contains(&self.needle)
            })
    }
}

/// Holds the history's read lock a thousand turns at a time, so the collector's writes wait no
/// longer than they do behind a range reply.
pub fn search(
    history: &RwLock<SlotHistory>,
    info: &RwLock<ValidatorInfoCache>,
    epochs: &[EpochInfo],
    params: &SearchParams,
) -> SearchReply {
    let needle = params
        .query
        .trim()
        .chars()
        .take(MAX_QUERY_CHARS)
        .collect::<String>()
        .to_lowercase();
    if needle.is_empty() && !params.ours {
        return SearchReply::default();
    }
    let leaders = match info.read() {
        Ok(info) => epochs
            .iter()
            .map(|epoch| EpochLeaders::new(epoch, &info, &needle))
            .collect(),
        Err(_) => return SearchReply::default(),
    };
    let wanted = Wanted {
        digits: !needle.is_empty() && needle.bytes().all(|byte| byte.is_ascii_digit()),
        needle,
        ours: params.ours,
        leaders,
    };
    let limit = params
        .limit
        .unwrap_or(MAX_SEARCH_TURNS)
        .clamp(1, MAX_SEARCH_TURNS);
    let lead = NUM_SLOTS_FOR_REWARD;
    let rows = usize::try_from(lead.saturating_add(SLOTS_PER_TURN)).unwrap_or(usize::MAX);

    let capacity = match history.read() {
        Ok(history) => u64::try_from(history.capacity()).unwrap_or(u64::MAX),
        Err(_) => return SearchReply::default(),
    };
    // Nothing below this can still be in the ring.
    let floor = params.before.saturating_sub(capacity);
    let mut turn = params.before.checked_div(SLOTS_PER_TURN).unwrap_or(0);
    let mut found = Vec::new();
    let mut text = String::new();
    loop {
        let Ok(history) = history.read() else {
            return SearchReply {
                turns: found,
                next: None,
            };
        };
        for _ in 0..TURNS_PER_LOCK {
            let Some(below) = turn.checked_sub(1) else {
                return SearchReply {
                    turns: found,
                    next: None,
                };
            };
            turn = below;
            let start = turn.saturating_mul(SLOTS_PER_TURN);
            if start < floor {
                return SearchReply {
                    turns: found,
                    next: None,
                };
            }
            if !wanted.turn(&history, start, &mut text) {
                continue;
            }
            found.push(history.range(start.saturating_sub(lead), rows));
            if found.len() >= limit {
                return SearchReply {
                    turns: found,
                    next: Some(start),
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{proto, validator_info::ValidatorInfo},
    };

    const START: Slot = 1_000;

    /// An epoch from `START` whose turns cycle through `leaders`, with ours the first.
    fn epoch(leaders: &[&str]) -> EpochInfo {
        let turns: Vec<u16> = (0..1_000u16)
            .map(|turn| turn.checked_rem(leaders.len() as u16).unwrap_or(0))
            .collect();
        EpochInfo {
            epoch: 3,
            start_slot: START,
            end_slot: START + 3_999,
            slots_in_epoch: 4_000,
            my_leader_slots: vec![START, START + 1, START + 2, START + 3],
            leaders: leaders.iter().map(|key| key.to_string()).collect(),
            turns,
            block_cost_limit: 0,
            account_cost_limit: 0,
        }
    }

    fn history(from: Slot, to: Slot) -> RwLock<SlotHistory> {
        let mut history = SlotHistory::new(4_096);
        for slot in from..=to {
            history.record_time(slot, slot);
        }
        RwLock::new(history)
    }

    fn named(key: &Pubkey, name: &str) -> RwLock<ValidatorInfoCache> {
        let mut info = ValidatorInfoCache::default();
        info.insert(
            *key,
            ValidatorInfo {
                name: Some(name.into()),
                icon_url: None,
            },
        );
        RwLock::new(info)
    }

    fn params(query: &str, ours: bool, before: Slot, limit: Option<usize>) -> SearchParams {
        SearchParams {
            query: query.into(),
            ours,
            before,
            limit,
        }
    }

    fn starts(reply: &SearchReply) -> Vec<Slot> {
        reply
            .turns
            .iter()
            .map(|turn| turn.first_slot.saturating_add(NUM_SLOTS_FOR_REWARD))
            .collect()
    }

    #[test]
    fn test_a_name_matches_whatever_its_case() {
        let (ours, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let epochs = [epoch(&[&ours.to_string(), &other.to_string()])];
        let reply = search(
            &history(START, START + 15),
            &named(&other, "Hamsa Labs"),
            &epochs,
            &params("hamsa", false, START + 16, None),
        );
        assert_eq!(starts(&reply), vec![START + 12, START + 4], "newest first");
        assert_eq!(reply.next, None);
    }

    #[test]
    fn test_a_key_and_a_slot_number_match() {
        let (ours, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let epochs = [epoch(&[&ours.to_string(), &other.to_string()])];
        let key = other.to_string().to_lowercase();
        let by_key = search(
            &history(START, START + 15),
            &RwLock::default(),
            &epochs,
            &params(&key[..6], false, START + 16, None),
        );
        assert_eq!(starts(&by_key), vec![START + 12, START + 4]);
        let by_slot = search(
            &history(START, START + 15),
            &RwLock::default(),
            &epochs,
            &params("1009", false, START + 16, None),
        );
        assert_eq!(starts(&by_slot), vec![START + 8]);
    }

    #[test]
    fn test_ours_keeps_only_our_turns() {
        let (ours, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let epochs = [epoch(&[&ours.to_string(), &other.to_string()])];
        let reply = search(
            &history(START, START + 15),
            &RwLock::default(),
            &epochs,
            &params("", true, START + 16, None),
        );
        assert_eq!(starts(&reply), vec![START + 8, START]);
    }

    #[test]
    fn test_a_turn_with_nothing_held_is_left_out() {
        let ours = Pubkey::new_unique();
        let epochs = [epoch(&[&ours.to_string()])];
        let reply = search(
            &history(START + 8, START + 11),
            &RwLock::default(),
            &epochs,
            &params("", true, START + 16, None),
        );
        assert_eq!(starts(&reply), vec![START + 8]);
    }

    #[test]
    fn test_pages_continue_where_the_last_stopped() {
        let ours = Pubkey::new_unique();
        let epochs = [epoch(&[&ours.to_string()])];
        let held = history(START, START + 19);
        let first = search(
            &held,
            &RwLock::default(),
            &epochs,
            &params("", true, START + 20, Some(3)),
        );
        assert_eq!(starts(&first), vec![START + 16, START + 12, START + 8]);
        assert_eq!(first.next, Some(START + 8));
        let rest = search(
            &held,
            &RwLock::default(),
            &epochs,
            &params("", true, START + 8, Some(3)),
        );
        assert_eq!(starts(&rest), vec![START + 4, START]);
        assert_eq!(rest.next, None);
    }

    #[test]
    fn test_each_turn_carries_the_rows_its_certificates_are_read_from() {
        let ours = Pubkey::new_unique();
        let epochs = [epoch(&[&ours.to_string()])];
        let reply = search(
            &history(START, START + 15),
            &RwLock::default(),
            &epochs,
            &params("", true, START + 16, Some(1)),
        );
        let turn = &reply.turns[0];
        assert_eq!(turn.first_slot, START + 4);
        assert_eq!(turn.rows.len(), 12);
        assert!(turn.rows.iter().all(Option::is_some));
    }

    #[test]
    fn test_nothing_is_searched_for_without_text_or_ours() {
        let reply = search(
            &history(START, START + 15),
            &RwLock::default(),
            &[epoch(&["a"])],
            &params("  ", false, START + 16, None),
        );
        assert_eq!(reply, SearchReply::default());
    }

    #[test]
    fn test_a_full_page_fits_the_message_ceiling() {
        let ours = Pubkey::new_unique();
        let epochs = [epoch(&[&ours.to_string()])];
        let mut held = SlotHistory::new(4_096);
        for slot in START..START + 4_000 {
            held.record_worst_case(slot);
        }
        let reply = search(
            &RwLock::new(held),
            &RwLock::default(),
            &epochs,
            &params("", true, START + 4_000, None),
        );
        assert_eq!(reply.turns.len(), MAX_SEARCH_TURNS);
        let encoded = proto::encode_with_id("slot", "search", Some(1), &reply);
        assert!(
            encoded.len() < proto::MAX_MESSAGE / 2,
            "a full page is {} bytes against a {} byte ceiling",
            encoded.len(),
            proto::MAX_MESSAGE
        );
    }
}
