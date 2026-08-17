//! A web dashboard for the Agave validator.
//!
//! The validator serves a single-page app and a websocket feed of its own
//! state on one port. Every value it reports comes from a handle the validator
//! already holds: bank forks, gossip, the blockstore, the leader schedule
//! cache. Enabling it takes one flag and no external services.

pub mod collect;
pub mod config;
pub mod context;
pub mod meters;
pub mod net_stats;
pub mod produced;
pub mod proto;
pub mod server;
pub mod service;
pub mod slots;
pub mod startup;
pub mod udp_drops;
pub mod validator_info;

pub use {
    config::DashboardConfig,
    context::{DashboardContext, StartupProgress, StartupProgressFn},
    service::DashboardService,
};
