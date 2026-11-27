//! Our blocks, turns and per-slot reports read back from the rewind log at startup, so a restart keeps
//! the slot page's history.

use {
    crate::{
        metrics_tap::{SlotCost, SlotWaterfall, keep_newest},
        produced::{BlockFees, MAX_HELD_BLOCKS, ProducedBlock},
        rewind_log::RewindLog,
        turns::LeaderTurn,
    },
    serde::de::DeserializeOwned,
    solana_clock::Slot,
    std::collections::BTreeMap,
};

const PREFIX: &str = r#"{"topic":"summary","key":""#;

const VALUE: &str = r#"","value":"#;

/// What the log held of ours, each slot as last recorded.
#[derive(Debug, Default)]
pub struct Refilled {
    pub blocks: BTreeMap<Slot, ProducedBlock>,
    pub turns: BTreeMap<Slot, LeaderTurn>,
    pub waterfalls: BTreeMap<Slot, SlotWaterfall>,
    pub costs: BTreeMap<Slot, SlotCost>,
    pub fees: BTreeMap<Slot, BlockFees>,
    pub segments: usize,
    /// Lines with one of our keys that did not parse.
    pub unread: usize,
}

/// Reads `segments`, as `RewindLog::range` lists them, oldest first; `stop` is asked between
/// segments.
pub fn read(log: &RewindLog, segments: &[(u64, u64, usize)], stop: impl Fn() -> bool) -> Refilled {
    let mut refilled = Refilled::default();
    for (start, _, blocks) in segments {
        if stop() {
            break;
        }
        for block in 0..*blocks {
            // A segment pruned since it was listed reads as nothing.
            let Some(block) = log.read(*start, block) else {
                break;
            };
            for line in block.text.lines() {
                refilled.apply(line);
            }
        }
        refilled.segments = refilled.segments.saturating_add(1);
    }
    refilled.finish();
    refilled
}

/// The key and the value's text of a summary line, the rest unparsed.
fn split(line: &str) -> Option<(&str, &str)> {
    let (_, json) = line.split_once(' ')?;
    let (key, value) = json.strip_prefix(PREFIX)?.split_once(VALUE)?;
    Some((key, value.strip_suffix('}')?))
}

fn parse<T: DeserializeOwned>(value: &str) -> Option<T> {
    serde_json::from_str(value).ok()
}

impl Refilled {
    fn apply(&mut self, line: &str) {
        let Some((key, value)) = split(line) else {
            return;
        };
        let read = match key {
            "produced_block" => parse(value).map(|block: ProducedBlock| {
                self.blocks.insert(block.slot, block);
            }),
            "produced_blocks" => parse(value).map(|list| self.whole(list)),
            "produced_turns" => parse(value).map(|turns: Vec<LeaderTurn>| {
                self.turns
                    .extend(turns.into_iter().map(|turn| (turn.first, turn)));
            }),
            "produced_floor" => parse(value).map(|floor| self.hold_from(floor)),
            "produced_dropped" => parse(value).map(|slots: Vec<Slot>| {
                for slot in slots {
                    self.blocks.remove(&slot);
                }
            }),
            "slot_waterfall" => parse(value).map(|waterfall: SlotWaterfall| {
                self.waterfalls.insert(waterfall.slot, waterfall);
            }),
            "slot_waterfalls" => parse(value).map(|list: Vec<SlotWaterfall>| {
                self.waterfalls.extend(
                    list.into_iter()
                        .map(|waterfall| (waterfall.slot, waterfall)),
                );
            }),
            "slot_cost" => parse(value).map(|cost: SlotCost| {
                self.costs.insert(cost.slot, cost);
            }),
            "slot_costs" => parse(value).map(|list: Vec<SlotCost>| {
                self.costs
                    .extend(list.into_iter().map(|cost| (cost.slot, cost)));
            }),
            "block_fees" => parse(value).map(|fees: BlockFees| {
                self.fees.insert(fees.slot, fees);
            }),
            _ => return,
        };
        if read.is_none() {
            self.unread = self.unread.saturating_add(1);
        }
    }

    /// The newest blocks as the store held them, so one missing from their span had been dropped.
    fn whole(&mut self, list: Vec<ProducedBlock>) {
        let (Some(first), Some(last)) = (list.first(), list.last()) else {
            return;
        };
        let mut span = self.blocks.split_off(&first.slot);
        let mut above = span.split_off(&last.slot.saturating_add(1));
        self.blocks.append(&mut above);
        self.blocks
            .extend(list.into_iter().map(|block| (block.slot, block)));
    }

    fn hold_from(&mut self, floor: Slot) {
        self.blocks = self.blocks.split_off(&floor);
        self.turns = self.turns.split_off(&floor);
        self.waterfalls = self.waterfalls.split_off(&floor);
        self.costs = self.costs.split_off(&floor);
        self.fees = self.fees.split_off(&floor);
    }

    fn finish(&mut self) {
        keep_newest(&mut self.blocks, MAX_HELD_BLOCKS);
        keep_newest(&mut self.waterfalls, MAX_HELD_BLOCKS);
        keep_newest(&mut self.costs, MAX_HELD_BLOCKS);
        let blocks = &self.blocks;
        self.fees.retain(|slot, _| blocks.contains_key(slot));
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{
            metrics_tap::{SchedulerSource, SchedulerTotals},
            produced::{sample_block as block, tests::turn},
            proto::{Publisher, TOPIC_SUMMARY},
            rewind_log::{Recorder, Settings},
        },
        std::{
            fs::OpenOptions,
            io::Write,
            path::Path,
            sync::{
                Arc,
                atomic::{AtomicU64, Ordering},
            },
        },
    };

    fn settings() -> Settings {
        Settings {
            segment_ms: 60_000,
            block_raw: 4096,
            block_ms: 5_000,
            retain_ms: 600_000,
            cap_bytes: u64::MAX,
        }
    }

    /// Records what `publish` sends, a step at a time, then reads it all back.
    fn record(dir: &Path, publish: impl FnOnce(&Publisher, &mut dyn FnMut())) -> Refilled {
        let log = Arc::new(RewindLog::open(dir).unwrap());
        let publisher = Arc::new(Publisher::new());
        let now = Arc::new(AtomicU64::new(1_000_000));
        let clock = now.clone();
        let mut recorder = Recorder::new(
            log,
            publisher.clone(),
            settings(),
            Box::new(move || clock.load(Ordering::Relaxed)),
        );
        let mut step = || {
            recorder.step();
            now.fetch_add(1_000, Ordering::Relaxed);
        };
        step();
        publish(&publisher, &mut step);
        step();
        recorder.close();
        let log = RewindLog::open(dir).unwrap();
        read(&log, &log.range(), || false)
    }

    fn slots<T>(held: &BTreeMap<Slot, T>) -> Vec<Slot> {
        held.keys().copied().collect()
    }

    /// Encoded as the feed sends it, then read back as a refill reads it.
    fn round_trip<T: serde::Serialize + DeserializeOwned>(key: &str, value: &T) -> T {
        let message = crate::proto::encode(TOPIC_SUMMARY, key, value);
        let line = format!("1 {}", message.text());
        let (read_key, text) = split(&line).unwrap();
        assert_eq!(read_key, key);
        parse(text).unwrap()
    }

    #[test]
    fn test_every_recorded_type_reads_back_as_sent() {
        use crate::{
            metrics_tap::{LeaderTiming, StageTimes},
            produced::{
                BlockCertificate, Bundles, CertificateValidator, Execution, TopFeePayer,
                TopFeeTransaction,
            },
            versions::TxVersions,
        };
        let ip: std::net::IpAddr = "1.1.1.1".parse().unwrap();
        let mut full = block(10);
        full.slot_time_millis = Some(4_000);
        full.duration_nanos = Some(400_000_000);
        full.tips = Some(7);
        full.bundles = Some(Bundles {
            sanitized: 3,
            executed: 2,
        });
        full.versions = Some(TxVersions {
            legacy: 1,
            v0: 2,
            v1: 3,
        });
        full.execution = Some(Execution {
            non_vote: StageTimes {
                load_execute: 9,
                ..StageTimes::default()
            },
            workers: 4,
            longest_batch: 5,
            votes: Some(StageTimes::default()),
            window_millis: 402,
        });
        full.certificate = Some(BlockCertificate {
            rewards: 12,
            leader: Some(solana_pubkey::Pubkey::new_unique()),
            leader_name: Some("leader".to_owned()),
            notarized: true,
            paid: 3,
            ranks: 4,
            stake_paid: 0.75,
            notar: 3,
            skip: 1,
            ours_in: true,
            usual: Some(3),
            left_out: vec![CertificateValidator {
                identity: solana_pubkey::Pubkey::new_unique(),
                name: None,
                ip: Some(ip),
                country: crate::geoip::country(ip),
            }],
        });
        full.leading = Some(LeaderTiming {
            open_millis: Some(380),
            fast_handover: true,
            ..LeaderTiming::default()
        });
        assert!(
            full.certificate.as_ref().unwrap().left_out[0]
                .country
                .is_some()
        );
        assert_eq!(round_trip("produced_block", &full), full);

        let turn = turn(8, 11);
        assert_eq!(round_trip("produced_turns", &vec![turn.clone()]), [turn]);
        let waterfall = SlotWaterfall {
            slot: 10,
            source: SchedulerSource::Bam,
            counts: SchedulerTotals {
                received: 5,
                ..Default::default()
            },
        };
        assert_eq!(round_trip("slot_waterfall", &waterfall), waterfall);
        let cost = SlotCost {
            slot: 10,
            costliest_account: "account".to_owned(),
            costliest_cost: 4,
            ..SlotCost::default()
        };
        assert_eq!(round_trip("slot_cost", &cost), cost);
        let payer = solana_pubkey::Pubkey::new_unique();
        let fees = BlockFees {
            slot: 10,
            payer_count: 1,
            payers: vec![TopFeePayer {
                payer,
                transactions: 2,
                failed: 1,
                priority: 3,
                paid: 4,
            }],
            transactions: vec![TopFeeTransaction {
                signature: "sig".to_owned(),
                payer,
                failed: None,
                priority: 3,
                paid: 4,
            }],
        };
        assert_eq!(round_trip("block_fees", &fees), fees);
    }

    #[test]
    fn test_the_last_copy_of_a_block_wins() {
        let dir = tempfile::tempdir().unwrap();
        let refilled = record(dir.path(), |publisher, step| {
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 10, &block(10));
            step();
            let mut filled = block(10);
            filled.duration_nanos = Some(400_000_000);
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 10, &filled);
        });
        assert_eq!(slots(&refilled.blocks), [10]);
        assert_eq!(refilled.blocks[&10].duration_nanos, Some(400_000_000));
        assert_eq!(refilled.unread, 0);
    }

    #[test]
    fn test_a_block_missing_from_a_later_whole_list_was_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let refilled = record(dir.path(), |publisher, step| {
            for slot in [10, 11, 12, 13] {
                publisher.publish_update(TOPIC_SUMMARY, "produced_block", slot, &block(slot));
            }
            step();
            let list = vec![block(10), block(11), block(13)];
            publisher.publish(TOPIC_SUMMARY, "produced_blocks", &list);
        });
        assert_eq!(slots(&refilled.blocks), [10, 11, 13]);
    }

    #[test]
    fn test_a_short_list_after_a_restart_drops_nothing_older() {
        let dir = tempfile::tempdir().unwrap();
        let refilled = record(dir.path(), |publisher, step| {
            for slot in [10, 11] {
                publisher.publish_update(TOPIC_SUMMARY, "produced_block", slot, &block(slot));
            }
            step();
            publisher.publish(TOPIC_SUMMARY, "produced_blocks", &vec![block(20)]);
            step();
            publisher.publish(
                TOPIC_SUMMARY,
                "produced_blocks",
                &Vec::<ProducedBlock>::new(),
            );
        });
        assert_eq!(slots(&refilled.blocks), [10, 11, 20]);
    }

    #[test]
    fn test_a_block_a_restart_turned_away_stays_away() {
        let dir = tempfile::tempdir().unwrap();
        let refilled = record(dir.path(), |publisher, step| {
            for slot in [10, 11, 12] {
                publisher.publish_update(TOPIC_SUMMARY, "produced_block", slot, &block(slot));
            }
            step();
            publisher.publish_ephemeral(TOPIC_SUMMARY, "produced_dropped", &vec![11u64, 12]);
        });
        assert_eq!(slots(&refilled.blocks), [10]);
    }

    #[test]
    fn test_a_floor_drops_what_is_older() {
        let dir = tempfile::tempdir().unwrap();
        let refilled = record(dir.path(), |publisher, step| {
            for slot in [10, 20] {
                publisher.publish_update(TOPIC_SUMMARY, "produced_block", slot, &block(slot));
                publisher.publish_update(
                    TOPIC_SUMMARY,
                    "slot_cost",
                    slot,
                    &SlotCost {
                        slot,
                        ..SlotCost::default()
                    },
                );
            }
            step();
            publisher.publish(TOPIC_SUMMARY, "produced_floor", &15u64);
        });
        assert_eq!(slots(&refilled.blocks), [20]);
        assert_eq!(slots(&refilled.costs), [20]);
    }

    #[test]
    fn test_turns_waterfalls_and_fees_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let refilled = record(dir.path(), |publisher, _| {
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 10, &block(10));
            let waterfall = SlotWaterfall {
                slot: 10,
                source: SchedulerSource::Scheduler,
                counts: SchedulerTotals::default(),
            };
            publisher.publish(TOPIC_SUMMARY, "slot_waterfalls", &vec![waterfall]);
            publisher.publish(TOPIC_SUMMARY, "produced_turns", &vec![turn(8, 11)]);
            let fees = |slot| BlockFees {
                slot,
                payer_count: 2,
                payers: Vec::new(),
                transactions: Vec::new(),
            };
            publisher.publish_update(TOPIC_SUMMARY, "block_fees", 10, &fees(10));
            // A block not held keeps no fees.
            publisher.publish_update(TOPIC_SUMMARY, "block_fees", 11, &fees(11));
        });
        assert_eq!(slots(&refilled.waterfalls), [10]);
        assert_eq!(slots(&refilled.turns), [8]);
        assert_eq!(slots(&refilled.fees), [10]);
    }

    #[test]
    fn test_a_line_that_does_not_parse_is_counted_and_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let refilled = record(dir.path(), |publisher, _| {
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 10, &"not a block");
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 11, &block(11));
            publisher.publish(TOPIC_SUMMARY, "cluster", &"testnet");
        });
        assert_eq!(slots(&refilled.blocks), [11]);
        assert_eq!(refilled.unread, 1);
    }

    #[test]
    fn test_a_tail_cut_off_by_a_crash_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), |publisher, _| {
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 10, &block(10));
        });
        let path = std::fs::read_dir(dir.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(&[0x50, 0x2a, 0x4d, 0x18, 1, 2, 3]).unwrap();
        let log = RewindLog::open(dir.path()).unwrap();
        let refilled = read(&log, &log.range(), || false);
        assert_eq!(slots(&refilled.blocks), [10]);
    }

    #[test]
    fn test_a_segment_gone_since_listed_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), |publisher, _| {
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 10, &block(10));
        });
        let log = RewindLog::open(dir.path()).unwrap();
        let mut listed = log.range();
        listed.insert(0, (1, 2, 3));
        let refilled = read(&log, &listed, || false);
        assert_eq!(slots(&refilled.blocks), [10]);
        assert_eq!(refilled.segments, 2);
    }

    #[test]
    fn test_stop_ends_the_read() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), |publisher, _| {
            publisher.publish_update(TOPIC_SUMMARY, "produced_block", 10, &block(10));
        });
        let log = RewindLog::open(dir.path()).unwrap();
        let refilled = read(&log, &log.range(), || true);
        assert!(refilled.blocks.is_empty());
        assert_eq!(refilled.segments, 0);
    }

    #[test]
    fn test_the_newest_are_kept_under_the_cap() {
        let mut refilled = Refilled::default();
        let over = u64::try_from(MAX_HELD_BLOCKS).unwrap().saturating_add(2);
        for slot in 0..over {
            refilled.blocks.insert(slot, block(slot));
        }
        refilled.finish();
        assert_eq!(refilled.blocks.len(), MAX_HELD_BLOCKS);
        assert_eq!(refilled.blocks.keys().next(), Some(&2));
    }
}
