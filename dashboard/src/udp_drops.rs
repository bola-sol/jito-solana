//! Per-socket UDP receive counters, read from `/proc/net/udp`.
//!
//! These say something the validator's own counters cannot. `StreamerReceiveStats`
//! counts packets that were already delivered into userspace, so a packet the
//! kernel discarded because the receive buffer was full is invisible to it — and
//! that is the common way a validator loses shreds. `sk_drops` counts exactly
//! those.
//!
//! It also reaches the QUIC paths. QUIC runs over UDP, so the TPU sockets appear
//! here with drop counters of their own, where the equivalent in-process figures
//! are private to `solana-streamer`.
//!
//! Counters are cumulative per socket and keyed here by port. Attribution to a
//! service is the caller's job, and it is a heuristic: this file describes every
//! UDP socket in the network namespace, not just the validator's.

use std::{
    collections::{HashMap, VecDeque},
    io,
    time::{Duration, Instant},
};

/// Kernel receive counters for every socket bound to one port.
///
/// Summed across sockets rather than reported one by one: turbine binds several
/// to a single port with `SO_REUSEPORT`, and a multi-homed validator binds one
/// per address, so a port routinely has many rows and only their total means
/// anything.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PortCounters {
    /// Datagrams discarded since the sockets were opened, overwhelmingly
    /// because the receive buffer was full when one arrived.
    pub drops: u64,
    /// Bytes sitting unread right now. A gauge rather than a counter, and the
    /// leading indicator: a queue that stays deep is a reader falling behind,
    /// which is the state that precedes dropping.
    pub queued: u64,
}

pub type PortMap = HashMap<u16, PortCounters>;

/// Drops over a trailing window, alongside the cumulative total.
///
/// The total on its own cannot answer the question the panel is opened to ask,
/// which is whether packets are being lost *now*. A validator that dropped a
/// quarter of a million while gossip pulled its first view of the cluster, and
/// none in the hour since, reads identically to one still dropping them. This
/// lets that burst age out.
#[derive(Debug)]
pub struct DropWindow {
    span: Duration,
    /// Oldest first, each entry one tick's cumulative totals per port.
    samples: VecDeque<(Instant, HashMap<u16, u64>)>,
}

impl DropWindow {
    pub fn new(span: Duration) -> Self {
        Self {
            span,
            samples: VecDeque::new(),
        }
    }

    /// Records a tick and forgets what has fallen out of the window.
    ///
    /// The oldest sample kept is the newest one that is still at least a span
    /// old, so the window covers slightly more than the span rather than less.
    /// Discarding it as soon as it aged out would measure from the sample after
    /// it and under-report by a tick — and under-reporting drops is the one
    /// direction this must not err in.
    pub fn push(&mut self, now: Instant, totals: HashMap<u16, u64>) {
        self.samples.push_back((now, totals));
        while let Some((next, _)) = self.samples.get(1) {
            if now.duration_since(*next) < self.span {
                break;
            }
            self.samples.pop_front();
        }
    }

    /// Time the window actually covers, which is short until it has filled.
    ///
    /// Reported so the panel can name the span it is showing instead of
    /// claiming a full minute it has not yet watched.
    pub fn covers(&self, now: Instant) -> Duration {
        self.samples
            .front()
            .map(|(at, _)| now.duration_since(*at))
            .unwrap_or_default()
    }

    /// Drops on `port` since the start of the window.
    ///
    /// Zero for a port with no reading yet at the window's start, which needs a
    /// port to have appeared part-way through — the caller writes every port it
    /// reports on every tick, so that means a socket bound after startup.
    pub fn since(&self, port: u16, current: u64) -> u64 {
        self.samples
            .front()
            .and_then(|(_, totals)| totals.get(&port))
            // A socket closed and reopened restarts at zero, so a total below
            // the remembered one is read as no drops rather than as a wrap.
            .and_then(|earlier| current.checked_sub(*earlier))
            .unwrap_or(0)
    }
}

/// Reads both address families and merges them by port.
///
/// `/proc/net/udp6` is absent on a kernel built without IPv6, and a validator
/// bound only to v4 is entirely ordinary, so either file alone is enough.
#[cfg(target_os = "linux")]
pub fn read() -> io::Result<PortMap> {
    let mut ports = PortMap::new();
    let mut rows: usize = 0;
    let mut last_err = None;

    for path in ["/proc/net/udp", "/proc/net/udp6"] {
        match std::fs::read_to_string(path) {
            Ok(contents) => rows = rows.saturating_add(parse_into(&contents, &mut ports)),
            Err(err) => last_err = Some(err),
        }
    }

    // A validator always holds UDP sockets, so understanding no rows at all
    // means the files were unreadable or are not in the format expected.
    if rows == 0 {
        return Err(last_err.unwrap_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "unrecognised /proc/net/udp")
        }));
    }
    Ok(ports)
}

#[cfg(not(target_os = "linux"))]
pub fn read() -> io::Result<PortMap> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "socket counters are only available on Linux",
    ))
}

/// Accumulates one `/proc/net/udp`-format table into `ports`, returning the
/// number of rows understood.
///
/// Both tables share a layout, of which three columns are wanted:
///
/// ```text
///  sl  local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode ref pointer drops
/// 308: 00000000:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000   0        0 22359 2 0000000000000000 0
/// ```
///
/// Only the address width differs between v4 and v6, and since just the port is
/// wanted — the hex after the colon, big-endian in both — one parser covers each
/// file.
///
/// `drops` is read by index rather than as the last field. It has been the
/// thirteenth column since it was appended in 2.6.27, and a kernel that grows a
/// fourteenth should be ignored rather than have that column reported as drops.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_into(contents: &str, ports: &mut PortMap) -> usize {
    let mut rows: usize = 0;

    for line in contents.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (Some(local), Some(queues), Some(drops)) =
            (fields.get(1), fields.get(4), fields.get(12))
        else {
            continue;
        };
        // Also how the heading row is rejected: its `local_address` column is
        // the literal word, which has no port to parse.
        let Some(port) = local
            .rsplit_once(':')
            .and_then(|(_, port)| u16::from_str_radix(port, 16).ok())
        else {
            continue;
        };
        let Ok(drops) = drops.parse::<u64>() else {
            continue;
        };
        // `tx_queue:rx_queue`. Only the receive side says whether this validator
        // is keeping up with what arrives.
        let queued = queues
            .rsplit_once(':')
            .and_then(|(_, rx)| u64::from_str_radix(rx, 16).ok())
            .unwrap_or(0);

        let entry = ports.entry(port).or_default();
        entry.drops = entry.drops.saturating_add(drops);
        entry.queued = entry.queued.saturating_add(queued);
        rows = rows.saturating_add(1);
    }

    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two sockets on port 8001 (0x1F41) as `SO_REUSEPORT` gives, and one on
    /// 8899 (0x22C3).
    ///
    /// Left unformatted because it is a verbatim transcript of the kernel's
    /// output, and the column positions are the thing under test. Wrapping the
    /// rows preserves their value but hides the alignment that makes a
    /// mis-indexed column obvious on sight.
    #[rustfmt::skip]
    const V4: &str = "\
   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  308: 00000000:1F41 00000000:0000 07 00000000:00000100 00:00000000 00000000     0        0 22359 2 0000000000000000 12
  309: 00000000:1F41 00000000:0000 07 00000000:00000200 00:00000000 00000000     0        0 22360 2 0000000000000000 30
  310: 0100007F:22C3 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 22361 2 0000000000000000 0
";

    /// The v6 table, whose wider address column must not shift the fields read
    /// from it. Unformatted for the same reason as [`V4`].
    #[rustfmt::skip]
    const V6: &str = "\
   sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  511: 00000000000000000000000000000000:1F41 00000000000000000000000000000000:0000 07 00000000:00000040 00:00000000 00000000     0        0 22362 2 0000000000000000 5
";

    fn parse(contents: &str) -> PortMap {
        let mut ports = PortMap::new();
        parse_into(contents, &mut ports);
        ports
    }

    #[test]
    fn sums_every_socket_sharing_a_port() {
        let ports = parse(V4);
        let reused = ports[&8001];
        assert_eq!(reused.drops, 42);
        // 0x100 and 0x200: the queue columns are hex where drops is decimal.
        assert_eq!(reused.queued, 768);
    }

    #[test]
    fn an_idle_socket_reports_zeroes_rather_than_being_absent() {
        let ports = parse(V4);
        assert_eq!(ports[&8899], PortCounters::default());
    }

    #[test]
    fn the_two_address_families_merge_into_one_port() {
        let mut ports = PortMap::new();
        assert_eq!(parse_into(V4, &mut ports), 3);
        assert_eq!(parse_into(V6, &mut ports), 1);
        // The wider v6 address must not shift which column is read.
        assert_eq!(ports[&8001].drops, 47);
        assert_eq!(ports[&8001].queued, 832);
    }

    #[test]
    fn headings_alone_yield_nothing() {
        assert_eq!(parse(V4.lines().next().unwrap()).len(), 0);
        assert_eq!(parse("").len(), 0);
    }

    #[test]
    fn a_malformed_row_does_not_poison_the_total() {
        let text = format!("{V4}  311: garbage\n  312: 00000000:1F41 nonsense here\n");
        let ports = parse(&text);
        assert_eq!(ports[&8001].drops, 42);
        assert_eq!(ports.len(), 2);
    }

    /// One tick's totals for a single port.
    fn totals(port: u16, drops: u64) -> HashMap<u16, u64> {
        HashMap::from([(port, drops)])
    }

    #[test]
    fn a_burst_ages_out_of_the_window() {
        let base = Instant::now();
        let mut window = DropWindow::new(Duration::from_secs(60));

        // A hundred dropped at startup, then nothing for two minutes.
        window.push(base, totals(8001, 0));
        window.push(base + Duration::from_secs(1), totals(8001, 100));
        assert_eq!(window.since(8001, 100), 100);

        for second in 2..=120 {
            window.push(base + Duration::from_secs(second), totals(8001, 100));
        }
        // The total still says a hundred; the window says the validator is fine.
        assert_eq!(window.since(8001, 100), 0);
    }

    #[test]
    fn the_window_covers_at_least_its_span_once_filled() {
        let base = Instant::now();
        let mut window = DropWindow::new(Duration::from_secs(60));
        for second in 0..=120 {
            window.push(base + Duration::from_secs(second), totals(8001, 0));
        }
        let covered = window.covers(base + Duration::from_secs(120));
        assert!(covered >= Duration::from_secs(60), "covered {covered:?}");
        // Never wildly more, or a burst would linger well past its minute.
        assert!(covered <= Duration::from_secs(61), "covered {covered:?}");
    }

    #[test]
    fn a_short_window_reports_the_span_it_has_actually_watched() {
        let base = Instant::now();
        let mut window = DropWindow::new(Duration::from_secs(60));
        window.push(base, totals(8001, 0));
        window.push(base + Duration::from_secs(5), totals(8001, 3));
        assert_eq!(
            window.covers(base + Duration::from_secs(5)),
            Duration::from_secs(5)
        );
        assert_eq!(window.since(8001, 3), 3);
    }

    #[test]
    fn a_port_with_no_baseline_in_the_window_reports_no_drops() {
        // Rather than the whole cumulative total, which would show a socket
        // bound part-way through the window as having dropped everything it
        // has ever dropped inside it.
        let base = Instant::now();
        let mut window = DropWindow::new(Duration::from_secs(60));
        window.push(base, totals(8001, 0));
        assert_eq!(window.since(8899, 4_000), 0);
    }

    #[test]
    fn a_counter_reset_reads_as_no_drops_rather_than_a_wrap() {
        let base = Instant::now();
        let mut window = DropWindow::new(Duration::from_secs(60));
        window.push(base, totals(8001, 900));
        assert_eq!(window.since(8001, 12), 0);
    }

    #[test]
    fn a_row_missing_its_trailing_columns_is_skipped() {
        // Truncated after `inode`, as a kernel predating the drops column would
        // print it. Reading the last field instead of the thirteenth would take
        // the inode here and report it as millions of drops.
        let text = "  308: 00000000:1F41 00000000:0000 07 00000000:00000100 00:00000000 00000000 \
                    0 0 22359\n";
        assert_eq!(parse(text).len(), 0);
    }
}
