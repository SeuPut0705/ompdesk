//! Notification policy shared by desktop banners and Web Push (`notification-batch.ts`). The
//! caller owns OS handles and timers; this state owns the fixed window, priority and retractions.
//! Text is injected from the shell's existing main-text table, never duplicated here.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const BATCH_WINDOW_MS: i64 = 4_000;

pub trait Text: Send + Sync {
    fn text(&self, key: &str, params: &[(&str, String)]) -> String;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Completion,
    Error,
    Ask,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Completion => "completion",
            Self::Error => "error",
            Self::Ask => "ask",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub tab: Option<String>,
    pub kind: Option<Kind>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    pub finished: usize,
    pub failed: usize,
    pub asks: usize,
}
impl Counts {
    pub fn total(&self) -> usize {
        self.finished + self.failed + self.asks
    }
}

#[derive(Clone, Debug)]
pub struct Shown {
    pub window: i64,
    pub notice: Notice,
    pub summary: Option<Counts>,
    /// Close the first banner only when a summary actually replaces it.
    pub replace_first: bool,
    pub first_tab: Option<String>,
}

struct Entry {
    title: String,
    kind: Kind,
    seq: u64,
}
struct Batch {
    first_tab: String,
    entries: HashMap<String, Entry>,
    followers: u64,
    at: i64,
    order: u64,
}

#[derive(Default)]
pub struct Batcher {
    batches: HashMap<i64, Batch>,
    seq: u64,
}

impl Batcher {
    pub fn notify(&mut self, window: i64, notice: Notice, now: i64) -> Option<Shown> {
        let (Some(kind), Some(tab)) = (notice.kind, notice.tab.as_ref().filter(|s| !s.is_empty()))
        else {
            return Some(Shown {
                window,
                notice,
                summary: None,
                replace_first: false,
                first_tab: None,
            });
        };
        let first = !self.batches.contains_key(&window);
        let batch = self.batches.entry(window).or_insert_with(|| Batch {
            first_tab: tab.clone(),
            entries: HashMap::new(),
            followers: 0,
            at: now.saturating_add(BATCH_WINDOW_MS),
            order: self.seq,
        });
        if !first {
            batch.followers += 1;
        }
        let winner = batch
            .entries
            .get(tab)
            .map_or(kind, |old| old.kind.max(kind));
        batch.entries.insert(
            tab.clone(),
            Entry {
                title: notice.title.clone(),
                kind: winner,
                seq: self.seq,
            },
        );
        self.seq += 1;
        if first {
            let first_tab = Some(tab.clone());
            Some(Shown {
                window,
                notice,
                summary: None,
                replace_first: false,
                first_tab,
            })
        } else {
            None
        }
    }

    pub fn retract(&mut self, window: i64, tab: &str) {
        if let Some(batch) = self.batches.get_mut(&window)
            && batch
                .entries
                .get(tab)
                .is_some_and(|entry| entry.kind == Kind::Ask)
        {
            batch.entries.remove(tab);
        }
    }

    pub fn next_due(&self) -> Option<i64> {
        self.batches.values().map(|b| b.at).min()
    }
    pub fn drop_window(&mut self, window: i64) {
        self.batches.remove(&window);
    }
    pub fn dispose(&mut self) {
        self.batches.clear();
    }

    pub fn advance(&mut self, now: i64, text: &dyn Text) -> Vec<Shown> {
        let mut due: Vec<_> = self
            .batches
            .iter()
            .filter(|(_, b)| b.at <= now)
            .map(|(win, b)| (*win, b.at, b.order))
            .collect();
        due.sort_by_key(|(_, at, order)| (*at, *order));
        let mut shown = Vec::new();
        for (window, _, _) in due {
            let Some(batch) = self.batches.remove(&window) else {
                continue;
            };
            if batch.followers == 0 || batch.entries.is_empty() {
                continue;
            }
            let mut ranked: Vec<_> = batch.entries.into_iter().collect();
            ranked.sort_by(|(_, a), (_, b)| b.kind.cmp(&a.kind).then_with(|| b.seq.cmp(&a.seq)));
            let mut counts = Counts::default();
            for (_, entry) in &ranked {
                match entry.kind {
                    Kind::Completion => counts.finished += 1,
                    Kind::Error => counts.failed += 1,
                    Kind::Ask => counts.asks += 1,
                }
            }
            let titles: Vec<_> = ranked.iter().map(|(_, e)| e.title.as_str()).collect();
            let (title, body) = format_summary(&counts, &titles, text);
            let (tab, kind) = ranked
                .first()
                .map(|(t, e)| (Some(t.clone()), Some(e.kind)))
                .unwrap_or_default();
            shown.push(Shown {
                window,
                notice: Notice {
                    title,
                    body,
                    tab,
                    kind,
                },
                summary: Some(counts),
                replace_first: true,
                first_tab: Some(batch.first_tab),
            });
        }
        shown
    }
}

pub fn format_summary(counts: &Counts, titles: &[&str], text: &dyn Text) -> (String, String) {
    let mut parts = Vec::new();
    if counts.finished > 0 {
        let key = if counts.finished == 1 {
            "batch.finished.one"
        } else {
            "batch.finished.other"
        };
        parts.push(text.text(key, &[("count", counts.finished.to_string())]));
    }
    if counts.failed > 0 {
        parts.push(text.text("batch.failed", &[("count", counts.failed.to_string())]));
    }
    if counts.asks > 0 {
        let key = if counts.asks == 1 {
            "batch.needsYou.one"
        } else {
            "batch.needsYou.other"
        };
        parts.push(text.text(key, &[("count", counts.asks.to_string())]));
    }
    let list = titles
        .iter()
        .take(3)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let body = if titles.len() > 3 {
        text.text(
            "batch.more",
            &[("list", list), ("count", (titles.len() - 3).to_string())],
        )
    } else {
        list
    };
    (parts.join(" · "), body)
}

/// Stock omp notifications have no body. This is the GUI's existing prose extraction, kept shared
/// with desktop banners. UTF-16 cuts follow the page's contract, including a split surrogate.
pub fn notification_summary(markdown: &str, limit: usize) -> String {
    let no_fences = strip_fences(markdown);
    let no_comments = remove_sections(&no_fences, "<!--", "-->");
    let lines: Vec<_> = no_comments.split('\n').map(prose_line).collect();
    let mut prose = lines.join("\n");
    prose = links(&prose);
    prose = tags(&prose);
    prose = inline_code(&prose);
    prose = marked_spans(&prose, &["**", "__"]);
    prose = emphasis(&prose);
    prose = marked_spans(&prose, &["~~"]);
    let mut paragraphs = Vec::new();
    let mut paragraph = String::new();
    for line in prose.split('\n') {
        if line.trim_matches(super::auth::js_space).is_empty() {
            if !paragraph.is_empty() {
                paragraphs.push(std::mem::take(&mut paragraph));
            }
        } else {
            if !paragraph.is_empty() {
                paragraph.push(' ');
            }
            paragraph.push_str(line);
        }
    }
    if !paragraph.is_empty() {
        paragraphs.push(paragraph);
    }
    let mut paragraphs: Vec<_> = paragraphs
        .into_iter()
        .map(|s| flatten(&s))
        .filter(|s| !s.is_empty())
        .collect();
    let length = paragraphs.len();
    for (index, paragraph) in paragraphs.iter_mut().enumerate() {
        if index + 1 < length && !paragraph.ends_with(['.', '!', '?', ':', '。']) {
            paragraph.push('.');
        }
    }
    let prose = paragraphs.join(" ");
    if prose.encode_utf16().count() <= limit {
        return prose;
    }
    let cut = crate::json::utf16_prefix(&prose, limit.saturating_sub(1));
    let cut = match cut.rfind(' ') {
        Some(space) if cut[..space].encode_utf16().count() > limit / 2 => &cut[..space],
        _ => &cut,
    };
    format!(
        "{}…",
        cut.trim_end_matches(
            |c: char| super::auth::js_space(c) || matches!(c, ',' | '.' | ';' | ':')
        )
    )
}

pub fn flatten(text: &str) -> String {
    text.split(super::auth::js_space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_fences(text: &str) -> String {
    let mut out = String::new();
    let mut fence: Option<&str> = None;
    for line in text.split_inclusive('\n') {
        if let Some(marker) = fence {
            if line.starts_with(marker) {
                fence = None;
            }
            continue;
        }
        if line.ends_with('\n') && (line.starts_with("```") || line.starts_with("~~~")) {
            fence = Some(&line[..3]);
            out.push('\n');
        } else {
            out.push_str(line);
        }
    }
    out
}

fn remove_sections(text: &str, open: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(open) {
        let Some(end) = rest[start + open.len()..].find(close) else {
            break;
        };
        out.push_str(&rest[..start]);
        rest = &rest[start + open.len() + end + close.len()..];
    }
    out.push_str(rest);
    out
}

fn prose_line(line: &str) -> String {
    let mut line = line.trim_matches(super::auth::js_space);
    if (line.starts_with('|') && line.ends_with('|'))
        || (line.chars().filter(|c| !super::auth::js_space(*c)).count() >= 3
            && line
                .chars()
                .all(|c| super::auth::js_space(c) || matches!(c, '-' | '*' | '_')))
    {
        return String::new();
    }
    let heading = line.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&heading)
        && line[heading..]
            .chars()
            .next()
            .is_some_and(super::auth::js_space)
    {
        line = line[heading..].trim_start_matches(super::auth::js_space);
    }
    while let Some(rest) = line.strip_prefix('>') {
        line = rest.trim_start_matches(super::auth::js_space);
    }
    for alert in [
        "[!NOTE]",
        "[!TIP]",
        "[!IMPORTANT]",
        "[!WARNING]",
        "[!CAUTION]",
    ] {
        if line
            .get(..alert.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(alert))
        {
            line = line[alert.len()..].trim_start_matches(super::auth::js_space);
            break;
        }
    }
    let marker = if matches!(line.as_bytes().first(), Some(b'-' | b'*' | b'+')) {
        1
    } else {
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && matches!(line.as_bytes().get(digits), Some(b'.' | b')')) {
            digits + 1
        } else {
            0
        }
    };
    if marker > 0
        && line[marker..]
            .chars()
            .next()
            .is_some_and(super::auth::js_space)
    {
        line = line[marker..].trim_start_matches(super::auth::js_space);
        if matches!(line.get(..3), Some("[ ]" | "[x]" | "[X]"))
            && line[3..].chars().next().is_some_and(super::auth::js_space)
        {
            line = line[3..].trim_start_matches(super::auth::js_space);
        }
    }
    line.to_owned()
}

fn links(text: &str) -> String {
    replace_links(&replace_links(text, true), false)
}

fn replace_links(text: &str, image: bool) -> String {
    let mut out = String::new();
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let opening = if image {
            if rest.starts_with("![") { 2 } else { 0 }
        } else if rest.starts_with('[') {
            1
        } else {
            0
        };
        if opening > 0
            && let Some(label_end) = rest[opening..].find(']')
        {
            let label_end = opening + label_end;
            if (image || label_end > opening)
                && rest[label_end..].starts_with("](")
                && let Some(end) = rest[label_end + 2..].find(')')
            {
                if !image {
                    out.push_str(&rest[opening..label_end]);
                }
                at += label_end + 2 + end + 1;
                continue;
            }
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        at += c.len_utf8();
    }
    out
}

fn tags(text: &str) -> String {
    let mut out = String::new();
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let tag = rest
            .strip_prefix('<')
            .map(|s| s.strip_prefix('/').unwrap_or(s))
            .is_some_and(|s| s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic));
        if tag && let Some(end) = rest.find('>') {
            at += end + 1;
            continue;
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        at += c.len_utf8();
    }
    out
}

fn inline_code(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('`') {
        let width = rest[start..].bytes().take_while(|b| *b == b'`').count();
        let tail = &rest[start + width..];
        let Some(end) = tail.find('`') else {
            if width >= 2 {
                out.push_str(&rest[..start]);
                rest = tail;
                continue;
            }
            break;
        };
        out.push_str(&rest[..start]);
        out.push_str(&tail[..end]);
        let closing = tail[end..].bytes().take_while(|b| *b == b'`').count();
        rest = &tail[end + closing..];
    }
    out.push_str(rest);
    out
}

fn marked_spans(text: &str, markers: &[&str]) -> String {
    let mut out = String::new();
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        if let Some(marker) = markers.iter().find(|marker| rest.starts_with(**marker)) {
            let tail = &rest[marker.len()..];
            if let Some(end) = tail
                .char_indices()
                .take_while(|(_, c)| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
                .find_map(|(index, _)| {
                    (index > 0 && tail[index..].starts_with(marker)).then_some(index)
                })
            {
                out.push_str(&tail[..end]);
                at += marker.len() + end + marker.len();
                continue;
            }
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        at += c.len_utf8();
    }
    out
}

fn emphasis(text: &str) -> String {
    fn word(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_' || c == '*'
    }
    let mut out = String::new();
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let c = rest.chars().next().unwrap_or_default();
        if matches!(c, '*' | '_') && !text[..at].chars().next_back().is_some_and(word) {
            let tail = &rest[1..];
            if tail
                .chars()
                .next()
                .is_some_and(|c| !super::auth::js_space(c))
            {
                let found = tail.char_indices().find(|(end, c)| {
                    *end > 0
                        && matches!(c, '*' | '_')
                        && !tail[..*end].contains(['\n', '\r', '\u{2028}', '\u{2029}'])
                        && !tail[..*end]
                            .chars()
                            .next_back()
                            .is_some_and(super::auth::js_space)
                        && !tail[*end + 1..].chars().next().is_some_and(word)
                });
                if let Some((end, _)) = found {
                    out.push_str(&tail[..end]);
                    at += end + 2;
                    continue;
                }
            }
        }
        out.push(c);
        at += c.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Labels;
    impl Text for Labels {
        fn text(&self, key: &str, params: &[(&str, String)]) -> String {
            let labels: serde_json::Value =
                serde_json::from_str(include_str!("../../../shell/src/boot_core/main-text.json"))
                    .unwrap();
            let mut text = labels[key]["en"].as_str().unwrap().to_owned();
            for (key, value) in params {
                text = text.replace(&format!("{{{key}}}"), value);
            }
            text
        }
    }
    fn notice(tab: &str, kind: Kind) -> Notice {
        Notice {
            title: format!("Tab {tab}"),
            body: "body".into(),
            tab: Some(tab.into()),
            kind: Some(kind),
        }
    }

    #[test]
    fn first_banner_fixed_window_priority_and_retract_match_desktop() {
        let mut batcher = Batcher::default();
        assert!(
            batcher
                .notify(1, notice("a", Kind::Completion), 0)
                .is_some()
        );
        assert!(batcher.notify(1, notice("b", Kind::Ask), 1000).is_none());
        batcher.notify(1, notice("b", Kind::Error), 2000);
        assert_eq!(batcher.next_due(), Some(4000));
        assert!(batcher.advance(3999, &Labels).is_empty());
        let shown = batcher.advance(4000, &Labels);
        assert_eq!(shown[0].notice.title, "1 task finished · 1 needs you");
        assert_eq!(shown[0].notice.tab.as_deref(), Some("b"));
        assert!(shown[0].replace_first);
        batcher.notify(1, notice("a", Kind::Completion), 5000);
        batcher.notify(1, notice("b", Kind::Ask), 5001);
        batcher.retract(1, "b");
        let shown = batcher.advance(9000, &Labels);
        assert_eq!(shown[0].notice.title, "1 task finished");
        assert_eq!(shown[0].summary.as_ref().unwrap().total(), 1);
    }

    #[test]
    fn independent_windows_lone_notices_and_disposal() {
        let mut batcher = Batcher::default();
        batcher.notify(1, notice("a", Kind::Ask), 0);
        batcher.notify(2, notice("b", Kind::Error), 0);
        assert!(batcher.advance(4000, &Labels).is_empty());
        batcher.notify(1, notice("a", Kind::Ask), 5000);
        batcher.notify(1, notice("b", Kind::Ask), 5001);
        batcher.retract(1, "a");
        batcher.retract(1, "b");
        assert!(batcher.advance(9000, &Labels).is_empty());
        batcher.notify(1, notice("a", Kind::Ask), 10000);
        batcher.dispose();
        assert_eq!(batcher.next_due(), None);
    }

    #[test]
    fn captured_typescript_summary_behavior() {
        #[derive(Deserialize)]
        struct Case {
            markdown: String,
            limit: usize,
            expected: String,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!("summary-capture.json")).unwrap();
        for case in cases {
            assert_eq!(
                notification_summary(&case.markdown, case.limit),
                case.expected,
                "limit={} markdown={:?}",
                case.limit,
                case.markdown
            );
        }
    }

    #[test]
    fn summary_matches_typescript_prose_cases() {
        for (markdown, expected) in [
            (
                "## Summary\n\n- **Fixed** the `parser` in [lexer.ts](src/lexer.ts)\n- Added _two_ tests\n\nAll green.",
                "Summary. Fixed the parser in lexer.ts Added two tests. All green.",
            ),
            (
                "Done.\n\n```ts\nconst x = 1;\n```\n\n![shot](a.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n<details>Ran it</details>",
                "Done. Ran it",
            ),
            (
                "Shipped.\n\n> [!WARNING]\n> Back up first.",
                "Shipped. Back up first.",
            ),
            (
                "Renamed max_tokens; 2 * 3 = 6",
                "Renamed max_tokens; 2 * 3 = 6",
            ),
            ("```\nls\n```", ""),
        ] {
            assert_eq!(notification_summary(markdown, 160), expected);
        }
        let summary = notification_summary(&"word ".repeat(80), 40);
        assert!(summary.encode_utf16().count() <= 40);
        assert!(summary.ends_with("word…"));
    }
}
