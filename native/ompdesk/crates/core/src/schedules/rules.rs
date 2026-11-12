//! The rules a schedule keeps, as `src/shared/schedules.ts` spells them for the page: whether a draft can be saved
//! (`scheduleDraftProblem`, which the Settings dialog still asks before it sends one), when a schedule starts next
//! (`nextRunAt`, which moved here whole), and the two things JavaScript's `Date` gave the service: reading a moment
//! (`Date.parse`) and writing one (`toISOString`). `captured.json` holds what the TypeScript answered for the same
//! inputs; `src/shared/schedules.test.ts` holds the page's copy of the draft rule to the same rows.
//!
//! A schedule is JSON as it was written (a journal keeps what it held, also what no rule names), so the rules read
//! values the way JavaScript did: `String(value)` before a pattern, `typeof` before a length.

use serde_json::Value;

use crate::control::js::string_of_value;
use crate::fs::order::{is_js_space, js_trim};

const MIN_INTERVAL: f64 = 5.0;
const MAX_INTERVAL: f64 = 7.0 * 24.0 * 60.0;
const GITHUB_EVENT_KINDS: [&str; 5] = ["pull_request", "issue", "ci_failure", "release", "push"];
const SESSION_EVENT_KINDS: [&str; 3] = ["done", "failed", "waiting"];
/// The longest a mail account's name or one of its filters may be, in UTF-16 units.
const MAIL_TEXT_MAX: usize = 200;
const DAY_MS: i64 = 86_400_000;

/// A calendar date; `month` and `day` count from 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Day {
    pub year: i64,
    pub month: u32,
    pub day: u32,
}

/// This computer's time zone, for the two questions a daily schedule and a moment without an offset ask.
pub trait Zone: Send {
    /// The local date at `ms` since the epoch.
    fn day(&self, ms: i64) -> Day;
    /// The instant of a local wall-clock minute, as `new Date(year, month, day, hour, minute)`.
    fn instant(&self, day: Day, hour: u32, minute: u32) -> i64;
}

/// The system's zone.
pub struct Local;

impl Zone for Local {
    fn day(&self, ms: i64) -> Day {
        // A zone the system cannot name reads as UTC.
        crate::sys::local_day(ms.div_euclid(1000))
            .map(|(year, month, day)| Day { year, month, day })
            .unwrap_or_else(|| civil(ms.div_euclid(DAY_MS)))
    }

    fn instant(&self, day: Day, hour: u32, minute: u32) -> i64 {
        crate::sys::local_instant(day.year, day.month, day.day, hour, minute)
            .map(|secs| secs * 1000)
            .unwrap_or_else(|| utc(day, hour, minute))
    }
}

/// A zone that is always `minutes` ahead of UTC (the tests' zone: the captured rows say theirs).
#[cfg(test)]
pub struct Fixed(pub i64);

#[cfg(test)]
impl Zone for Fixed {
    fn day(&self, ms: i64) -> Day {
        civil((ms + self.0 * 60_000).div_euclid(DAY_MS))
    }

    fn instant(&self, day: Day, hour: u32, minute: u32) -> i64 {
        utc(day, hour, minute) - self.0 * 60_000
    }
}

/// Days since the epoch of a date of the proleptic Gregorian calendar (Howard Hinnant's `days_from_civil`).
fn days(day: Day) -> i64 {
    let year = if day.month <= 2 {
        day.year - 1
    } else {
        day.year
    };
    let era = year.div_euclid(400);
    let of_era = year.rem_euclid(400);
    let month = i64::from(day.month);
    let of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day.day) - 1;
    let day_of_era = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date `days` after the epoch (`civil_from_days`).
fn civil(days: i64) -> Day {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let of_year = day_of_era - (365 * of_era + of_era / 4 - of_era / 100);
    let shifted_month = (5 * of_year + 2) / 153;
    let day = (of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = of_era + era * 400 + i64::from(month <= 2);
    Day { year, month, day }
}

fn utc(day: Day, hour: u32, minute: u32) -> i64 {
    days(day) * DAY_MS + i64::from(hour) * 3_600_000 + i64::from(minute) * 60_000
}

/// 0 = Sunday, as `getDay`.
fn weekday(day: Day) -> i64 {
    (days(day) + 4).rem_euclid(7)
}

/// `new Date(ms).toISOString()` for the years a schedule sees (0000 to 9999).
pub fn iso(ms: i64) -> String {
    let date = civil(ms.div_euclid(DAY_MS));
    let of_day = ms.rem_euclid(DAY_MS);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        date.year,
        date.month,
        date.day,
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

/// The furthest moment a JavaScript `Date` holds either way.
const TIME_CLIP: i64 = 8_640_000_000_000_000;

fn digits(text: &[u8], count: usize) -> Option<(i64, &[u8])> {
    let (head, rest) = text.split_at_checked(count)?;
    let mut value = 0;
    for byte in head {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    Some((value, rest))
}

/// `Date.parse(text)` for the date-time format ECMAScript defines (what `toISOString` writes and its shorter
/// forms): `YYYY[-MM[-DD]][THH:mm[:ss[.s…]]][Z|±HH:mm]`, a year of six digits with its sign, and what V8 takes
/// beside it: a small `t` or `z`, an offset without its colon, a day up to 31 in any month (the 31st of a short
/// month is a day of the next). A date alone is UTC, a date and time without an offset is local. Any other spelling
/// is no moment here, where V8 went on to guess.
pub fn date_parse(text: &str, zone: &dyn Zone) -> Option<i64> {
    let text = text.as_bytes();
    let (year, rest) = match text.first()? {
        sign @ (b'+' | b'-') => {
            let (year, rest) = digits(&text[1..], 6)?;
            if *sign == b'-' && year == 0 {
                return None;
            }
            (if *sign == b'-' { -year } else { year }, rest)
        }
        _ => digits(text, 4)?,
    };
    let mut month = 1;
    let mut day = 1;
    let mut rest = rest;
    if let Some(after) = rest.strip_prefix(b"-") {
        (month, rest) = digits(after, 2)?;
        if let Some(after) = rest.strip_prefix(b"-") {
            (day, rest) = digits(after, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let first = Day {
        year,
        month: month as u32,
        day: 1,
    };
    let date = civil(days(first) + day - 1);
    let Some(after) = rest.strip_prefix(b"T").or_else(|| rest.strip_prefix(b"t")) else {
        return rest
            .is_empty()
            .then(|| utc(date, 0, 0))
            .filter(|ms| ms.abs() <= TIME_CLIP);
    };
    let (hour, after) = digits(after, 2)?;
    let (minute, mut rest) = digits(after.strip_prefix(b":")?, 2)?;
    let mut second = 0;
    let mut milli = 0;
    if let Some(after) = rest.strip_prefix(b":") {
        (second, rest) = digits(after, 2)?;
        if let Some(after) = rest.strip_prefix(b".") {
            let count = after
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if count == 0 {
                return None;
            }
            // Milliseconds are the first three digits; the rest are dropped.
            let (fraction, _) = digits(after, count.min(3))?;
            milli = fraction * 10_i64.pow(3 - count.min(3) as u32);
            rest = &after[count..];
        }
    }
    let whole_day = hour == 24 && minute == 0 && second == 0 && milli == 0;
    if !(hour < 24 || whole_day) || minute > 59 || second > 59 {
        return None;
    }
    let of_minute = second * 1000 + milli;
    let ms = match rest {
        b"" => zone.instant(date, hour as u32, minute as u32) + of_minute,
        b"Z" | b"z" => utc(date, hour as u32, minute as u32) + of_minute,
        [sign @ (b'+' | b'-'), offset @ ..] => {
            let (hours, after) = digits(offset, 2)?;
            let (minutes, after) = digits(after.strip_prefix(b":").unwrap_or(after), 2)?;
            if !after.is_empty() || hours > 23 || minutes > 59 {
                return None;
            }
            let ahead = (hours * 60 + minutes) * 60_000;
            utc(date, hour as u32, minute as u32)
                + of_minute
                + if *sign == b'+' { -ahead } else { ahead }
        }
        _ => return None,
    };
    (ms.abs() <= TIME_CLIP).then_some(ms)
}

/// `^([01]\d|2[0-3]):([0-5]\d)$`: hours and minutes of a local `HH:MM`.
fn time_of(text: &str) -> Option<(u32, u32)> {
    let [h1, h2, b':', m1, m2] = text.as_bytes() else {
        return None;
    };
    if ![h1, h2, m1, m2].iter().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let hours = u32::from(h1 - b'0') * 10 + u32::from(h2 - b'0');
    let minutes = u32::from(m1 - b'0') * 10 + u32::from(m2 - b'0');
    (hours < 24 && minutes < 60).then_some((hours, minutes))
}

/// `^(?:\/|[A-Za-z]:[\\/])`: a path that names its root on either system.
pub fn is_absolute(path: &str) -> bool {
    match path.as_bytes() {
        [b'/', ..] => true,
        [drive, b':', b'\\' | b'/', ..] => drive.is_ascii_alphabetic(),
        _ => false,
    }
}

/// `^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$`: `owner/name` as GitHub spells a repository.
fn is_github_repo(text: &str) -> bool {
    let Some((owner, name)) = text.split_once('/') else {
        return false;
    };
    let plain = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'-';
    !owner.is_empty()
        && owner.bytes().all(plain)
        && !name.is_empty()
        && name
            .bytes()
            .all(|byte| plain(byte) || byte == b'.' || byte == b'_')
}

/// `^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\]+(?<![./])$`: the common subset of the names git takes for a branch.
fn is_branch(text: &str) -> bool {
    !text.is_empty()
        && !text.starts_with('-')
        && !text.contains("..")
        && !text.contains("//")
        && !text.ends_with(['.', '/'])
        && !text
            .chars()
            .any(|c| is_js_space(c) || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
}

/// JavaScript's truthiness of a parsed JSON value.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `Number.isInteger(value)` and its value.
fn integer(value: Option<&Value>) -> Option<f64> {
    value?
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0)
}

/// `value ?? ""` as a pattern reads it.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => string_of_value(value),
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Array.isArray(values) && values.length > 0 && values.every(value => allowed.includes(value))`.
fn non_empty_subset(values: Option<&Value>, allowed: &[&str]) -> bool {
    values.and_then(Value::as_array).is_some_and(|values| {
        !values.is_empty()
            && values
                .iter()
                .all(|value| value.as_str().is_some_and(|value| allowed.contains(&value)))
    })
}

/// Whether an event trigger is sound (`scheduleEventProblem` answers null).
fn event_sound(event: Option<&Value>) -> bool {
    let Some(event) = event.and_then(Value::as_object) else {
        return false;
    };
    match event.get("source").and_then(Value::as_str) {
        Some("webhook") => event
            .get("key")
            .and_then(Value::as_str)
            .is_some_and(|key| utf16_len(key) >= 16),
        Some("github") => {
            is_github_repo(&text_or_empty(event.get("repo")))
                && non_empty_subset(event.get("events"), &GITHUB_EVENT_KINDS)
        }
        Some("files") => is_absolute(&text_or_empty(event.get("path"))),
        Some("git") => {
            is_absolute(&text_or_empty(event.get("repo")))
                && is_branch(&text_or_empty(event.get("branch")))
        }
        Some("session") => {
            let folder = match event.get("folder") {
                None => true,
                Some(folder) => folder
                    .as_str()
                    .is_some_and(|folder| !js_trim(folder).is_empty()),
            };
            folder && non_empty_subset(event.get("events"), &SESSION_EVENT_KINDS)
        }
        Some("email") => {
            let short = |text: &str| !js_trim(text).is_empty() && utf16_len(text) <= MAIL_TEXT_MAX;
            event
                .get("account")
                .and_then(Value::as_str)
                .is_some_and(short)
                && ["from", "subject", "to"]
                    .iter()
                    .all(|name| match event.get(*name) {
                        None => true,
                        Some(value) => value.as_str().is_some_and(short),
                    })
        }
        _ => false,
    }
}

/// The JavaScript threw a `TypeError` over this draft (a name that is no text, days that are no list): a journal
/// holding such a schedule read as empty.
#[derive(Debug, PartialEq, Eq)]
pub struct Threw;

/// `scheduleDraftProblem(draft)`: why a draft cannot be saved, null when it can.
pub fn draft_problem(draft: &Value, zone: &dyn Zone) -> Result<Option<&'static str>, Threw> {
    // `draft.name.trim()`: only text has it.
    let text = |name: &str| draft.get(name).and_then(Value::as_str).ok_or(Threw);
    if js_trim(text("name")?).is_empty() {
        return Ok(Some("name"));
    }
    if js_trim(text("prompt")?).is_empty() {
        return Ok(Some("prompt"));
    }
    if !truthy(draft.get("cwd")) || !is_absolute(&text_or_empty(draft.get("cwd"))) {
        return Ok(Some("cwd"));
    }
    let frequency = match draft.get("frequency") {
        None | Some(Value::Null) => return Err(Threw),
        Some(frequency) => frequency,
    };
    Ok(match frequency.get("kind").and_then(Value::as_str) {
        Some("interval") => integer(frequency.get("minutes"))
            .is_none_or(|minutes| !(MIN_INTERVAL..=MAX_INTERVAL).contains(&minutes))
            .then_some("interval"),
        Some("daily") => {
            // `String(undefined)` is no time either.
            let time = frequency.get("time").map(string_of_value);
            if time.as_deref().and_then(time_of).is_none() {
                return Ok(Some("time"));
            }
            // `frequency.days.every(…)`: only a list has it.
            let days = frequency
                .get("days")
                .and_then(Value::as_array)
                .ok_or(Threw)?;
            days.iter()
                .any(|day| integer(Some(day)).is_none_or(|day| !(0.0..=6.0).contains(&day)))
                .then_some("days")
        }
        Some("once") => frequency
            .get("at")
            .and_then(Value::as_str)
            .and_then(|at| date_parse(at, zone))
            .is_none()
            .then_some("once"),
        Some("event") => (!event_sound(frequency.get("event"))).then_some("event"),
        _ => Some("interval"),
    })
}

/// `nextRunAt(frequency, now, lastStart, minuteMs)`: the first start strictly after `now`; none when the clock never
/// starts it (an event trigger, a one-time schedule whose moment passed). An interval repeats from the previous
/// start (else from `now`); a start that fell while the app was closed is skipped, so the next one is a full
/// interval away. A daily schedule starts at its local time on an allowed weekday. A one-time schedule's own start
/// is spent by turning it off, never read from its runs.
pub fn next_run_at(
    frequency: &Value,
    now: i64,
    last_start: Option<i64>,
    minute_ms: i64,
    zone: &dyn Zone,
) -> Option<i64> {
    match frequency.get("kind").and_then(Value::as_str)? {
        "once" => frequency
            .get("at")
            .and_then(Value::as_str)
            .and_then(|at| date_parse(at, zone))
            .filter(|at| *at > now),
        "interval" => {
            let step = (frequency.get("minutes")?.as_f64()? * minute_ms as f64) as i64;
            Some(match last_start {
                Some(last) if last + step > now => last + step,
                _ => now + step,
            })
        }
        "daily" => {
            let (hours, minutes) = frequency
                .get("time")
                .and_then(Value::as_str)
                .and_then(time_of)
                .unwrap_or((9, 0));
            let allowed = frequency.get("days").and_then(Value::as_array)?;
            let today = days(zone.day(now));
            (0..=7)
                .map(|offset| zone.instant(civil(today + offset), hours, minutes))
                .find(|candidate| {
                    *candidate > now
                        && (allowed.is_empty() || {
                            let on = weekday(zone.day(*candidate)) as f64;
                            allowed.iter().any(|day| day.as_f64() == Some(on))
                        })
                })
                // Unreachable with a valid weekday list; a day out runs again tomorrow at the time.
                .or_else(|| Some(zone.instant(civil(today + 1), hours, minutes)))
        }
        _ => None,
    }
}

/// One line of at most 500 UTF-16 units out of what a trigger said: `text.replace(/\s+/g, " ").trim().slice(0, 500)`.
pub fn one_line(text: &str) -> String {
    let mut line = String::with_capacity(text.len());
    let mut spaced = false;
    for c in text.chars() {
        if is_js_space(c) {
            spaced = true;
            continue;
        }
        if spaced && !line.is_empty() {
            line.push(' ');
        }
        spaced = false;
        line.push(c);
    }
    crate::json::utf16_prefix(&line, 500)
}

#[cfg(test)]
mod tests {
    use super::super::captured;
    use super::*;

    fn zone_of(row: &Value) -> Fixed {
        Fixed(row["offset"].as_i64().unwrap())
    }

    #[test]
    fn finds_the_next_start_as_the_typescript_did() {
        let rows = captured("nextRunAt");
        assert!(rows.len() > 1000);
        for row in rows {
            let next = next_run_at(
                &row["frequency"],
                row["now"].as_i64().unwrap(),
                row["last"].as_i64(),
                row["minuteMs"].as_i64().unwrap_or(60_000),
                &zone_of(&row),
            );
            assert_eq!(next, row["next"].as_i64(), "{row}");
        }
    }

    /// Spellings V8's fallback parser guessed a moment for; here they are no moment.
    const GUESSED: [&str; 1] = ["2026-1-5"];

    #[test]
    fn reads_a_moment_as_date_parse_did() {
        let rows = captured("dateParse");
        assert!(rows.len() > 150);
        for row in &rows {
            let text = row["text"].as_str().unwrap();
            let read = date_parse(text, &zone_of(row));
            if GUESSED.contains(&text) {
                assert!(row["ms"].as_i64().is_some(), "{row}");
                assert_eq!(read, None, "{row}");
            } else {
                assert_eq!(read, row["ms"].as_i64(), "{row}");
            }
        }
    }

    #[test]
    fn writes_a_moment_as_to_iso_string_did() {
        for row in captured("iso") {
            let ms = row["ms"].as_i64().unwrap();
            assert_eq!(iso(ms), row["text"].as_str().unwrap());
            assert_eq!(date_parse(&iso(ms), &Fixed(540)), Some(ms));
        }
    }

    #[test]
    fn names_a_drafts_problem_as_the_typescript_did() {
        let rows = captured("draftProblem");
        assert!(rows.len() > 150);
        for row in rows {
            let expected = if row["throws"] == true {
                Err(Threw)
            } else {
                Ok(row["problem"].as_str())
            };
            assert_eq!(draft_problem(&row["draft"], &Fixed(0)), expected, "{row}");
        }
    }

    #[test]
    fn the_systems_zone_reads_back_the_minute_it_wrote() {
        // Noon is no clock change anywhere.
        for ms in [0, 1_792_065_600_000, 1_771_329_600_000, 951_782_400_000] {
            let day = Local.day(ms);
            let noon = Local.instant(day, 12, 0);
            assert_eq!(Local.day(noon), day);
            assert!((noon - ms).abs() <= 2 * DAY_MS, "{ms} {noon}");
        }
    }

    #[test]
    fn keeps_one_line_of_what_a_trigger_said() {
        assert_eq!(one_line("  src/b.ts \u{a0}  changed\n"), "src/b.ts changed");
        assert_eq!(one_line(" \t\n"), "");
        assert_eq!(one_line(&"x".repeat(600)).len(), 500);
        // A pair cut in half ends in U+FFFD, where JavaScript kept the lone half.
        let cut = one_line(&format!("{}😀", "x".repeat(499)));
        assert_eq!(cut.chars().count(), 500);
        assert!(cut.ends_with('\u{fffd}'));
    }
}
