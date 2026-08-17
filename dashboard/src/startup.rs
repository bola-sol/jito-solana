//! Publishing the validator's boot phase.
//!
//! Shared by the boot thread, which runs before the validator is assembled,
//! and by the collector, which takes over once it is. Keeping one
//! implementation means the handover between them does not change what the
//! client sees.

use {
    crate::{
        context::StartupProgress,
        proto::{Debounced, Publisher, TOPIC_SUMMARY},
    },
    solana_clock::Slot,
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
}

impl StartupPublisher {
    pub fn publish(&mut self, publisher: &Publisher, mut progress: StartupProgress) {
        progress.fraction = self.fraction(progress.replay_slots);
        self.debounce
            .publish(publisher, TOPIC_SUMMARY, KEY_STARTUP_PROGRESS, progress);
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
        }
    }

    #[test]
    fn fraction_is_measured_from_the_first_slot_seen() {
        let mut publisher = StartupPublisher::default();
        // Replay resumes from a snapshot at slot 1000 and is heading for 2000.
        assert_eq!(publisher.fraction(Some((1000, 2000))), Some(0.0));
        assert_eq!(publisher.fraction(Some((1500, 2000))), Some(0.5));
        assert_eq!(publisher.fraction(Some((2000, 2000))), Some(1.0));
    }

    #[test]
    fn fraction_is_absent_without_replay_slots() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(None), None);
    }

    #[test]
    fn fraction_never_exceeds_one_or_runs_backwards() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(Some((1000, 1100))), Some(0.0));
        // Overshooting the target must not report more than complete.
        assert_eq!(publisher.fraction(Some((1200, 1100))), Some(1.0));
        // Nor may a slot below the origin produce a negative fraction.
        assert_eq!(publisher.fraction(Some((900, 1100))), Some(0.0));
    }

    #[test]
    fn a_target_already_reached_reads_as_complete() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(Some((1000, 1000))), Some(1.0));
    }

    #[test]
    fn a_target_behind_the_origin_reports_nothing() {
        let mut publisher = StartupPublisher::default();
        assert_eq!(publisher.fraction(Some((1000, 900))), None);
    }

    #[test]
    fn publishing_fills_in_the_fraction() {
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
    fn the_internal_slots_are_not_sent_to_clients() {
        let publisher = Publisher::new();
        let mut startup = StartupPublisher::default();
        startup.publish(&publisher, progress(Some((100, 200))));
        assert!(!publisher.snapshot()[0].contains("replay_slots"));
    }
}
