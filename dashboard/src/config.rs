use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// How often validator state is sampled and diffed for publication.
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 200;

/// Number of recent slots kept in memory for the slot strip and sidebar.
pub const DEFAULT_SLOT_HISTORY: usize = 4096;

/// Number of TPS samples retained for the transactions chart. At one sample per
/// slot this is a little over ten minutes of history.
pub const DEFAULT_TPS_HISTORY: usize = 1500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardConfig {
    pub listen_addr: SocketAddr,
    pub poll_interval_ms: u64,
    pub slot_history: usize,
    pub tps_history: usize,
}

impl Default for DashboardConfig {
    fn default() -> Self {
        Self {
            // Loopback by default. The dashboard exposes validator internals
            // and has no authentication, so opening it to the network should
            // take a deliberate act.
            listen_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 10999),
            poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
            slot_history: DEFAULT_SLOT_HISTORY,
            tps_history: DEFAULT_TPS_HISTORY,
        }
    }
}
