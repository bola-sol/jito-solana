//! What an operator can set. Everything else the dashboard needs to know is a
//! constant next to the code that reads it: sampling rates in `collect`, buffer
//! sizes in `server`. Only these two reach a command-line flag, so only these
//! two travel as configuration.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardConfig {
    pub listen_addr: SocketAddr,
    /// Host names this dashboard will answer to.
    ///
    /// A browser can be steered at a service on the machine it is running on by
    /// resolving a name the attacker controls to a loopback address — the page
    /// then counts as same-origin and the origin check below cannot tell the
    /// difference. Pinning the acceptable `Host` is what stops that.
    ///
    /// Address literals are always accepted and are not listed here — they
    /// cannot be rebound, so testing on `127.0.0.1:10999` or on a public IP
    /// needs no configuration. Only names need naming, and an operator serving
    /// the dashboard through a reverse proxy must add the public one, because
    /// the proxy forwards the name the visitor typed.
    pub allowed_hosts: Vec<String>,
}

impl Default for DashboardConfig {
    fn default() -> Self {
        Self {
            // Loopback by default. The dashboard exposes validator internals
            // and has no authentication, so opening it to the network should
            // take a deliberate act.
            listen_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 10999),
            allowed_hosts: vec!["localhost".to_string()],
        }
    }
}
