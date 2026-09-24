//! Our vote's reward certificates walked from block footers, the epoch's tally of them, and the
//! miss and written lists read from that tally.

use {
    super::Collector,
    crate::{
        certs,
        history::HAS_CLOCK,
        produced::{BlockCertificate, CertificateValidator},
        proto::TOPIC_SUMMARY,
        validator_info::ValidatorInfoCache,
    },
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_gossip::contact_info::ContactInfo,
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    std::{collections::HashMap, sync::Arc},
};

const CERT_SLOTS_PER_TICK: u64 = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct MissList {
    pub epoch: Epoch,
    pub since_slot: Slot,
    pub rewarded: u64,
    pub ranks: u32,
    pub writers: Vec<MissWriter>,
    pub validators: Vec<MissValidator>,
    /// Oldest first.
    pub rows: Vec<MissRow>,
    pub written: WrittenList,
}

pub(super) type Contacts<'a> = HashMap<Pubkey, &'a ContactInfo>;

struct Described {
    name: Option<String>,
    client: Option<String>,
    version: Option<String>,
    ip: Option<String>,
}

fn describe(key: &Pubkey, info: &ValidatorInfoCache, heard: &Contacts) -> Described {
    let contact = heard.get(key);
    Described {
        name: info.get(key).and_then(|info| info.name.clone()),
        client: contact.map(|contact| contact.version().client().to_string()),
        version: contact.map(|contact| contact.version().to_string()),
        ip: contact
            .and_then(|contact| contact.gossip())
            .map(|addr| addr.ip().to_string()),
    }
}

pub struct MissReplies {
    pub misses: Arc<str>,
    pub written: Arc<str>,
}

impl MissReplies {
    pub fn new(list: &MissList) -> Self {
        Self {
            misses: json_or_null(list),
            written: json_or_null(&list.written),
        }
    }
}

impl Default for MissReplies {
    fn default() -> Self {
        Self::new(&MissList::default())
    }
}

fn json_or_null<T: Serialize>(value: &T) -> Arc<str> {
    match serde_json::to_string(value) {
        Ok(json) => Arc::from(json),
        Err(err) => {
            log::error!("dashboard: failed to encode the miss list: {err}");
            Arc::from("null")
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WrittenList {
    /// Certificates from any writer that paid anybody, which `left_out_everywhere`
    /// is of.
    pub rewarded: u64,
    pub certificates: u64,
    /// Of those, the ones that left no regular out.
    pub carried_all: u64,
    pub rows: Vec<WrittenRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WrittenRow {
    pub identity: String,
    pub name: Option<String>,
    pub client: Option<String>,
    pub version: Option<String>,
    pub ip: Option<String>,
    pub left_out_of_ours: u64,
    pub left_out_everywhere: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissValidator {
    pub identity: String,
    pub name: Option<String>,
    pub ip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissWriter {
    pub identity: String,
    pub name: Option<String>,
    pub client: Option<String>,
    pub version: Option<String>,
    pub ip: Option<String>,
    pub certificates: u64,
    pub misses: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MissRow {
    pub slot: Slot,
    /// In unix milliseconds.
    pub time_millis: Option<u64>,
    pub place: certs::Place,
    pub paid_ranks: u32,
    /// Indices into `validators`: the regulars left out beside this node.
    pub others: Vec<u32>,
    pub writer: Option<u32>,
    pub vote: Option<certs::VoteSent>,
}

#[derive(Default)]
pub(super) struct CertificateWalk {
    /// The slot the certificate walk started at and the last it has read. Marks before the start
    /// are dropped, since an unwalked slot looks like one before alpenglow.
    walk: Option<(Slot, Slot)>,
    tally: Option<certs::Tally>,
}

impl Collector {
    pub(super) fn collect_vote_certs(&mut self, root_bank: &Bank) {
        if !root_bank.is_alpenglow() || self.last_completed_slot == 0 {
            return;
        }
        let (floor, from) = match self.certificates.walk {
            Some((floor, read_to)) => (floor, read_to.saturating_add(1)),
            None => (self.last_completed_slot, self.last_completed_slot),
        };
        let to = self
            .last_completed_slot
            .min(from.saturating_add(CERT_SLOTS_PER_TICK).saturating_sub(1));
        if to < from {
            return;
        }
        let (read_to, marks) = certs::walk(
            &self.ctx.blockstore,
            root_bank,
            &self.ctx.vote_account,
            from,
            to,
        );
        if let Some(read_to) = read_to {
            self.certificates.walk = Some((floor, read_to));
        }
        let schedule = root_bank.epoch_schedule();
        let spans = self.snapshots.spans().collect::<Vec<_>>();
        if let Some(tally) = self.certificates.tally.as_mut() {
            for (slot, vote) in self.metrics_tap.take_vote_tracks() {
                tally.note_vote(slot, vote);
            }
        }
        for mark in marks {
            if mark.slot < floor {
                continue;
            }
            let epoch = schedule.get_epoch(mark.slot);
            if self
                .certificates
                .tally
                .as_ref()
                .is_none_or(|tally| tally.epoch() != epoch)
            {
                self.certificates.tally = Some(self.new_tally(root_bank, epoch, mark.slot));
                let start = schedule.get_first_slot_in_epoch(epoch);
                self.snapshots.forget_before(start);
            }
            let detail = Some(self.miss_detail(root_bank, mark.slot));
            let left_out = self.certificates.tally.as_mut().and_then(|tally| {
                tally.add(&mark, &spans, detail);
                tally.left_out(&mark)
            });
            let updated = self.slots.update(mark.slot, |entry| {
                entry.reward = Some(mark.reward);
                entry.left_out = left_out.map(|count| u16::try_from(count).unwrap_or(u16::MAX));
            });
            if let Some(entry) = updated {
                self.publish_slot(&entry);
            }
        }
        if let Some(tally) = &self.certificates.tally {
            let info = self.info_cache.read().unwrap();
            let participation =
                tally.participation(|leader| info.get(leader).and_then(|info| info.name.clone()));
            drop(info);
            self.debounces.vote_participation.publish(
                &self.publisher,
                TOPIC_SUMMARY,
                "vote_participation",
                participation,
            );
        }
    }

    pub(super) fn collect_miss_list(&self, bank: &Bank, heard: &Contacts) {
        let Some(tally) = &self.certificates.tally else {
            return;
        };
        let records = tally.records();
        let epoch_start = bank.epoch_schedule().get_first_slot_in_epoch(tally.epoch());
        let rank_map = bank.get_rank_map(epoch_start);
        let mut writers: Vec<MissWriter> = Vec::new();
        let mut writer_at: HashMap<Pubkey, u32> = HashMap::new();
        let mut validators: Vec<MissValidator> = Vec::new();
        let mut validator_at: HashMap<u32, u32> = HashMap::new();
        let info = self.info_cache.read().unwrap();
        let history = self.history.read().unwrap();
        let rows = records
            .iter()
            .map(|record| {
                let others = record
                    .others
                    .iter()
                    .filter_map(|rank| {
                        if let Some(at) = validator_at.get(rank) {
                            return Some(*at);
                        }
                        let key = rank_map
                            .and_then(|map| {
                                map.get_pubkey_stake_entry(usize::try_from(*rank).ok()?)
                            })
                            .map(|entry| entry.node_pubkey)?;
                        let described = describe(&key, &info, heard);
                        validators.push(MissValidator {
                            identity: key.to_string(),
                            name: described.name,
                            ip: described.ip,
                        });
                        let at = u32::try_from(validators.len().saturating_sub(1)).ok()?;
                        validator_at.insert(*rank, at);
                        Some(at)
                    })
                    .collect();
                let writer = record.writer.map(|key| {
                    let at = *writer_at.entry(key).or_insert_with(|| {
                        let described = describe(&key, &info, heard);
                        writers.push(MissWriter {
                            identity: key.to_string(),
                            name: described.name,
                            client: described.client,
                            version: described.version,
                            ip: described.ip,
                            certificates: tally.writer_certificates(&key),
                            misses: 0,
                        });
                        u32::try_from(writers.len().saturating_sub(1)).unwrap_or(u32::MAX)
                    });
                    if let Some(writer) =
                        usize::try_from(at).ok().and_then(|at| writers.get_mut(at))
                    {
                        writer.misses = writer.misses.saturating_add(1);
                    }
                    at
                });
                MissRow {
                    slot: record.slot,
                    time_millis: history
                        .get(record.slot)
                        .filter(|row| (row.flags & HAS_CLOCK) != 0)
                        .map(|row| row.time_millis),
                    place: record.place,
                    paid_ranks: record.paid_ranks,
                    others,
                    writer,
                    vote: record.vote,
                }
            })
            .collect();
        drop(history);
        let summary = tally.written();
        let written_rows = (0..summary.unpaid_everywhere.len())
            .filter_map(|rank| {
                let key = rank_map
                    .and_then(|map| map.get_pubkey_stake_entry(rank))
                    .map(|entry| entry.node_pubkey)?;
                let described = describe(&key, &info, heard);
                Some(WrittenRow {
                    identity: key.to_string(),
                    name: described.name,
                    client: described.client,
                    version: described.version,
                    ip: described.ip,
                    left_out_of_ours: summary.unpaid_by_rank.get(rank).copied().unwrap_or(0),
                    left_out_everywhere: summary.unpaid_everywhere.get(rank).copied().unwrap_or(0),
                })
            })
            .collect();
        drop(info);
        let list = MissList {
            epoch: tally.epoch(),
            since_slot: tally.since_slot(),
            rewarded: tally.rewarded(),
            ranks: tally.ranks(),
            writers,
            validators,
            rows,
            written: WrittenList {
                rewarded: tally.rewarded(),
                certificates: summary.certificates,
                carried_all: summary.carried_all,
                rows: written_rows,
            },
        };
        let replies = MissReplies::new(&list);
        *self.misses.write().unwrap() = replies;
    }

    pub(super) fn fill_certificates(&mut self, bank: &Bank, heard: &Contacts) -> bool {
        let Some(tally) = &self.certificates.tally else {
            return false;
        };
        let pending: Vec<Slot> = self
            .produced
            .blocks()
            .iter()
            .filter(|block| block.certificate.is_none())
            .map(|block| block.slot)
            .collect();
        if pending.is_empty() {
            return false;
        }
        let info = self.info_cache.read().unwrap();
        let regulars = tally.regulars();
        let mut found = Vec::new();
        for slot in pending {
            let Some(rewards) = certs::rewarded_slot(slot) else {
                continue;
            };
            let Some(written) = tally.written_for(rewards) else {
                continue;
            };
            let map = bank.get_rank_map(rewards);
            let ranks = map.map_or(0, |map| map.len());
            let stake_of = |rank: usize| {
                map.and_then(|map| map.get_pubkey_stake_entry(rank))
                    .map_or(0, |entry| entry.stake.get())
            };
            let total = (0..ranks).fold(0u64, |sum, rank| sum.saturating_add(stake_of(rank)));
            let unpaid = written
                .unpaid
                .iter()
                .filter_map(|rank| usize::try_from(*rank).ok())
                .fold(0u64, |sum, rank| sum.saturating_add(stake_of(rank)));
            let stake_paid = if total > 0 {
                total.saturating_sub(unpaid) as f64 / total as f64
            } else {
                0.0
            };
            let left_out = written
                .unpaid
                .iter()
                .filter_map(|rank| {
                    let at = usize::try_from(*rank).ok()?;
                    if !regulars.get(at).copied().unwrap_or(false) {
                        return None;
                    }
                    let key = map
                        .and_then(|map| map.get_pubkey_stake_entry(at))
                        .map(|entry| entry.node_pubkey)?;
                    let described = describe(&key, &info, heard);
                    Some(CertificateValidator {
                        identity: key.to_string(),
                        name: described.name,
                        ip: described.ip,
                    })
                })
                .collect();
            let leader = self
                .ctx
                .leader_schedule_cache
                .slot_leader_at(rewards, Some(bank))
                .map(|leader| leader.id);
            found.push((
                slot,
                BlockCertificate {
                    rewards,
                    leader: leader.map(|key| key.to_string()),
                    leader_name: leader
                        .and_then(|key| info.get(&key).and_then(|info| info.name.clone())),
                    // A tie reads as notarized.
                    notarized: written.notar >= written.skip,
                    paid: written.paid,
                    ranks: u32::try_from(ranks).unwrap_or(u32::MAX),
                    stake_paid,
                    notar: written.notar,
                    skip: written.skip,
                    ours_in: written.ours_in,
                    usual: tally.usual_paid(),
                    left_out,
                },
            ));
        }
        drop(info);
        let mut changed = false;
        for (slot, certificate) in found {
            changed |= self.produced.set_certificate(slot, certificate);
        }
        changed
    }

    /// An unknown leader schedule counts as no leader slots; it is known for every slot the root
    /// has passed.
    fn new_tally(&self, bank: &Bank, epoch: Epoch, since_slot: Slot) -> certs::Tally {
        let schedule = bank.epoch_schedule();
        certs::Tally::new(
            epoch,
            since_slot,
            schedule.get_first_slot_in_epoch(epoch),
            schedule.get_slots_in_epoch(epoch),
            self.leader_slots_in_epoch(bank, epoch).unwrap_or_default(),
        )
    }

    /// Who wrote the certificate for `slot`, and whether this node finished
    /// replaying `slot` only after that leader's own slot had begun arriving.
    fn miss_detail(&self, bank: &Bank, slot: Slot) -> certs::MissDetail {
        let writer_slot = certs::writer_slot(slot);
        let writer = self
            .ctx
            .leader_schedule_cache
            .slot_leader_at(writer_slot, Some(bank))
            .map(|leader| leader.id);
        let late = match (self.slots.get(slot), self.slots.get(writer_slot)) {
            (Some(voted), Some(written)) => {
                match (
                    voted.time_millis,
                    voted.replayed_millis,
                    written.time_millis,
                ) {
                    (Some(arrived), Some(replayed), Some(writer_arrived)) => {
                        arrived.saturating_add(replayed) > writer_arrived
                    }
                    _ => false,
                }
            }
            _ => false,
        };
        certs::MissDetail { writer, late }
    }
}
