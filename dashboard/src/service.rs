//! Owns the dashboard's threads and ties the collector to the server.
//!
//! The dashboard starts in two stages. The server and a boot-progress thread
//! come up near the top of validator startup, so that a snapshot download or a
//! ledger replay — the hour in which an operator most wants to see something —
//! is visible rather than blank. The collector attaches later, once bank forks
//! and the blockstore exist for it to read.
//!
//! Sampling runs on two threads. The collector walks slots, which means reading
//! the blockstore and the accounts database; the meters take the once-a-second
//! readings, which touch neither. Kept on one thread, a validator busy enough to
//! slow a blockstore read stalled every panel at once — and since a stalled
//! panel goes on showing its last value, it looked no different from a live one.

use {
    crate::{
        collect::Collector,
        config::DashboardConfig,
        context::{DashboardContext, StartupProgressFn},
        meters::{METER_INTERVAL, Meters},
        metrics_tap::MetricsTap,
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
    tokio::{net::TcpListener, runtime::Builder},
};

/// Worker threads the dashboard's runtime is allowed.
///
/// `Runtime::new()` takes one per core, which on a large validator is two
/// dozen threads that can each saturate one — competing with replay, banking
/// and PoH under the same scheduler, in the same process, where no cgroup or
/// nice value can separate them. The dashboard serves a handful of operators
/// and its work is almost all socket writes, so two is generous. What this
/// bounds is not the ordinary case but the hostile one.
const RUNTIME_THREADS: usize = 2;

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
    /// Counters lifted from the measurements the validator submits about
    /// itself, watched from `start` so the boot sequence is counted too.
    metrics_tap: Arc<MetricsTap>,
    server: Option<JoinHandle<()>>,
    boot: Option<JoinHandle<()>>,
    collector: Option<JoinHandle<()>>,
    meters: Option<JoinHandle<()>>,
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
        // Installed with the service rather than with the collector, so that
        // the points submitted during the boot sequence — which is most of a
        // cold start — are counted too. A validator with no dashboard installs
        // nothing and the hook stays empty.
        let metrics_tap = MetricsTap::install();
        let attached = Arc::new(AtomicBool::new(false));

        let runtime = Builder::new_multi_thread()
            .worker_threads(RUNTIME_THREADS)
            .thread_name("solDashRt")
            .enable_all()
            .build()?;
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
            metrics_tap,
            server: Some(server),
            boot: Some(boot),
            collector: None,
            meters: None,
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

        // Validator names are read once here rather than on the collector's
        // timer. The read is a secondary index lookup returning a few thousand
        // accounts, so it costs about what any other account load costs, but it
        // is kept off the collector's thread anyway: the cache lock is taken
        // only to merge the result, never across the read, or the collector
        // would block behind it.
        //
        // Whether it finds anything at all depends on how the validator was
        // started, which `scan_all` explains in the log rather than here.
        self.info_loader = Some({
            let context = context.clone();
            let info_cache = info_cache.clone();
            thread::Builder::new()
                .name("solDashInfo".to_string())
                .spawn(move || {
                    let bank = context.bank_forks.read().unwrap().root_bank();
                    let started = std::time::Instant::now();
                    let entries = crate::validator_info::scan_all(&bank);
                    let found = entries.len();
                    let loaded = info_cache.write().unwrap().merge(entries);
                    log::info!(
                        "dashboard: read validator info in {:?}, {found} accounts, {loaded} cached",
                        started.elapsed()
                    );
                })?
        });

        self.meters = Some({
            let exit = self.exit.clone();
            let publisher = self.publisher.clone();
            let startup_progress = self.startup_progress.clone();
            let context = context.clone();
            let validator_exit = validator_exit.clone();
            let metrics_tap = self.metrics_tap.clone();
            thread::Builder::new()
                .name("solDashMeter".to_string())
                .spawn(move || {
                    let mut meters = Meters::new(context, publisher, startup_progress, metrics_tap);
                    while !exit.load(Ordering::Relaxed) && !validator_exit.load(Ordering::Relaxed) {
                        meters.tick();
                        thread::sleep(METER_INTERVAL);
                    }
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
            self.meters.take(),
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

async fn wait_for_exit(exit: Arc<AtomicBool>, validator_exit: Arc<AtomicBool>) {
    while !exit.load(Ordering::Relaxed) && !validator_exit.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
