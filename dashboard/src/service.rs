//! Owns the dashboard's threads and ties the collector to the server.
//!
//! The dashboard starts in two stages. The server and a boot-progress thread
//! come up near the top of validator startup, so that a snapshot download or a
//! ledger replay — the hour in which an operator most wants to see something —
//! is visible rather than blank. The collector attaches later, once bank forks
//! and the blockstore exist for it to read.

use {
    crate::{
        collect::Collector,
        config::DashboardConfig,
        context::{DashboardContext, StartupProgressFn},
        proto::Publisher,
        server,
        startup::StartupPublisher,
        validator_info::ValidatorInfoCache,
    },
    std::{
        io,
        sync::{
            Arc, RwLock,
            atomic::{AtomicBool, Ordering},
        },
        thread::{self, JoinHandle},
        time::Duration,
    },
    tokio::{net::TcpListener, runtime::Runtime},
};

/// How often the boot thread samples the validator's startup phase. Phases
/// last seconds at least, so this is about responsiveness rather than
/// resolution.
const BOOT_POLL: Duration = Duration::from_millis(250);

/// How often the collector samples validator state.
///
/// The base rate the tiers in `collect` are multiples of. Five times a second
/// is fast enough that a slot never passes between two samples unobserved,
/// which is what the slot ring depends on.
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// How far behind this validator's own last vote may be for the accounts scan
/// to consider it caught up. The same threshold the RPC layer calls delinquent.
const CAUGHT_UP_SLOTS: u64 = 128;

/// How often the info thread checks whether the validator has caught up.
const CATCH_UP_POLL: Duration = Duration::from_secs(5);

/// How long the validator info scan waits for that before giving up and running
/// anyway.
///
/// A node restarted from an old snapshot can take an hour to catch up, and one
/// that is unstaked or not voting never satisfies the check at all. Without a
/// ceiling those dashboards would show truncated pubkeys forever, which is a
/// worse outcome than a badly timed scan.
const CATCH_UP_WAIT: Duration = Duration::from_secs(15 * 60);

pub struct DashboardService {
    /// The dashboard's own stop signal.
    ///
    /// Deliberately not the validator's `exit`: the dashboard now starts before
    /// the validator is assembled, so a failure part-way through startup drops
    /// this service, and signalling the shared flag from `Drop` would tell the
    /// whole validator to shut down.
    exit: Arc<AtomicBool>,
    /// Stops the boot thread once the collector has taken over reporting.
    attached: Arc<AtomicBool>,
    publisher: Arc<Publisher>,
    /// Retained from `start` and handed to the collector at `attach`, so the
    /// caller supplies it once. The validator cannot supply it a second time
    /// anyway: translating its startup enum lives in the binary that owns it.
    startup_progress: StartupProgressFn,
    server: Option<JoinHandle<()>>,
    boot: Option<JoinHandle<()>>,
    collector: Option<JoinHandle<()>>,
    info_loader: Option<JoinHandle<()>>,
}

impl DashboardService {
    /// Binds the listener and begins serving startup progress.
    ///
    /// The only error returned is a failure to bind, which makes a
    /// misconfigured dashboard fail loudly at boot rather than quietly never
    /// appearing. Call [`DashboardService::attach`] once the validator has
    /// assembled enough state for the collector to read.
    pub fn start(
        config: DashboardConfig,
        startup_progress: StartupProgressFn,
        validator_exit: Arc<AtomicBool>,
    ) -> io::Result<Self> {
        let publisher = Arc::new(Publisher::new());
        let exit = Arc::new(AtomicBool::new(false));
        let attached = Arc::new(AtomicBool::new(false));

        let runtime = Runtime::new()?;
        let listener = runtime.block_on(async { TcpListener::bind(config.listen_addr).await })?;
        log::info!(
            "dashboard: listening on http://{} (websocket at /websocket)",
            config.listen_addr
        );

        let allowed_hosts: Arc<[String]> = config.allowed_hosts.clone().into();
        log::info!("dashboard: answering to hosts {:?}", config.allowed_hosts);

        let server = {
            let publisher = publisher.clone();
            let exit = exit.clone();
            let validator_exit = validator_exit.clone();
            thread::Builder::new()
                .name("solDashSrv".to_string())
                .spawn(move || {
                    runtime.block_on(async move {
                        tokio::select! {
                            _ = server::serve(listener, publisher, allowed_hosts) => {}
                            _ = wait_for_exit(exit, validator_exit) => {}
                        }
                    });
                })?
        };

        let boot = {
            let publisher = publisher.clone();
            let exit = exit.clone();
            let attached = attached.clone();
            let validator_exit = validator_exit.clone();
            let startup_progress = startup_progress.clone();
            thread::Builder::new()
                .name("solDashBoot".to_string())
                .spawn(move || {
                    let mut startup = StartupPublisher::default();
                    while !attached.load(Ordering::Relaxed)
                        && !exit.load(Ordering::Relaxed)
                        && !validator_exit.load(Ordering::Relaxed)
                    {
                        let progress = (startup_progress)();
                        startup.publish(&publisher, progress);
                        thread::sleep(BOOT_POLL);
                    }
                })?
        };

        Ok(Self {
            exit,
            attached,
            publisher,
            startup_progress,
            server: Some(server),
            boot: Some(boot),
            collector: None,
            info_loader: None,
        })
    }

    /// Starts the collector against a fully assembled validator.
    ///
    /// Reporting passes from the boot thread to the collector here, which is
    /// why both publish startup progress through the same
    /// [`StartupPublisher`]: the handover must not be visible to a client.
    pub fn attach(
        &mut self,
        context: DashboardContext,
        validator_exit: Arc<AtomicBool>,
    ) -> io::Result<()> {
        let info_cache = Arc::new(RwLock::new(ValidatorInfoCache::default()));

        // The one-time scan of validator info accounts walks the whole accounts
        // database and takes minutes. It runs off the collector's timer, and
        // the cache lock is taken only to merge the result, never across the
        // scan itself, or the collector would block behind it.
        //
        // It also waits for the validator to catch up first. This runs at the
        // end of validator startup, which is exactly when the node begins
        // replaying hard toward the cluster tip — the busiest the accounts
        // database ever gets. Waiting costs nothing but the delay before names
        // replace pubkeys on the page.
        self.info_loader = Some({
            let context = context.clone();
            let info_cache = info_cache.clone();
            let exit = self.exit.clone();
            let validator_exit = validator_exit.clone();
            thread::Builder::new()
                .name("solDashInfo".to_string())
                .spawn(move || {
                    let began = std::time::Instant::now();
                    while !caught_up(&context) && began.elapsed() < CATCH_UP_WAIT {
                        // Checked here and not only around the scan: without
                        // this, shutting down during the wait would block the
                        // validator's join for the rest of it.
                        if exit.load(Ordering::Relaxed) || validator_exit.load(Ordering::Relaxed) {
                            return;
                        }
                        thread::sleep(CATCH_UP_POLL);
                    }

                    let waited = began.elapsed();

                    // Taken after the wait, not before: a bank picked up at
                    // attach time would be a quarter of an hour stale by now,
                    // and holding it would have kept it from being dropped.
                    let bank = context.bank_forks.read().unwrap().root_bank();
                    let started = std::time::Instant::now();
                    let entries = crate::validator_info::scan_all(&bank);
                    let found = entries.len();
                    let loaded = info_cache.write().unwrap().merge(entries);
                    log::info!(
                        "dashboard: waited {waited:?} to catch up, then scanned validator info in \
                         {:?}, {found} accounts, {loaded} cached",
                        started.elapsed()
                    );
                })?
        });

        self.collector = Some({
            let exit = self.exit.clone();
            let publisher = self.publisher.clone();
            let startup_progress = self.startup_progress.clone();
            thread::Builder::new()
                .name("solDashColl".to_string())
                .spawn(move || {
                    let mut collector =
                        Collector::new(context, publisher, info_cache, startup_progress);
                    collector.publish_static();
                    while !exit.load(Ordering::Relaxed) && !validator_exit.load(Ordering::Relaxed) {
                        collector.tick();
                        thread::sleep(POLL_INTERVAL);
                    }
                })?
        });

        // Set last: the boot thread must not stop before the collector exists,
        // or startup progress would go stale in the gap.
        self.attached.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn join(mut self) -> thread::Result<()> {
        self.exit.store(true, Ordering::Relaxed);
        for handle in [
            self.collector.take(),
            self.boot.take(),
            self.server.take(),
            self.info_loader.take(),
        ]
        .into_iter()
        .flatten()
        {
            handle.join()?;
        }
        Ok(())
    }
}

impl Drop for DashboardService {
    /// Startup can fail after the dashboard is up, in which case this is
    /// dropped without `join`. Signal the threads so they do not outlive the
    /// validator that owns them.
    fn drop(&mut self) {
        self.exit.store(true, Ordering::Relaxed);
    }
}

/// Whether this validator is voting close enough to the tip to count as caught
/// up, and so to be a good moment for a full accounts scan.
///
/// Deliberately not the collector's health check, which only runs while someone
/// has the page open. A validator nobody is watching still deserves its scan at
/// the right moment rather than at the fifteen-minute fallback.
///
/// One hash lookup in the stakes cache, so polling it costs nothing.
fn caught_up(context: &DashboardContext) -> bool {
    let bank = context.bank_forks.read().unwrap().working_bank();
    let Some(vote_account) = bank.get_vote_account(&context.vote_account) else {
        return false;
    };
    let Some(last_vote) = vote_account.vote_state_view().last_voted_slot() else {
        return false;
    };
    bank.slot().saturating_sub(last_vote) < CAUGHT_UP_SLOTS
}

async fn wait_for_exit(exit: Arc<AtomicBool>, validator_exit: Arc<AtomicBool>) {
    while !exit.load(Ordering::Relaxed) && !validator_exit.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
