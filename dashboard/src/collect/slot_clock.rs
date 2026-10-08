//! When each slot's first shred arrived, what that says the cluster's slot time is, and when the
//! epoch will end.

use {
    solana_clock::{Clock, Epoch, Slot},
    std::{
        collections::VecDeque,
        ops::RangeInclusive,
        time::{Duration, SystemTime},
    },
};

/// In slots rather than time, so a stall does not thin the window.
const SLOT_TIME_WINDOW_SLOTS: usize = 750;

const SLOT_READOUT_SPAN_MS: u64 = 60_000;

const CAUGHT_UP_SLOT_DISTANCE: u64 = 4;

/// Samples the window must hold before the distance is believed: a validator just loaded from a
/// snapshot sits at zero distance before replaying anything.
const CAUGHT_UP_MIN_SAMPLES: usize = 64;

/// Skipped past the transition, whose interval is part replay burst and part cluster.
const CAUGHT_UP_MARGIN_SLOTS: u64 = 4;

/// Slots an epoch must have run before its own rate is believed; below this the cluster clock's
/// whole-second steps are noisier than the sliding window.
const EPOCH_RATE_MIN_ELAPSED_SLOTS: u64 = 4_000;

const EPOCH_END_DRIFT_DIVISOR: u32 = 64;

const MAX_SLOTS_TIMED_PER_TICK: u64 = 512;

pub(crate) const CATCH_UP_SLOTS_PER_SECOND: f64 = 20.0;

#[derive(Debug, Default)]
pub(super) struct SlotClock {
    /// Advances past skipped slots, which never carry a timestamp.
    timed_to: Option<Slot>,
    last_shred_time: Option<(Slot, u64)>,
    window: VecDeque<(Slot, u64)>,
    caught_up_at: Option<Slot>,
    replayed_behind: bool,
    /// Held so the readout does not chase its own estimate.
    epoch_end: Option<(Epoch, SystemTime)>,
}

impl SlotClock {
    /// The slots not yet timed up to `up_to`, at most `MAX_SLOTS_TIMED_PER_TICK` of them.
    pub(super) fn slots_to_time(&mut self, up_to: Slot) -> RangeInclusive<Slot> {
        let from = match self.timed_to {
            None => up_to,
            Some(timed_to) => timed_to.saturating_add(1),
        };
        let from = from.max(up_to.saturating_sub(MAX_SLOTS_TIMED_PER_TICK));
        if from <= up_to {
            self.timed_to = Some(up_to);
        }
        from..=up_to
    }

    /// Returns the milliseconds since the last slot that had a first shred, if it was earlier.
    pub(super) fn record(&mut self, slot: Slot, arrived: u64) -> Option<u64> {
        let elapsed = self
            .last_shred_time
            .filter(|(previous_slot, _)| slot > *previous_slot)
            .map(|(_, previous_arrival)| arrived.saturating_sub(previous_arrival));
        self.last_shred_time = Some((slot, arrived));
        self.window.push_back((slot, arrived));
        // Skipped slots never enter the window. The mean divides by slot span, not
        // sample count, so they are still accounted for.
        while self.window.len() > SLOT_TIME_WINDOW_SLOTS {
            self.window.pop_front();
        }
        elapsed
    }

    /// Never cleared: falling behind later is real.
    pub(super) fn mark_caught_up(&mut self, highest_slot: Slot, completed: Slot) {
        if self.caught_up_at.is_some() {
            return;
        }
        if highest_slot.saturating_sub(completed) > CAUGHT_UP_SLOT_DISTANCE {
            self.replayed_behind = true;
            return;
        }
        if self.window.len() < CAUGHT_UP_MIN_SAMPLES {
            return;
        }

        let from = completed.saturating_add(CAUGHT_UP_MARGIN_SLOTS);
        self.caught_up_at = Some(from);
        if self.replayed_behind {
            self.window.retain(|(slot, _)| *slot >= from);
        }
        log::info!("dashboard: caught up with the cluster, timing slots from {from}");
    }

    pub(super) fn observed_nanos(&self) -> Option<u64> {
        windowed_mean_nanos(&self.window, SLOT_READOUT_SPAN_MS)
    }

    /// Slot duration on the best evidence: the arrival window once caught up,
    /// the epoch's own clock before that, the configured duration before either.
    pub(super) fn slot_nanos(
        &self,
        clock: &Clock,
        start_slot: Slot,
        completed: Slot,
        configured: u64,
    ) -> u64 {
        let window = self
            .caught_up_at
            .and_then(|_| windowed_mean_nanos(&self.window, u64::MAX));
        best_slot_nanos(
            window,
            epoch_anchored_nanos(clock, start_slot, completed),
            configured,
        )
    }

    /// Holds the last estimate of `epoch`'s end until a new one drifts past the allowance.
    pub(super) fn epoch_end(
        &mut self,
        epoch: Epoch,
        estimate: SystemTime,
        now: SystemTime,
    ) -> SystemTime {
        let held = self
            .epoch_end
            .filter(|(held_epoch, _)| *held_epoch == epoch)
            .map(|(_, end)| end);
        // Proportional to what is left, so the countdown is as steady near the boundary as far from
        // it.
        let allowance = held
            .and_then(|end| end.duration_since(now).ok())
            .unwrap_or_default()
            .checked_div(EPOCH_END_DRIFT_DIVISOR)
            .unwrap_or_default();
        let end = steady_epoch_end(held, estimate, allowance);
        self.epoch_end = Some((epoch, end));
        end
    }
}

/// In nanoseconds; `u64::MAX` reads the whole window.
fn windowed_mean_nanos(window: &VecDeque<(Slot, u64)>, span_ms: u64) -> Option<u64> {
    let (last_slot, last_arrival) = window.back().copied()?;
    let (first_slot, first_arrival) = window
        .iter()
        .rev()
        .take_while(|(_, arrival)| last_arrival.saturating_sub(*arrival) <= span_ms)
        .last()
        .copied()?;
    let slots = last_slot
        .checked_sub(first_slot)
        .filter(|slots| *slots > 0)?;
    let millis = last_arrival.checked_sub(first_arrival)?;

    // Repair delivers old slots' shreds at once, so their bunched arrivals are the download, not
    // the cluster.
    let per_second = slots as f64 / (millis as f64 / 1_000.0).max(f64::MIN_POSITIVE);
    if per_second > CATCH_UP_SLOTS_PER_SECOND {
        return None;
    }

    let nanos = (millis as f64 / slots as f64) * 1_000_000.0;
    Some(nanos as u64)
}

/// The window is measured on this node's clock: the cluster clock is clamped near the nominal slot,
/// so off nominal it reads the clamp rather than the rate.
fn best_slot_nanos(window: Option<u64>, clock: Option<u64>, configured: u64) -> u64 {
    window.or(clock).unwrap_or(configured)
}

/// `None` until enough slots have run for the clock's whole seconds not to matter.
fn epoch_anchored_nanos(clock: &Clock, start_slot: Slot, completed: Slot) -> Option<u64> {
    let slots = completed.saturating_sub(start_slot);
    if slots < EPOCH_RATE_MIN_ELAPSED_SLOTS {
        return None;
    }
    let elapsed = clock
        .unix_timestamp
        .checked_sub(clock.epoch_start_timestamp)?;
    let elapsed = u64::try_from(elapsed).ok().filter(|secs| *secs > 0)?;
    elapsed.checked_mul(1_000_000_000)?.checked_div(slots)
}

fn steady_epoch_end(
    held: Option<SystemTime>,
    estimate: SystemTime,
    allowance: Duration,
) -> SystemTime {
    let Some(held) = held else {
        return estimate;
    };
    let drift = held
        .duration_since(estimate)
        .or_else(|_| estimate.duration_since(held))
        .unwrap_or_default();
    if drift > allowance { estimate } else { held }
}

#[cfg(test)]
mod tests {
    use {super::*, std::time::UNIX_EPOCH};

    const ALLOWANCE: Duration = Duration::from_secs(60);

    fn window(samples: &[(Slot, u64)]) -> VecDeque<(Slot, u64)> {
        samples.iter().copied().collect()
    }

    fn steady_window(from: (Slot, u64), count: u64, slot_ms: u64) -> VecDeque<(Slot, u64)> {
        let (slot, arrival) = from;
        (0..count)
            .map(|index| {
                (
                    slot.saturating_add(index),
                    arrival.saturating_add(index.saturating_mul(slot_ms)),
                )
            })
            .collect()
    }

    #[test]
    fn test_a_tip_that_steps_back_does_not_retime_slots() {
        let mut clock = SlotClock::default();
        assert_eq!(clock.slots_to_time(100), 100..=100);
        assert_eq!(clock.slots_to_time(104), 101..=104);
        assert!(clock.slots_to_time(102).is_empty());
        assert_eq!(clock.slots_to_time(105), 105..=105);
    }

    #[test]
    fn test_a_full_window_averages_the_whole_of_it() {
        let samples = steady_window((100, 1_000), SLOT_TIME_WINDOW_SLOTS as u64, 420);
        assert_eq!(windowed_mean_nanos(&samples, u64::MAX), Some(420_000_000));
    }

    #[test]
    fn test_a_full_window_of_replay_is_still_rejected() {
        let samples = steady_window((100, 1_000), SLOT_TIME_WINDOW_SLOTS as u64, 10);
        assert_eq!(windowed_mean_nanos(&samples, u64::MAX), None);
    }

    #[test]
    fn test_the_readout_span_ignores_samples_older_than_itself() {
        let mut samples = steady_window((100, 1_000), SLOT_TIME_WINDOW_SLOTS as u64, 400);
        let (last_slot, last_arrival) = *samples.back().unwrap();
        samples.extend(steady_window(
            (
                last_slot.saturating_add(1),
                last_arrival.saturating_add(500),
            ),
            120,
            500,
        ));
        assert_eq!(
            windowed_mean_nanos(&samples, SLOT_READOUT_SPAN_MS),
            Some(500_000_000)
        );
        assert!(windowed_mean_nanos(&samples, u64::MAX).unwrap() < 420_000_000);
    }

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH
            .checked_add(Duration::from_secs(seconds))
            .unwrap()
    }

    fn clock_at(elapsed: i64) -> Clock {
        Clock {
            epoch_start_timestamp: 1_700_000_000,
            unix_timestamp: 1_700_000_000_i64.saturating_add(elapsed),
            ..Clock::default()
        }
    }

    #[test]
    fn test_epoch_rate_is_elapsed_time_over_slots() {
        let nanos = epoch_anchored_nanos(&clock_at(21_600), 100, 60_100);
        assert_eq!(nanos, Some(360_000_000));
    }

    #[test]
    fn test_the_measured_rate_outranks_a_clamped_clock() {
        // Testnet at 190ms slots: the clock sits on its clamp, advancing 500ms a slot.
        assert_eq!(
            best_slot_nanos(Some(190_000_000), Some(500_000_000), 400_000_000),
            190_000_000
        );
        assert_eq!(
            best_slot_nanos(None, Some(500_000_000), 400_000_000),
            500_000_000
        );
        assert_eq!(best_slot_nanos(None, None, 400_000_000), 400_000_000);
    }

    #[test]
    fn test_the_epoch_rate_waits_for_the_epoch_to_get_going() {
        // The cluster clock moves in whole seconds, so early on the error in
        // that second is worth more than the answer.
        assert_eq!(epoch_anchored_nanos(&clock_at(400), 100, 1_100), None);
    }

    #[test]
    fn test_a_clock_that_has_not_moved_yields_no_rate() {
        assert_eq!(epoch_anchored_nanos(&clock_at(0), 100, 60_100), None);
        assert_eq!(epoch_anchored_nanos(&clock_at(-10), 100, 60_100), None);
    }

    #[test]
    fn test_the_first_estimate_is_adopted_as_it_stands() {
        assert_eq!(steady_epoch_end(None, at(10_000), ALLOWANCE), at(10_000));
    }

    #[test]
    fn test_small_drift_does_not_move_the_countdown() {
        let held = at(10_000);
        for estimate in [at(10_030), at(9_970)] {
            assert_eq!(steady_epoch_end(Some(held), estimate, ALLOWANCE), held);
        }
    }

    #[test]
    fn test_real_drift_is_followed_in_one_step() {
        let held = at(10_000);
        assert_eq!(
            steady_epoch_end(Some(held), at(10_600), ALLOWANCE),
            at(10_600),
            "ten minutes is the estimate genuinely changing, not noise"
        );
    }

    #[test]
    fn test_drift_exactly_at_the_allowance_is_still_held() {
        let held = at(10_000);
        assert_eq!(steady_epoch_end(Some(held), at(10_060), ALLOWANCE), held);
    }

    #[test]
    fn test_the_allowance_scales_with_what_is_left() {
        let six_hours = Duration::from_secs(21_600);
        let allowance = six_hours.checked_div(EPOCH_END_DRIFT_DIVISOR).unwrap();
        assert!(allowance > Duration::from_secs(300), "{allowance:?}");

        let one_hour = Duration::from_secs(3_600);
        let allowance = one_hour.checked_div(EPOCH_END_DRIFT_DIVISOR).unwrap();
        assert!(allowance < Duration::from_secs(60), "{allowance:?}");
    }

    fn clock_following(last: Slot, count: u64) -> SlotClock {
        let first = last.saturating_sub(count.saturating_sub(1));
        SlotClock {
            window: steady_window((first, 1_000), count, 400),
            ..SlotClock::default()
        }
    }

    #[test]
    fn test_the_marker_waits_for_the_window_to_fill() {
        // A validator that has loaded a snapshot and received nothing sits at zero
        // distance without having caught up.
        let mut clock = clock_following(300_000_000, 4);
        clock.mark_caught_up(300_000_000, 300_000_000);
        assert_eq!(clock.caught_up_at, None);
        assert_eq!(clock.window.len(), 4, "nothing discarded");
    }

    #[test]
    fn test_the_marker_waits_for_replay_to_reach_the_tip() {
        let mut clock = clock_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        clock.mark_caught_up(300_001_000, 300_000_000);
        assert_eq!(clock.caught_up_at, None);
    }

    #[test]
    fn test_catching_up_discards_everything_measured_while_behind() {
        let mut clock = clock_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        clock.mark_caught_up(300_001_000, 300_000_000);
        clock.mark_caught_up(300_000_002, 300_000_000);

        assert_eq!(
            clock.caught_up_at,
            Some(300_000_000_u64.saturating_add(CAUGHT_UP_MARGIN_SLOTS))
        );
        assert!(
            clock.window.is_empty(),
            "every sample was taken while behind, so none of it describes the cluster"
        );
    }

    #[test]
    fn test_starting_level_keeps_the_samples_it_already_has() {
        let mut clock = clock_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        clock.mark_caught_up(300_000_000, 300_000_000);

        assert!(clock.caught_up_at.is_some());
        assert_eq!(
            clock.window.len(),
            CAUGHT_UP_MIN_SAMPLES,
            "nothing was measured while behind, so nothing is thrown away"
        );
    }

    #[test]
    fn test_marker_is_set_once() {
        let mut clock = clock_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        clock.mark_caught_up(300_000_000, 300_000_000);
        let marked = clock.caught_up_at;

        clock.window = steady_window((300_001_000, 1_000), 200, 400);
        clock.mark_caught_up(300_099_000, 300_001_000);

        assert_eq!(clock.caught_up_at, marked, "the marker never moves");
        assert_eq!(
            clock.window.len(),
            200,
            "and nothing is discarded a second time"
        );
    }

    #[test]
    fn test_mean_spans_the_ends_of_the_window() {
        let samples = window(&[(100, 1_000), (105, 3_100), (110, 5_000)]);
        assert_eq!(windowed_mean_nanos(&samples, u64::MAX), Some(400_000_000));
    }

    #[test]
    fn test_one_slow_slot_barely_moves_the_mean() {
        let steady = 150_u64 * 400;
        assert_eq!(
            windowed_mean_nanos(&window(&[(0, 0), (150, steady + 1_600)]), u64::MAX),
            Some(410_666_666)
        );
    }

    #[test]
    fn test_repair_burst_is_not_reported_as_the_cluster_rate() {
        // A thousand slots arriving in two seconds is a download, not a cluster.
        assert_eq!(
            windowed_mean_nanos(&window(&[(0, 0), (1_000, 2_000)]), u64::MAX),
            None
        );
    }

    #[test]
    fn test_window_that_cannot_span_two_slots_reports_nothing() {
        assert_eq!(windowed_mean_nanos(&window(&[]), u64::MAX), None);
        assert_eq!(
            windowed_mean_nanos(&window(&[(100, 1_000)]), u64::MAX),
            None
        );
    }
}
