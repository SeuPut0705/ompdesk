//! The project's rules file (`AGENTS.md`, `CLAUDE.md` at the repository root, `.omp/rules/*.md`) is already in front
//! of every session, so a learned page that only repeats it is noise (was `src/main/ai-memory/rules-file.ts`).
//!
//! The check is local, no model call: a proposal is the rules file's when one sentence of the file holds at least
//! `RULES_COVERAGE` of the proposal's content terms, weighted by how rare each term is in the file (IDF over its
//! sentences), and at least `RULES_MIN_SHARED` of them. Terms are Latin words (lowercased, common words left out, a
//! plural or tense ending cut) and character pairs of Hangul, Han and kana runs.
//!
//! The weights use `Math.log`: `aimemory::value::js_log` is V8's (fdlibm) logarithm, which the platform's `f64::ln` is not
//! (it differs in the last digit for one weight in twelve, enough to flip a verdict that sits on `RULES_COVERAGE`).
//!
//! `rules_file-captured.json` holds what the TypeScript answered for the same inputs; the tests replay every row.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use icu_normalizer::ComposingNormalizerBorrowed;
use icu_properties::CodePointMapData;
use icu_properties::props::Script;

use crate::aimemory::value::js_log;
use crate::fs::order::{is_js_space, js_trim};

pub const RULES_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
/// omp's project rules folder: a repository can keep its rules there instead of one large `AGENTS.md`.
pub const RULES_DIR: &str = ".omp/rules";
pub const RULES_FILE_BYTES: usize = 4 * 1024 * 1024;
pub const RULES_COVERAGE: f64 = 0.6;
pub const RULES_MIN_SHARED: usize = 3;
/// The rules-file outline the distill prompt carries (about 1.5k tokens at most).
pub const RULES_OUTLINE_BYTES: usize = 6 * 1024;
/// A bold lead longer than this (UTF-16 units) is an emphasized sentence, not a label.
const OUTLINE_LEAD_CHARS: usize = 100;

/// Words that say nothing about what a rule is about.
const STOP_WORDS: [&str; 69] = [
    "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were", "has",
    "have", "had", "not", "but", "its", "it's", "any", "all", "can", "will", "would", "should",
    "must", "when", "then", "than", "them", "they", "their", "there", "here", "what", "which",
    "who", "how", "why", "use", "uses", "used", "using", "also", "only", "just", "more", "most",
    "very", "one", "two", "each", "every", "other", "our", "your", "you", "via", "per", "out",
    "off", "own", "same", "such", "does", "did", "done", "been", "being", "onto",
];

/// A text's content terms: a JavaScript `Set<string>`, which keeps the order terms were first added in (sums over
/// the terms run in that order, so floating-point results equal V8's).
///
/// A term is a Latin word or a pair of UTF-16 units out of a Hangul, Han or kana run. JavaScript cuts that run by
/// unit, so a character past U+FFFF (Han extension B and later) is cut into halves, each half a term with a lone
/// surrogate in it. A Rust string cannot hold one, so a lone surrogate unit `u` is spelled as the plane 15 private
/// use character `U+F0000 + (u - 0xD800)`: no letter of those scripts and no ASCII word ever holds such a character,
/// so two terms are equal exactly when the JavaScript strings were. A term is only compared and hashed, never shown.
#[derive(Clone, Debug, Default)]
pub struct Terms {
    order: Vec<String>,
    seen: HashSet<String>,
}

impl Terms {
    fn add(&mut self, term: String) {
        if self.seen.insert(term.clone()) {
            self.order.push(term);
        }
    }

    /// The terms in the order they were first added.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = &str> + '_ {
        self.order.iter().map(String::as_str)
    }

    pub fn contains(&self, term: &str) -> bool {
        self.seen.contains(term)
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

/// `word.slice(0, -ending.length)` for the first of `ing`, `ed`, `es`, `s` the word ends with and is long enough for.
fn stem(word: &str) -> &str {
    for ending in ["ing", "ed", "es", "s"] {
        if word.len() > ending.len() + 3 && word.ends_with(ending) {
            return &word[..word.len() - ending.len()];
        }
    }
    word
}

fn is_cjk(map: &icu_properties::CodePointMapDataBorrowed<'static, Script>, c: char) -> bool {
    let script = map.get(c);
    script == Script::Hangul
        || script == Script::Han
        || script == Script::Hiragana
        || script == Script::Katakana
}

/// Two UTF-16 units as a term (see `Terms`).
fn unit_pair(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|unit| {
            unit.unwrap_or_else(|lone| {
                char::from_u32(0xF0000 + u32::from(lone.unpaired_surrogate()) - 0xD800)
                    .unwrap_or('\u{fffd}')
            })
        })
        .collect()
}

/// `text.normalize("NFKC").toLowerCase()`.
fn nfkc_lower(text: &str) -> String {
    ComposingNormalizerBorrowed::new_nfkc()
        .normalize(text)
        .to_lowercase()
}

/// A text's content terms (`contentTerms`).
pub fn content_terms(text: &str) -> Terms {
    let mut terms = Terms::default();
    let lower = nfkc_lower(text);
    let bytes = lower.as_bytes();
    // `/[a-z][a-z0-9_]{2,}/g`: a letter and at least two more word characters, greedy, left to right.
    let mut at = 0;
    while at < bytes.len() {
        if !bytes[at].is_ascii_lowercase() {
            at += 1;
            continue;
        }
        let end = at
            + 1
            + bytes[at + 1..]
                .iter()
                .take_while(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || **byte == b'_'
                })
                .count();
        if end - at >= 3 {
            let word = &lower[at..end];
            if !STOP_WORDS.contains(&word) {
                terms.add(stem(word).to_owned());
            }
            at = end;
        } else {
            at += 1;
        }
    }
    // `/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu`, then every pair of UTF-16 units.
    let script = CodePointMapData::<Script>::new();
    let mut run: Vec<u16> = Vec::new();
    let flush = |run: &mut Vec<u16>, terms: &mut Terms| {
        for pair in run.windows(2) {
            terms.add(unit_pair(pair));
        }
        run.clear();
    };
    for c in lower.chars() {
        if is_cjk(&script, c) {
            let mut buffer = [0u16; 2];
            run.extend_from_slice(c.encode_utf16(&mut buffer));
        } else {
            flush(&mut run, &mut terms);
        }
    }
    flush(&mut run, &mut terms);
    terms
}

/// The rules text as sentences' terms, the units a proposal is compared with one by one.
#[derive(Clone, Debug, Default)]
pub struct RulesIndex {
    /// Each sentence's terms.
    pub units: Vec<Terms>,
    /// How many sentences hold each term.
    pub df: HashMap<String, usize>,
}

/// `text.split(/\n|(?<=[.!?;。])\s+/)`: a line break, or the whitespace after a sentence's end (all of it, line breaks
/// included, but never a `\n` that follows the end mark directly: the first alternative takes that one alone).
fn sentences(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut from = 0;
    let mut previous: Option<char> = None;
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if c == '\n' {
            parts.push(&text[from..at]);
            from = at + 1;
        } else if is_js_space(c)
            && previous.is_some_and(|p| matches!(p, '.' | '!' | '?' | ';' | '。'))
        {
            let mut end = at + c.len_utf8();
            while let Some(&(next, space)) = chars.peek() {
                if !is_js_space(space) {
                    break;
                }
                end = next + space.len_utf8();
                chars.next();
            }
            parts.push(&text[from..at]);
            from = end;
            previous = text[..end].chars().next_back();
            continue;
        }
        previous = Some(c);
    }
    parts.push(&text[from..]);
    parts
}

/// The index of a rules text (`rulesIndex`).
pub fn rules_index(text: &str) -> RulesIndex {
    let units: Vec<Terms> = sentences(text)
        .into_iter()
        .map(content_terms)
        .filter(|terms| terms.len() >= RULES_MIN_SHARED)
        .collect();
    let mut df: HashMap<String, usize> = HashMap::new();
    for unit in &units {
        for term in unit.iter() {
            *df.entry(term.to_owned()).or_insert(0) += 1;
        }
    }
    RulesIndex { units, df }
}

fn covered(terms: &Terms, index: &RulesIndex) -> bool {
    if terms.len() < RULES_MIN_SHARED {
        return false;
    }
    let units = (index.units.len() + 1) as f64;
    let weight: Vec<(&str, f64)> = terms
        .iter()
        .map(|term| {
            let held = index.df.get(term).copied().unwrap_or(0) + 1;
            (term, js_log(units / held as f64) + 1.0)
        })
        .collect();
    let mut total = 0.0;
    for (_, value) in &weight {
        total += value;
    }
    for unit in &index.units {
        let mut shared = 0usize;
        let mut held = 0.0;
        for (term, value) in &weight {
            if !unit.contains(term) {
                continue;
            }
            shared += 1;
            held += value;
        }
        if shared >= RULES_MIN_SHARED && held / total >= RULES_COVERAGE {
            return true;
        }
    }
    false
}

/// Whether the rules file already states what the proposal says (`statedByRules`). An empty `gist` counts as none.
pub fn stated_by_rules(index: &RulesIndex, title: &str, body: &str, gist: Option<&str>) -> bool {
    if index.units.is_empty() {
        return false;
    }
    gist.filter(|gist| !gist.is_empty())
        .is_some_and(|gist| covered(&content_terms(gist), index))
        || covered(&content_terms(&format!("{title}\n{body}")), index)
}

/// `/^#{1,3} \S/`: a `#`, `##` or `###` heading line.
fn is_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=3).contains(&hashes) {
        return false;
    }
    let mut rest = line[hashes..].chars();
    rest.next() == Some(' ') && rest.next().is_some_and(|c| !is_js_space(c))
}

/// `/^\s*(?:[-*]\s+)?\*\*([^*\n]+?)\*\*/.exec(line)?.[1]?.trim()`: the bold phrase a line opens with.
fn bold_lead(line: &str) -> Option<&str> {
    let rest = line.trim_start_matches(is_js_space);
    let rest = match rest.strip_prefix(['-', '*']) {
        Some(after) if after.starts_with(is_js_space) => after.trim_start_matches(is_js_space),
        _ => rest,
    };
    let rest = rest.strip_prefix("**")?;
    let stop = rest.find('*')?;
    if stop == 0 || !rest[stop..].starts_with("**") {
        return None;
    }
    Some(js_trim(&rest[..stop]))
}

/// What the distill prompt shows of the rules file (`rulesOutline`): the `#`, `##` and `###` headings, then the bold
/// lead phrases (`- **No count caps**: …` becomes `- No count caps`; one over 100 UTF-16 units is left out), shown in
/// the file's order, whole lines up to `RULES_OUTLINE_BYTES` UTF-8 bytes. Headings are taken first.
pub fn rules_outline(text: &str) -> String {
    let mut headings: Vec<(usize, String)> = Vec::new();
    let mut leads: Vec<(usize, String)> = Vec::new();
    for (at, line) in text.split('\n').enumerate() {
        if is_heading(line) {
            headings.push((at, line.trim_end_matches(is_js_space).to_owned()));
        } else if let Some(lead) = bold_lead(line)
            && !lead.is_empty()
            && lead.encode_utf16().count() <= OUTLINE_LEAD_CHARS
        {
            leads.push((at, format!("- {lead}")));
        }
    }
    let mut kept: Vec<(usize, String)> = Vec::new();
    let mut bytes = 0;
    for entry in headings.into_iter().chain(leads) {
        let size = entry.1.len() + 1;
        if bytes + size > RULES_OUTLINE_BYTES + 1 {
            break;
        }
        bytes += size;
        kept.push(entry);
    }
    kept.sort_by_key(|entry| entry.0);
    kept.into_iter()
        .map(|entry| entry.1)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The repository root holding `cwd` (a `.git` folder or file), else `cwd` itself.
fn repository_root(cwd: &Path) -> PathBuf {
    let mut dir = cwd;
    loop {
        if std::fs::metadata(dir.join(".git")).is_ok() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(up) => dir = up,
            None => return cwd.to_path_buf(),
        }
    }
}

/// A file's first `RULES_FILE_BYTES`, decoded as node's `toString("utf8")` does (a bad byte is U+FFFD, a cut inside a
/// character too); empty for anything that cannot be read.
fn head(file: &Path) -> String {
    use std::io::Read;
    let Ok(handle) = std::fs::File::open(file) else {
        return String::new();
    };
    let Ok(meta) = handle.metadata() else {
        return String::new();
    };
    let length = meta.len().min(RULES_FILE_BYTES as u64);
    let mut buffer = Vec::with_capacity(length as usize);
    if handle.take(length).read_to_end(&mut buffer).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

/// The rules text of the repository `cwd` is in (`readRulesText`), blocking: `AGENTS.md`, `CLAUDE.md` at its root,
/// then each `.omp/rules/*.md` in UTF-16 name order, each read up to `RULES_FILE_BYTES`, the empty ones dropped, joined
/// by `\n`. Empty when there are none or `cwd` is empty.
pub fn read_rules_text_blocking(cwd: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    let root = repository_root(Path::new(cwd));
    let mut names: Vec<std::ffi::OsString> = std::fs::read_dir(root.join(RULES_DIR))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name())
                .filter(|name| name.to_string_lossy().ends_with(".md"))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| {
        a.to_string_lossy()
            .encode_utf16()
            .cmp(b.to_string_lossy().encode_utf16())
    });
    let mut files: Vec<PathBuf> = RULES_FILES.iter().map(|name| root.join(name)).collect();
    files.extend(names.iter().map(|name| root.join(RULES_DIR).join(name)));
    files
        .iter()
        .map(|file| head(file))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `read_rules_text_blocking` on a blocking thread.
pub async fn read_rules_text(cwd: &str) -> String {
    let cwd = cwd.to_owned();
    tokio::task::spawn_blocking(move || read_rules_text_blocking(&cwd))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn table() -> Value {
        serde_json::from_str(&crate::json::whole_surrogates(include_str!(
            "rules_file-captured.json"
        )))
        .expect("the captured table is JSON")
    }

    fn text(value: &Value) -> &str {
        value.as_str().expect("a string")
    }

    fn rules_of(table: &Value, name: &str) -> String {
        text(&table["rulesTexts"][name]).to_owned()
    }

    const AGENTS: &str = "# Rules\n- Packaged apps keep only Electron's en-US and ko locales; never en alone, which blanks the window.\n- Settings rows read icon + label + control. Every string description sits behind its info glyph.";

    fn page(gist: &str) -> (String, String, Option<String>) {
        (
            "제목".to_owned(),
            "본문은 한국어로 쓴다".to_owned(),
            Some(gist.to_owned()),
        )
    }

    fn stated(index: &RulesIndex, (title, body, gist): &(String, String, Option<String>)) -> bool {
        stated_by_rules(index, title, body, gist.as_deref())
    }

    #[test]
    fn matches_a_gist_one_sentence_of_the_rules_file_holds_most_of_whatever_the_wordings_endings() {
        let index = rules_index(AGENTS);
        assert!(stated(
            &index,
            &page("Packaged builds keep only the en-US and ko Electron locales.")
        ));
        assert!(stated(
            &index,
            &page("Every settings description sits behind an info glyph.")
        ));
    }

    #[test]
    fn leaves_a_page_alone_that_shares_a_word_or_two_or_is_spread_over_several_sentences() {
        let index = rules_index(AGENTS);
        assert!(!stated(
            &index,
            &page("Settings changes need a relaunch of the window.")
        ));
        assert!(!stated(
            &index,
            &page("Packaged settings rows keep the glyph locales.")
        ));
        assert!(!stated(
            &rules_index(""),
            &page("Packaged builds keep only the en-US and ko Electron locales.")
        ));
    }

    #[test]
    fn outline_keeps_the_headings_and_the_bold_lead_phrases_in_the_files_order_and_nothing_else() {
        let outline = rules_outline(
            &[
                "# Rules",
                "Intro prose that is not kept.",
                "## Composer",
                "- **Esc while a turn runs only arms**: a second Esc stops.",
                "  - Nested prose without bold.",
                "#### Too deep",
                "**Bold paragraph lead.** More text.",
                "### Phone composer",
                "- Plain bullet with **bold inside** is not a lead.",
            ]
            .join("\n"),
        );
        assert_eq!(
            outline,
            [
                "# Rules",
                "## Composer",
                "- Esc while a turn runs only arms",
                "- Bold paragraph lead.",
                "### Phone composer",
            ]
            .join("\n")
        );
    }

    #[test]
    fn outline_stops_at_the_byte_bound_on_a_whole_line() {
        let text = (0..2000)
            .map(|index| format!("## 섹션 {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let outline = rules_outline(&text);
        assert!(outline.len() <= RULES_OUTLINE_BYTES);
        assert!(outline.split('\n').all(|line| {
            line.strip_prefix("## 섹션 ").is_some_and(|rest| {
                !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
            })
        }));
        assert_eq!(rules_outline(""), "");
    }

    #[test]
    fn outline_takes_every_heading_before_any_lead_so_a_long_files_later_sections_survive_the_bound()
     {
        let mut lines = vec!["# Rules".to_owned()];
        lines.extend((0..400).map(|index| format!("- **Early lead phrase number {index}**: text")));
        lines.push("## Late section".to_owned());
        lines.push("- **Late lead**: text".to_owned());
        let outline = rules_outline(&lines.join("\n"));
        assert!(outline.contains("## Late section"));
        assert!(outline.starts_with("# Rules\n- Early lead phrase number 0"));
        assert!(outline.len() <= RULES_OUTLINE_BYTES);
    }

    #[test]
    fn terms_keep_insertion_order_and_answer_membership() {
        let terms = content_terms("Running boxes; running 동시 세션 boxes");
        assert_eq!(
            terms.iter().collect::<Vec<_>>(),
            ["runn", "boxe", "동시", "세션"]
        );
        assert!(terms.contains("boxe") && !terms.contains("boxes"));
        assert_eq!(terms.len(), 4);
        assert!(content_terms("").is_empty());
    }

    #[test]
    fn every_captured_set_of_terms_is_what_the_typescript_made() {
        let table = table();
        for row in table["terms"].as_array().unwrap() {
            let expected: Vec<&str> = row["terms"].as_array().unwrap().iter().map(text).collect();
            let terms = content_terms(text(&row["text"]));
            assert_eq!(
                terms.iter().collect::<Vec<_>>(),
                expected,
                "{:?}",
                row["text"]
            );
            assert_eq!(terms.len(), expected.len());
        }
    }

    #[test]
    fn every_captured_index_is_what_the_typescript_made() {
        let table = table();
        for row in table["indexes"].as_array().unwrap() {
            let index = rules_index(text(&row["text"]));
            let units = row["units"].as_array().unwrap();
            assert_eq!(index.units.len(), units.len(), "{:?}", row["text"]);
            for (unit, expected) in index.units.iter().zip(units) {
                let expected: Vec<&str> = expected.as_array().unwrap().iter().map(text).collect();
                assert_eq!(
                    unit.iter().collect::<Vec<_>>(),
                    expected,
                    "{:?}",
                    row["text"]
                );
            }
            let df = row["df"].as_object().unwrap();
            assert_eq!(index.df.len(), df.len(), "{:?}", row["text"]);
            for (term, count) in df {
                assert_eq!(
                    index.df.get(term.as_str()).copied(),
                    count.as_u64().map(|n| n as usize)
                );
            }
        }
    }

    #[test]
    fn every_captured_verdict_is_what_the_typescript_said() {
        let table = table();
        let rows = table["stated"].as_array().unwrap();
        for row in rows {
            let index = rules_index(&rules_of(&table, text(&row["rules"])));
            let gist = row["gist"].as_str();
            let verdict = stated_by_rules(&index, text(&row["title"]), text(&row["body"]), gist);
            assert_eq!(verdict, row["stated"].as_bool().unwrap(), "{row}");
        }
        let held = rows
            .iter()
            .filter(|row| row["stated"].as_bool().unwrap())
            .count();
        assert!(
            held > 0 && held < rows.len(),
            "the table holds both verdicts"
        );
    }

    #[test]
    fn every_captured_outline_is_what_the_typescript_made() {
        let table = table();
        for row in table["outlines"].as_array().unwrap() {
            assert_eq!(
                rules_outline(text(&row["text"])),
                text(&row["outline"]),
                "{:?}",
                row["text"]
            );
        }
    }

    fn base64(encoded: &str) -> Vec<u8> {
        let mut out = Vec::new();
        let (mut bits, mut have) = (0u32, 0);
        for byte in encoded.bytes().filter(|byte| *byte != b'=') {
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                _ => 63,
            };
            bits = (bits << 6) | u32::from(value);
            have += 6;
            if have >= 8 {
                have -= 8;
                out.push((bits >> have) as u8);
                bits &= (1 << have) - 1;
            }
        }
        out
    }

    fn fnv(bytes: &[u8]) -> String {
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        for byte in bytes {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3);
        }
        format!("{hash:x}")
    }

    #[test]
    fn every_captured_folder_reads_as_readrulestext_did() {
        let table = table();
        let base = std::env::temp_dir().join(format!("rules7c-{}", std::process::id()));
        for (number, row) in table["reads"].as_array().unwrap().iter().enumerate() {
            let root = base.join(number.to_string());
            std::fs::create_dir_all(&root).unwrap();
            for file in row["files"].as_array().unwrap() {
                let target = root.join(text(&file["path"]));
                if file["dir"].as_bool() == Some(true) {
                    std::fs::create_dir_all(&target).unwrap();
                    continue;
                }
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                let bytes: Vec<u8> = match file["segments"].as_array() {
                    Some(segments) => segments
                        .iter()
                        .flat_map(|segment| {
                            let unit = base64(text(&segment[0]));
                            unit.repeat(segment[1].as_u64().unwrap() as usize)
                        })
                        .collect(),
                    None => file["text"].as_str().unwrap_or("").as_bytes().to_vec(),
                };
                std::fs::write(&target, bytes).unwrap();
            }
            let cwd = match row["cwd"].as_array().unwrap().as_slice() {
                [only] if text(only) == "\u{0}none" => String::new(),
                parts => {
                    let mut path = root.clone();
                    for part in parts {
                        path.push(text(part));
                    }
                    let mut path = path.to_string_lossy().into_owned();
                    if row["trailingSep"].as_bool() == Some(true) {
                        path.push('/');
                    }
                    path
                }
            };
            let got = read_rules_text_blocking(&cwd);
            let name = text(&row["name"]);
            match row["expected"].as_str() {
                Some(expected) => assert_eq!(got, expected, "{name}"),
                None => {
                    assert_eq!(
                        got.len() as u64,
                        row["expectedBytes"].as_u64().unwrap(),
                        "{name}"
                    );
                    assert_eq!(fnv(got.as_bytes()), text(&row["expectedFnv"]), "{name}");
                    assert!(got.starts_with(text(&row["expectedHead"])), "{name}");
                    assert!(got.ends_with(text(&row["expectedTail"])), "{name}");
                }
            }
            std::fs::remove_dir_all(&root).unwrap();
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn the_async_read_is_the_blocking_one_on_another_thread() {
        assert_eq!(read_rules_text("").await, "");
    }
}
