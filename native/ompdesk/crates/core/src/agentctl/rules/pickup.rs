//! Where an idle session the caller opened left its work, read from what it said: its answer's verdict line and its
//! last report to the opener (`pickup.ts`). Pure. Also holds `parse_worker_result`, `parseWorkerResult` of
//! `src/shared/agent-control.ts` (the verdict line a worker ends its answer with), by hand because the core has no
//! regex engine; it is the one copy for the Rust side.
//!
//! Difference: a reason is cut at 160 UTF-16 code units as `String.prototype.slice` cuts, but never inside a
//! surrogate pair (a Rust string cannot hold half of one).

use super::mail::MailKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerResult {
    Ok,
    Problem { reason: String },
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `/^[>*_\s]*Result:[*_\s]*(ok|problem)\b[*_\s]*(?:[—–:-]+\s*(.*?))?[*_\s]*$/i` on one line: the verdict (`ok`
/// lower-cased) and the reason text, when it matches.
fn result_line(line: &str) -> Option<(bool, String)> {
    let skip = |s: &str, accept: &dyn Fn(char) -> bool| -> usize {
        s.char_indices()
            .find(|(_, c)| !accept(*c))
            .map_or(s.len(), |(at, _)| at)
    };
    let mut rest = &line[skip(line, &|c| c == '>' || c == '*' || c == '_' || js_space(c))..];
    let head = rest.get(..7)?;
    if !head.eq_ignore_ascii_case("result:") {
        return None;
    }
    rest = &rest[7..];
    let trail = |c: char| c == '*' || c == '_' || js_space(c);
    rest = &rest[skip(rest, &trail)..];
    let (ok, word) = if rest.get(..2).is_some_and(|w| w.eq_ignore_ascii_case("ok")) {
        (true, 2)
    } else if rest
        .get(..7)
        .is_some_and(|w| w.eq_ignore_ascii_case("problem"))
    {
        (false, 7)
    } else {
        return None;
    };
    rest = &rest[word..];
    // `\b`: the word's last letter is a word character, so the next one must not be.
    if rest.chars().next().is_some_and(is_word) {
        return None;
    }
    rest = &rest[skip(rest, &trail)..];
    if rest.is_empty() {
        return Some((ok, String::new()));
    }
    let dash = |c: char| matches!(c, '—' | '–' | ':' | '-');
    if !rest.starts_with(dash) {
        return None;
    }
    rest = &rest[skip(rest, &dash)..];
    rest = &rest[skip(rest, &js_space)..];
    // The lazy `(.*?)` stops where only `[*_\s]` is left; `.` never crosses a line terminator.
    let end = rest
        .char_indices()
        .filter(|(_, c)| !trail(*c))
        .map(|(at, c)| at + c.len_utf8())
        .next_back()
        .unwrap_or(0);
    let reason = &rest[..end];
    if reason.contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((ok, reason.to_owned()))
}

/// The structured verdict a worker ends its answer with; none when the last line is no such line. Prose is never read.
pub fn parse_worker_result(answer: Option<&str>) -> Option<WorkerResult> {
    let trimmed = answer.unwrap_or("").trim_end_matches(js_space);
    let last = trimmed.rsplit('\n').next().unwrap_or("");
    let (ok, reason) = result_line(last)?;
    Some(if ok {
        WorkerResult::Ok
    } else {
        WorkerResult::Problem {
            reason: reason.trim_matches(js_space).to_owned(),
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickupReport {
    pub kind: MailKind,
    pub dispatch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PickupFacts {
    /// Its last answer, whose final line may be `Result: ok` / `Result: problem — <reason>`.
    pub answer: Option<String>,
    /// Its last report to the opener, with the dispatch it was stamped with.
    pub report: Option<PickupReport>,
    /// The opener's current dispatch to it: a report stamped with an earlier one answers earlier work.
    pub dispatch: Option<String>,
}

/// `string.slice(0, 160)` by UTF-16 units.
fn cut_160(text: &str) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > 160 {
            return &text[..at];
        }
    }
    text
}

/// One short clause for an idle opened session's row, or none when nothing it said tells.
pub fn pickup_of(facts: &PickupFacts) -> Option<String> {
    match parse_worker_result(facts.answer.as_deref()) {
        Some(WorkerResult::Ok) => return Some("finished: Result ok".into()),
        Some(WorkerResult::Problem { reason }) => {
            return Some(if reason.is_empty() {
                "finished with a problem".into()
            } else {
                format!("finished with a problem: {}", cut_160(&reason))
            });
        }
        None => {}
    }
    let report = facts
        .report
        .as_ref()
        .filter(|report| report.dispatch == facts.dispatch);
    match report.map(|report| report.kind) {
        Some(kind @ (MailKind::Done | MailKind::Review)) => {
            return Some(format!("finished: reported {}", kind.as_str()));
        }
        Some(MailKind::Blocked) => return Some("stopped: reported blocked".into()),
        _ => {}
    }
    if facts.answer.as_deref().is_none_or(str::is_empty) {
        return Some("has not answered yet".into());
    }
    Some("ended its turn with no verdict line and no done report: read its answer, or ask it where the work stands".into())
}
