//! Host-wide totals from `/proc/net/dev`, each byte counted once at the network cards, not the
//! validator's own traffic. Reports nothing rather than zeros where the file is unreadable.

use std::{io, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetCounters {
    pub received: u64,
    pub sent: u64,
}

/// Which interfaces a reading summed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counted {
    /// Those backed by a device, less any whose master is too.
    Cards,
    /// Every interface but loopback, where none is backed by a device.
    Every,
}

#[cfg(target_os = "linux")]
pub fn read() -> io::Result<(NetCounters, Counted)> {
    let contents = std::fs::read_to_string("/proc/net/dev")?;
    read_from(&contents, Path::new("/sys/class/net"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unrecognised /proc/net/dev"))
}

#[cfg(not(target_os = "linux"))]
pub fn read() -> io::Result<(NetCounters, Counted)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "network counters are only available on Linux",
    ))
}

/// Totals over the cards found under `sys`, or over every interface where there are none.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn read_from(contents: &str, sys: &Path) -> Option<(NetCounters, Counted)> {
    let on_a_card = |name: &str| crate::net_ifaces::counts_toward_host_total(&sys.join(name));
    parse(contents, on_a_card)
        .map(|counters| (counters, Counted::Cards))
        // A container sees only virtual interfaces.
        .or_else(|| parse(contents, |_| true).map(|counters| (counters, Counted::Every)))
}

/// Transmit counters start at the ninth field.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse(contents: &str, include: impl Fn(&str) -> bool) -> Option<NetCounters> {
    let mut totals = NetCounters {
        received: 0,
        sent: 0,
    };
    let mut seen_any = false;

    for line in contents.lines() {
        let Some((name, counters)) = line.split_once(':') else {
            // The first two lines are column headings and carry no colon.
            continue;
        };
        let name = name.trim();
        if name == "lo" || !include(name) {
            continue;
        }
        let fields: Vec<u64> = counters
            .split_whitespace()
            .map(|field| field.parse().unwrap_or(0))
            .collect();
        let (Some(received), Some(sent)) = (fields.first(), fields.get(8)) else {
            continue;
        };
        totals.received = totals.received.saturating_add(*received);
        totals.sent = totals.sent.saturating_add(*sent);
        seen_any = true;
    }

    seen_any.then_some(totals)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000       10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  eth0: 5000       50    0    0    0     0          0         0     7000      70    0    0    0     0       0          0
  eth1:  500        5    0    0    0     0          0         0      300       3    0    0    0     0       0          0
";

    #[test]
    fn test_sums_interfaces_and_excludes_loopback() {
        let counters = parse(SAMPLE, |_| true).unwrap();
        assert_eq!(counters.received, 5500);
        assert_eq!(counters.sent, 7300);
    }

    #[test]
    fn test_headings_alone_yield_nothing() {
        let headings = SAMPLE.lines().take(2).collect::<Vec<_>>().join("\n");
        assert!(parse(&headings, |_| true).is_none());
        assert!(parse("", |_| true).is_none());
    }

    #[test]
    fn test_malformed_row_does_not_poison_the_total() {
        let text = format!("{SAMPLE}  eth2: garbage\n");
        assert_eq!(parse(&text, |_| true).unwrap().received, 5500);
    }

    #[test]
    fn test_counts_only_the_interfaces_asked_for() {
        let counters = parse(SAMPLE, |name| name == "eth0").unwrap();
        assert_eq!((counters.received, counters.sent), (5000, 7000));
        assert!(parse(SAMPLE, |_| false).is_none());
    }

    #[cfg(unix)]
    const BONDED: &str = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000       10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
 bond0: 9000       90    0    0    0     0          0         0     6000      60    0    0    0     0       0          0
  eno1: 6000       60    0    0    0     0          0         0     4000      40    0    0    0     0       0          0
  eno2: 3000       30    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
doublezero0:  500   5    0    0    0     0          0         0      300       3    0    0    0     0       0          0
 veth0:   70        1    0    0    0     0          0         0       80       1    0    0    0     0       0          0
";

    #[cfg(unix)]
    #[test]
    fn test_reads_the_cards_once_and_every_interface_where_there_are_none() {
        use std::{fs, os::unix::fs::symlink};
        let cards = tempfile::tempdir().unwrap();
        let bare = tempfile::tempdir().unwrap();
        for name in ["lo", "bond0", "eno1", "eno2", "doublezero0", "veth0"] {
            fs::create_dir(cards.path().join(name)).unwrap();
            fs::create_dir(bare.path().join(name)).unwrap();
        }
        for port in ["eno1", "eno2"] {
            fs::create_dir(cards.path().join(port).join("device")).unwrap();
            symlink("../bond0", cards.path().join(port).join("master")).unwrap();
            symlink("../bond0", bare.path().join(port).join("master")).unwrap();
        }
        let totals = |(counters, counted): (NetCounters, Counted)| {
            (counters.received, counters.sent, counted)
        };
        assert_eq!(
            read_from(BONDED, cards.path()).map(totals),
            Some((9000, 6000, Counted::Cards))
        );
        assert_eq!(
            read_from(BONDED, bare.path()).map(totals),
            Some((18_570, 12_380, Counted::Every))
        );
        assert_eq!(read_from("", cards.path()), None);
    }
}
