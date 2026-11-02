//! Turns in the held history that match a leader's name or key, a slot number, this validator, or
//! a condition on their slots, answered a page at a time for the schedule page's search.

use {
    crate::{
        collect::EpochInfo,
        history::{
            HAS_BLOCK, HAS_CLOCK, HAS_SHREDS, HAS_TIPS, PackedSlot, REWARD_MASK, REWARD_UNPAID,
            SlotHistory, SlotRange,
        },
        slots::SlotLevel,
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

/// Fewer non-vote transactions than this is few.
pub const FEW_TRANSACTIONS: u32 = 100;

/// How far back a slot's duration looks for an earlier block that filled, as the page does.
const FULL_REACH: u64 = 64;

/// Slower than this share of the slots at the same place in the turn is slow.
const SLOW_PERCENT: u64 = 95;

/// Fewer durations than this at a place gives that place no cut-off.
const SLOW_SAMPLES: u64 = 20;

/// Longer durations share the last bucket.
const MAX_DURATION_MILLIS: usize = 10_000;

/// A condition on a slot, one per filter on the page; a turn is listed when one of its slots meets
/// every one asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Only {
    Skipped,
    /// Slower than the cut-off for its place in the turn.
    Slow,
    /// The reward certificate was written without our vote.
    LeftOut,
    FewTransactions,
    /// Tips were read, and were nought.
    NoTips,
}

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
    #[serde(default)]
    pub only: Vec<Only>,
    /// Turns that began after this are passed over, for a jump to a time.
    #[serde(default)]
    pub until_millis: Option<u64>,
    /// The slow cut-offs a first page answered with, so later pages keep them.
    #[serde(default)]
    pub slow: Option<Vec<Option<u32>>>,
}

/// A page of matching turns, newest first.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct SearchReply {
    /// Each matching turn's rows, from the slot whose certificate its first row shows.
    pub turns: Vec<SlotRange>,
    /// Where to search below next; `None` once the history is read to its end.
    pub next: Option<Slot>,
    /// Each place in the turn's slow cut-off in milliseconds, first slot first, where slow was
    /// asked for.
    pub slow: Option<Vec<Option<u32>>>,
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

/// When a row's block became full here, as the page reads it.
fn full_at(row: &PackedSlot) -> Option<u64> {
    (row.flags & HAS_CLOCK != 0 && row.flags & HAS_SHREDS != 0)
        .then(|| row.time_millis.saturating_add(u64::from(row.full_millis)))
}

/// From the nearest earlier block to fill to this one filling, as the page measures it.
fn duration_millis(history: &SlotHistory, slot: Slot) -> Option<u64> {
    let full = full_at(history.get(slot)?)?;
    let previous =
        (1..=FULL_REACH).find_map(|back| full_at(history.get(slot.checked_sub(back)?)?))?;
    full.checked_sub(previous)
}

fn place(slot: Slot) -> usize {
    usize::try_from(slot.checked_rem(SLOTS_PER_TURN).unwrap_or(0)).unwrap_or(0)
}

/// The duration at or under which `SLOW_PERCENT` of the counted slots fall.
fn cut_off(counts: &[u32]) -> Option<u32> {
    let total = counts.iter().map(|count| u64::from(*count)).sum::<u64>();
    if total < SLOW_SAMPLES {
        return None;
    }
    let wanted = total.saturating_mul(SLOW_PERCENT).div_ceil(100);
    let mut seen = 0u64;
    counts.iter().enumerate().find_map(|(millis, count)| {
        seen = seen.saturating_add(u64::from(*count));
        (seen >= wanted)
            .then(|| u32::try_from(millis).ok())
            .flatten()
    })
}

/// Each place in the turn's cut-off, from every slot held between `floor` and `top`.
fn slow_cut_offs(history: &RwLock<SlotHistory>, floor: Slot, top: Slot) -> Vec<Option<u32>> {
    let places = usize::try_from(SLOTS_PER_TURN).unwrap_or(1);
    let mut counts = vec![vec![0u32; MAX_DURATION_MILLIS.saturating_add(1)]; places];
    let span = u64::try_from(TURNS_PER_LOCK)
        .unwrap_or(u64::MAX)
        .saturating_mul(SLOTS_PER_TURN);
    // The last block to fill, carried across the slots so each is read once.
    let mut last: Option<(Slot, u64)> = None;
    let mut slot = floor;
    while slot < top {
        let Ok(history) = history.read() else {
            break;
        };
        let stop = slot.saturating_add(span).min(top);
        for at in slot..stop {
            let Some(full) = history.get(at).and_then(full_at) else {
                continue;
            };
            let gap = last
                .filter(|(was, _)| at.saturating_sub(*was) <= FULL_REACH)
                .and_then(|(_, millis)| full.checked_sub(millis));
            if let Some(gap) = gap {
                let bucket = usize::try_from(gap)
                    .unwrap_or(MAX_DURATION_MILLIS)
                    .min(MAX_DURATION_MILLIS);
                if let Some(count) = counts
                    .get_mut(place(at))
                    .and_then(|at_place| at_place.get_mut(bucket))
                {
                    *count = count.saturating_add(1);
                }
            }
            last = Some((at, full));
        }
        slot = stop;
    }
    counts.iter().map(|counted| cut_off(counted)).collect()
}

/// What a search is for: text as the page matches it, lower-cased, whether only ours count, and
/// the conditions a slot must meet.
struct Wanted<'a> {
    needle: String,
    digits: bool,
    ours: bool,
    leaders: Vec<EpochLeaders<'a>>,
    only: &'a [Only],
    slow: Vec<Option<u32>>,
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
        let matched = self.needle.is_empty()
            || leader.is_some_and(|(named, _)| named)
            // Only digits can be part of a slot number, so other text skips the formatting.
            || (self.digits
                && (first..=end).any(|slot| {
                    text.clear();
                    write!(text, "{slot}").is_ok() && text.contains(&self.needle)
                }));
        matched && (self.only.is_empty() || (first..=end).any(|slot| self.meets(history, slot)))
    }

    fn meets(&self, history: &SlotHistory, slot: Slot) -> bool {
        let Some(row) = history.get(slot) else {
            return false;
        };
        self.only.iter().all(|only| match only {
            Only::Skipped => row.level == SlotLevel::Skipped as u8,
            Only::Slow => self
                .slow
                .get(place(slot))
                .copied()
                .flatten()
                .zip(duration_millis(history, slot))
                .is_some_and(|(limit, millis)| millis > u64::from(limit)),
            Only::LeftOut => row.flags & REWARD_MASK == REWARD_UNPAID,
            Only::FewTransactions => row.flags & HAS_BLOCK != 0 && row.non_votes < FEW_TRANSACTIONS,
            Only::NoTips => row.flags & HAS_TIPS != 0 && row.tips == 0,
        })
    }
}

/// When the turn's first held slot with a clock began.
fn began_millis(history: &SlotHistory, start: Slot) -> Option<u64> {
    (start..start.saturating_add(SLOTS_PER_TURN)).find_map(|slot| {
        history
            .get(slot)
            .filter(|row| row.flags & HAS_CLOCK != 0)
            .map(|row| row.time_millis)
    })
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
    let leaders = match info.read() {
        Ok(info) => epochs
            .iter()
            .map(|epoch| EpochLeaders::new(epoch, &info, &needle))
            .collect(),
        Err(_) => return SearchReply::default(),
    };
    let capacity = match history.read() {
        Ok(history) => u64::try_from(history.capacity()).unwrap_or(u64::MAX),
        Err(_) => return SearchReply::default(),
    };
    // Nothing below this can still be in the ring.
    let floor = params.before.saturating_sub(capacity);
    // Measured over the whole ring, which reaches no further than its length past the start, so a
    // jump or the live window above it does not move them.
    let slow = params.only.contains(&Only::Slow).then(|| {
        params.slow.clone().unwrap_or_else(|| {
            slow_cut_offs(history, floor, params.before.saturating_add(capacity))
        })
    });
    let wanted = Wanted {
        digits: !needle.is_empty() && needle.bytes().all(|byte| byte.is_ascii_digit()),
        needle,
        ours: params.ours,
        leaders,
        only: &params.only,
        slow: slow.clone().unwrap_or_default(),
    };
    let limit = params
        .limit
        .unwrap_or(MAX_SEARCH_TURNS)
        .clamp(1, MAX_SEARCH_TURNS);
    let lead = NUM_SLOTS_FOR_REWARD;
    let rows = usize::try_from(lead.saturating_add(SLOTS_PER_TURN)).unwrap_or(usize::MAX);

    // Passed once a turn at or before the time is reached; older turns are older still.
    let mut reached = params.until_millis.is_none();
    let mut turn = params.before.checked_div(SLOTS_PER_TURN).unwrap_or(0);
    let mut found = Vec::new();
    let mut text = String::new();
    loop {
        let Ok(history) = history.read() else {
            return SearchReply {
                turns: found,
                next: None,
                slow,
            };
        };
        for _ in 0..TURNS_PER_LOCK {
            let Some(below) = turn.checked_sub(1) else {
                return SearchReply {
                    turns: found,
                    next: None,
                    slow,
                };
            };
            turn = below;
            let start = turn.saturating_mul(SLOTS_PER_TURN);
            if start < floor {
                return SearchReply {
                    turns: found,
                    next: None,
                    slow,
                };
            }
            if !reached {
                match (began_millis(&history, start), params.until_millis) {
                    (Some(began), Some(until)) if began <= until => reached = true,
                    _ => continue,
                }
            }
            if !wanted.turn(&history, start, &mut text) {
                continue;
            }
            found.push(history.range(start.saturating_sub(lead), rows));
            if found.len() >= limit {
                return SearchReply {
                    turns: found,
                    next: Some(start),
                    slow,
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
            0,
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
            only: Vec::new(),
            until_millis: None,
            slow: None,
        }
    }

    fn only(conditions: &[Only], before: Slot) -> SearchParams {
        SearchParams {
            only: conditions.to_vec(),
            ..params("", false, before, None)
        }
    }

    /// Every slot an ordinary block with tips and our vote paid, then `fill` on each.
    fn rows(from: Slot, to: Slot, fill: impl Fn(Slot, &mut PackedSlot)) -> RwLock<SlotHistory> {
        let mut history = SlotHistory::new(4_096);
        for slot in from..=to {
            history.record_test_row(slot, |row| {
                row.level = SlotLevel::Finalized as u8;
                row.flags = HAS_BLOCK | HAS_TIPS | crate::history::REWARD_PAID;
                row.non_votes = 500;
                row.tips = 10;
                fill(slot, row);
            });
        }
        RwLock::new(history)
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
    fn test_a_search_for_nothing_lists_every_turn_for_a_jump() {
        let reply = search(
            &history(START, START + 15),
            &RwLock::default(),
            &[epoch(&["a"])],
            &params("  ", false, START + 12, None),
        );
        assert_eq!(starts(&reply), vec![START + 8, START + 4, START]);
        assert_eq!(reply.slow, None, "slow was not asked for");
    }

    #[test]
    fn test_each_condition_keeps_the_turns_with_a_slot_meeting_it() {
        let held = rows(START, START + 15, |slot, row| {
            match slot.saturating_sub(START) {
                1 => row.tips = 0,
                5 => {
                    row.level = SlotLevel::Skipped as u8;
                    row.flags = 0;
                }
                9 => row.non_votes = 99,
                13 => row.flags = HAS_BLOCK | HAS_TIPS | REWARD_UNPAID,
                _ => {}
            }
        });
        let epochs = [epoch(&["a"])];
        let found = |conditions: &[Only]| {
            starts(&search(
                &held,
                &RwLock::default(),
                &epochs,
                &only(conditions, START + 16),
            ))
        };
        assert_eq!(found(&[Only::NoTips]), vec![START]);
        assert_eq!(found(&[Only::Skipped]), vec![START + 4]);
        assert_eq!(found(&[Only::FewTransactions]), vec![START + 8]);
        assert_eq!(found(&[Only::LeftOut]), vec![START + 12]);
    }

    #[test]
    fn test_conditions_together_must_meet_in_one_slot() {
        let held = rows(START, START + 7, |slot, row| {
            match slot.saturating_sub(START) {
                1 => row.non_votes = 5,
                2 => row.flags = HAS_BLOCK | HAS_TIPS | REWARD_UNPAID,
                5 => {
                    row.non_votes = 5;
                    row.flags = HAS_BLOCK | HAS_TIPS | REWARD_UNPAID;
                }
                _ => {}
            }
        });
        let reply = search(
            &held,
            &RwLock::default(),
            &[epoch(&["a"])],
            &only(&[Only::FewTransactions, Only::LeftOut], START + 8),
        );
        assert_eq!(starts(&reply), vec![START + 4]);
    }

    #[test]
    fn test_slow_is_measured_against_the_same_place_in_the_turn() {
        // First slots take 300 ms and the rest 200, but for one of each.
        let duration = |slot: Slot| match (slot.saturating_sub(START), place(slot)) {
            (41, _) => 260,
            (200, _) => 500,
            (_, 0) => 300,
            _ => 200,
        };
        let mut history = SlotHistory::new(4_096);
        let mut time = 0;
        for slot in START..START + 400 {
            time = u64::saturating_add(time, duration(slot));
            history.record_test_row(slot, |row| {
                row.flags = HAS_CLOCK | HAS_SHREDS;
                row.time_millis = time;
            });
        }
        let held = RwLock::new(history);
        let epochs = [epoch(&["a"])];
        let first = search(
            &held,
            &RwLock::default(),
            &epochs,
            &only(&[Only::Slow], START + 400),
        );
        assert_eq!(
            first.slow,
            Some(vec![Some(300), Some(200), Some(200), Some(200)])
        );
        assert_eq!(starts(&first), vec![START + 200, START + 40]);
        // Starting lower, as a jump does, measures the same slots.
        let jumped = search(
            &held,
            &RwLock::default(),
            &epochs,
            &only(&[Only::Slow], START + 100),
        );
        assert_eq!(jumped.slow, first.slow);
        assert_eq!(starts(&jumped), vec![START + 40]);
        // A later page keeps the first page's cut-offs rather than measuring again.
        let later = search(
            &held,
            &RwLock::default(),
            &epochs,
            &SearchParams {
                slow: Some(vec![Some(400), Some(300), Some(300), Some(300)]),
                ..only(&[Only::Slow], START + 200)
            },
        );
        assert_eq!(starts(&later), Vec::<Slot>::new());
        assert_eq!(
            later.slow,
            Some(vec![Some(400), Some(300), Some(300), Some(300)])
        );
    }

    #[test]
    fn test_a_place_with_few_durations_has_no_cut_off() {
        assert_eq!(cut_off(&[0, 19]), None);
        assert_eq!(cut_off(&[0, 19, 1]), Some(1));
        assert_eq!(cut_off(&[0, 18, 2]), Some(2));
    }

    #[test]
    fn test_a_jump_to_a_time_starts_at_the_turn_begun_by_then() {
        let epochs = [epoch(&["a"])];
        let reply = search(
            &history(START, START + 15),
            &RwLock::default(),
            &epochs,
            &SearchParams {
                until_millis: Some(START + 9),
                ..params("", false, START + 16, None)
            },
        );
        assert_eq!(starts(&reply), vec![START + 8, START + 4, START]);
    }

    #[test]
    fn test_conditions_are_read_by_their_page_names() {
        let params: SearchParams = serde_json::from_str(
            r#"{"before":8,"only":["skipped","slow","left_out","few_transactions","no_tips"]}"#,
        )
        .expect("parses");
        assert_eq!(
            params.only,
            vec![
                Only::Skipped,
                Only::Slow,
                Only::LeftOut,
                Only::FewTransactions,
                Only::NoTips
            ]
        );
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
