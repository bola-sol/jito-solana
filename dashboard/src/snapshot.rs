//! The newest snapshot archives on disk, read as `getHighestSnapshotSlot`
//! reads them, and how often new ones are due.

use {
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
