//! Publishing the validator's boot phase. Shared by the boot thread and the
//! collector, so the handover between them is invisible to the client.

use {
    crate::{
        metrics_tap::StakeInGossip,
        proto::{Debounced, Publisher, TOPIC_SUMMARY},
        validator_info::ValidatorInfoCache,
    },
    crossbeam_channel::Receiver,
    serde::Serialize,
    solana_clock::Slot,
    solana_core::validator::{GossipReady, ValidatorStartProgress},
    solana_gossip::{
        cluster_info::ClusterInfo, contact_info::ContactInfo,
        crds_gossip_pull::CRDS_GOSSIP_PULL_CRDS_TIMEOUT_MS,
    },
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    std::{
        collections::HashMap,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    },
};

pub const KEY_STARTUP_PROGRESS: &str = "startup_progress";
pub const KEY_GOSSIP_STAKE: &str = "gossip_stake";

/// The handles the validator sends before its supermajority wait.
pub type GossipReadyReceiver = Receiver<GossipReady>;

/// The wait as this node sees it: every staked validator, and whether gossip
/// holds it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipStake {
    pub slot: Slot,
    pub shred_version: u16,
    pub total: u64,
    pub seen: u64,
    /// Stake descending.
    pub validators: Vec<GossipValidator>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipValidator {
    pub identity: String,
    pub name: Option<String>,
    pub icon: Option<String>,
    /// As gossip reports it. `None` for a node gossip does not hold.
    pub version: Option<String>,
    pub stake: u64,
    pub seen: bool,
}

/// Walks the bank's staked identities against gossip the way the validator's
/// own wait does: seen is a TVU peer whose contact is fresh, since contacts
/// restored from disk outlive the nodes that wrote them, and this node counts
/// as seen.
pub fn gossip_stake(
    cluster_info: &ClusterInfo,
    bank: &Bank,
    names: &ValidatorInfoCache,
) -> GossipStake {
    let shred_version = cluster_info.my_shred_version();
    let now = unix_millis();
    let mut contacts: HashMap<Pubkey, String> = cluster_info
        .tvu_peers(ContactInfo::clone)
        .into_iter()
        .filter(|contact| {
            now.saturating_sub(contact.wallclock()) < CRDS_GOSSIP_PULL_CRDS_TIMEOUT_MS
        })
        .map(|contact| (*contact.pubkey(), contact.version().to_string()))
        .collect();
    contacts.insert(
        cluster_info.id(),
        cluster_info.my_contact_info().version().to_string(),
    );

    let mut staked: HashMap<Pubkey, u64> = HashMap::new();
    for (stake, account) in bank.vote_accounts().values() {
        if *stake > 0 {
            let held = staked.entry(*account.node_pubkey()).or_insert(0);
            *held = held.saturating_add(*stake);
        }
    }

    let mut validators: Vec<GossipValidator> = staked
        .into_iter()
        .map(|(identity, stake)| {
            let info = names.get(&identity);
            let version = contacts.get(&identity).cloned();
            GossipValidator {
                identity: identity.to_string(),
                name: info.and_then(|info| info.name.clone()),
                icon: info.and_then(|info| info.icon_url.clone()),
                seen: version.is_some(),
                version,
                stake,
            }
        })
        .collect();
    validators.sort_by(|a, b| {
        b.stake
            .cmp(&a.stake)
            .then_with(|| a.identity.cmp(&b.identity))
    });
    let total = validators
        .iter()
        .fold(0, |sum, v| u64::saturating_add(sum, v.stake));
    let seen = validators
        .iter()
        .filter(|v| v.seen)
        .fold(0, |sum, v| u64::saturating_add(sum, v.stake));
    GossipStake {
        slot: bank.slot(),
        shred_version,
        total,
        seen,
        validators,
    }
}

/// What the client is sent about the boot sequence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StartupProgress {
    /// Machine-readable phase name, e.g. `"loading_ledger"`.
    pub phase: String,
    pub detail: Option<String>,
    pub running: bool,
    /// How far ledger replay has got, from 0 to 1, measured from where it
    /// began.
    pub fraction: Option<f64>,
    /// Share of the cluster's stake seen in gossip while waiting for a
    /// supermajority, from 0 to 1. A whole percent, truncated by the validator.
    pub stake_percent: Option<f64>,
    /// The same wait as the validator counted it, in lamports, from the point
    /// it submits every tenth check. Exact, and a few seconds behind. Only
    /// during the wait, and only once a point has arrived.
    pub stake_in_gossip: Option<StakeInGossip>,
    /// How long the validator has been in this phase, and how long each phase
    /// before it took, since most phases cannot say how far along they are.
    pub phase_elapsed_nanos: u64,
    pub phases_taken: Vec<PhaseTiming>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhaseTiming {
    pub phase: String,
    pub elapsed_nanos: u64,
}

/// Gossip's clock: milliseconds since the epoch.
fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| u64::try_from(since.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

#[derive(Default)]
pub struct StartupPublisher {
    debounce: Debounced<StartupProgress>,
    gossip: Debounced<Option<GossipStake>>,
    /// The first replay slot seen. Replay starts from a snapshot rather than
    /// from zero, so `slot / max_slot` would sit near 100% throughout.
    replay_origin: Option<Slot>,
    /// The phase being timed and when it began. The validator says which
    /// phase it is in and nothing about when it got there.
    current: Option<(String, Instant)>,
    /// How long each finished phase took. Accumulated if a phase comes round
    /// again, which `loading_ledger` does.
    taken: Vec<PhaseTiming>,
}

impl StartupPublisher {
    /// The wait's validator list, or `None` once the wait is over.
    pub fn publish_gossip(&mut self, publisher: &Publisher, stake: Option<GossipStake>) {
        self.gossip
            .publish(publisher, TOPIC_SUMMARY, KEY_GOSSIP_STAKE, stake);
    }

    /// `stake_in_gossip` is the tap's latest count, and rides along only while
    /// the phase is the wait it describes.
    pub fn publish(
        &mut self,
        publisher: &Publisher,
        progress: ValidatorStartProgress,
        stake_in_gossip: Option<StakeInGossip>,
    ) {
        let phase = describe(progress);
        let waiting = matches!(
            progress,
            ValidatorStartProgress::WaitingForSupermajority { .. }
        );
        let progress = StartupProgress {
            phase: phase.name.to_string(),
            detail: phase.detail,
            running: matches!(progress, ValidatorStartProgress::Running),
            fraction: self.fraction(phase.replay_slots),
            stake_percent: phase.stake_percent,
            stake_in_gossip: stake_in_gossip.filter(|_| waiting),
            phase_elapsed_nanos: self.elapsed(phase.name, Instant::now()),
            phases_taken: self.taken.clone(),
        };
        self.debounce
            .publish(publisher, TOPIC_SUMMARY, KEY_STARTUP_PROGRESS, progress);
    }

    /// Time in the current phase, rounded down to whole seconds so that the
    /// debounce does not send four messages a second for the length of a boot.
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
        // Replay can be handed a target it has already passed, and the origin is
        // only an estimate; neither may run the meter backwards or past the end.
        let span = target.checked_sub(origin)?;
        if span == 0 {
            return Some(1.0);
        }
        let done = current.saturating_sub(origin).min(span);
        Some(done as f64 / span as f64)
    }
}

/// What a phase reports about itself, as far as it reports anything.
struct Phase {
    name: &'static str,
    detail: Option<String>,
    replay_slots: Option<(Slot, Slot)>,
    stake_percent: Option<f64>,
}

fn describe(progress: ValidatorStartProgress) -> Phase {
    let (name, detail, replay_slots, stake_percent) = match progress {
        ValidatorStartProgress::Initializing => ("initializing", None, None, None),
        ValidatorStartProgress::SearchingForRpcService => {
            ("searching_for_rpc_service", None, None, None)
        }
        ValidatorStartProgress::DownloadingSnapshot { slot, rpc_addr } => (
            "downloading_snapshot",
            Some(format!("slot {slot} from {rpc_addr}")),
            None,
            None,
        ),
        ValidatorStartProgress::CleaningBlockStore => ("cleaning_blockstore", None, None, None),
        ValidatorStartProgress::CleaningAccounts => ("cleaning_accounts", None, None, None),
        ValidatorStartProgress::LoadingLedger => ("loading_ledger", None, None, None),
        ValidatorStartProgress::ProcessingLedger { slot, max_slot } => (
            "processing_ledger",
            Some(format!("slot {slot} of {max_slot}")),
            Some((slot, max_slot)),
            None,
        ),
        ValidatorStartProgress::StartingServices => ("starting_services", None, None, None),
        ValidatorStartProgress::Halted => ("halted", None, None, None),
        ValidatorStartProgress::WaitingForSupermajority {
            slot,
            gossip_stake_percent,
        } => (
            "waiting_for_supermajority",
            Some(format!("slot {slot}")),
            None,
            Some(gossip_stake_percent as f64 / 100.0),
        ),
        ValidatorStartProgress::Running => ("running", None, None, None),
    };
    Phase {
        name,
        detail,
        replay_slots,
        stake_percent,
    }
}

/// A duration in whole seconds, as nanoseconds.
fn whole_seconds(now: Instant, since: Instant) -> u64 {
    Duration::from_secs(now.duration_since(since).as_secs()).as_nanos() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replaying(slot: Slot, max_slot: Slot) -> ValidatorStartProgress {
        ValidatorStartProgress::ProcessingLedger { slot, max_slot }
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
        // `loading_ledger` is entered once for the snapshot and again if the
        // blockstore has slots to process.
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
        startup.publish(&publisher, replaying(100, 200), None);
        startup.publish(&publisher, replaying(150, 200), None);

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
    fn test_the_stake_count_rides_only_on_the_wait() {
        // The tap holds the last count for the life of the process; once the
        // validator is running it describes nothing on screen.
        let seen = Some(StakeInGossip {
            online: 3,
            offline: 7,
            total: 10,
        });
        let waiting = ValidatorStartProgress::WaitingForSupermajority {
            slot: 5,
            gossip_stake_percent: 30,
        };
        for (phase, carried) in [
            (waiting, true),
            (ValidatorStartProgress::Running, false),
            (ValidatorStartProgress::StartingServices, false),
        ] {
            let publisher = Publisher::new();
            StartupPublisher::default().publish(&publisher, phase, seen);
            let sent = publisher.snapshot().pop().unwrap();
            assert_eq!(
                sent.contains(r#""stake_in_gossip":{"online":3,"offline":7,"total":10}"#),
                carried,
                "{sent}"
            );
        }
    }

    #[test]
    fn test_every_phase_is_named_and_only_running_runs() {
        // Every phase has a name and running is the only running one.
        let phases = [
            ValidatorStartProgress::Initializing,
            ValidatorStartProgress::SearchingForRpcService,
            ValidatorStartProgress::CleaningBlockStore,
            ValidatorStartProgress::CleaningAccounts,
            ValidatorStartProgress::LoadingLedger,
            replaying(1, 2),
            ValidatorStartProgress::StartingServices,
            ValidatorStartProgress::Halted,
            ValidatorStartProgress::WaitingForSupermajority {
                slot: 5,
                gossip_stake_percent: 50,
            },
            ValidatorStartProgress::Running,
        ];
        for phase in phases {
            let publisher = Publisher::new();
            StartupPublisher::default().publish(&publisher, phase, None);
            let sent = publisher.snapshot().pop().unwrap();
            assert!(!sent.contains(r#""phase":"""#), "{sent}");
            assert_eq!(
                sent.contains(r#""running":true"#),
                phase == ValidatorStartProgress::Running,
                "{sent}"
            );
        }
    }
}
