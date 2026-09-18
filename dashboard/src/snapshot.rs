//! The newest snapshot archives on disk, read as `getHighestSnapshotSlot`
//! reads them, and how often new ones are due.

use {
    agave_snapshots::{
        SnapshotInterval, paths, snapshot_archive_info::SnapshotArchiveInfoGetter,
        snapshot_config::SnapshotConfig,
    },
    serde::Serialize,
    solana_clock::Slot,
    std::{fs, path::Path, time::UNIX_EPOCH},
};

/// One archive: the slot it holds and when the file was written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Archive {
    pub slot: Slot,
    /// Milliseconds since the epoch. `None` where the file could not be read.
    pub written_millis: Option<u64>,
}

/// The newest full archive, the newest incremental on top of it, and the
/// block-height intervals new ones arrive at. A `None` interval is disabled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Snapshots {
    pub full: Option<Archive>,
    pub incremental: Option<Archive>,
    pub full_interval: Option<u64>,
    pub incremental_interval: Option<u64>,
}

/// `None` where the validator generates no snapshots.
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
    })
}

fn archive(info: &impl SnapshotArchiveInfoGetter) -> Archive {
    Archive {
        slot: info.slot(),
        written_millis: written(info.path()),
    }
}

fn written(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    u64::try_from(modified.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
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
    fn test_a_node_that_generates_none_reads_as_nothing() {
        // The archive it booted from is still on disk, and only gets older.
        let dir = TempDir::new().unwrap();
        touch(&dir, &format!("snapshot-100-{HASH}.tar.zst"));
        assert_eq!(read(&config(&dir, SnapshotUsage::LoadOnly)), None);
    }
}
