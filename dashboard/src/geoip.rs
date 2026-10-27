//! The country of an IPv4 address, from DB-IP's IP to Country Lite (CC BY 4.0) as packed by
//! `geoip/generate.py`.

use {
    flate2::read::GzDecoder,
    std::{io::Read, net::IpAddr, sync::OnceLock},
};

static PACKED: &[u8] = include_bytes!("../geoip/country-ipv4.bin.gz");

const MAGIC: &[u8] = b"GEO4";

/// A range DB-IP places in no country.
const UNKNOWN: u8 = u8::MAX;

#[derive(Debug)]
struct Table {
    codes: Vec<String>,
    /// First address of each range; a range runs to the next one's first.
    starts: Vec<u32>,
    countries: Vec<u8>,
}

impl Table {
    fn country(&self, ip: u32) -> Option<&str> {
        let at = self
            .starts
            .partition_point(|start| *start <= ip)
            .checked_sub(1)?;
        let country = *self.countries.get(at)?;
        if country == UNKNOWN {
            return None;
        }
        self.codes.get(usize::from(country)).map(String::as_str)
    }
}

/// The two-letter code of the country DB-IP places `ip` in; none for IPv6 or an unplaced range.
pub fn country(ip: IpAddr) -> Option<&'static str> {
    static TABLE: OnceLock<Option<Table>> = OnceLock::new();
    let IpAddr::V4(ip) = ip.to_canonical() else {
        return None;
    };
    TABLE
        .get_or_init(|| {
            decode(PACKED)
                .inspect_err(|err| log::error!("dashboard: country table unreadable: {err}"))
                .ok()
        })
        .as_ref()?
        .country(u32::from(ip))
}

/// Each ISO country code's continent, as two letters: AF, AN, AS, EU, NA, OC or SA.
const CONTINENTS: [(&str, &str); 7] = [
    (
        "AF",
        "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA \
         MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
    ),
    ("AN", "AQ BV GS HM TF"),
    (
        "AS",
        "AE AF AM AZ BD BH BN BT CC CN CX GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB \
         LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
    ),
    (
        "EU",
        "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE \
         LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
    ),
    (
        "NA",
        "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX \
         NI PA PM PR SV SX TC TT UM US VC VG VI",
    ),
    (
        "OC",
        "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS",
    ),
    ("SA", "AR BO BR CL CO EC FK GF GY PE PY SR UY VE"),
];

/// The continent of a two-letter country code; none for a code outside the table.
pub fn continent(country: &str) -> Option<&'static str> {
    CONTINENTS
        .iter()
        .find(|(_, codes)| codes.split_ascii_whitespace().any(|code| code == country))
        .map(|(continent, _)| *continent)
}

fn decode(packed: &[u8]) -> Result<Table, &'static str> {
    let mut bytes = Vec::new();
    GzDecoder::new(packed)
        .read_to_end(&mut bytes)
        .map_err(|_| "not gzip")?;
    let rest = bytes.strip_prefix(MAGIC).ok_or("wrong header")?;
    let (&code_count, rest) = rest.split_first().ok_or("truncated")?;
    if code_count == UNKNOWN {
        return Err("too many countries");
    }
    let (codes, rest) = rest
        .split_at_checked(usize::from(code_count).saturating_mul(2))
        .ok_or("truncated")?;
    let codes = codes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|code| std::str::from_utf8(code).map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "country code not text")?;
    let (row_count, mut rest) = rest.split_first_chunk::<4>().ok_or("truncated")?;
    let row_count = usize::try_from(u32::from_le_bytes(*row_count)).map_err(|_| "too many rows")?;

    let mut starts = Vec::with_capacity(row_count.min(rest.len()));
    let mut start: u32 = 0;
    for _ in 0..row_count {
        let (delta, tail) = leb128(rest).ok_or("bad range start")?;
        start = start
            .checked_add(delta)
            .ok_or("range start past the last address")?;
        if starts.last().is_some_and(|last| *last >= start) {
            return Err("range starts out of order");
        }
        starts.push(start);
        rest = tail;
    }
    if starts.first() != Some(&0) {
        return Err("first range does not start at 0.0.0.0");
    }
    if rest.len() != row_count {
        return Err("country column the wrong length");
    }
    if rest
        .iter()
        .any(|country| *country != UNKNOWN && *country >= code_count)
    {
        return Err("country index out of range");
    }
    Ok(Table {
        codes,
        starts,
        countries: rest.to_vec(),
    })
}

fn leb128(bytes: &[u8]) -> Option<(u32, &[u8])> {
    let mut value: u64 = 0;
    for (at, byte) in bytes.iter().enumerate().take(5) {
        let shift = u32::try_from(at).ok()?.checked_mul(7)?;
        value |= u64::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some((u32::try_from(value).ok()?, bytes.get(at.checked_add(1)?..)?));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        flate2::{Compression, write::GzEncoder},
        std::{io::Write, net::Ipv4Addr},
    };

    #[test]
    fn test_continents_cover_the_staked_countries() {
        for (country, expected) in [
            ("DE", "EU"),
            ("NL", "EU"),
            ("US", "NA"),
            ("KY", "NA"),
            ("SG", "AS"),
            ("JP", "AS"),
            ("BR", "SA"),
            ("AU", "OC"),
            ("ZA", "AF"),
        ] {
            assert_eq!(continent(country), Some(expected), "{country}");
        }
        assert_eq!(continent("ZZ"), None);
        // Every code is listed once.
        let mut codes: Vec<&str> = CONTINENTS
            .iter()
            .flat_map(|(_, codes)| codes.split_ascii_whitespace())
            .collect();
        let listed = codes.len();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), listed);
        assert!(codes.iter().all(|code| code.len() == 2));
    }

    fn pack(codes: &[&str], rows: &[(u32, u8)]) -> Vec<u8> {
        let mut raw = MAGIC.to_vec();
        raw.push(codes.len() as u8);
        for code in codes {
            raw.extend_from_slice(code.as_bytes());
        }
        raw.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        let mut previous = 0;
        for (start, _) in rows {
            let mut delta = start.checked_sub(previous).unwrap();
            loop {
                let byte = (delta & 0x7f) as u8;
                delta >>= 7;
                raw.push(if delta == 0 { byte } else { byte | 0x80 });
                if delta == 0 {
                    break;
                }
            }
            previous = *start;
        }
        raw.extend(rows.iter().map(|(_, country)| *country));
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&raw).unwrap();
        encoder.finish().unwrap()
    }

    fn ip(text: &str) -> u32 {
        u32::from(text.parse::<Ipv4Addr>().unwrap())
    }

    #[test]
    fn looks_up_the_range_holding_the_address() {
        let table = decode(&pack(
            &["AU", "DE"],
            &[
                (0, UNKNOWN),
                (ip("1.0.0.0"), 0),
                (ip("2.0.0.0"), 1),
                (ip("200.0.0.0"), UNKNOWN),
            ],
        ))
        .unwrap();
        assert_eq!(table.country(ip("0.255.255.255")), None);
        assert_eq!(table.country(ip("1.0.0.0")), Some("AU"));
        assert_eq!(table.country(ip("1.255.255.255")), Some("AU"));
        assert_eq!(table.country(ip("2.0.0.0")), Some("DE"));
        assert_eq!(table.country(ip("199.255.255.255")), Some("DE"));
        assert_eq!(table.country(u32::MAX), None);
    }

    #[test]
    fn refuses_a_damaged_table() {
        let good = pack(&["AU"], &[(0, UNKNOWN), (16, 0)]);
        assert!(decode(&good).is_ok());
        assert!(decode(&good[..good.len() / 2]).is_err());
        assert_eq!(
            decode(&pack(&["AU"], &[(0, UNKNOWN), (16, 1)])).unwrap_err(),
            "country index out of range"
        );
        assert_eq!(
            decode(&pack(&["AU"], &[(16, 0)])).unwrap_err(),
            "first range does not start at 0.0.0.0"
        );
    }

    #[test]
    fn reads_the_embedded_table() {
        let table = decode(PACKED).unwrap();
        assert!(table.codes.len() > 200);
        assert!(table.starts.len() > 100_000);
        assert_eq!(country("10.0.0.1".parse().unwrap()), None);
        assert!(country("8.8.8.8".parse().unwrap()).is_some());
        assert_eq!(
            country("::ffff:8.8.8.8".parse().unwrap()),
            country("8.8.8.8".parse().unwrap())
        );
        assert_eq!(country("2001:db8::1".parse().unwrap()), None);
    }
}
