//! Validator display names, read from on-chain `ValidatorInfo` config accounts.
//!
//! These are the names the dashboard shows instead of raw pubkeys. They live in
//! accounts owned by the config program, keyed by the validator's identity.
//!
//! Enumerating them is a full accounts scan, which is far too expensive to do
//! on a timer, so it happens exactly once on a background thread at startup.
//! After that the cache is kept current from the much cheaper per-slot list of
//! config accounts written in that slot.

use {
    serde::{Deserialize, Serialize},
    solana_account::ReadableAccount,
    solana_config_interface::state::{ConfigKeys, get_config_data},
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    std::collections::HashMap,
};

/// Marker key present as the first entry of a `ValidatorInfo` config account.
const VALIDATOR_INFO_PROGRAM: Pubkey =
    Pubkey::from_str_const("Va1idator1nfo111111111111111111111111111111");

/// Upper bound on a valid `ValidatorInfo` account, used to skip oversized
/// config accounts without deserializing them.
const MAX_VALIDATOR_INFO_LEN: usize = 576 + 1 + (32 + 1) * 2;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatorInfo {
    pub name: Option<String>,
    pub website: Option<String>,
    pub details: Option<String>,
    #[serde(rename = "iconUrl")]
    pub icon_url: Option<String>,
    #[serde(rename = "keybaseUsername")]
    pub keybase_username: Option<String>,
}

impl ValidatorInfo {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Default)]
pub struct ValidatorInfoCache {
    by_identity: HashMap<Pubkey, ValidatorInfo>,
}

impl ValidatorInfoCache {
    pub fn get(&self, identity: &Pubkey) -> Option<&ValidatorInfo> {
        self.by_identity.get(identity)
    }

    pub fn len(&self) -> usize {
        self.by_identity.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_identity.is_empty()
    }

    /// Inserts an entry, returning true if it was new or changed.
    pub fn insert(&mut self, identity: Pubkey, info: ValidatorInfo) -> bool {
        if self.by_identity.get(&identity) == Some(&info) {
            return false;
        }
        self.by_identity.insert(identity, info);
        true
    }

    /// Merges the result of [`scan_all`], returning how many entries changed.
    /// Kept separate from the scan so the lock is only held for the merge.
    pub fn merge(&mut self, entries: Vec<(Pubkey, ValidatorInfo)>) -> usize {
        entries
            .into_iter()
            .filter(|(identity, info)| self.insert(*identity, info.clone()))
            .count()
    }

    /// Cheap incremental refresh from the config accounts written in `bank`'s
    /// own slot. Returns the identities whose info changed.
    pub fn update_from_slot(&mut self, bank: &Bank) -> Vec<Pubkey> {
        bank.get_program_accounts_modified_since_parent(&solana_sdk_ids::config::id())
            .into_iter()
            .filter_map(|(_pubkey, account)| parse(account.data()))
            .filter(|(identity, info)| self.insert(*identity, info.clone()) && !info.is_empty())
            .map(|(identity, _)| identity)
            .collect()
    }
}

/// Walks every config account and returns the validator info it finds.
///
/// This is a full accounts-database scan and takes minutes on a real cluster.
/// It must run on a background thread, and no lock may be held across it, or
/// anything else wanting that lock stalls for the duration.
pub fn scan_all(bank: &Bank) -> Vec<(Pubkey, ValidatorInfo)> {
    let accounts = match bank.get_program_accounts(&solana_sdk_ids::config::id()) {
        Ok(accounts) => accounts,
        Err(err) => {
            log::warn!("dashboard: could not scan validator info accounts: {err}");
            return Vec::new();
        }
    };
    accounts
        .into_iter()
        .filter_map(|(_pubkey, account)| parse(account.data()))
        .collect()
}

/// Extracts the validator identity and its advertised info from a config
/// account's raw data. Returns `None` for config accounts that are not
/// validator info, or that are malformed.
fn parse(data: &[u8]) -> Option<(Pubkey, ValidatorInfo)> {
    if data.len() > MAX_VALIDATOR_INFO_LEN {
        return None;
    }
    let keys = bincode::deserialize::<ConfigKeys>(data).ok()?;
    // The first key marks the account type; the second is the identity that
    // signed for it, which is what we key the cache on.
    if keys.keys.first()?.0 != VALIDATOR_INFO_PROGRAM {
        return None;
    }
    let identity = keys.keys.get(1)?.0;

    // The config payload is a bincode string whose contents are JSON.
    let json = bincode::deserialize::<String>(get_config_data(data).ok()?).ok()?;
    let info = serde_json::from_str::<ValidatorInfo>(&json).ok()?;
    Some((identity, info))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(keys: Vec<(Pubkey, bool)>, json: &str) -> Vec<u8> {
        let mut data = bincode::serialize(&ConfigKeys { keys }).unwrap();
        data.extend(bincode::serialize(&json.to_string()).unwrap());
        data
    }

    #[test]
    fn parses_a_validator_info_account() {
        let identity = Pubkey::new_unique();
        let data = encode(
            vec![(VALIDATOR_INFO_PROGRAM, false), (identity, true)],
            r#"{"name":"Lantern","website":"https://example.com"}"#,
        );
        let (parsed_identity, info) = parse(&data).unwrap();
        assert_eq!(parsed_identity, identity);
        assert_eq!(info.name.as_deref(), Some("Lantern"));
        assert_eq!(info.details, None);
    }

    #[test]
    fn ignores_other_config_accounts() {
        let data = encode(
            vec![(Pubkey::new_unique(), false), (Pubkey::new_unique(), true)],
            r#"{"name":"nope"}"#,
        );
        assert!(parse(&data).is_none());
    }

    #[test]
    fn ignores_malformed_data() {
        assert!(parse(&[]).is_none());
        assert!(parse(&[0xff; 32]).is_none());
        assert!(parse(&vec![0u8; MAX_VALIDATOR_INFO_LEN + 1]).is_none());
    }

    #[test]
    fn insert_reports_only_changes() {
        let mut cache = ValidatorInfoCache::default();
        let identity = Pubkey::new_unique();
        let info = ValidatorInfo {
            name: Some("Lantern".into()),
            ..Default::default()
        };
        assert!(cache.insert(identity, info.clone()));
        assert!(!cache.insert(identity, info));
        assert_eq!(cache.len(), 1);
    }
}
