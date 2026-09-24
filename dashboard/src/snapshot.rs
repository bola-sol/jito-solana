//! The newest snapshot archives on disk, read as `getHighestSnapshotSlot`
//! reads them, and how often new ones are due.

use {
    crate::certs::Span,
    agave_snapshots::{
        SnapshotInterval, paths, snapshot_archive_info::SnapshotArchiveInfoGetter,
        snapshot_config::SnapshotConfig,
    },
    serde::Serialize,
    solana_clock::Slot,
    std::{
        collections::{BTreeMap, HashSet},
        fs,
        path::Path,
        time::{Duration, SystemTime, UNIX_EPOCH},
    },
};

/// A staging file older than this is a leftover from a crash, not a write.
const STALE_WRITE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Archive {
    pub slot: Slot,
    pub written_millis: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Writing {
    pub slot: Slot,
    pub since_millis: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Written {
    pub slot: Slot,
    pub took_millis: u64,
    pub fell_behind_slots: u64,
}

/// A `None` interval is disabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snapshots {
    pub full: Option<Archive>,
    pub incremental: Option<Archive>,
    pub full_interval: Option<u64>,
    pub incremental_interval: Option<u64>,
    /// Kind unknown: both kinds stage under the same name.
    pub writing: Option<Writing>,
    pub last_written: Option<Written>,
}

/// Follows each write from its staging file to its end, and the slots each one spanned.
#[derive(Debug, Default)]
pub struct SnapshotTracker {
    /// The write in progress, the most slots the node fell behind during it, and where it began.
    writing: Option<(Writing, u64, Slot)>,
    last: Option<Written>,
    spans: Vec<Span>,
}

impl SnapshotTracker {
    /// Takes what the archive directories show now and returns it with the last write filled in.
    pub fn observe(
        &mut self,
        read: Option<Snapshots>,
        completed: Slot,
        now_millis: u64,
    ) -> Option<Snapshots> {
        let writing = read.as_ref().and_then(|snapshots| snapshots.writing);
        match (writing, self.writing.take()) {
            (Some(writing), None) => self.writing = Some((writing, 0, completed)),
            (Some(writing), Some((_, fell_behind, from))) => {
                self.writing = Some((writing, fell_behind, from));
            }
            (None, Some((writing, fell_behind_slots, from))) => {
                self.last = Some(Written {
                    slot: writing.slot,
                    took_millis: now_millis.saturating_sub(writing.since_millis),
                    fell_behind_slots,
                });
                self.spans.push(Span {
                    from,
                    to: Some(completed),
                });
            }
            (None, None) => {}
        }
        read.map(|snapshots| Snapshots {
            last_written: self.last,
            ..snapshots
        })
    }

    pub fn note_behind(&mut self, slots: u64) {
        if let Some((_, fell_behind, _)) = &mut self.writing {
            *fell_behind = (*fell_behind).max(slots);
        }
    }

    /// Finished writes, then the one in progress with no end.
    pub fn spans(&self) -> impl Iterator<Item = Span> + '_ {
        self.spans
            .iter()
            .copied()
            .chain(self.writing.map(|(_, _, from)| Span { from, to: None }))
    }

    pub fn forget_before(&mut self, slot: Slot) {
        self.spans
            .retain(|span| span.to.is_none_or(|to| to >= slot));
    }
}

pub fn read(config: &SnapshotConfig) -> Option<Snapshots> {
    if !config.should_generate_snapshots() {
        return None;
    }
    let full = paths::get_highest_full_snapshot_archive_info(&config.full_snapshot_archives_dir);
    let incremental = full.as_ref().and_then(|full| {
        paths::get_highest_incremental_snapshot_archive_info(
            &config.incremental_snapshot_archives_dir,
            full.slot(),
        )
    });
    Some(Snapshots {
        full: full.as_ref().map(archive),
        incremental: incremental.as_ref().map(archive),
        full_interval: slots_of(config.full_snapshot_archive_interval),
        incremental_interval: slots_of(config.incremental_snapshot_archive_interval),
        writing: writing_in(&[
            &config.full_snapshot_archives_dir,
            &config.incremental_snapshot_archives_dir,
        ]),
        last_written: None,
    })
}

fn archive(info: &impl SnapshotArchiveInfoGetter) -> Archive {
    Archive {
        slot: info.slot(),
        written_millis: written(info.path()),
    }
}

fn written(path: &Path) -> Option<u64> {
    millis(fs::metadata(path).ok()?.modified().ok()?)
}

fn millis(time: SystemTime) -> Option<u64> {
    u64::try_from(time.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

/// Its directory dates the start, and a file untouched for a minute is a leftover.
fn writing_in(dirs: &[&Path]) -> Option<Writing> {
    let now = SystemTime::now();
    let mut seen: HashSet<&Path> = HashSet::new();
    let mut staged: BTreeMap<Slot, (bool, SystemTime)> = BTreeMap::new();
    for &dir in dirs {
        if !seen.insert(dir) {
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(rest) = name
                .to_str()
                .and_then(|name| name.strip_prefix(paths::TMP_SNAPSHOT_ARCHIVE_PREFIX))
            else {
                continue;
            };
            let Some(slot) = rest
                .split(['-', '.'])
                .next()
                .and_then(|slot| slot.parse().ok())
            else {
                continue;
            };
            let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
                continue;
            };
            let fresh = entry.file_type().is_ok_and(|kind| kind.is_file())
                && now.duration_since(modified).unwrap_or_default() <= STALE_WRITE;
            let (writing, since) = staged.entry(slot).or_insert((false, modified));
            *writing |= fresh;
            *since = (*since).min(modified);
        }
    }
    staged
        .into_iter()
        .filter(|(_, (writing, _))| *writing)
        .filter_map(|(slot, (_, since))| {
            Some(Writing {
                slot,
                since_millis: millis(since)?,
            })
        })
        .next_back()
}

fn slots_of(interval: SnapshotInterval) -> Option<u64> {
    match interval {
        SnapshotInterval::Slots(slots) => Some(slots.get()),
        SnapshotInterval::Disabled => None,
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        agave_snapshots::snapshot_config::SnapshotUsage,
        std::{fs::File, num::NonZeroU64},
        tempfile::TempDir,
    };

    const HASH: &str = "11111111111111111111111111111111";

    fn staged(writing: Option<Writing>) -> Option<Snapshots> {
        Some(Snapshots {
            full: None,
            incremental: None,
            full_interval: None,
            incremental_interval: None,
            writing,
            last_written: None,
        })
    }

    const WRITE: Writing = Writing {
        slot: 300,
        since_millis: 1_000,
    };

    #[test]
    fn test_a_write_is_timed_from_its_staging_to_its_end() {
        let mut tracker = SnapshotTracker::default();
        let shown = tracker.observe(staged(Some(WRITE)), 10, 1_500).unwrap();
        assert_eq!(shown.last_written, None);
        assert_eq!(
            tracker.spans().collect::<Vec<_>>(),
            [Span { from: 10, to: None }]
        );

        tracker.note_behind(7);
        tracker.note_behind(3);
        tracker.observe(staged(Some(WRITE)), 40, 2_000);
        let shown = tracker.observe(staged(None), 90, 91_000).unwrap();
        assert_eq!(
            shown.last_written,
            Some(Written {
                slot: 300,
                took_millis: 90_000,
                fell_behind_slots: 7,
            })
        );
        assert_eq!(
            tracker.spans().collect::<Vec<_>>(),
            [Span {
                from: 10,
                to: Some(90),
            }]
        );
    }

    #[test]
    fn test_lag_outside_a_write_is_not_counted() {
        let mut tracker = SnapshotTracker::default();
        tracker.note_behind(50);
        tracker.observe(staged(Some(WRITE)), 10, 1_500);
        let shown = tracker.observe(staged(None), 20, 2_000).unwrap();
        assert_eq!(shown.last_written.unwrap().fell_behind_slots, 0);
    }

    #[test]
    fn test_spans_ended_before_an_epoch_are_forgotten_and_an_open_one_kept() {
        let mut tracker = SnapshotTracker::default();
        tracker.observe(staged(Some(WRITE)), 10, 0);
        tracker.observe(staged(None), 20, 0);
        tracker.observe(staged(Some(WRITE)), 30, 0);
        tracker.observe(staged(None), 40, 0);
        tracker.observe(staged(Some(WRITE)), 50, 0);
        tracker.forget_before(35);
        assert_eq!(
            tracker.spans().collect::<Vec<_>>(),
            [
                Span {
                    from: 30,
                    to: Some(40),
                },
                Span { from: 50, to: None },
            ]
        );
    }

    #[test]
    fn test_no_snapshot_config_publishes_nothing() {
        let mut tracker = SnapshotTracker::default();
        assert_eq!(tracker.observe(None, 10, 0), None);
    }

    fn config(dir: &TempDir, usage: SnapshotUsage) -> SnapshotConfig {
        SnapshotConfig {
            usage,
            full_snapshot_archives_dir: dir.path().to_path_buf(),
            incremental_snapshot_archives_dir: dir.path().to_path_buf(),
            full_snapshot_archive_interval: SnapshotInterval::Slots(
                NonZeroU64::new(25_000).unwrap(),
            ),
            incremental_snapshot_archive_interval: SnapshotInterval::Disabled,
            ..SnapshotConfig::default()
        }
    }

    fn touch(dir: &TempDir, name: &str) {
        File::create(dir.path().join(name)).unwrap();
    }

    #[test]
    fn test_the_newest_full_and_the_incremental_on_it_are_read() {
        let dir = TempDir::new().unwrap();
        touch(&dir, &format!("snapshot-100-{HASH}.tar.zst"));
        touch(&dir, &format!("snapshot-200-{HASH}.tar.zst"));
        touch(
            &dir,
            &format!("incremental-snapshot-100-180-{HASH}.tar.zst"),
        );
        touch(
            &dir,
            &format!("incremental-snapshot-200-260-{HASH}.tar.zst"),
        );

        let got = read(&config(&dir, SnapshotUsage::LoadAndGenerate)).unwrap();
        assert_eq!(got.full.as_ref().map(|archive| archive.slot), Some(200));
        assert_eq!(
            got.incremental.as_ref().map(|archive| archive.slot),
            Some(260)
        );
        assert!(got.full.unwrap().written_millis.is_some());
        assert_eq!(got.full_interval, Some(25_000));
        assert_eq!(got.incremental_interval, None);
    }

    #[test]
    fn test_an_empty_directory_reads_as_no_archives_rather_than_nothing() {
        let dir = TempDir::new().unwrap();
        let got = read(&config(&dir, SnapshotUsage::LoadAndGenerate)).unwrap();
        assert_eq!(got.full, None);
        assert_eq!(got.incremental, None);
    }

    #[test]
    fn test_an_archive_being_staged_is_reported_with_its_start() {
        let dir = TempDir::new().unwrap();
        touch(&dir, &format!("snapshot-100-{HASH}.tar.zst"));
        fs::create_dir(dir.path().join("tmp-snapshot-archive-300-abcd")).unwrap();
        touch(&dir, "tmp-snapshot-archive-300.tar.zst");

        let got = read(&config(&dir, SnapshotUsage::LoadAndGenerate)).unwrap();
        let writing = got.writing.expect("a fresh staging file is a write");
        assert_eq!(writing.slot, 300);
        assert!(writing.since_millis > 0);
        assert_eq!(got.last_written, None);
    }

    #[test]
    fn test_a_stale_staging_file_is_a_leftover_not_a_write() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("tmp-snapshot-archive-300.tar.zst");
        let file = File::create(&path).unwrap();
        let stale = SystemTime::now()
            .checked_sub(Duration::from_secs(600))
            .unwrap();
        file.set_modified(stale).unwrap();

        let got = read(&config(&dir, SnapshotUsage::LoadAndGenerate)).unwrap();
        assert_eq!(got.writing, None);
    }

    #[test]
    fn test_a_staging_directory_alone_is_not_a_write() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("tmp-snapshot-archive-300-abcd")).unwrap();
        let got = read(&config(&dir, SnapshotUsage::LoadAndGenerate)).unwrap();
        assert_eq!(got.writing, None);
    }

    #[test]
    fn test_a_node_that_generates_none_reads_as_nothing() {
        let dir = TempDir::new().unwrap();
        touch(&dir, &format!("snapshot-100-{HASH}.tar.zst"));
        assert_eq!(read(&config(&dir, SnapshotUsage::LoadOnly)), None);
    }
}
