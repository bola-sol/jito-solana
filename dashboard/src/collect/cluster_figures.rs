//! Each leader's skip rate over the current epoch, as a spread across the leaders.

use {
    super::EpochInfo,
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_leader_schedule::NUM_CONSECUTIVE_LEADER_SLOTS,
    solana_slot_history::Check,
};

/// Fewer leaders than these leave the figure out.
const MIN_LEADERS: usize = 10;

/// A leader's rate counts from this many settled slots.
const LEADER_SLOTS: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Spread {
    pub p05: f64,
    pub p50: f64,
    pub p95: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClusterFigures {
    pub epoch: Epoch,
    /// Percent of each leader's slots, from the root bank's slot history.
    pub skip_rate: Option<Spread>,
}

/// The epoch's settled slots up to `root`, each checked against the root bank's slot history.
pub(super) fn figures(
    epoch: &EpochInfo,
    root: Slot,
    check: impl Fn(Slot) -> Check,
) -> ClusterFigures {
    let mut skips = leader_skips(epoch, root, check);
    ClusterFigures {
        epoch: epoch.epoch,
        skip_rate: spread(&mut skips, MIN_LEADERS, |value| f64::from(value) / 100.0),
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
        let slots: u64 = 1_200;
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

    #[test]
    fn test_skips_are_per_leader() {
        let epoch = epoch(16);
        // Leader 3 misses every slot, so one leader in sixteen sits at 100%.
        let skipped = |slot: Slot| slot.saturating_sub(epoch.start_slot) / 4 % 16 == 3;
        let figures = figures(&epoch, epoch.end_slot, |slot| {
            if skipped(slot) {
                Check::NotFound
            } else {
                Check::Found
            }
        });
        let skip = figures.skip_rate.unwrap();
        assert_eq!((skip.p05, skip.p50, skip.p95), (0.0, 0.0, 100.0));
    }

    #[test]
    fn test_too_few_samples_give_no_figure() {
        let mut values = vec![1u32; MIN_LEADERS - 1];
        assert_eq!(spread(&mut values, MIN_LEADERS, f64::from), None);
        let mut values: Vec<u32> = (1..=100).collect();
        let spread = spread(&mut values, MIN_LEADERS, f64::from).unwrap();
        assert_eq!((spread.p05, spread.p50, spread.p95), (6.0, 51.0, 96.0));
    }
}
