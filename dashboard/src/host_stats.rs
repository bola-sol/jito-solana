//! Host load, processor time, memory, filesystem capacity and disk saturation,
//! read from `/proc` and `statvfs` rather than the metrics tap, so the panel
//! works on a node logging below the default. Capacity and saturation are kept
//! apart: a machine can be in trouble on one while the other reads healthy.

#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
use {
    serde::Serialize,
    std::{
        collections::BTreeMap,
        ffi::CString,
        io,
        path::{Path, PathBuf},
    },
};

/// Bytes in a disk sector as `/proc/diskstats` counts them: always 512,
/// whatever the device's own sector size.
const SECTOR_BYTES: u64 = 512;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoadAverage {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
    /// Threads on a run queue right now, and threads in total.
    pub running: u64,
    pub threads: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Memory {
    pub total: u64,
    /// What the kernel believes can be handed out without swapping, which is
    /// not the same as free: most of the page cache is included in it.
    pub available: u64,
    /// Page cache and buffers, the part of "used" the kernel will give back.
    pub reclaimable: u64,
    /// Untouched memory. What is spoken for is `total - free - reclaimable`;
    /// `available` is larger than `free` by most of the page cache.
    pub free: u64,
    pub swap_total: u64,
    pub swap_free: u64,
}

/// Cumulative ticks for every core together, straight out of the `cpu` line of
/// `/proc/stat`. Guest time is already inside `user` and `nice`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CpuCounters {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    /// Idle with a disk request outstanding: not busy, but not free either.
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    /// Time a hypervisor gave to someone else. Always nought on bare metal.
    pub steal: u64,
}

/// One interval's ticks as shares of it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CpuUse {
    /// Everything but idle and iowait.
    pub busy: f64,
    pub user: f64,
    /// The kernel, including interrupt handling.
    pub system: f64,
    pub iowait: f64,
    pub steal: f64,
}

impl CpuCounters {
    /// This sample less the one before, or `None` if a counter went backwards.
    pub fn since(&self, previous: &Self) -> Option<Self> {
        Some(Self {
            user: self.user.checked_sub(previous.user)?,
            nice: self.nice.checked_sub(previous.nice)?,
            system: self.system.checked_sub(previous.system)?,
            idle: self.idle.checked_sub(previous.idle)?,
            iowait: self.iowait.checked_sub(previous.iowait)?,
            irq: self.irq.checked_sub(previous.irq)?,
            softirq: self.softirq.checked_sub(previous.softirq)?,
            steal: self.steal.checked_sub(previous.steal)?,
        })
    }

    /// `None` where no time passed, since nought of nothing is not idle.
    pub fn shares(&self) -> Option<CpuUse> {
        let total = [
            self.user,
            self.nice,
            self.system,
            self.idle,
            self.iowait,
            self.irq,
            self.softirq,
            self.steal,
        ]
        .into_iter()
        .fold(0u64, u64::saturating_add);
        if total == 0 {
            return None;
        }
        let share = |part: u64| part as f64 / total as f64;
        Some(CpuUse {
            busy: 1.0 - share(self.idle.saturating_add(self.iowait)),
            user: share(self.user.saturating_add(self.nice)),
            system: share(
                self.system
                    .saturating_add(self.irq)
                    .saturating_add(self.softirq),
            ),
            iowait: share(self.iowait),
            steal: share(self.steal),
        })
    }
}

/// Cumulative counters for one block device, straight out of `/proc/diskstats`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DiskCounters {
    pub reads: u64,
    pub read_sectors: u64,
    pub read_ms: u64,
    pub writes: u64,
    pub write_sectors: u64,
    pub write_ms: u64,
    /// Milliseconds the device had at least one request in flight, which is what
    /// `iostat` turns into `%util`. A duty cycle, not a level.
    pub busy_ms: u64,
}

impl DiskCounters {
    /// This sample less the one before, or `None` if a counter went backwards, as
    /// it does when a device is re-added.
    pub fn since(&self, previous: &Self) -> Option<Self> {
        Some(Self {
            reads: self.reads.checked_sub(previous.reads)?,
            read_sectors: self.read_sectors.checked_sub(previous.read_sectors)?,
            read_ms: self.read_ms.checked_sub(previous.read_ms)?,
            writes: self.writes.checked_sub(previous.writes)?,
            write_sectors: self.write_sectors.checked_sub(previous.write_sectors)?,
            write_ms: self.write_ms.checked_sub(previous.write_ms)?,
            busy_ms: self.busy_ms.checked_sub(previous.busy_ms)?,
        })
    }

    pub fn read_bytes(&self) -> u64 {
        self.read_sectors.saturating_mul(SECTOR_BYTES)
    }

    pub fn write_bytes(&self) -> u64 {
        self.write_sectors.saturating_mul(SECTOR_BYTES)
    }

    pub fn operations(&self) -> u64 {
        self.reads.saturating_add(self.writes)
    }

    /// Mean milliseconds a request spent queued and serviced. `None` where the
    /// device did nothing, since nought would read as fast.
    pub fn wait_ms(&self) -> Option<f64> {
        let operations = self.operations();
        if operations == 0 {
            return None;
        }
        let waited = self.read_ms.saturating_add(self.write_ms);
        Some(waited as f64 / operations as f64)
    }

    /// Share of the interval the device had work in flight, clamped because the
    /// kernel accumulates `busy_ms` on its own clock.
    pub fn busy(&self, interval_ms: f64) -> Option<f64> {
        if interval_ms <= 0.0 {
            return None;
        }
        Some((self.busy_ms as f64 / interval_ms).clamp(0.0, 1.0))
    }
}

/// How full one filesystem is. A level, read as it stands rather than diffed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Filesystem {
    pub total: u64,
    /// Bytes a process without privileges may still write, which is what an
    /// operator has left. Root's reserve is deliberately not counted.
    pub available: u64,
}

/// Everything read in one pass.
#[derive(Debug, Clone, PartialEq)]
pub struct HostSnapshot {
    pub load: LoadAverage,
    /// Absent where `/proc/stat` could not be read, so only that tile goes.
    pub cpu: Option<CpuCounters>,
    pub memory: Memory,
    /// Keyed by the kernel's device name, before partitions are folded into
    /// their parent disk.
    pub disks: BTreeMap<String, DiskCounters>,
}

#[cfg(target_os = "linux")]
pub fn read() -> io::Result<HostSnapshot> {
    let load = parse_load(&std::fs::read_to_string("/proc/loadavg")?)
        .ok_or_else(|| invalid("unrecognised /proc/loadavg"))?;
    let cpu = std::fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|contents| parse_stat(&contents));
    let memory = parse_memory(&std::fs::read_to_string("/proc/meminfo")?)
        .ok_or_else(|| invalid("unrecognised /proc/meminfo"))?;
    let disks = parse_diskstats(&std::fs::read_to_string("/proc/diskstats")?);
    Ok(HostSnapshot {
        load,
        cpu,
        memory,
        disks,
    })
}

#[cfg(not(target_os = "linux"))]
pub fn read() -> io::Result<HostSnapshot> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "host counters are only available on Linux",
    ))
}

/// How full the filesystem holding `path` is.
#[cfg(target_os = "linux")]
pub fn filesystem(path: &Path) -> io::Result<Filesystem> {
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| invalid("path contains a nul byte"))?;
    // SAFETY: `stat` is written only on success, and the pointer is valid for
    // the duration of the call.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // `f_frsize` rather than `f_bsize`: the block counts are in fragments, and
    // on filesystems where the two differ using `f_bsize` overstates the size.
    let block = stat.f_frsize as u64;
    Ok(Filesystem {
        total: (stat.f_blocks as u64).saturating_mul(block),
        available: (stat.f_bavail as u64).saturating_mul(block),
    })
}

#[cfg(not(target_os = "linux"))]
pub fn filesystem(_path: &Path) -> io::Result<Filesystem> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem capacity is only available on Linux",
    ))
}

/// Which filesystem `path` is on, for grouping: four accounts directories
/// under one mount are one filesystem, not four.
#[cfg(target_os = "linux")]
pub fn filesystem_id(path: &Path) -> io::Result<u64> {
    use std::os::linux::fs::MetadataExt;
    Ok(std::fs::metadata(path)?.st_dev())
}

#[cfg(not(target_os = "linux"))]
pub fn filesystem_id(_path: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem identity is only available on Linux",
    ))
}

/// The block device behind `path`, named as `/proc/diskstats` names it, folded
/// up to the parent disk for a partition since every partition competes for
/// the same queue. `None` where there is no block device at all, as on tmpfs.
#[cfg(target_os = "linux")]
pub fn device_for(path: &Path) -> io::Result<Option<String>> {
    use std::os::linux::fs::MetadataExt;
    let device = std::fs::metadata(path)?.st_dev();
    let (major, minor) = (libc::major(device), libc::minor(device));
    if major == 0 {
        // Anonymous device: tmpfs, overlayfs and the like, with no block
        // device underneath.
        return Ok(None);
    }

    let link = PathBuf::from(format!("/sys/dev/block/{major}:{minor}"));
    let Ok(resolved) = std::fs::canonicalize(&link) else {
        return Ok(None);
    };
    // A partition carries this file; a whole disk does not.
    let is_partition = resolved.join("partition").exists();
    let disk = if is_partition {
        resolved.parent().map(Path::to_path_buf)
    } else {
        Some(resolved)
    };
    Ok(disk
        .as_deref()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned()))
}

#[cfg(not(target_os = "linux"))]
pub fn device_for(_path: &Path) -> io::Result<Option<String>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "block devices are only available on Linux",
    ))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// `0.52 0.58 0.59 2/1847 12345`
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_load(contents: &str) -> Option<LoadAverage> {
    let mut fields = contents.split_whitespace();
    let one = fields.next()?.parse().ok()?;
    let five = fields.next()?.parse().ok()?;
    let fifteen = fields.next()?.parse().ok()?;
    let (running, threads) = match fields.next().and_then(|pair| pair.split_once('/')) {
        Some((running, threads)) => (
            running.parse().unwrap_or_default(),
            threads.parse().unwrap_or_default(),
        ),
        None => (0, 0),
    };
    Some(LoadAverage {
        one,
        five,
        fifteen,
        running,
        threads,
    })
}

/// `cpu  1234 5 678 90000 12 0 34 0 0 0`: the line summing every core, ahead
/// of one per core. User, nice, system and idle, then iowait, irq, softirq and
/// steal, which older kernels leave off.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_stat(contents: &str) -> Option<CpuCounters> {
    let line = contents.lines().find(|line| line.starts_with("cpu "))?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .map(|value| value.parse().unwrap_or_default())
        .collect();
    if fields.len() < 4 {
        return None;
    }
    let at = |index: usize| fields.get(index).copied().unwrap_or_default();
    Some(CpuCounters {
        user: at(0),
        nice: at(1),
        system: at(2),
        idle: at(3),
        iowait: at(4),
        irq: at(5),
        softirq: at(6),
        steal: at(7),
    })
}

/// `MemTotal:       395264000 kB`, one key per line, values in kibibytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_memory(contents: &str) -> Option<Memory> {
    let mut memory = Memory::default();
    let mut seen_total = false;
    let mut buffers = 0u64;
    let mut cached = 0u64;

    for line in contents.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(kibibytes) = rest
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        let bytes = kibibytes.saturating_mul(1024);
        match key {
            "MemTotal" => {
                memory.total = bytes;
                seen_total = true;
            }
            "MemAvailable" => memory.available = bytes,
            "MemFree" => memory.free = bytes,
            "Buffers" => buffers = bytes,
            // Prefix matched exactly: `SwapCached` is a different figure and
            // must not land here.
            "Cached" => cached = bytes,
            "SwapTotal" => memory.swap_total = bytes,
            "SwapFree" => memory.swap_free = bytes,
            _ => {}
        }
    }

    memory.reclaimable = buffers.saturating_add(cached);
    seen_total.then_some(memory)
}

/// `259 0 nvme0n1 12345 0 987654 3210 ...`: reads, reads merged, sectors read,
/// milliseconds reading, the same four for writes, requests in flight, then
/// milliseconds doing any I/O. Later discard and flush counters are ignored.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_diskstats(contents: &str) -> BTreeMap<String, DiskCounters> {
    let mut disks = BTreeMap::new();
    for line in contents.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(name) = fields.get(2) else {
            continue;
        };
        let at = |index: usize| -> u64 {
            fields
                .get(index)
                .and_then(|value| value.parse().ok())
                .unwrap_or_default()
        };
        // A line too short to carry the busy figure is from a kernel this
        // cannot read, and half a row is worse than none.
        if fields.len() < 13 {
            continue;
        }
        disks.insert(
            (*name).to_owned(),
            DiskCounters {
                reads: at(3),
                read_sectors: at(5),
                read_ms: at(6),
                writes: at(7),
                write_sectors: at(9),
                write_ms: at(10),
                busy_ms: at(12),
            },
        );
    }
    disks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reads_the_three_averages_and_the_thread_counts() {
        let load = parse_load("12.40 11.80 10.90 14/1847 3320145\n").unwrap();
        assert_eq!(load.one, 12.40);
        assert_eq!(load.five, 11.80);
        assert_eq!(load.fifteen, 10.90);
        assert_eq!(load.running, 14);
        assert_eq!(load.threads, 1847);
    }

    #[test]
    fn test_survives_a_loadavg_without_the_thread_pair() {
        let load = parse_load("0.10 0.20 0.30").unwrap();
        assert_eq!(load.running, 0);
        assert_eq!(load.threads, 0);
    }

    #[test]
    fn test_refuses_a_loadavg_it_cannot_read() {
        assert!(parse_load("").is_none());
        assert!(parse_load("not a number 1 2").is_none());
    }

    const MEMINFO: &str = "\
MemTotal:       402653184 kB
MemFree:         25165824 kB
MemAvailable:    92274688 kB
Buffers:          2097152 kB
Cached:          65011712 kB
SwapCached:             0 kB
SwapTotal:        8388608 kB
SwapFree:         8388608 kB
";

    const STAT: &str = "\
cpu  2400 10 600 20000 100 20 80 0 0 0
cpu0 1200 5 300 10000 50 10 40 0 0 0
cpu1 1200 5 300 10000 50 10 40 0 0 0
intr 12345 0 0
ctxt 6789
";

    #[test]
    fn test_reads_the_line_summing_every_core() {
        let cpu = parse_stat(STAT).unwrap();
        assert_eq!(cpu.user, 2400);
        assert_eq!(cpu.nice, 10);
        assert_eq!(cpu.system, 600);
        assert_eq!(cpu.idle, 20000);
        assert_eq!(cpu.iowait, 100);
        assert_eq!(cpu.irq, 20);
        assert_eq!(cpu.softirq, 80);
        assert_eq!(cpu.steal, 0);
    }

    #[test]
    fn test_survives_a_stat_from_before_steal_was_counted() {
        let cpu = parse_stat("cpu  10 0 20 70\n").unwrap();
        assert_eq!(cpu.idle, 70);
        assert_eq!(cpu.iowait, 0);
        assert_eq!(cpu.steal, 0);
    }

    #[test]
    fn test_refuses_a_stat_without_the_sum_line() {
        assert!(parse_stat("cpu0 10 0 20 70\n").is_none());
        assert!(parse_stat("cpu  10 0\n").is_none());
    }

    #[test]
    fn test_busy_leaves_out_idle_and_iowait_alone() {
        let delta = CpuCounters {
            user: 20,
            nice: 4,
            system: 5,
            idle: 60,
            iowait: 5,
            irq: 2,
            softirq: 3,
            steal: 1,
        };
        let shares = delta.shares().unwrap();
        assert!((shares.busy - 0.35).abs() < 1e-9);
        assert!((shares.user - 0.24).abs() < 1e-9);
        assert!((shares.system - 0.10).abs() < 1e-9);
        assert!((shares.iowait - 0.05).abs() < 1e-9);
        assert!((shares.steal - 0.01).abs() < 1e-9);
    }

    #[test]
    fn test_no_ticks_is_no_reading() {
        // Nought of nothing would read as a wholly idle machine.
        assert_eq!(CpuCounters::default().shares(), None);
    }

    #[test]
    fn test_discards_cpu_counters_that_went_backwards() {
        let previous = CpuCounters {
            user: 100,
            ..CpuCounters::default()
        };
        let current = CpuCounters {
            user: 5,
            ..CpuCounters::default()
        };
        assert!(current.since(&previous).is_none());
        assert_eq!(
            previous.since(&current),
            Some(CpuCounters {
                user: 95,
                ..CpuCounters::default()
            })
        );
    }

    #[test]
    fn test_reads_memory_in_bytes_and_adds_the_reclaimable_parts() {
        let memory = parse_memory(MEMINFO).unwrap();
        assert_eq!(memory.total, 402_653_184 * 1024);
        assert_eq!(memory.available, 92_274_688 * 1024);
        assert_eq!(memory.free, 25_165_824 * 1024);
        assert_eq!(memory.reclaimable, (2_097_152 + 65_011_712) * 1024);
        assert_eq!(memory.swap_total, 8_388_608 * 1024);
        assert_eq!(memory.swap_free, 8_388_608 * 1024);
    }

    #[test]
    fn test_does_not_mistake_swap_cached_for_the_page_cache() {
        // `SwapCached` sits directly under `Cached` and is a different figure.
        // A prefix match here would add it to the reclaimable total.
        let memory =
            parse_memory("MemTotal: 1024 kB\nCached: 512 kB\nSwapCached: 256 kB\nBuffers: 0 kB\n")
                .unwrap();
        assert_eq!(memory.reclaimable, 512 * 1024);
    }

    #[test]
    fn test_reports_no_swap_where_none_is_configured() {
        let memory = parse_memory("MemTotal: 1024 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n").unwrap();
        assert_eq!(memory.swap_total, 0);
    }

    #[test]
    fn test_refuses_meminfo_without_a_total() {
        assert!(parse_memory("MemFree: 100 kB\n").is_none());
    }

    const DISKSTATS: &str = "\
 259       0 nvme0n1 1000 0 20000 300 4000 0 80000 900 0 1500 1200
 259       1 nvme0n1p1 900 0 18000 250 3800 0 76000 850 0 1400 1100
   8       0 sda 10 0 20 30 40 0 50 60 0 70 80
   7       0 loop0
";

    #[test]
    fn test_reads_the_counters_a_device_line_carries() {
        let disks = parse_diskstats(DISKSTATS);
        let disk = disks.get("nvme0n1").unwrap();
        assert_eq!(disk.reads, 1000);
        assert_eq!(disk.read_sectors, 20000);
        assert_eq!(disk.read_ms, 300);
        assert_eq!(disk.writes, 4000);
        assert_eq!(disk.write_sectors, 80000);
        assert_eq!(disk.write_ms, 900);
        assert_eq!(disk.busy_ms, 1500);
    }

    #[test]
    fn test_keeps_partitions_separate_here_and_folds_them_later() {
        // Both are read; `device_for` is what decides a path on `nvme0n1p1` is
        // reported against `nvme0n1`.
        let disks = parse_diskstats(DISKSTATS);
        assert!(disks.contains_key("nvme0n1"));
        assert!(disks.contains_key("nvme0n1p1"));
    }

    #[test]
    fn test_skips_a_line_too_short_to_carry_the_busy_figure() {
        assert!(!parse_diskstats(DISKSTATS).contains_key("loop0"));
    }

    #[test]
    fn test_turns_sectors_into_bytes_at_five_hundred_and_twelve() {
        let disk = DiskCounters {
            read_sectors: 2,
            write_sectors: 4,
            ..DiskCounters::default()
        };
        assert_eq!(disk.read_bytes(), 1024);
        assert_eq!(disk.write_bytes(), 2048);
    }

    #[test]
    fn test_subtracts_the_previous_sample() {
        let previous = DiskCounters {
            reads: 10,
            busy_ms: 100,
            ..DiskCounters::default()
        };
        let current = DiskCounters {
            reads: 25,
            busy_ms: 340,
            ..DiskCounters::default()
        };
        let delta = current.since(&previous).unwrap();
        assert_eq!(delta.reads, 15);
        assert_eq!(delta.busy_ms, 240);
    }

    #[test]
    fn test_discards_a_sample_where_a_counter_went_backwards() {
        // A device removed and re-added restarts at nought, and an unsigned
        // wrap would read as an enormous burst of work.
        let previous = DiskCounters {
            reads: 100,
            ..DiskCounters::default()
        };
        let current = DiskCounters {
            reads: 5,
            ..DiskCounters::default()
        };
        assert!(current.since(&previous).is_none());
    }

    #[test]
    fn test_works_out_the_mean_wait_across_reads_and_writes() {
        let delta = DiskCounters {
            reads: 30,
            writes: 70,
            read_ms: 6,
            write_ms: 14,
            ..DiskCounters::default()
        };
        assert_eq!(delta.wait_ms(), Some(0.2));
    }

    #[test]
    fn test_has_no_wait_to_report_where_the_device_did_nothing() {
        // Nought here would read as an idle device being infinitely fast.
        assert_eq!(DiskCounters::default().wait_ms(), None);
    }

    #[test]
    fn test_reads_busy_as_a_share_of_the_interval() {
        let delta = DiskCounters {
            busy_ms: 340,
            ..DiskCounters::default()
        };
        assert_eq!(delta.busy(1000.0), Some(0.34));
    }

    #[test]
    fn test_clamps_busy_where_the_kernel_clock_runs_past_the_interval() {
        let delta = DiskCounters {
            busy_ms: 1004,
            ..DiskCounters::default()
        };
        assert_eq!(delta.busy(1000.0), Some(1.0));
    }
}
