//! The cluster's spread over the current epoch: each block's compute share and slot time, each
//! leader's skip rate, and transactions per second over runs of slots.

use {
    super::EpochInfo,
    crate::history::{HAS_BLOCK, HAS_CLOCK, HAS_SHREDS, PackedSlot, SlotHistory},
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_leader_schedule::NUM_CONSECUTIVE_LEADER_SLOTS,
    solana_slot_history::Check,
};

/// About a minute of slots; a run's rate is its transactions over its slots' median time.
pub(super) const RUN_SLOTS: u64 = 300;

/// A run counts once nearly all of its slots are held.
const RUN_HELD: u64 = 285;

/// Fewer samples than these leave a figure out.
const MIN_BLOCKS: usize = 20;
const MIN_RUNS: usize = 3;
const MIN_LEADERS: usize = 10;

/// A leader's rate counts from this many settled slots.
const LEADER_SLOTS: u32 = 20;

/// Consecutive blocks further apart than this, as after a restart, give no slot time.
const MAX_SLOT_GAP: u64 = 8;
const MAX_INTERVAL_MILLIS: u64 = 10_000;

/// Held rows starting this far into the epoch mean the figures begin after it did.
const LATE_START_SLOTS: u64 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Spread {
    pub p05: f64,
    pub p50: f64,
    pub p95: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClusterFigures {
    pub epoch: Epoch,
    /// When the first held slot's first shred arrived, where the ring starts after the epoch did.
    pub since_millis: Option<u64>,
    /// Percent of the block limit.
    pub cu_used: Option<Spread>,
    pub slot_time_millis: Option<Spread>,
    /// Percent of each leader's slots, from the root bank's slot history.
    pub skip_rate: Option<Spread>,
    pub tps: Option<Spread>,
    pub failed_tps: Option<Spread>,
}

/// Collected under the history lock; the percentiles are taken after it is released.
#[derive(Debug, Default)]
pub(super) struct Samples {
    epoch: Epoch,
    first_held: Option<Slot>,
    since_millis: Option<u64>,
    /// Hundredths of a percent.
    cu: Vec<u32>,
    slot_millis: Vec<u32>,
    /// Transactions and failed transactions per full run.
    runs: Vec<(u64, u64)>,
    /// Hundredths of a percent.
    skip: Vec<u32>,
}

/// Slots from the epoch's start to `newest` for the blocks, to `root` for skips and runs.
pub(super) fn samples(
    history: &SlotHistory,
    epoch: &EpochInfo,
    newest: Slot,
    root: Slot,
    check: impl Fn(Slot) -> Check,
) -> Samples {
    let last = newest.min(epoch.end_slot);
    let held = usize::try_from(last.saturating_sub(epoch.start_slot)).unwrap_or(0);
    let mut samples = Samples {
        epoch: epoch.epoch,
        cu: Vec::with_capacity(held),
        slot_millis: Vec::with_capacity(held),
        ..Samples::default()
    };
    let mut previous_full: Option<(Slot, u64)> = None;
    let mut run = RunTally::default();
    for slot in epoch.start_slot..=last {
        let row = history.get(slot);
        if let Some(row) = row {
            note_block(&mut samples, epoch, slot, row, &mut previous_full);
        }
        if slot <= root {
            run.note(row);
            let run_end = slot.checked_sub(epoch.start_slot).is_some_and(|index| {
                index.checked_rem(RUN_SLOTS) == Some(RUN_SLOTS.saturating_sub(1))
            });
            if run_end {
                if run.held >= RUN_HELD {
                    samples.runs.push((run.transactions, run.failed));
                }
                run = RunTally::default();
            }
        }
    }
    samples.skip = leader_skips(epoch, root, check);
    samples
}

fn note_block(
    samples: &mut Samples,
    epoch: &EpochInfo,
    slot: Slot,
    row: &PackedSlot,
    previous_full: &mut Option<(Slot, u64)>,
) {
    let first_held = *samples.first_held.get_or_insert(slot);
    if samples.since_millis.is_none()
        && row.flags & HAS_CLOCK != 0
        && first_held > epoch.start_slot.saturating_add(LATE_START_SLOTS)
    {
        samples.since_millis = Some(row.time_millis);
    }
    if row.flags & HAS_BLOCK != 0 && epoch.block_cost_limit > 0 {
        let share = u64::from(row.compute)
            .saturating_mul(10_000)
            .checked_div(epoch.block_cost_limit)
            .unwrap_or(0);
        samples.cu.push(u32::try_from(share).unwrap_or(u32::MAX));
    }
    if row.flags & HAS_CLOCK != 0 && row.flags & HAS_SHREDS != 0 {
        let full = row.time_millis.saturating_add(u64::from(row.full_millis));
        if let Some((before, before_full)) = *previous_full
            && slot.saturating_sub(before) <= MAX_SLOT_GAP
            && let Some(interval) = full.checked_sub(before_full)
            && interval > 0
            && interval < MAX_INTERVAL_MILLIS
        {
            samples
                .slot_millis
                .push(u32::try_from(interval).unwrap_or(u32::MAX));
        }
        *previous_full = Some((slot, full));
    }
}

#[derive(Debug, Default)]
struct RunTally {
    held: u64,
    transactions: u64,
    failed: u64,
}

impl RunTally {
    fn note(&mut self, row: Option<&PackedSlot>) {
        let Some(row) = row else {
            return;
        };
        self.held = self.held.saturating_add(1);
        if row.flags & HAS_BLOCK != 0 {
            self.transactions = self
                .transactions
                .saturating_add(u64::from(row.votes))
                .saturating_add(u64::from(row.non_votes));
            self.failed = self.failed.saturating_add(u64::from(row.failed));
        }
    }
}

/// Each leader's skipped share of its settled slots, for leaders with enough of them.
fn leader_skips(epoch: &EpochInfo, root: Slot, check: impl Fn(Slot) -> Check) -> Vec<u32> {
    let stride = NUM_CONSECUTIVE_LEADER_SLOTS.get() as u64;
    let mut tallies = vec![(0u32, 0u32); epoch.leaders.len()];
    for slot in epoch.start_slot..=root.min(epoch.end_slot) {
        let made = match check(slot) {
            Check::Found => true,
            Check::NotFound => false,
            Check::TooOld | Check::Future => continue,
        };
        let turn = slot
            .saturating_sub(epoch.start_slot)
            .checked_div(stride)
            .unwrap_or(0);
        let Some(leader) = usize::try_from(turn)
            .ok()
            .and_then(|turn| epoch.turns.get(turn))
        else {
            continue;
        };
        if let Some((slots, skipped)) = tallies.get_mut(usize::from(*leader)) {
            *slots = slots.saturating_add(1);
            if !made {
                *skipped = skipped.saturating_add(1);
            }
        }
    }
    tallies
        .into_iter()
        .filter(|(slots, _)| *slots >= LEADER_SLOTS)
        .map(|(slots, skipped)| {
            skipped
                .saturating_mul(10_000)
                .checked_div(slots)
                .unwrap_or(0)
        })
        .collect()
}

impl Samples {
    pub(super) fn figures(mut self) -> ClusterFigures {
        let hundredths = |value: u32| f64::from(value) / 100.0;
        let slot_time = spread(&mut self.slot_millis, MIN_BLOCKS, f64::from);
        // A run's span is taken as its slots at the epoch's median slot time, which a node
        // catching up does not compress the way its own arrival times are.
        let run_seconds = slot_time.map(|slot| slot.p50 * RUN_SLOTS as f64 / 1_000.0);
        let rate = |runs: &mut Vec<u64>| {
            run_seconds
                .filter(|seconds| *seconds > 0.0)
                .and_then(|seconds| spread(runs, MIN_RUNS, |count| count as f64 / seconds))
        };
        let mut transactions: Vec<u64> = self.runs.iter().map(|(all, _)| *all).collect();
        let mut failed: Vec<u64> = self.runs.iter().map(|(_, failed)| *failed).collect();
        ClusterFigures {
            epoch: self.epoch,
            since_millis: self.since_millis,
            cu_used: spread(&mut self.cu, MIN_BLOCKS, hundredths),
            slot_time_millis: slot_time,
            skip_rate: spread(&mut self.skip, MIN_LEADERS, hundredths),
            tps: rate(&mut transactions),
            failed_tps: rate(&mut failed),
        }
    }
}

/// The 5th, 50th and 95th by nearest rank, each found without a full sort.
fn spread<T: Copy + Ord>(values: &mut [T], min: usize, unit: impl Fn(T) -> f64) -> Option<Spread> {
    if values.len() < min || values.is_empty() {
        return None;
    }
    let mut at = |percent: usize| {
        let index = values
            .len()
            .saturating_mul(percent)
            .checked_div(100)
            .unwrap_or(0)
            .min(values.len().saturating_sub(1));
        *values.select_nth_unstable(index).1
    };
    Some(Spread {
        p05: unit(at(5)),
        p50: unit(at(50)),
        p95: unit(at(95)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epoch(leaders: usize) -> EpochInfo {
        let slots = 4 * RUN_SLOTS;
        EpochInfo {
            epoch: 7,
            start_slot: 1_000,
            end_slot: slots.saturating_add(999),
            slots_in_epoch: slots,
            my_leader_slots: Vec::new(),
            leaders: (0..leaders).map(|index| format!("leader{index}")).collect(),
            turns: (0..slots / 4)
                .map(|turn| u16::try_from(turn.checked_rem(leaders as u64).unwrap()).unwrap())
                .collect(),
            block_cost_limit: 60_000_000,
            account_cost_limit: 12_000_000,
        }
    }

    /// A block every slot, filling 400 ms after the last, with `transactions` of which a tenth failed.
    fn filled(epoch: &EpochInfo, transactions: u64) -> SlotHistory {
        let mut history = SlotHistory::new(8_192);
        for slot in epoch.start_slot..=epoch.end_slot {
            history.record_test_row(slot, |row| {
                row.flags = HAS_BLOCK | HAS_CLOCK | HAS_SHREDS;
                row.non_votes = u32::try_from(transactions).unwrap();
                row.failed = u32::try_from(transactions / 10).unwrap();
                row.compute = 30_000_000;
                row.time_millis = slot.saturating_sub(epoch.start_slot).saturating_mul(400);
                row.full_millis = 100;
            });
        }
        history
    }

    #[test]
    fn test_figures_read_each_block_and_run() {
        let epoch = epoch(16);
        let history = filled(&epoch, 800);
        let figures = samples(&history, &epoch, epoch.end_slot, epoch.end_slot, |_| {
            Check::Found
        })
        .figures();
        assert_eq!(figures.since_millis, None);
        assert_eq!(figures.cu_used.unwrap().p50, 50.0);
        assert_eq!(figures.slot_time_millis.unwrap().p50, 400.0);
        // 800 a slot at 400 ms, and a tenth of them failed.
        assert_eq!(figures.tps.unwrap().p50, 2_000.0);
        assert_eq!(figures.failed_tps.unwrap().p95, 200.0);
        assert_eq!(figures.skip_rate.unwrap().p95, 0.0);
    }

    #[test]
    fn test_skips_are_per_leader() {
        let epoch = epoch(16);
        let history = filled(&epoch, 1);
        // Leader 3 misses every slot, so one leader in sixteen sits at 100%.
        let skipped = |slot: Slot| slot.saturating_sub(epoch.start_slot) / 4 % 16 == 3;
        let figures = samples(&history, &epoch, epoch.end_slot, epoch.end_slot, |slot| {
            if skipped(slot) {
                Check::NotFound
            } else {
                Check::Found
            }
        })
        .figures();
        let skip = figures.skip_rate.unwrap();
        assert_eq!((skip.p05, skip.p50, skip.p95), (0.0, 0.0, 100.0));
    }

    #[test]
    fn test_a_late_start_is_dated_and_an_unsettled_run_left_out() {
        let epoch = epoch(16);
        let mut history = SlotHistory::new(8_192);
        let late = epoch.start_slot.saturating_add(RUN_SLOTS + 20);
        for slot in late..=epoch.end_slot {
            history.record_test_row(slot, |row| {
                row.flags = HAS_BLOCK | HAS_CLOCK | HAS_SHREDS;
                row.non_votes = 10;
                row.time_millis = slot
                    .saturating_sub(late)
                    .saturating_mul(400)
                    .saturating_add(5_000);
                row.full_millis = 100;
            });
        }
        // The root ends the third run: the first holds nothing, the second starts too late to count.
        let root = epoch.start_slot.saturating_add(3 * RUN_SLOTS - 1);
        let figures = samples(&history, &epoch, epoch.end_slot, root, |_| Check::Found);
        assert_eq!(figures.since_millis, Some(5_000));
        assert_eq!(figures.runs.len(), 1);
    }

    #[test]
    fn test_too_few_samples_give_no_figure() {
        let mut values = vec![1u32; MIN_BLOCKS - 1];
        assert_eq!(spread(&mut values, MIN_BLOCKS, f64::from), None);
        let mut values: Vec<u32> = (1..=100).collect();
        let spread = spread(&mut values, MIN_BLOCKS, f64::from).unwrap();
        assert_eq!((spread.p05, spread.p50, spread.p95), (6.0, 51.0, 96.0));
    }
}
