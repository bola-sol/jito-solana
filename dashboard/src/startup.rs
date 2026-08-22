//! Publishing the validator's boot phase.
//!
//! Shared by the boot thread, which runs before the validator is assembled,
//! and by the collector, which takes over once it is. Keeping one
//! implementation means the handover between them does not change what the
//! client sees.

use {
    crate::{
        context::{PhaseTiming, StartupProgress},
        proto::{Debounced, Publisher, TOPIC_SUMMARY},
    },
    solana_clock::Slot,
    std::time::{Duration, Instant},
};

pub const KEY_STARTUP_PROGRESS: &str = "startup_progress";

#[derive(Default)]
pub struct StartupPublisher {
    debounce: Debounced<StartupProgress>,
    /// The first replay slot seen. Progress is measured from here: the
    /// validator reports absolute slots, and replay starts from whatever
    /// snapshot was loaded rather than from zero, so `slot / max_slot` would
    /// sit at a useless 99-point-something percent throughout.
    replay_origin: Option<Slot>,

    /// The phase currently being timed and when it began. The validator says
    /// which phase it is in and nothing about when it got there, so the change
    /// is watched for here.
    current: Option<(String, Instant)>,
    /// How long each finished phase took, in the order they finished.
    ///
    /// Accumulated rather than appended if a phase comes round again, which
    /// `loading_ledger` does: the validator enters it once to load a snapshot
    /// and again if it finds the blockstore still has slots to process. Two
    /// rows for one phase would read as two different steps.
    taken: Vec<PhaseTiming>,
}

impl StartupPublisher {
    pub fn publish(&mut self, publisher: &Publisher, mut progress: StartupProgress) {
        progress.fraction = self.fraction(progress.replay_slots);
        progress.phase_elapsed_nanos = self.elapsed(&progress.phase, Instant::now());
        progress.phases_taken = self.taken.clone();
        self.debounce
            .publish(publisher, TOPIC_SUMMARY, KEY_STARTUP_PROGRESS, progress);
    }

    /// Time in the current phase, rounded down to whole seconds.
    ///
    /// Rounded because this is sent through a debounce that suppresses
    /// unchanged values, and the boot thread polls four times a second. At
    /// nanosecond resolution every poll would differ and the message would go
    /// out four times a second for the length of a boot; at second resolution
    /// it goes out when there is something new to say.
    fn elapsed(&mut self, phase: &str, now: Instant) -> u64 {
        match &mut self.current {
            Some((current, since)) if current == phase => whole_seconds(now, *since),
            other => {
                // A phase ending: keep what it took before starting the next.
                if let Some((finished, since)) = other.take() {
                    let elapsed_nanos = now.duration_since(since).as_nanos() as u64;
                    match self
                        .taken
                        .iter_mut()
                        .find(|timing| timing.phase == finished)
                    {
                        Some(timing) => {
                            timing.elapsed_nanos =
                                timing.elapsed_nanos.saturating_add(elapsed_nanos)
                        }
                        None => self.taken.push(PhaseTiming {
                            phase: finished,
                            elapsed_nanos,
                        }),
                    }
                }
                *other = Some((phase.to_string(), now));
                0
            }
        }
    }

    fn fraction(&mut self, slots: Option<(Slot, Slot)>) -> Option<f64> {
        let (current, target) = slots?;
        let origin = *self.replay_origin.get_or_insert(current);
        // Replay can be handed a target it has already passed, and the origin
        // is only an estimate of where it began. Neither should produce a
        // meter that runs backwards or past the end.
        let span = target.checked_sub(origin)?;
        if span == 0 {
            return Some(1.0);
        }
        let done = current.saturating_sub(origin).min(span);
        Some(done as f64 / span as f64)
    }
}

/// A duration in whole seconds, as nanoseconds.
fn whole_seconds(now: Instant, since: Instant) -> u64 {
    Duration::from_secs(now.duration_since(since).as_secs()).as_nanos() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(slots: Option<(Slot, Slot)>) -> StartupProgress {
        StartupProgress {
            phase: "processing_ledger".to_string(),
            detail: None,
            running: false,
            fraction: None,
            replay_slots: slots,
            stake_percent: None,
            phase_elapsed_nanos: 0,
            phases_taken: Vec::new(),
        }
    }

    #[test]
    fn test_fraction_is_measured_from_the_first_slot_seen() {
        let mut publisher = StartupPublisher::default();
        // Replay resumes from a snapshot at slot 1000 and is heading for 2000.
        assert_eq!(publisher.fraction(Some((1000, 2000))), Some(0.0));
        assert_eq!(publisher.fraction(Some((1500, 2000))), Some(0.5));
        assert_eq!(publisher.fraction(Some((2000, 2000))), Some(1.0));
    }

    #[test]
    fn test_fraction_is_absent_without_replay_slots() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(None), None);
    }

    #[test]
    fn test_fraction_never_exceeds_one_or_runs_backwards() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(Some((1000, 1100))), Some(0.0));
        // Overshooting the target must not report more than complete.
        assert_eq!(publisher.fraction(Some((1200, 1100))), Some(1.0));
        // Nor may a slot below the origin produce a negative fraction.
        assert_eq!(publisher.fraction(Some((900, 1100))), Some(0.0));
    }

    #[test]
    fn test_target_already_reached_reads_as_complete() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(Some((1000, 1000))), Some(1.0));
    }

    #[test]
    fn test_target_behind_the_origin_reports_nothing() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(Some((1000, 900))), None);
    }

    #[test]
    fn test_a_phase_is_timed_from_when_it_was_first_seen() {
        let mut publisher = StartupPublisher::default();
        let base = Instant::now();
        assert_eq!(publisher.elapsed("loading_ledger", base), 0);
        assert_eq!(
            publisher.elapsed("loading_ledger", base + Duration::from_millis(4_500)),
            Duration::from_secs(4).as_nanos() as u64,
            "rounded down to whole seconds, or the debounce sends four a second"
        );
    }

    #[test]
    fn test_a_finished_phase_keeps_what_it_took() {
        let mut publisher = StartupPublisher::default();
        let base = Instant::now();
        publisher.elapsed("cleaning_accounts", base);
        publisher.elapsed("loading_ledger", base + Duration::from_secs(30));

        assert_eq!(publisher.taken.len(), 1);
        assert_eq!(publisher.taken[0].phase, "cleaning_accounts");
        assert_eq!(
            publisher.taken[0].elapsed_nanos,
            Duration::from_secs(30).as_nanos() as u64
        );
    }

    #[test]
    fn test_a_phase_entered_twice_adds_to_its_own_total() {
        // `loading_ledger` is entered once to load a snapshot and again if the
        // blockstore still has slots to process. Two rows for one phase would
        // read as two different steps of the boot.
        let mut publisher = StartupPublisher::default();
        let base = Instant::now();
        publisher.elapsed("loading_ledger", base);
        publisher.elapsed("processing_ledger", base + Duration::from_secs(10));
        publisher.elapsed("loading_ledger", base + Duration::from_secs(15));
        publisher.elapsed("processing_ledger", base + Duration::from_secs(21));

        let loading = publisher
            .taken
            .iter()
            .filter(|timing| timing.phase == "loading_ledger")
            .count();
        assert_eq!(
            loading, 1,
            "one row per phase, however often it comes round"
        );
        assert_eq!(
            publisher
                .taken
                .iter()
                .find(|timing| timing.phase == "loading_ledger")
                .unwrap()
                .elapsed_nanos,
            Duration::from_secs(16).as_nanos() as u64,
            "ten seconds the first time and six the second"
        );
    }

    #[test]
    fn test_publishing_fills_in_the_fraction() {
        let publisher = Publisher::new();
        let mut startup = StartupPublisher::default();
        startup.publish(&publisher, progress(Some((100, 200))));
        startup.publish(&publisher, progress(Some((150, 200))));

        let snapshot = publisher.snapshot();
        assert_eq!(
            snapshot.len(),
            1,
            "startup progress is a single retained key"
        );
        assert!(
            snapshot[0].contains(r#""fraction":0.5"#),
            "expected a half-complete fraction, got {}",
            snapshot[0]
        );
    }

    #[test]
    fn test_internal_slots_are_not_sent_to_clients() {
        let publisher = Publisher::new();
        let mut startup = StartupPublisher::default();
        startup.publish(&publisher, progress(Some((100, 200))));
        assert!(!publisher.snapshot()[0].contains("replay_slots"));
    }
}
