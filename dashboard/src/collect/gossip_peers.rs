//! Every node in the gossip table with what it advertises about itself, gathered only while a
//! client is asking for it.

use {
    super::Collector,
    serde::Serialize,
    solana_clock::Slot,
    solana_gossip::{
        contact_info::ContactInfo,
        crds_data::{LowestSlot, SnapshotHashes},
    },
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    std::{
        collections::HashMap,
        sync::{Arc, atomic::Ordering},
    },
};

/// How long after the last request the list is still gathered.
const WANTED_FOR_MILLIS: u64 = 30_000;

/// One array per column, so several thousand rows stay compact.
#[derive(Debug, Default, Serialize)]
pub struct GossipPeers {
    /// Our root, which the snapshot and lowest slots are read against.
    pub root: Slot,
    /// Active stake in lamports, of which `stake` is each node's share.
    pub total_stake: u64,
    /// `(client, version)` pairs, indexed by `client`.
    pub clients: Vec<(String, String)>,
    pub identity: Vec<String>,
    pub name: Vec<Option<String>>,
    /// In lamports.
    pub stake: Vec<u64>,
    pub client: Vec<usize>,
    pub ip: Vec<Option<String>>,
    pub rpc: Vec<Option<u16>>,
    /// Milliseconds since this node last received the peer's contact record.
    pub heard_ago: Vec<u64>,
    /// When the peer's process started, in unix milliseconds.
    pub started: Vec<u64>,
    pub snapshot_full: Vec<Option<Slot>>,
    pub snapshot_incremental: Vec<Option<Slot>>,
    pub lowest: Vec<Option<Slot>>,
}

impl Collector {
    pub(super) fn collect_gossip_peers(
        &mut self,
        bank: &Bank,
        root: Slot,
        peers: &[(ContactInfo, u64)],
        now_millis: u64,
    ) {
        let wanted = self.replies.gossip_peers_wanted.load(Ordering::Relaxed);
        if now_millis.saturating_sub(wanted) > WANTED_FOR_MILLIS {
            return;
        }
        let list = self.gossip_peers(bank, root, peers, now_millis);
        let json = match serde_json::to_string(&list) {
            Ok(json) => json,
            Err(err) => {
                log::error!("dashboard: failed to encode the gossip peers: {err}");
                return;
            }
        };
        if let Ok(mut held) = self.replies.gossip_peers.write() {
            *held = Arc::from(json);
        }
    }

    fn gossip_peers(
        &self,
        bank: &Bank,
        root: Slot,
        peers: &[(ContactInfo, u64)],
        now_millis: u64,
    ) -> GossipPeers {
        let mut stakes: HashMap<Pubkey, u64> = HashMap::new();
        let mut total: u64 = 0;
        for (stake, account) in bank.vote_accounts().values() {
            if *stake == 0 {
                continue;
            }
            let held = stakes.entry(*account.node_pubkey()).or_insert(0);
            *held = held.saturating_add(*stake);
            total = total.saturating_add(*stake);
        }
        let stake_of = |key: &Pubkey| stakes.get(key).copied().unwrap_or(0);
        let mut rows: Vec<&(ContactInfo, u64)> = peers.iter().collect();
        rows.sort_by(|(a, _), (b, _)| {
            stake_of(b.pubkey())
                .cmp(&stake_of(a.pubkey()))
                .then_with(|| a.pubkey().cmp(b.pubkey()))
        });

        let mut list = GossipPeers {
            root,
            total_stake: total,
            ..GossipPeers::default()
        };
        // What each peer advertises, read in one short hold of the gossip table's lock.
        let advertised: Vec<(Option<Slot>, Option<Slot>, Option<Slot>)> = {
            let crds = self.ctx.cluster_info.gossip.crds.read().ok();
            rows.iter()
                .map(|(contact, _)| {
                    let Some(crds) = crds.as_ref() else {
                        return (None, None, None);
                    };
                    let key = *contact.pubkey();
                    let hashes = crds.get::<&SnapshotHashes>(key);
                    (
                        hashes.map(|hashes| hashes.full.0),
                        hashes.and_then(|hashes| {
                            hashes.incremental.iter().map(|(slot, _)| *slot).max()
                        }),
                        crds.get::<&LowestSlot>(key).map(|lowest| lowest.lowest),
                    )
                })
                .collect()
        };

        let mut client_at: HashMap<(String, String), usize> = HashMap::new();
        let info = self.info_cache.read().unwrap();
        for ((contact, heard_at), (full, incremental, lowest)) in rows.into_iter().zip(advertised) {
            let key = contact.pubkey();
            let client = (
                contact.version().client().to_string(),
                contact.version().to_string(),
            );
            let index = match client_at.get(&client) {
                Some(index) => *index,
                None => {
                    let index = list.clients.len();
                    client_at.insert(client.clone(), index);
                    list.clients.push(client);
                    index
                }
            };
            list.identity.push(key.to_string());
            list.name
                .push(info.get(key).and_then(|info| info.name.clone()));
            list.stake.push(stake_of(key));
            list.client.push(index);
            list.ip
                .push(contact.gossip().map(|addr| addr.ip().to_string()));
            list.rpc.push(contact.rpc().map(|addr| addr.port()));
            list.heard_ago.push(now_millis.saturating_sub(*heard_at));
            list.started
                .push(contact.outset().checked_div(1_000).unwrap_or(0));
            list.snapshot_full.push(full);
            list.snapshot_incremental.push(incremental);
            list.lowest.push(lowest);
        }
        list
    }
}
