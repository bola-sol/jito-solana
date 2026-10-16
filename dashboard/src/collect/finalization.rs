//! How often each validator's vote was in the finalization certificate a block carried, under
//! alpenglow. A block credits that certificate's signers with its recent slot and the reward
//! certificate's with the slot eight back, so a last vote near the newest in the bank was carried.

use {
    super::{Collector, TOPIC_SUMMARY},
    serde::Serialize,
    solana_clock::Slot,
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    solana_time_utils::timestamp,
    std::collections::{HashMap, VecDeque},
};

/// A last vote this close to the newest one in the bank counts as carried.
const NEAR_SLOTS: u64 = 3;

const MINUTE_MILLIS: u64 = 60_000;

/// Minutes behind the trend.
const TREND_MINUTES: usize = 60;

/// Minutes behind the share, the median and the bands.
const WINDOW_MINUTES: u64 = 10;

const BANDS: usize = 10;

/// Behind the time to vote, as for finality.
const VOTE_WINDOW_MILLIS: u64 = 60_000;

#[derive(Debug, Default)]
struct Minute {
    start_millis: u64,
    blocks: u32,
    /// Per vote account: blocks whose certificate carried it, and blocks it was staked in.
    by_vote: HashMap<Pubkey, (u32, u32)>,
}

#[derive(Debug, Default)]
pub(super) struct FinalizationTally {
    minutes: VecDeque<Minute>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FinalizationShare {
    pub blocks: u32,
    pub validators: usize,
    /// `None` when our vote account was not staked in the window.
    pub ours: Option<f64>,
    pub median: Option<f64>,
    /// Share of the other validators ours is above.
    pub above: Option<f64>,
    /// Validators per tenth of the share, lowest first.
    pub bands: [u32; BANDS],
    /// Finished minutes, oldest first.
    pub trend: Vec<TrendMinute>,
    /// Median from a block's last shred to our notarize vote over the last minute.
    pub vote_micros: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TrendMinute {
    pub start_millis: u64,
    pub ours: Option<f64>,
    pub median: Option<f64>,
}

impl FinalizationTally {
    /// One frozen block's staked vote accounts, each with its last voted slot.
    pub(super) fn observe(&mut self, votes: &[(Pubkey, Slot)], now_millis: u64) {
        let Some(front) = votes.iter().map(|(_, slot)| *slot).max() else {
            return;
        };
        let minute = self.minute(now_millis);
        minute.blocks = minute.blocks.saturating_add(1);
        for (vote, slot) in votes {
            let (carried, seen) = minute.by_vote.entry(*vote).or_default();
            *seen = seen.saturating_add(1);
            if front.saturating_sub(*slot) <= NEAR_SLOTS {
                *carried = carried.saturating_add(1);
            }
        }
    }

    fn minute(&mut self, now_millis: u64) -> &mut Minute {
        let start_millis = now_millis
            .checked_div(MINUTE_MILLIS)
            .unwrap_or_default()
            .saturating_mul(MINUTE_MILLIS);
        if self
            .minutes
            .back()
            .is_none_or(|minute| minute.start_millis != start_millis)
        {
            self.minutes.push_back(Minute {
                start_millis,
                ..Minute::default()
            });
            while self.minutes.len() > TREND_MINUTES.saturating_add(1) {
                self.minutes.pop_front();
            }
        }
        self.minutes.back_mut().expect("pushed above")
    }

    /// Each vote account's share over the window, for validators staked in at least half its blocks.
    pub(super) fn shares(&self, now_millis: u64) -> HashMap<Pubkey, f64> {
        let since = now_millis.saturating_sub(WINDOW_MINUTES.saturating_mul(MINUTE_MILLIS));
        shares_of(
            self.minutes
                .iter()
                .filter(|minute| minute.start_millis > since),
        )
    }

    pub(super) fn summary(
        &self,
        ours: &Pubkey,
        now_millis: u64,
        vote_micros: Option<u64>,
    ) -> Option<FinalizationShare> {
        let since = now_millis.saturating_sub(WINDOW_MINUTES.saturating_mul(MINUTE_MILLIS));
        let window: Vec<&Minute> = self
            .minutes
            .iter()
            .filter(|minute| minute.start_millis > since)
            .collect();
        let blocks = window
            .iter()
            .fold(0u32, |sum, minute| sum.saturating_add(minute.blocks));
        if blocks == 0 {
            return None;
        }
        let shares = shares_of(window.iter().copied());
        let mut values: Vec<f64> = shares.values().copied().collect();
        values.sort_by(f64::total_cmp);
        let own = shares.get(ours).copied();
        let above = own.and_then(|own| {
            let others = values.len().checked_sub(1).filter(|others| *others > 0)?;
            let below = values.iter().filter(|share| **share < own).count();
            Some(below as f64 / others as f64)
        });
        let mut bands = [0u32; BANDS];
        for share in &values {
            let band = ((share * BANDS as f64) as usize).min(BANDS.saturating_sub(1));
            bands[band] = bands[band].saturating_add(1);
        }
        let current = self.minutes.back().map(|minute| minute.start_millis);
        let trend = self
            .minutes
            .iter()
            .filter(|minute| Some(minute.start_millis) != current)
            .map(|minute| {
                let shares = shares_of(std::iter::once(minute));
                let mut values: Vec<f64> = shares.values().copied().collect();
                values.sort_by(f64::total_cmp);
                TrendMinute {
                    start_millis: minute.start_millis,
                    ours: shares.get(ours).copied(),
                    median: median(&values),
                }
            })
            .collect();
        Some(FinalizationShare {
            blocks,
            validators: values.len(),
            ours: own,
            median: median(&values),
            above,
            bands,
            trend,
            vote_micros,
        })
    }
}

impl Collector {
    pub(super) fn observe_finalization(&mut self, bank: &Bank) {
        if !bank.is_alpenglow() {
            return;
        }
        let votes: Vec<(Pubkey, Slot)> = bank
            .vote_accounts()
            .iter()
            .filter(|(_, (stake, _))| *stake > 0)
            .filter_map(|(vote, (_, account))| {
                Some((*vote, account.vote_state_view().last_voted_slot()?))
            })
            .collect();
        self.finalization.observe(&votes, timestamp());
    }

    pub(super) fn collect_finalization_share(&mut self, bank: &Bank) {
        let now_millis = timestamp();
        let share = bank
            .is_alpenglow()
            .then(|| {
                let vote_micros = self
                    .metrics_tap
                    .vote_lag_micros(now_millis, VOTE_WINDOW_MILLIS);
                self.finalization
                    .summary(&self.ctx.vote_account, now_millis, vote_micros)
            })
            .flatten();
        self.debounces.finalization_share.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "finalization_share",
            share,
        );
    }

    /// Each node's share over the window, for the peers list.
    pub(super) fn finalization_by_node(
        &self,
        bank: &Bank,
        now_millis: u64,
    ) -> HashMap<Pubkey, f64> {
        let shares = self.finalization.shares(now_millis);
        if shares.is_empty() {
            return HashMap::new();
        }
        bank.vote_accounts()
            .iter()
            .filter_map(|(vote, (_, account))| Some((*account.node_pubkey(), *shares.get(vote)?)))
            .collect()
    }
}

fn shares_of<'a>(minutes: impl Iterator<Item = &'a Minute>) -> HashMap<Pubkey, f64> {
    let mut blocks = 0u32;
    let mut totals: HashMap<Pubkey, (u32, u32)> = HashMap::new();
    for minute in minutes {
        blocks = blocks.saturating_add(minute.blocks);
        for (vote, (carried, seen)) in &minute.by_vote {
            let total = totals.entry(*vote).or_default();
            total.0 = total.0.saturating_add(*carried);
            total.1 = total.1.saturating_add(*seen);
        }
    }
    totals
        .into_iter()
        .filter(|(_, (_, seen))| seen.saturating_mul(2) >= blocks && *seen > 0)
        .map(|(vote, (carried, seen))| (vote, f64::from(carried) / f64::from(seen)))
        .collect()
}

/// The upper middle of sorted values.
fn median(sorted: &[f64]) -> Option<f64> {
    sorted.get(sorted.len().checked_div(2)?).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: u64 = 1_800_000_000_000;

    fn block(tally: &mut FinalizationTally, votes: &[(Pubkey, Slot)], at: u64) {
        tally.observe(votes, at);
    }

    #[test]
    fn test_a_vote_near_the_newest_was_carried() {
        let (ours, near, behind) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let mut tally = FinalizationTally::default();
        for slot in 100u64..110 {
            // Ours is carried in every other block, the reward certificate's eight back otherwise.
            let own = if slot % 2 == 0 {
                slot
            } else {
                slot.saturating_sub(8)
            };
            block(
                &mut tally,
                &[
                    (ours, own),
                    (near, slot.saturating_sub(3)),
                    (behind, slot.saturating_sub(8)),
                ],
                MINUTE,
            );
        }

        let summary = tally.summary(&ours, MINUTE, Some(11_400)).unwrap();
        assert_eq!(summary.blocks, 10);
        assert_eq!(summary.validators, 3);
        assert_eq!(summary.ours, Some(0.5));
        assert_eq!(summary.median, Some(0.5));
        assert_eq!(summary.above, Some(0.5), "above the one never carried");
        assert_eq!(summary.bands[0], 1);
        assert_eq!(summary.bands[5], 1);
        assert_eq!(summary.bands[9], 1, "a share of 1 falls in the top band");
        assert_eq!(summary.vote_micros, Some(11_400));
    }

    #[test]
    fn test_the_window_is_ten_minutes_and_the_trend_an_hour() {
        let ours = Pubkey::new_unique();
        let mut tally = FinalizationTally::default();
        for minute in 0..70u64 {
            let at = MINUTE.saturating_add(minute.saturating_mul(MINUTE_MILLIS));
            // Left out for the first sixty minutes, carried after.
            let own = if minute < 60 { 92 } else { 100 };
            block(&mut tally, &[(ours, own), (Pubkey::new_unique(), 100)], at);
        }
        let now = MINUTE.saturating_add(69u64.saturating_mul(MINUTE_MILLIS));

        let summary = tally.summary(&ours, now, None).unwrap();
        assert_eq!(summary.ours, Some(1.0), "only the last ten minutes count");
        assert_eq!(
            summary.trend.len(),
            TREND_MINUTES,
            "the current minute is left out"
        );
        assert_eq!(summary.trend.last().unwrap().ours, Some(1.0));
        assert_eq!(summary.trend.first().unwrap().ours, Some(0.0));
    }

    #[test]
    fn test_a_validator_staked_for_part_of_the_window_is_left_out() {
        let (ours, late) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut tally = FinalizationTally::default();
        for slot in 0..10 {
            let mut votes = vec![(ours, slot)];
            if slot >= 8 {
                votes.push((late, slot));
            }
            block(&mut tally, &votes, MINUTE);
        }

        assert_eq!(tally.shares(MINUTE).len(), 1);
        assert_eq!(tally.summary(&ours, MINUTE, None).unwrap().validators, 1);
        assert!(
            FinalizationTally::default()
                .summary(&ours, MINUTE, None)
                .is_none()
        );
    }
}
