//! Turns in the held history that match a leader's name or key, a slot number, this validator, or
//! conditions on their slots and leaders, answered a page at a time for the schedule page's search,
//! and the same matches summed up, overall and by client.

use {
    crate::{
        collect::EpochInfo,
        history::{
            HAS_BLOCK, HAS_CLOCK, HAS_REPLAYED, HAS_SHREDS, HAS_TIPS, PackedSlot, REWARD_MASK,
            REWARD_NONE, REWARD_PAID, REWARD_UNPAID, SlotHistory, SlotRange,
        },
        slots::SlotLevel,
        validator_info::ValidatorInfoCache,
    },
    agave_votor_messages::reward_certificate::NUM_SLOTS_FOR_REWARD,
    serde::{Deserialize, Serialize},
    solana_clock::Slot,
    solana_leader_schedule::NUM_CONSECUTIVE_LEADER_SLOTS,
    solana_pubkey::Pubkey,
    std::{
        collections::{BTreeSet, HashMap},
        fmt::Write,
        str::FromStr,
        sync::RwLock,
    },
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

/// What gossip and the bank say of a staked node, for conditions on a turn's leader. Current, not
/// as of the turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LeaderTraits {
    pub client: Option<String>,
    pub country: Option<&'static str>,
    /// In lamports.
    pub stake: u64,
    /// Not voting: never, or too far behind the tip.
    pub delinquent: bool,
    /// The oldest last vote among its staked vote accounts.
    pub last_vote: Option<Slot>,
}

/// Every staked node's traits, written by the collector.
pub type LeaderMap = HashMap<Pubkey, LeaderTraits>;

/// A column a condition reads: the leader's, or the slot's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    /// Whether the leader is voting now: `delinquent` or `voting`.
    Leader,
    Client,
    Country,
    Stake,
    Voted,
    LeftOut,
    Transactions,
    BaseFee,
    Priority,
    Tips,
    Duration,
    Shreds,
    Repaired,
    Received,
    Replay,
    Compute,
    BlockFill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Gt,
    Ge,
    Lt,
    Le,
    Eq,
    Is,
    IsNot,
}

/// One row of the page's conditions. Missing figures never match.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Condition {
    pub field: Field,
    pub op: Op,
    /// For a comparison, in the field's own unit: lamports, milliseconds, compute units, percent.
    #[serde(default)]
    pub value: f64,
    /// For `is` and `is_not`: clients, country codes, or `paid`, `unpaid` and `none` for voted.
    #[serde(default)]
    pub values: Vec<String>,
}

/// What the page asks for: text matched as the page matches it, and whether only ours count.
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub ours: bool,
    /// Turns starting below this slot are searched, newest first; with `forward`, turns starting at
    /// or above it, oldest first.
    pub before: Slot,
    /// Searches up from `before`, for scrolling up from a jump.
    #[serde(default)]
    pub forward: bool,
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
    #[serde(default, rename = "where")]
    pub conditions: Vec<Condition>,
    /// A range: turns outside it are passed over, and a scan stops on leaving it.
    #[serde(default)]
    pub from_slot: Option<Slot>,
    #[serde(default)]
    pub to_slot: Option<Slot>,
    #[serde(default)]
    pub from_millis: Option<u64>,
    #[serde(default)]
    pub to_millis: Option<u64>,
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

/// One epoch's leaders, each marked for whether its name or key matches, with its traits.
struct EpochLeaders<'a> {
    epoch: &'a EpochInfo,
    named: Vec<bool>,
    ours: Option<u16>,
    traits: Vec<Option<LeaderTraits>>,
}

/// A turn's leader as a search sees it.
#[derive(Clone, Copy)]
struct LeaderAt<'a> {
    named: bool,
    ours: bool,
    traits: Option<&'a LeaderTraits>,
    block_cost_limit: u64,
}

impl<'a> EpochLeaders<'a> {
    fn new(epoch: &'a EpochInfo, info: &ValidatorInfoCache, map: &LeaderMap, needle: &str) -> Self {
        let traits = epoch
            .leaders
            .iter()
            .map(|key| map.get(&Pubkey::from_str(key).ok()?).cloned())
            .collect();
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
        Self {
            epoch,
            named,
            ours,
            traits,
        }
    }

    /// The turn's leader: whether it matches by name or key, whether it is ours, and its traits;
    /// `None` outside this epoch.
    fn at(&self, slot: Slot) -> Option<LeaderAt<'_>> {
        let index = usize::from(leader_index(self.epoch, slot)?);
        Some(LeaderAt {
            named: self.named.get(index).copied().unwrap_or(false),
            ours: self.ours.map(usize::from) == Some(index),
            traits: self.traits.get(index).and_then(Option::as_ref),
            block_cost_limit: self.epoch.block_cost_limit,
        })
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
/// the filters and conditions a slot must meet.
struct Wanted<'a> {
    needle: String,
    digits: bool,
    ours: bool,
    leaders: Vec<EpochLeaders<'a>>,
    only: &'a [Only],
    slow: Vec<Option<u32>>,
    conditions: &'a [Condition],
}

impl Wanted<'_> {
    fn leader(&self, start: Slot) -> Option<LeaderAt<'_>> {
        self.leaders.iter().find_map(|leaders| leaders.at(start))
    }

    /// Whether the turn is listed: matched as a turn, with one held slot meeting everything.
    /// `text` is scratch for writing slot numbers, kept across calls.
    fn turn(&self, history: &SlotHistory, start: Slot, text: &mut String) -> bool {
        let end = start.saturating_add(SLOTS_PER_TURN.saturating_sub(1));
        // A turn with no row held is not listed, as the page draws none.
        let Some(first) = (start..=end).find(|slot| history.get(*slot).is_some()) else {
            return false;
        };
        let leader = self.leader(start);
        self.turn_matches(first, end, leader, text)
            && (first..=end).any(|slot| self.meets(history, slot, leader))
    }

    /// The parts of a match that are the turn's rather than a slot's: name, key, slot number, ours.
    fn turn_matches(
        &self,
        first: Slot,
        end: Slot,
        leader: Option<LeaderAt<'_>>,
        text: &mut String,
    ) -> bool {
        if self.ours && !leader.is_some_and(|leader| leader.ours) {
            return false;
        }
        self.needle.is_empty()
            || leader.is_some_and(|leader| leader.named)
            // Only digits can be part of a slot number, so other text skips the formatting.
            || (self.digits
                && (first..=end).any(|slot| {
                    text.clear();
                    write!(text, "{slot}").is_ok() && text.contains(&self.needle)
                }))
    }

    /// Whether a held slot meets every filter and condition; with none asked, any held slot does.
    fn meets(&self, history: &SlotHistory, slot: Slot, leader: Option<LeaderAt<'_>>) -> bool {
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
        }) && self
            .conditions
            .iter()
            .all(|condition| holds(condition, history, slot, row, leader))
    }
}

fn holds(
    condition: &Condition,
    history: &SlotHistory,
    slot: Slot,
    row: &PackedSlot,
    leader: Option<LeaderAt<'_>>,
) -> bool {
    let traits = leader.and_then(|leader| leader.traits);
    match condition.field {
        Field::Client => listed(
            condition,
            traits.and_then(|traits| traits.client.as_deref()),
        ),
        Field::Country => listed(condition, traits.and_then(|traits| traits.country)),
        Field::Voted => listed(condition, voted(row)),
        Field::Leader => listed(
            condition,
            traits.map(|traits| {
                if traits.delinquent {
                    "delinquent"
                } else {
                    "voting"
                }
            }),
        ),
        field => figure(field, history, slot, row, leader).is_some_and(|figure| {
            let value = condition.value;
            match condition.op {
                Op::Gt => figure > value,
                Op::Ge => figure >= value,
                Op::Lt => figure < value,
                Op::Le => figure <= value,
                Op::Eq => (figure - value).abs() < f64::EPSILON,
                Op::Is | Op::IsNot => false,
            }
        }),
    }
}

/// `is` and `is_not` against a list; a value not known matches neither.
fn listed(condition: &Condition, value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let named = condition.values.iter().any(|listed| listed == value);
    match condition.op {
        Op::Is => named,
        Op::IsNot => !named,
        _ => false,
    }
}

fn voted(row: &PackedSlot) -> Option<&'static str> {
    match row.flags & REWARD_MASK {
        REWARD_PAID => Some("paid"),
        REWARD_UNPAID => Some("unpaid"),
        REWARD_NONE => Some("none"),
        _ => None,
    }
}

/// Replay's own span, from the block filling to replay finishing, as the page draws it.
fn replay_millis(row: &PackedSlot) -> Option<u64> {
    (row.flags & HAS_REPLAYED != 0 && row.flags & HAS_SHREDS != 0)
        .then(|| u64::from(row.replayed_millis.saturating_sub(row.full_millis)))
}

/// A slot's or its leader's figure in the field's own unit; `None` where not measured.
fn figure(
    field: Field,
    history: &SlotHistory,
    slot: Slot,
    row: &PackedSlot,
    leader: Option<LeaderAt<'_>>,
) -> Option<f64> {
    let block = row.flags & HAS_BLOCK != 0;
    let shreds = row.flags & HAS_SHREDS != 0;
    let whole = match field {
        Field::Stake => leader
            .and_then(|leader| leader.traits)
            .map(|traits| traits.stake),
        Field::LeftOut => matches!(row.flags & REWARD_MASK, REWARD_PAID | REWARD_UNPAID)
            .then_some(u64::from(row.left_out)),
        Field::Transactions => block.then_some(u64::from(row.non_votes)),
        Field::BaseFee => block.then(|| row.fees.saturating_sub(row.priority_fees)),
        Field::Priority => block.then_some(row.priority_fees),
        Field::Tips => (row.flags & HAS_TIPS != 0).then_some(row.tips),
        Field::Duration => duration_millis(history, slot),
        Field::Shreds => shreds.then_some(u64::from(row.shreds)),
        Field::Repaired => shreds.then_some(u64::from(row.repaired)),
        Field::Received => shreds.then_some(u64::from(row.full_millis)),
        Field::Replay => replay_millis(row),
        Field::Compute => block.then_some(u64::from(row.compute)),
        Field::BlockFill => {
            let limit = leader
                .map(|leader| leader.block_cost_limit)
                .filter(|limit| *limit > 0)?;
            return block.then(|| f64::from(row.compute) / limit as f64 * 100.0);
        }
        Field::Leader | Field::Client | Field::Country | Field::Voted => None,
    };
    whole.map(|value| value as f64)
}

/// Where a turn lies against the range asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Below,
    Within,
    Above,
}

fn range_side(params: &SearchParams, history: &SlotHistory, start: Slot) -> Side {
    let end = start.saturating_add(SLOTS_PER_TURN.saturating_sub(1));
    if params.from_slot.is_some_and(|from| end < from) {
        return Side::Below;
    }
    if params.to_slot.is_some_and(|to| start > to) {
        return Side::Above;
    }
    if params.from_millis.is_none() && params.to_millis.is_none() {
        return Side::Within;
    }
    // A turn with no clock is taken as inside; its neighbours place the scan.
    match began_millis(history, start) {
        Some(began) if params.from_millis.is_some_and(|from| began < from) => Side::Below,
        Some(began) if params.to_millis.is_some_and(|to| began > to) => Side::Above,
        _ => Side::Within,
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
/// What a search and a summary share: the matcher, the ring's length and floor, and the slow
/// cut-offs where slow was asked for.
struct Prepared<'a> {
    wanted: Wanted<'a>,
    capacity: u64,
    floor: Slot,
    slow: Option<Vec<Option<u32>>>,
}

fn prepare<'a>(
    history: &RwLock<SlotHistory>,
    info: &RwLock<ValidatorInfoCache>,
    map: &LeaderMap,
    epochs: &'a [EpochInfo],
    params: &'a SearchParams,
) -> Option<Prepared<'a>> {
    let needle = params
        .query
        .trim()
        .chars()
        .take(MAX_QUERY_CHARS)
        .collect::<String>()
        .to_lowercase();
    let leaders = {
        let info = info.read().ok()?;
        epochs
            .iter()
            .map(|epoch| EpochLeaders::new(epoch, &info, map, &needle))
            .collect()
    };
    let capacity = u64::try_from(history.read().ok()?.capacity()).unwrap_or(u64::MAX);
    // Nothing below this can still be in the ring.
    let floor = params.before.saturating_sub(capacity);
    // Measured over the whole ring, which reaches no further than its length past the start, so a
    // jump or the live window above it does not move them.
    let slow = params.only.contains(&Only::Slow).then(|| {
        params.slow.clone().unwrap_or_else(|| {
            slow_cut_offs(history, floor, params.before.saturating_add(capacity))
        })
    });
    Some(Prepared {
        wanted: Wanted {
            digits: !needle.is_empty() && needle.bytes().all(|byte| byte.is_ascii_digit()),
            needle,
            ours: params.ours,
            leaders,
            only: &params.only,
            slow: slow.clone().unwrap_or_default(),
            conditions: &params.conditions,
        },
        capacity,
        floor,
        slow,
    })
}

pub fn search(
    history: &RwLock<SlotHistory>,
    info: &RwLock<ValidatorInfoCache>,
    leaders: &RwLock<LeaderMap>,
    epochs: &[EpochInfo],
    params: &SearchParams,
) -> SearchReply {
    let Ok(map) = leaders.read() else {
        return SearchReply::default();
    };
    let Some(Prepared {
        wanted,
        capacity,
        floor,
        slow,
    }) = prepare(history, info, &map, epochs, params)
    else {
        return SearchReply::default();
    };
    drop(map);
    let limit = params
        .limit
        .unwrap_or(MAX_SEARCH_TURNS)
        .clamp(1, MAX_SEARCH_TURNS);
    let lead = NUM_SLOTS_FOR_REWARD;
    let rows = usize::try_from(lead.saturating_add(SLOTS_PER_TURN)).unwrap_or(usize::MAX);

    // Passed once a turn at or before the time is reached; older turns are older still.
    let mut reached = params.until_millis.is_none() || params.forward;
    // Each turn's first slot in the order searched, as far as the ring can reach either way.
    let ceiling = params.before.saturating_add(capacity);
    let mut turn = params.before.checked_div(SLOTS_PER_TURN).unwrap_or(0);
    let mut next_start = || -> Option<Slot> {
        if params.forward {
            let start = turn.saturating_mul(SLOTS_PER_TURN);
            turn = turn.saturating_add(1);
            (start < ceiling).then_some(start)
        } else {
            turn = turn.checked_sub(1)?;
            let start = turn.saturating_mul(SLOTS_PER_TURN);
            (start >= floor).then_some(start)
        }
    };
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
            let Some(start) = next_start() else {
                return SearchReply {
                    turns: found,
                    next: None,
                    slow,
                };
            };
            match range_side(params, &history, start) {
                Side::Within => {}
                // Every turn further on lies outside too.
                Side::Below if !params.forward => {
                    return SearchReply {
                        turns: found,
                        next: None,
                        slow,
                    };
                }
                Side::Above if params.forward => {
                    return SearchReply {
                        turns: found,
                        next: None,
                        slow,
                    };
                }
                Side::Below | Side::Above => continue,
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
                let next = if params.forward {
                    start.saturating_add(SLOTS_PER_TURN)
                } else {
                    start
                };
                return SearchReply {
                    turns: found,
                    next: Some(next),
                    slow,
                };
            }
        }
    }
}

/// A mean built a slot at a time.
#[derive(Debug, Default, Clone, Copy)]
struct Mean {
    sum: f64,
    count: u64,
}

impl Mean {
    fn add(&mut self, value: Option<u64>) {
        if let Some(value) = value {
            self.sum += value as f64;
            self.count = self.count.saturating_add(1);
        }
    }

    fn get(self) -> Option<f64> {
        (self.count > 0).then(|| self.sum / self.count as f64)
    }
}

#[derive(Debug, Default, Clone)]
struct Sums {
    slots: u64,
    skipped: u64,
    transactions: u64,
    duration: Mean,
    replay: Mean,
    base_fee: Mean,
    priority_fee: Mean,
    tips: Mean,
    compute: Mean,
}

impl Sums {
    fn add(&mut self, history: &SlotHistory, slot: Slot, row: &PackedSlot) {
        let block = row.flags & HAS_BLOCK != 0;
        self.slots = self.slots.saturating_add(1);
        if row.level == SlotLevel::Skipped as u8 {
            self.skipped = self.skipped.saturating_add(1);
        }
        if block {
            self.transactions = self.transactions.saturating_add(u64::from(row.non_votes));
        }
        self.duration.add(duration_millis(history, slot));
        self.replay.add(replay_millis(row));
        self.base_fee
            .add(block.then(|| row.fees.saturating_sub(row.priority_fees)));
        self.priority_fee.add(block.then_some(row.priority_fees));
        self.tips
            .add((row.flags & HAS_TIPS != 0).then_some(row.tips));
        self.compute.add(block.then_some(u64::from(row.compute)));
    }

    fn figures(&self) -> Figures {
        Figures {
            slots: self.slots,
            skipped: self.skipped,
            transactions: self.transactions,
            duration_ms: self.duration.get(),
            replay_ms: self.replay.get(),
            base_fee: self.base_fee.get(),
            priority_fee: self.priority_fee.get(),
            tips: self.tips.get(),
            compute: self.compute.get(),
        }
    }
}

/// The matching slots summed up; means are per slot, over the slots that have the figure, fees in
/// lamports and tips before jito's cut.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Figures {
    pub slots: u64,
    pub skipped: u64,
    pub transactions: u64,
    pub duration_ms: Option<f64>,
    pub replay_ms: Option<f64>,
    pub base_fee: Option<f64>,
    pub priority_fee: Option<f64>,
    pub tips: Option<f64>,
    pub compute: Option<f64>,
}

/// One client's share of the matches; `None` for leaders gossip gives no client for.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClientFigures {
    pub client: Option<String>,
    #[serde(flatten)]
    pub figures: Figures,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HeldFrom {
    pub slot: Slot,
    pub millis: Option<u64>,
}

/// A leader not voting now, which the page tags wherever its turns show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DelinquentLeader {
    pub identity: String,
    pub last_vote: Option<Slot>,
}

/// What the page offers in its client and country lists: those among staked nodes.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Choices {
    pub clients: Vec<String>,
    pub countries: Vec<&'static str>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct SummaryReply {
    /// Turns with a slot that matched.
    pub turns: u64,
    pub figures: Figures,
    /// Most slots first.
    pub clients: Vec<ClientFigures>,
    /// The oldest slot held, so the page can say how far back it reaches.
    pub held_from: Option<HeldFrom>,
    pub choices: Choices,
    pub slow: Option<Vec<Option<u32>>>,
    /// Every staked node not voting now.
    pub delinquent: Vec<DelinquentLeader>,
}

/// The oldest held slot between `floor` and `top`.
fn held_from(history: &RwLock<SlotHistory>, floor: Slot, top: Slot) -> Option<HeldFrom> {
    let span = u64::try_from(TURNS_PER_LOCK)
        .unwrap_or(u64::MAX)
        .saturating_mul(SLOTS_PER_TURN);
    let mut slot = floor;
    while slot < top {
        let history = history.read().ok()?;
        let stop = slot.saturating_add(span).min(top);
        if let Some((held, row)) = (slot..stop).find_map(|at| history.get(at).map(|row| (at, *row)))
        {
            return Some(HeldFrom {
                slot: held,
                millis: (row.flags & HAS_CLOCK != 0).then_some(row.time_millis),
            });
        }
        slot = stop;
    }
    None
}

/// Every turn below `before` that a search would list, summed up overall and by client. With
/// nothing asked, that is everything held.
pub fn summarize(
    history: &RwLock<SlotHistory>,
    info: &RwLock<ValidatorInfoCache>,
    leaders: &RwLock<LeaderMap>,
    epochs: &[EpochInfo],
    params: &SearchParams,
) -> SummaryReply {
    let Ok(map) = leaders.read() else {
        return SummaryReply::default();
    };
    let choices = {
        let clients: BTreeSet<&str> = map
            .values()
            .filter_map(|traits| traits.client.as_deref())
            .collect();
        let countries: BTreeSet<&'static str> =
            map.values().filter_map(|traits| traits.country).collect();
        Choices {
            clients: clients.into_iter().map(str::to_string).collect(),
            countries: countries.into_iter().collect(),
        }
    };
    let mut delinquent: Vec<DelinquentLeader> = map
        .iter()
        .filter(|(_, traits)| traits.delinquent)
        .map(|(identity, traits)| DelinquentLeader {
            identity: identity.to_string(),
            last_vote: traits.last_vote,
        })
        .collect();
    delinquent.sort_by(|a, b| a.identity.cmp(&b.identity));
    let Some(Prepared {
        wanted,
        capacity: _,
        floor,
        slow,
    }) = prepare(history, info, &map, epochs, params)
    else {
        return SummaryReply::default();
    };
    drop(map);

    let mut overall = Sums::default();
    let mut by_client: HashMap<Option<String>, Sums> = HashMap::new();
    let mut turns = 0u64;
    let mut text = String::new();
    let mut turn = params.before.checked_div(SLOTS_PER_TURN).unwrap_or(0);
    'scan: loop {
        let Ok(history) = history.read() else {
            break;
        };
        for _ in 0..TURNS_PER_LOCK {
            let Some(below) = turn.checked_sub(1) else {
                break 'scan;
            };
            turn = below;
            let start = turn.saturating_mul(SLOTS_PER_TURN);
            if start < floor {
                break 'scan;
            }
            match range_side(params, &history, start) {
                Side::Within => {}
                Side::Below => break 'scan,
                Side::Above => continue,
            }
            let end = start.saturating_add(SLOTS_PER_TURN.saturating_sub(1));
            let Some(first) = (start..=end).find(|slot| history.get(*slot).is_some()) else {
                continue;
            };
            let leader = wanted.leader(start);
            if !wanted.turn_matches(first, end, leader, &mut text) {
                continue;
            }
            let client = leader
                .and_then(|leader| leader.traits)
                .and_then(|traits| traits.client.clone());
            let mut matched = false;
            for slot in first..=end {
                let Some(row) = history.get(slot) else {
                    continue;
                };
                if !wanted.meets(&history, slot, leader) {
                    continue;
                }
                matched = true;
                overall.add(&history, slot, row);
                by_client
                    .entry(client.clone())
                    .or_default()
                    .add(&history, slot, row);
            }
            if matched {
                turns = turns.saturating_add(1);
            }
        }
    }

    let mut clients: Vec<ClientFigures> = by_client
        .into_iter()
        .map(|(client, sums)| ClientFigures {
            client,
            figures: sums.figures(),
        })
        .collect();
    clients.sort_by(|a, b| {
        b.figures
            .slots
            .cmp(&a.figures.slots)
            .then_with(|| a.client.cmp(&b.client))
    });
    SummaryReply {
        turns,
        figures: overall.figures(),
        clients,
        held_from: held_from(history, floor, params.before),
        choices,
        slow,
        delinquent,
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
            forward: false,
            only: Vec::new(),
            until_millis: None,
            slow: None,
            conditions: Vec::new(),
            from_slot: None,
            to_slot: None,
            from_millis: None,
            to_millis: None,
        }
    }

    fn condition(field: Field, op: Op, value: f64, values: &[&str]) -> Condition {
        Condition {
            field,
            op,
            value,
            values: values.iter().map(|value| value.to_string()).collect(),
        }
    }

    /// Two leaders taking turns, the first ours, with traits for the second only.
    fn two_leaders() -> ([EpochInfo; 1], RwLock<LeaderMap>) {
        let (ours, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let map = LeaderMap::from([(
            other,
            LeaderTraits {
                client: Some("AgaveBam".into()),
                country: Some("DE"),
                stake: 5_000,
                delinquent: true,
                last_vote: Some(7),
            },
        )]);
        (
            [epoch(&[&ours.to_string(), &other.to_string()])],
            RwLock::new(map),
        )
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
            &RwLock::default(),
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
            &RwLock::default(),
            &epochs,
            &params(&key[..6], false, START + 16, None),
        );
        assert_eq!(starts(&by_key), vec![START + 12, START + 4]);
        let by_slot = search(
            &history(START, START + 15),
            &RwLock::default(),
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
            &RwLock::default(),
            &epochs,
            &params("", true, START + 20, Some(3)),
        );
        assert_eq!(starts(&first), vec![START + 16, START + 12, START + 8]);
        assert_eq!(first.next, Some(START + 8));
        let rest = search(
            &held,
            &RwLock::default(),
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
    fn test_a_forward_search_reads_up_from_its_start_a_page_at_a_time() {
        let epochs = [epoch(&["a"])];
        let held = history(START, START + 19);
        let forward = |before: Slot| SearchParams {
            forward: true,
            ..params("", false, before, Some(2))
        };
        let first = search(
            &held,
            &RwLock::default(),
            &RwLock::default(),
            &epochs,
            &forward(START + 4),
        );
        assert_eq!(starts(&first), vec![START + 4, START + 8], "oldest first");
        assert_eq!(first.next, Some(START + 12));
        let rest = search(
            &held,
            &RwLock::default(),
            &RwLock::default(),
            &epochs,
            &forward(START + 12),
        );
        assert_eq!(starts(&rest), vec![START + 12, START + 16]);
        let past = search(
            &held,
            &RwLock::default(),
            &RwLock::default(),
            &epochs,
            &forward(START + 20),
        );
        assert_eq!(starts(&past), Vec::<Slot>::new());
        assert_eq!(past.next, None, "nothing above the newest held");
    }

    #[test]
    fn test_column_conditions_hold_in_one_slot_with_the_leaders_traits() {
        let held = rows(START, START + 15, |slot, row| {
            if slot.saturating_sub(START) == 13 || slot.saturating_sub(START) == 1 {
                row.non_votes = 50;
            }
        });
        let (epochs, map) = two_leaders();
        let found = |conditions: Vec<Condition>| {
            starts(&search(
                &held,
                &RwLock::default(),
                &map,
                &epochs,
                &SearchParams {
                    conditions,
                    ..params("", false, START + 16, None)
                },
            ))
        };
        assert_eq!(
            found(vec![condition(Field::Transactions, Op::Lt, 100.0, &[])]),
            vec![START + 12, START],
            "a figure in one slot"
        );
        assert_eq!(
            found(vec![condition(
                Field::Client,
                Op::Is,
                0.0,
                &["AgaveBam", "Other"]
            )]),
            vec![START + 12, START + 4],
            "any of the clients listed"
        );
        assert_eq!(
            found(vec![
                condition(Field::Country, Op::Is, 0.0, &["DE"]),
                condition(Field::Transactions, Op::Lt, 100.0, &[]),
            ]),
            vec![START + 12],
            "a leader's trait and a slot's figure together"
        );
        assert_eq!(
            found(vec![condition(Field::Country, Op::IsNot, 0.0, &["DE"])]),
            Vec::<Slot>::new(),
            "a leader with no country known matches neither way"
        );
        assert_eq!(
            found(vec![condition(Field::Stake, Op::Ge, 5_000.0, &[])]),
            vec![START + 12, START + 4]
        );
        assert_eq!(
            found(vec![condition(Field::Leader, Op::Is, 0.0, &["delinquent"])]),
            vec![START + 12, START + 4],
            "a leader not voting now"
        );
    }

    #[test]
    fn test_a_range_keeps_the_turns_inside_it() {
        let reply = search(
            &history(START, START + 15),
            &RwLock::default(),
            &RwLock::default(),
            &[epoch(&["a"])],
            &SearchParams {
                from_slot: Some(START + 5),
                to_slot: Some(START + 10),
                ..params("", false, START + 16, None)
            },
        );
        assert_eq!(starts(&reply), vec![START + 8, START + 4]);
        assert_eq!(reply.next, None, "stopped on leaving the range");
        let by_time = search(
            &history(START, START + 15),
            &RwLock::default(),
            &RwLock::default(),
            &[epoch(&["a"])],
            &SearchParams {
                from_millis: Some(START + 4),
                to_millis: Some(START + 8),
                ..params("", false, START + 16, None)
            },
        );
        assert_eq!(starts(&by_time), vec![START + 8, START + 4]);
    }

    #[test]
    fn test_a_summary_sums_the_matches_overall_and_by_client() {
        let held = rows(START, START + 7, |slot, row| {
            row.fees = 7_000;
            row.priority_fees = 2_000;
            row.compute = 1_000_000;
            if slot == START + 6 {
                row.level = SlotLevel::Skipped as u8;
                row.flags = 0;
            }
        });
        let (epochs, map) = two_leaders();
        let reply = summarize(
            &held,
            &RwLock::default(),
            &map,
            &epochs,
            &params("", false, START + 8, None),
        );
        assert_eq!(reply.turns, 2);
        assert_eq!(reply.figures.slots, 8);
        assert_eq!(reply.figures.skipped, 1);
        assert_eq!(reply.figures.transactions, 7 * 500);
        assert_eq!(reply.figures.base_fee, Some(5_000.0));
        assert_eq!(reply.figures.priority_fee, Some(2_000.0));
        assert_eq!(reply.figures.compute, Some(1_000_000.0));
        assert_eq!(reply.clients.len(), 2);
        let agave = reply
            .clients
            .iter()
            .find(|client| client.client.as_deref() == Some("AgaveBam"))
            .expect("the second leader's client");
        assert_eq!((agave.figures.slots, agave.figures.skipped), (4, 1));
        assert!(
            reply.clients.iter().any(|client| client.client.is_none()),
            "a leader with no traits has its own row"
        );
        assert_eq!(
            reply.held_from,
            Some(HeldFrom {
                slot: START,
                millis: None
            })
        );
        assert_eq!(reply.choices.clients, vec!["AgaveBam".to_string()]);
        assert_eq!(reply.choices.countries, vec!["DE"]);
        assert_eq!(reply.delinquent.len(), 1);
        assert_eq!(reply.delinquent[0].last_vote, Some(7));
    }

    #[test]
    fn test_a_summary_counts_only_the_slots_that_match() {
        let held = rows(START, START + 7, |slot, row| {
            if slot == START + 1 {
                row.non_votes = 50;
            }
        });
        let reply = summarize(
            &held,
            &RwLock::default(),
            &RwLock::default(),
            &[epoch(&["a"])],
            &SearchParams {
                conditions: vec![condition(Field::Transactions, Op::Lt, 100.0, &[])],
                ..params("", false, START + 8, None)
            },
        );
        assert_eq!((reply.turns, reply.figures.slots), (1, 1));
        assert_eq!(reply.figures.transactions, 50);
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
