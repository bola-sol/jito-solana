//! The host's network interfaces: each one's kind, state, routes and byte counters, from
//! `/proc/net/dev`, `/proc/net/route` and `/sys/class/net`. Linux only.

use {
    serde::Serialize,
    std::{collections::HashMap, io, path::Path},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceKind {
    Physical,
    Bond,
    Bridge,
    Vlan,
    Tunnel,
    Virtual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceReading {
    pub name: String,
    pub kind: InterfaceKind,
    pub up: bool,
    pub mtu: Option<u32>,
    pub routes: u32,
    pub received: u64,
    pub sent: u64,
}

/// Link types the kernel gives tunnels: IPIP, IPv6-in-IPv6, SIT, GRE, IPv6 GRE, and none, which
/// TUN devices and WireGuard report.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const TUNNEL_TYPES: [u32; 6] = [768, 769, 776, 778, 823, 65534];

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const IFF_UP: u32 = 0x1;

#[cfg(target_os = "linux")]
pub fn read() -> io::Result<Vec<InterfaceReading>> {
    let counters = parse_counters(&std::fs::read_to_string("/proc/net/dev")?);
    // A host without IPv4 routes has no file; every interface then carries none.
    let routes = std::fs::read_to_string("/proc/net/route")
        .map(|contents| parse_routes(&contents))
        .unwrap_or_default();
    Ok(counters
        .into_iter()
        .map(|(name, received, sent)| {
            let sys = Path::new("/sys/class/net").join(&name);
            InterfaceReading {
                kind: kind_of(&sys),
                up: is_up(&sys),
                mtu: read_trimmed(&sys.join("mtu")).and_then(|mtu| mtu.parse().ok()),
                routes: routes.get(&name).copied().unwrap_or(0),
                name,
                received,
                sent,
            }
        })
        .collect())
}

#[cfg(not(target_os = "linux"))]
pub fn read() -> io::Result<Vec<InterfaceReading>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "network interfaces are only read on Linux",
    ))
}

/// Each interface but loopback, with its received and sent bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_counters(contents: &str) -> Vec<(String, u64, u64)> {
    contents
        .lines()
        .filter_map(|line| {
            let (name, counters) = line.split_once(':')?;
            let name = name.trim();
            if name == "lo" {
                return None;
            }
            let mut fields = counters.split_whitespace();
            let received = fields.next()?.parse().ok()?;
            let sent = fields.nth(7)?.parse().ok()?;
            Some((name.to_string(), received, sent))
        })
        .collect()
}

/// Routes per interface in the main IPv4 table, after the heading line.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_routes(contents: &str) -> HashMap<String, u32> {
    let mut routes = HashMap::new();
    for line in contents.lines().skip(1) {
        if let Some(name) = line.split_whitespace().next() {
            let count: &mut u32 = routes.entry(name.to_string()).or_default();
            *count = count.saturating_add(1);
        }
    }
    routes
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn kind_of(sys: &Path) -> InterfaceKind {
    let devtype = read_trimmed(&sys.join("uevent")).and_then(|uevent| {
        uevent
            .lines()
            .find_map(|line| line.strip_prefix("DEVTYPE=").map(str::to_string))
    });
    let link_type = read_trimmed(&sys.join("type")).and_then(|kind| kind.parse::<u32>().ok());
    if sys.join("bonding").is_dir() {
        InterfaceKind::Bond
    } else if sys.join("bridge").is_dir() {
        InterfaceKind::Bridge
    } else if devtype.as_deref() == Some("vlan") {
        InterfaceKind::Vlan
    } else if sys.join("tun_flags").exists()
        || link_type.is_some_and(|kind| TUNNEL_TYPES.contains(&kind))
    {
        InterfaceKind::Tunnel
    } else if sys.join("device").exists() {
        InterfaceKind::Physical
    } else {
        InterfaceKind::Virtual
    }
}

/// Administratively up and not reported down. Tunnels report their state as unknown while working.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_up(sys: &Path) -> bool {
    let flagged = read_trimmed(&sys.join("flags"))
        .and_then(|flags| u32::from_str_radix(flags.trim_start_matches("0x"), 16).ok())
        .is_some_and(|flags| flags & IFF_UP != 0);
    let operstate = read_trimmed(&sys.join("operstate")).unwrap_or_default();
    flagged && !matches!(operstate.as_str(), "down" | "lowerlayerdown" | "notpresent")
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|contents| contents.trim().to_string())
}

#[cfg(test)]
mod tests {
    use {super::*, std::fs};

    const DEV: &str = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000       10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  eno1: 5000       50    0    0    0     0          0         0     7000      70    0    0    0     0       0          0
doublezero0:  500   5    0    0    0     0          0         0      300       3    0    0    0     0       0          0
";

    const ROUTE: &str = "\
Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eno1\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
eno1\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
doublezero0\t0000400A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
";

    #[test]
    fn test_counters_per_interface_without_loopback() {
        assert_eq!(
            parse_counters(DEV),
            vec![
                ("eno1".to_string(), 5000, 7000),
                ("doublezero0".to_string(), 500, 300),
            ]
        );
    }

    #[test]
    fn test_routes_counted_per_interface_after_the_heading() {
        let routes = parse_routes(ROUTE);
        assert_eq!(routes.get("eno1"), Some(&2));
        assert_eq!(routes.get("doublezero0"), Some(&1));
        assert_eq!(routes.get("Iface"), None);
    }

    fn interface(files: &[(&str, &str)], dirs: &[&str]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for (name, contents) in files {
            fs::write(root.path().join(name), contents).unwrap();
        }
        for dir in dirs {
            fs::create_dir(root.path().join(dir)).unwrap();
        }
        root
    }

    #[test]
    fn test_kind_from_sysfs() {
        let kind = |files: &[(&str, &str)], dirs: &[&str]| kind_of(interface(files, dirs).path());
        let ethernet = [("type", "1\n")];
        assert_eq!(kind(&ethernet, &["device"]), InterfaceKind::Physical);
        assert_eq!(kind(&ethernet, &["bonding"]), InterfaceKind::Bond);
        assert_eq!(kind(&ethernet, &["bridge"]), InterfaceKind::Bridge);
        assert_eq!(
            kind(
                &[
                    ("type", "1\n"),
                    ("uevent", "DEVTYPE=vlan\nINTERFACE=eno1.10\n")
                ],
                &[]
            ),
            InterfaceKind::Vlan
        );
        assert_eq!(kind(&[("type", "778\n")], &[]), InterfaceKind::Tunnel);
        assert_eq!(
            kind(&[("type", "65534\n"), ("tun_flags", "0x1001\n")], &[]),
            InterfaceKind::Tunnel
        );
        assert_eq!(kind(&ethernet, &[]), InterfaceKind::Virtual);
    }

    #[test]
    fn test_a_tunnel_reporting_unknown_is_up_and_a_link_without_carrier_is_not() {
        let tunnel = interface(&[("flags", "0x1091\n"), ("operstate", "unknown\n")], &[]);
        assert!(is_up(tunnel.path()));
        let unplugged = interface(&[("flags", "0x1003\n"), ("operstate", "down\n")], &[]);
        assert!(!is_up(unplugged.path()));
        let disabled = interface(&[("flags", "0x1002\n"), ("operstate", "unknown\n")], &[]);
        assert!(!is_up(disabled.path()));
    }
}
