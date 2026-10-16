//! What an operator can set. Everything else is a constant next to the code
//! that reads it.

use {solana_pubkey::Pubkey, std::net::SocketAddr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardConfig {
    pub listen_addr: SocketAddr,
    /// What stops DNS rebinding; address literals are always accepted.
    pub allowed_hosts: Vec<String>,
    pub tip_payment_program_id: Option<Pubkey>,
    /// In basis points.
    pub commission_bps: Option<u16>,
}

impl DashboardConfig {
    pub fn new(listen_addr: SocketAddr) -> Self {
        Self {
            listen_addr,
            allowed_hosts: vec!["localhost".to_string()],
            tip_payment_program_id: None,
            commission_bps: None,
        }
    }
}
