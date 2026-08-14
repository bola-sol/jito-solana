//! Owns the dashboard's threads and ties the collector to the server.

use {
    crate::{
        collect::Collector, config::DashboardConfig, context::DashboardContext, proto::Publisher,
        server, validator_info::ValidatorInfoCache,
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

pub struct DashboardService {
    exit: Arc<AtomicBool>,
    collector: Option<JoinHandle<()>>,
    server: Option<JoinHandle<()>>,
    info_loader: Option<JoinHandle<()>>,
}

impl DashboardService {
    /// Binds the listener and starts collecting. The only error this returns is
    /// a failure to bind the port, which makes a misconfigured dashboard fail
    /// loudly at boot instead of quietly never appearing.
    pub fn new(
        config: DashboardConfig,
        context: DashboardContext,
        exit: Arc<AtomicBool>,
    ) -> io::Result<Self> {
        let publisher = Arc::new(Publisher::new());
        let info_cache = Arc::new(RwLock::new(ValidatorInfoCache::default()));

        let runtime = Runtime::new()?;
        let listener = runtime.block_on(async { TcpListener::bind(config.listen_addr).await })?;
        log::info!(
            "dashboard: listening on http://{} (websocket at /websocket)",
            config.listen_addr
        );

        let server = {
            let publisher = publisher.clone();
            let exit = exit.clone();
            thread::Builder::new()
                .name("solDashSrv".to_string())
                .spawn(move || {
                    runtime.block_on(async move {
                        tokio::select! {
                            _ = server::serve(listener, publisher) => {}
                            _ = wait_for_exit(exit) => {}
                        }
                    });
                })?
        };

        // The one-time scan of validator info accounts walks the whole accounts
        // database and takes minutes. It runs off the collector's timer, and
        // the cache lock is taken only to merge the result, never across the
        // scan itself, or the collector would block behind it.
        let info_loader = {
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
                        "dashboard: scanned validator info in {:?}, {found} accounts, {loaded} \
                         cached",
                        started.elapsed()
                    );
                })?
        };

        let collector = {
            let exit = exit.clone();
            let interval = Duration::from_millis(config.poll_interval_ms.max(20));
            thread::Builder::new()
                .name("solDashColl".to_string())
                .spawn(move || {
                    let mut collector = Collector::new(context, publisher, config, info_cache);
                    collector.publish_static();
                    while !exit.load(Ordering::Relaxed) {
                        collector.tick();
                        thread::sleep(interval);
                    }
                })?
        };

        Ok(Self {
            exit,
            collector: Some(collector),
            server: Some(server),
            info_loader: Some(info_loader),
        })
    }

    pub fn join(mut self) -> thread::Result<()> {
        self.exit.store(true, Ordering::Relaxed);
        if let Some(handle) = self.collector.take() {
            handle.join()?;
        }
        if let Some(handle) = self.server.take() {
            handle.join()?;
        }
        if let Some(handle) = self.info_loader.take() {
            handle.join()?;
        }
        Ok(())
    }
}

async fn wait_for_exit(exit: Arc<AtomicBool>) {
    while !exit.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
