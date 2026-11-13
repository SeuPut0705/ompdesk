//! Tests and cost (check control P4, `docs/design/check-control.md` §5 policy 4 and §8): what a repository's runs say
//! about its tests and what they cost. `slow` is the slowdown rule, `cost` the runner minutes by operating system,
//! `tab` the picture the Checks page's "Tests and cost" tab draws. The facts come from `results::ledger`.

pub mod cost;
pub mod slow;
pub mod tab;

use serde::{Deserialize, Serialize};

use super::contract::Os;

pub const DAY_MS: u64 = 86_400_000;
/// How far back a test's median looks.
pub const WINDOW_DAYS: u64 = 30;

/// The UTC day a time (milliseconds since the epoch) falls on.
pub fn day_of(ms: u64) -> u32 {
    (ms / DAY_MS) as u32
}

/// `YYYY-MM` of a UTC day (days since 1970-01-01; the proleptic Gregorian calendar, as `Date` counts).
pub fn month_of(day: u32) -> String {
    let z = i64::from(day) + 719_468;
    let (era, day_of_era) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let month = if month_part < 10 {
        month_part + 3
    } else {
        month_part - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}")
}

/// The middle of the values (the lower of the two middle ones for an even count, so it is always a value seen).
pub fn median(values: &mut [u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[(values.len() - 1) / 2])
}

/// One value per operating system.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct PerOs<T> {
    pub macos: T,
    pub windows: T,
    pub linux: T,
}

impl<T> PerOs<T> {
    pub fn of(&self, os: Os) -> &T {
        match os {
            Os::Macos => &self.macos,
            Os::Windows => &self.windows,
            Os::Linux => &self.linux,
        }
    }

    pub fn of_mut(&mut self, os: Os) -> &mut T {
        match os {
            Os::Macos => &mut self.macos,
            Os::Windows => &mut self.windows,
            Os::Linux => &mut self.linux,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_names_its_month() {
        assert_eq!(month_of(0), "1970-01");
        assert_eq!(month_of(30), "1970-01");
        assert_eq!(month_of(31), "1970-02");
        // 29 Feb 2024 and the day after; 13 Nov 2026.
        assert_eq!(month_of(19_782), "2024-02");
        assert_eq!(month_of(19_783), "2024-03");
        assert_eq!(month_of(day_of(1_794_528_000_000)), "2026-11");
        assert_eq!(month_of(20_818), "2026-12");
        assert_eq!(month_of(20_819), "2027-01");
    }

    #[test]
    fn the_median_is_a_value_that_was_seen() {
        assert_eq!(median(&mut []), None);
        assert_eq!(median(&mut [7]), Some(7));
        assert_eq!(median(&mut [9, 1]), Some(1));
        assert_eq!(median(&mut [5, 1, 9]), Some(5));
        assert_eq!(median(&mut [4, 1, 9, 5]), Some(4));
    }
}
