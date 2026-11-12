//! Turning a stretch of a person's conversation into the few durable pages worth keeping (was
//! `src/main/ai-memory/distill.ts`): what is read, what is asked, what is accepted. The schedule and the I/O are the
//! engine's.
//!
//! `distill-captured.json` holds what the TypeScript answered for the same inputs; the tests replay every row.
//!
//! Facts the TypeScript read with `memory-prompt.ts` are inputs here (the stock worker answers them): a prompt's
//! `isAgentPrompt` and a task title's `unwrapPrompt(title).body`.

use std::collections::HashSet;

use icu_normalizer::ComposingNormalizerBorrowed;
use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use serde::{Deserialize, Serialize};

use crate::fs::order::{is_js_space, js_trim};
use crate::git::parse::js_number;
use crate::json::utf16_prefix;

/// A window needs this many new prompts a person typed before it is worth a model call.
pub const DISTILL_MIN_PROMPTS: usize = 6;
/// One prompt is read up to this long (UTF-16 units).
const PROMPT_CHARS: usize = 700;
/// A window reads at most this many prompts (the newest are kept).
const WINDOW_PROMPTS: usize = 40;
pub(crate) const TASK_TITLES: usize = 12;
/// The project's own durable pages the model is shown (path, title, the start of the body), newest first.
pub const KNOWN_PROJECT_PAGES: usize = 30;
/// The owner's preferences (kept in `_global`, read in every project) the model is shown beside them.
pub const KNOWN_GLOBAL_PAGES: usize = 20;
/// How much of a known page's body the model reads.
pub const KNOWN_EXCERPT_CHARS: usize = 200;
/// Project pages (decision, rule, gotcha, procedure) one window may add.
pub const DISTILL_MAX_PAGES: usize = 3;
/// The owner's preferences and corrections one window may add, beside the project pages.
pub const DISTILL_MAX_GLOBAL_PAGES: usize = 2;
const MIN_CONFIDENCE: f64 = 0.75;
/// A correction is accepted from this confidence, and is kept first among the owner's pages.
const CORRECTION_MIN_CONFIDENCE: f64 = 0.65;
/// Fewer characters than this (UTF-16 units) is a heading, not a page.
const BODY_MIN: usize = 40;
const BODY_MAX: usize = 1800;
const TITLE_MAX: usize = 80;
/// A quote shorter than this proves nothing.
const QUOTE_MIN: usize = 4;
const QUOTE_MAX: usize = 300;
const GIST_MAX: usize = 300;
/// A model's JSON nested deeper than this is no answer (JavaScript's parser has a far larger, stack-bound limit).
const JSON_DEPTH: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistillKind {
    Decision,
    Rule,
    Gotcha,
    Procedure,
    Preference,
    Correction,
}

/// `{ workspace, project }` of a memory project.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProjectName {
    pub workspace: &'static str,
    pub project: &'static str,
}

/// `_global`: the reserved project ai-memory's `memory_query` unions into every project's default recall.
pub const GLOBAL_PROJECT: ProjectName = ProjectName {
    workspace: "default",
    project: "_global",
};

/// Where a kind's pages live and how the server files them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub folder: &'static str,
    /// `semantic` or `procedural`.
    pub tier: &'static str,
    pub kind: &'static str,
    /// The owner's page, not the project's: it goes to `_global`.
    pub global: bool,
}

/// Every kind with its layout (`KIND_LAYOUT`), in the TypeScript's key order.
pub const KIND_LAYOUT: [(DistillKind, Layout); 6] = [
    (
        DistillKind::Decision,
        Layout {
            folder: "decisions",
            tier: "semantic",
            kind: "decision",
            global: false,
        },
    ),
    (
        DistillKind::Rule,
        Layout {
            folder: "_rules",
            tier: "semantic",
            kind: "rule",
            global: false,
        },
    ),
    (
        DistillKind::Gotcha,
        Layout {
            folder: "gotchas",
            tier: "semantic",
            kind: "gotcha",
            global: false,
        },
    ),
    (
        DistillKind::Procedure,
        Layout {
            folder: "procedures",
            tier: "procedural",
            kind: "fact",
            global: false,
        },
    ),
    (
        DistillKind::Preference,
        Layout {
            folder: "preferences",
            tier: "semantic",
            kind: "preference",
            global: true,
        },
    ),
    (
        DistillKind::Correction,
        Layout {
            folder: "preferences",
            tier: "semantic",
            kind: "preference",
            global: true,
        },
    ),
];

impl DistillKind {
    /// The kind a model's `kind` names (own keys of `KIND_LAYOUT` only), else none.
    pub fn parse(name: &str) -> Option<DistillKind> {
        Some(match name {
            "decision" => DistillKind::Decision,
            "rule" => DistillKind::Rule,
            "gotcha" => DistillKind::Gotcha,
            "procedure" => DistillKind::Procedure,
            "preference" => DistillKind::Preference,
            "correction" => DistillKind::Correction,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            DistillKind::Decision => "decision",
            DistillKind::Rule => "rule",
            DistillKind::Gotcha => "gotcha",
            DistillKind::Procedure => "procedure",
            DistillKind::Preference => "preference",
            DistillKind::Correction => "correction",
        }
    }

    pub fn layout(self) -> Layout {
        KIND_LAYOUT
            .iter()
            .find(|(kind, _)| *kind == self)
            .map(|(_, layout)| *layout)
            .unwrap_or(KIND_LAYOUT[0].1)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    pub kind: DistillKind,
    pub title: String,
    pub body: String,
    pub confidence: f64,
    /// The numbers of the prompts (as the digest numbers them) the page rests on.
    pub evidence: Vec<u32>,
    /// The owner's own words the page rests on, copied verbatim from one of their prompts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    /// The page's point as one English sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gist: Option<String>,
    /// A page memory already holds (a path the model was shown, in the page's own scope) that this one replaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
}

/// A durable page memory already holds, as the model is shown it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct KnownPage {
    pub path: String,
    pub title: String,
    /// The start of its body, flattened, when it was read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    /// The version the model was shown (the server's page id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Pinned by the owner: never superseded.
    #[serde(default)]
    pub pinned: bool,
    /// Kept in `_global` (the owner's preferences), not in the project.
    pub global: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DigestPrompt {
    /// Position among the session's person prompts (1-based): what a proposal's `evidence` cites.
    pub n: u32,
    pub text: String,
    /// When it was typed (ms since the epoch), when the server said and `Date.parse` could read it.
    pub at: Option<i64>,
}

/// An observation as `person_prompts` reads it.
#[derive(Clone, Copy, Debug)]
pub struct PromptObservation<'a> {
    pub kind: &'a str,
    pub body: &'a str,
    pub created_at: Option<&'a str>,
    /// `isAgentPrompt(js_trim(body))`: the stock worker answers it. Ignored for a body that is blank once trimmed.
    pub agent: bool,
}

/// The text `person_prompts` asks `isAgentPrompt` about: the body, trimmed as JavaScript's `trim` trims.
pub fn prompt_text(body: &str) -> &str {
    js_trim(body)
}

/// The prompts a person typed (an agent-written message is not their word), in capture order.
pub fn person_prompts(observations: &[PromptObservation<'_>]) -> Vec<DigestPrompt> {
    let mut prompts: Vec<DigestPrompt> = Vec::new();
    for observation in observations {
        if observation.kind != "user-prompt" {
            continue;
        }
        let text = prompt_text(observation.body);
        if text.is_empty() || observation.agent {
            continue;
        }
        prompts.push(DigestPrompt {
            n: (prompts.len() + 1) as u32,
            text: text.to_owned(),
            at: observation
                .created_at
                .filter(|at| !at.is_empty())
                .and_then(date_parse),
        });
    }
    prompts
}

/// `text.replaceAll(/\s+/g, " ").trim()`.
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for word in text.split(is_js_space).filter(|word| !word.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn clip(text: &str) -> String {
    let flat = one_line(text);
    if utf16_len(&flat) > PROMPT_CHARS {
        format!("{}…", utf16_prefix(&flat, PROMPT_CHARS))
    } else {
        flat
    }
}

/// A prompt as the person typed it (line breaks and spacing kept, so a quote can be copied exactly), cut to length:
/// over 700 UTF-16 units it is cut to its first 700 code points.
fn as_typed(text: &str) -> String {
    let kept = js_trim(text);
    if utf16_len(kept) > PROMPT_CHARS {
        let cut: String = kept.chars().take(PROMPT_CHARS).collect();
        format!("{cut}…")
    } else {
        kept.to_owned()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Digest {
    pub text: String,
    /// The prompt numbers the digest shows (what a proposal may cite).
    pub shown: Vec<u32>,
    /// The prompts it shows, whole: what a proposal's quote must come from.
    pub prompts: Vec<DigestPrompt>,
}

/// A delegated task's title with the fact the stock worker answers for it.
#[derive(Clone, Copy, Debug)]
pub struct TaskTitle<'a> {
    pub title: &'a str,
    /// `unwrapPrompt(title).body`.
    pub body: &'a str,
}

/// What the model reads: the window's prompts, numbered, and the titles of the tasks delegated meanwhile.
pub fn build_digest(prompts: &[DigestPrompt], tasks: &[TaskTitle<'_>]) -> Digest {
    let window = &prompts[prompts.len().saturating_sub(WINDOW_PROMPTS)..];
    let mut lines = vec!["## What the person said (their own words, in order)".to_owned()];
    lines.extend(
        window
            .iter()
            .map(|prompt| format!("[{}] {}", prompt.n, as_typed(&prompt.text))),
    );
    let work: Vec<String> = tasks
        .iter()
        .take(TASK_TITLES)
        .map(|task| {
            let named = if task.body.is_empty() {
                task.title
            } else {
                task.body
            };
            format!("- {}", clip(named))
        })
        .collect();
    if !work.is_empty() {
        lines.push(String::new());
        lines.push("## Work their assistant started meanwhile (task titles)".to_owned());
        lines.extend(work);
    }
    Digest {
        text: lines.join("\n"),
        shown: window.iter().map(|prompt| prompt.n).collect(),
        prompts: window.to_vec(),
    }
}

/// The model's instructions.
pub const SYSTEM: &str = r##"You curate long-term memory from what its owner said while working with an AI coding assistant.
You read a numbered excerpt of the owner's own messages and may write at most 3 pages about the project and 2 preferences or corrections. Most excerpts deserve none: answer {"pages":[]} unless something clearly lasts.

Write a page only for knowledge a future session needs and cannot get from the code:
- decision: a choice the owner made about how this product should work or be built, with the reason when they gave one, and what they rejected.
- rule: a standing convention for this project ("always…", "never…", "stop doing…").
- gotcha: a failure, surprise or trap they ran into, and what it taught.
- procedure: a repeatable way of doing something they asked for.
- preference: how the owner wants any assistant to work in any project (scope, process, style, wording, how to report). It is kept for every project, so leave out anything that only makes sense in this codebase.
- correction: the owner told the assistant to redo or fix what it had just done. Record the lasting lesson (what to do instead, in every project), not the incident.

Never write: progress or status of one task, questions the owner asked, anything the owner did not actually say, guesses about why, restatements of what the code already shows, or secrets. Do not record a question as a decision. If the owner only asked or doubted, there is no decision yet.
Cite the message numbers a page rests on, and quote the owner: "quote" is a short passage copied character for character from one of those messages, in their language, with no translation, paraphrase or ellipsis. A preference or correction without such a quote is not written.
Give a confidence from 0 to 1 for how clearly the excerpt establishes it; write nothing below 0.75 (a correction: below 0.65).
Write each page in the language the owner wrote in. A title is a specific noun phrase of at most 80 characters that tells the page apart from every page memory already holds; a body is 2 to 8 short lines of plain markdown: the fact first, then the reason or the consequence. "gist_en" is the page's point as one plain English sentence.
Memory already holds the pages listed below. Do not repeat one. When a page you write replaces one of them (the same subject, decided again or contradicted), give that page's path as "supersedes"; never name a page that is only related.
The project's rules file is already in front of every session; its outline is listed below. Do not write a page that only restates a rule it already has; a page that decides something new or reverses one of its rules is still worth writing.

Answer with one JSON object and nothing else:
{"pages":[{"kind":"decision|rule|gotcha|procedure|preference|correction","title":"...","body":"...","quote":"...","gist_en":"...","supersedes":null,"confidence":0.0,"evidence":[1,2]}]}"##;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DistillMessage {
    pub system: String,
    pub user: String,
}

/// The one request: the instructions, the digest, the pages memory already holds (so a page is never written twice) and
/// the project's rules-file outline (`rules_file::rules_outline`, so a rule the file states is not learned again).
pub fn distill_message(
    digest: &Digest,
    known: &[KnownPage],
    rules_outline: &str,
) -> DistillMessage {
    let line = |page: &KnownPage| {
        let excerpt = page
            .excerpt
            .as_deref()
            .filter(|excerpt| !excerpt.is_empty())
            .map(|excerpt| format!(" · {excerpt}"))
            .unwrap_or_default();
        format!("- {} · {}{}", page.path, page.title, excerpt)
    };
    let listed = |global: bool, limit: usize| -> Vec<String> {
        let lines: Vec<String> = known
            .iter()
            .filter(|page| page.global == global)
            .take(limit)
            .map(line)
            .collect();
        if lines.is_empty() {
            vec!["(none)".to_owned()]
        } else {
            lines
        }
    };
    let outline = js_trim(rules_outline);
    let mut user = vec![
        digest.text.clone(),
        String::new(),
        "## Pages the project already has (path · title · start)".to_owned(),
    ];
    user.extend(listed(false, KNOWN_PROJECT_PAGES));
    user.push(String::new());
    user.push(
        "## The project's rules file already says (its headings and lead phrases)".to_owned(),
    );
    user.push(if outline.is_empty() {
        "(none)".to_owned()
    } else {
        outline.to_owned()
    });
    user.push(String::new());
    user.push(
        "## The owner's preferences, kept for every project (path · title · start)".to_owned(),
    );
    user.extend(listed(true, KNOWN_GLOBAL_PAGES));
    DistillMessage {
        system: SYSTEM.to_owned(),
        user: user.join("\n"),
    }
}

/// A parsed JSON value as `JSON.parse` reads it: numbers are doubles (an overflow is infinity), objects keep every
/// member and the last of a repeated key wins.
#[derive(Debug)]
enum Json {
    Null,
    Bool,
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(members) => members
                .iter()
                .rev()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    fn text(&self) -> Option<&str> {
        match self {
            Json::Str(text) => Some(text),
            _ => None,
        }
    }
}

struct Reader<'a> {
    text: &'a str,
    at: usize,
}

impl Reader<'_> {
    fn space(&mut self) {
        while matches!(
            self.text.as_bytes().get(self.at),
            Some(b' ' | b'\t' | b'\n' | b'\r')
        ) {
            self.at += 1;
        }
    }

    fn eat(&mut self, literal: &str) -> bool {
        if self.text[self.at..].starts_with(literal) {
            self.at += literal.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        self.space();
        let value = match *self.text.as_bytes().get(self.at)? {
            b'{' => {
                if depth >= JSON_DEPTH {
                    return None;
                }
                self.at += 1;
                let mut members = Vec::new();
                self.space();
                if self.eat("}") {
                    return Some(Json::Obj(members));
                }
                loop {
                    self.space();
                    let name = self.string()?;
                    self.space();
                    if !self.eat(":") {
                        return None;
                    }
                    members.push((name, self.value(depth + 1)?));
                    self.space();
                    if self.eat("}") {
                        break;
                    }
                    if !self.eat(",") {
                        return None;
                    }
                }
                Json::Obj(members)
            }
            b'[' => {
                if depth >= JSON_DEPTH {
                    return None;
                }
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.eat("]") {
                    return Some(Json::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.space();
                    if self.eat("]") {
                        break;
                    }
                    if !self.eat(",") {
                        return None;
                    }
                }
                Json::Arr(items)
            }
            b'"' => Json::Str(self.string()?),
            b't' => self.eat("true").then_some(Json::Bool)?,
            b'f' => self.eat("false").then_some(Json::Bool)?,
            b'n' => self.eat("null").then_some(Json::Null)?,
            _ => Json::Num(self.number()?),
        };
        Some(value)
    }

    fn number(&mut self) -> Option<f64> {
        let bytes = self.text.as_bytes();
        let start = self.at;
        let digits = |at: &mut usize| {
            let from = *at;
            while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
                *at += 1;
            }
            *at - from
        };
        let mut at = start;
        if bytes.get(at) == Some(&b'-') {
            at += 1;
        }
        match bytes.get(at)? {
            b'0' => at += 1,
            b'1'..=b'9' => {
                digits(&mut at);
            }
            _ => return None,
        }
        if bytes.get(at) == Some(&b'.') {
            at += 1;
            if digits(&mut at) == 0 {
                return None;
            }
        }
        if matches!(bytes.get(at), Some(b'e' | b'E')) {
            at += 1;
            if matches!(bytes.get(at), Some(b'+' | b'-')) {
                at += 1;
            }
            if digits(&mut at) == 0 {
                return None;
            }
        }
        self.at = at;
        self.text[start..at].parse().ok()
    }

    /// A string literal; a lone surrogate escape reads as U+FFFD, since Rust cannot hold one.
    fn string(&mut self) -> Option<String> {
        if !self.eat("\"") {
            return None;
        }
        let bytes = self.text.as_bytes();
        let mut out = String::new();
        let mut run = self.at;
        loop {
            let byte = *bytes.get(self.at)?;
            match byte {
                b'"' => {
                    out.push_str(&self.text[run..self.at]);
                    self.at += 1;
                    return Some(out);
                }
                0..=0x1f => return None,
                b'\\' => {
                    out.push_str(&self.text[run..self.at]);
                    self.at += 1;
                    let escape = *bytes.get(self.at)?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            if (0xD800..0xDC00).contains(&unit)
                                && self.text[self.at..].starts_with("\\u")
                            {
                                let save = self.at;
                                self.at += 2;
                                match self.hex4() {
                                    Some(low) if (0xDC00..0xE000).contains(&low) => {
                                        let code =
                                            0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                                    }
                                    _ => {
                                        self.at = save;
                                        out.push('\u{fffd}');
                                    }
                                }
                            } else {
                                out.push(char::from_u32(unit).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return None,
                    }
                    run = self.at;
                }
                _ => self.at += 1,
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.text.get(self.at..self.at + 4)?;
        if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u32::from_str_radix(digits, 16).ok()
    }
}

/// `JSON.parse(text)`; none where it throws.
fn parse_json(text: &str) -> Option<Json> {
    let mut reader = Reader { text, at: 0 };
    let value = reader.value(0)?;
    reader.space();
    (reader.at == text.len()).then_some(value)
}

/// The first balanced `{…}` of a model's answer (it may wrap the JSON in a fence or a sentence), parsed.
fn json_object(text: &str) -> Option<Json> {
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut chars = text[start..].char_indices();
    while let Some((offset, c)) = chars.next() {
        if in_string {
            if c == '\\' {
                chars.next();
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
        } else if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
            if depth == 0 {
                return parse_json(&text[start..start + offset + 1]);
            }
        }
    }
    None
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parsed {
    pub proposals: Vec<Proposal>,
    /// Why proposals were refused, one line each (the log's evidence that the checks run).
    pub refused: Vec<String>,
}

/// `text.normalize("NFC").replaceAll(/\s+/g, " ").trim()`.
fn flat(text: &str) -> String {
    one_line(&ComposingNormalizerBorrowed::new_nfc().normalize(text))
}

fn title_key(title: &str) -> String {
    flat(title).to_lowercase()
}

/// `String(number)`.
fn number_text(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else {
        js_number(value)
    }
}

/// The proposals a model's answer holds that pass the checks: a known kind, a real title and body, cited prompts,
/// confidence, and a quote that is the owner's own words (required for a preference or correction, checked on any
/// page that gives one): an exact substring of a prompt as typed, no whitespace folding or Unicode normalization. A
/// `supersedes` that names no page the model was shown, in the page's own scope, is dropped.
pub fn parse_proposals(answer: &str, prompts: &[DigestPrompt], known: &[KnownPage]) -> Parsed {
    let mut parsed = Parsed::default();
    let root = json_object(answer);
    let Some(Json::Arr(pages)) = root.as_ref().and_then(|root| root.get("pages")) else {
        parsed
            .refused
            .push("answer is not a {pages:[…]} object".to_owned());
        return parsed;
    };
    let mut taken: HashSet<String> = known.iter().map(|page| title_key(&page.title)).collect();
    let mut accepted: Vec<Proposal> = Vec::new();
    // Read past the page limits so a page late in the answer is weighed before a limit cuts.
    for entry in pages
        .iter()
        .take((DISTILL_MAX_PAGES + DISTILL_MAX_GLOBAL_PAGES) * 2)
    {
        let field = |name: &str| entry.get(name);
        let kind = field("kind").and_then(Json::text).unwrap_or("");
        let title = field("title")
            .and_then(Json::text)
            .map(flat)
            .unwrap_or_default();
        let body = field("body")
            .and_then(Json::text)
            .map(js_trim)
            .unwrap_or("");
        let confidence = match field("confidence") {
            Some(Json::Num(value)) => *value,
            _ => 0.0,
        };
        let mut evidence: Vec<u32> = Vec::new();
        if let Some(Json::Arr(values)) = field("evidence") {
            for value in values {
                if let Json::Num(value) = value
                    && value.is_finite()
                    && value.trunc() == *value
                    && let Some(prompt) =
                        prompts.iter().find(|prompt| f64::from(prompt.n) == *value)
                {
                    evidence.push(prompt.n);
                }
            }
        }
        let quote = field("quote")
            .and_then(Json::text)
            .map(js_trim)
            .unwrap_or("");
        let quote_units = utf16_len(quote);
        let quoted = if (QUOTE_MIN..=QUOTE_MAX).contains(&quote_units) {
            prompts.iter().find(|prompt| prompt.text.contains(quote))
        } else {
            None
        };
        let label = if !title.is_empty() {
            title.as_str()
        } else if !kind.is_empty() {
            kind
        } else {
            "page"
        };
        let layout = DistillKind::parse(kind).map(|kind| (kind, kind.layout()));
        let refusal = match layout {
            None => Some(format!("{label}: unknown kind")),
            Some((kind, layout)) => {
                let body_units = utf16_len(body);
                if title.is_empty() || utf16_len(&title) > TITLE_MAX {
                    Some(format!("{label}: title missing or longer than {TITLE_MAX}"))
                } else if !(BODY_MIN..=BODY_MAX).contains(&body_units) {
                    Some(format!("{label}: body {body_units} chars"))
                } else if confidence
                    < if kind == DistillKind::Correction {
                        CORRECTION_MIN_CONFIDENCE
                    } else {
                        MIN_CONFIDENCE
                    }
                {
                    Some(format!(
                        "{label} ({}): confidence {}",
                        kind.name(),
                        number_text(confidence)
                    ))
                } else if evidence.is_empty() && quoted.is_none() {
                    Some(format!("{label}: cites no prompt it was shown"))
                } else if !quote.is_empty() && quoted.is_none() {
                    Some(format!("{label}: quote is not the owner's words"))
                } else if quote.is_empty() && layout.global {
                    Some(format!("{label}: quotes no evidence"))
                } else if taken.contains(&title_key(&title)) {
                    Some(format!("{label}: title already used"))
                } else {
                    None
                }
            }
        };
        if let Some(line) = refusal {
            parsed.refused.push(line);
            continue;
        }
        let Some((kind, layout)) = layout else {
            continue;
        };
        taken.insert(title_key(&title));
        let gist = field("gist_en")
            .and_then(Json::text)
            .map(flat)
            .unwrap_or_default();
        let supersedes = field("supersedes")
            .and_then(Json::text)
            .map(js_trim)
            .unwrap_or("");
        let replaces = known
            .iter()
            .find(|page| page.path == supersedes && page.global == layout.global);
        if let Some(prompt) = quoted
            && !evidence.contains(&prompt.n)
        {
            evidence.push(prompt.n);
            evidence.sort_unstable();
        }
        accepted.push(Proposal {
            kind,
            title,
            body: body.to_owned(),
            confidence,
            evidence,
            quote: quoted.map(|_| quote.to_owned()),
            gist: (!gist.is_empty() && utf16_len(&gist) <= GIST_MAX).then_some(gist),
            supersedes: replaces.map(|page| page.path.clone()),
        });
    }
    let (owner, project): (Vec<Proposal>, Vec<Proposal>) = accepted
        .into_iter()
        .partition(|page| page.kind.layout().global);
    // Stable: corrections first among the owner's pages, the rest in the model's order.
    let (corrections, others): (Vec<Proposal>, Vec<Proposal>) = owner
        .into_iter()
        .partition(|page| page.kind == DistillKind::Correction);
    let owner: Vec<Proposal> = corrections.into_iter().chain(others).collect();
    for dropped in project.iter().skip(DISTILL_MAX_PAGES) {
        parsed.refused.push(format!(
            "{}: over the {DISTILL_MAX_PAGES}-page limit",
            dropped.title
        ));
    }
    for dropped in owner.iter().skip(DISTILL_MAX_GLOBAL_PAGES) {
        parsed.refused.push(format!(
            "{}: over the {DISTILL_MAX_GLOBAL_PAGES}-page limit",
            dropped.title
        ));
    }
    parsed.proposals = project
        .into_iter()
        .take(DISTILL_MAX_PAGES)
        .chain(owner.into_iter().take(DISTILL_MAX_GLOBAL_PAGES))
        .collect();
    parsed
}

/// `decisions/<slug>.md`: letters and digits of any script, the rest folded to `-`, cut to a readable length.
pub fn proposal_path(kind: DistillKind, title: &str) -> String {
    let lower = ComposingNormalizerBorrowed::new_nfkc()
        .normalize(title)
        .to_lowercase();
    let category = CodePointMapData::<GeneralCategory>::new();
    let mut folded = String::with_capacity(lower.len());
    let mut dash = false;
    for c in lower.chars() {
        let group = category.get(c);
        if GeneralCategoryGroup::Letter.contains(group)
            || GeneralCategoryGroup::Number.contains(group)
        {
            folded.push(c);
            dash = false;
        } else if !dash {
            folded.push('-');
            dash = true;
        }
    }
    let slug = utf16_prefix(folded.trim_matches('-'), 48);
    let slug = slug.trim_end_matches('-');
    format!(
        "{}/{}.md",
        kind.layout().folder,
        if slug.is_empty() { "page" } else { slug }
    )
}

/// The page: the title as its H1 (the server derives the title from it), the body, the owner's words, the page it
/// replaces, and where it came from.
pub fn proposal_markdown(proposal: &Proposal, session_id: &str, replaces: Option<&str>) -> String {
    let cited = proposal
        .evidence
        .iter()
        .map(|n| format!("#{n}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut lines: Vec<String> = vec![
        format!("# {}", proposal.title),
        String::new(),
        proposal.body.clone(),
        String::new(),
    ];
    if let Some(quote) = proposal.quote.as_deref().filter(|quote| !quote.is_empty()) {
        lines.extend(quote.split('\n').map(|line| format!("> {line}")));
        lines.push(String::new());
    }
    if let Some(replaces) = replaces.filter(|replaces| !replaces.is_empty()) {
        lines.push(format!("_Replaces [[{replaces}]]._"));
        lines.push(String::new());
    }
    lines.push(format!(
        "_Source: the owner's messages {cited}, session `{session_id}` (memory upkeep)._"
    ));
    lines.push(String::new());
    lines.join("\n")
}

/// `Date.parse(text)` for the ECMAScript date-time format (`YYYY[-MM[-DD]][THH:mm[:ss[.s…]]][Z|±HH:mm]`, a year of six
/// digits with its sign), which is what ai-memory writes. A day up to 31 is taken in any month, as V8 takes it. A
/// date-time with no offset reads as UTC (JavaScript reads it as local time), and any other spelling is none (V8
/// guessed at some).
pub(crate) fn date_parse(text: &str) -> Option<i64> {
    fn digits(bytes: &[u8], count: usize) -> Option<(i64, &[u8])> {
        let (head, rest) = bytes.split_at_checked(count)?;
        let mut value = 0;
        for byte in head {
            if !byte.is_ascii_digit() {
                return None;
            }
            value = value * 10 + i64::from(byte - b'0');
        }
        Some((value, rest))
    }
    /// Days since 1970-01-01 of a civil date (month 1-12, any day count from the month's first).
    fn days(year: i64, month: i64, day: i64) -> i64 {
        let year = if month <= 2 { year - 1 } else { year };
        let era = year.div_euclid(400);
        let year_of_era = year.rem_euclid(400);
        let shifted = (month + 9) % 12;
        let day_of_year = (153 * shifted + 2) / 5;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468 + day - 1
    }
    let bytes = text.as_bytes();
    let (year, rest) = match bytes.first()? {
        sign @ (b'+' | b'-') => {
            let (year, rest) = digits(&bytes[1..], 6)?;
            if *sign == b'-' && year == 0 {
                return None;
            }
            (if *sign == b'-' { -year } else { year }, rest)
        }
        _ => digits(bytes, 4)?,
    };
    let (mut month, mut day) = (1, 1);
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
    let date = days(year, month, day) * 86_400_000;
    let clip = |ms: i64| (ms.abs() <= 8_640_000_000_000_000).then_some(ms);
    let Some(after) = rest.strip_prefix(b"T").or_else(|| rest.strip_prefix(b"t")) else {
        return if rest.is_empty() { clip(date) } else { None };
    };
    let (hour, after) = digits(after, 2)?;
    let (minute, mut rest) = digits(after.strip_prefix(b":")?, 2)?;
    let (mut second, mut milli) = (0, 0);
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
            let (fraction, _) = digits(after, count.min(3))?;
            milli = fraction * 10_i64.pow(3 - count.min(3) as u32);
            rest = &after[count..];
        }
    }
    let whole_day = hour == 24 && minute == 0 && second == 0 && milli == 0;
    if !(hour < 24 || whole_day) || minute > 59 || second > 59 {
        return None;
    }
    let local = date + ((hour * 60 + minute) * 60 + second) * 1000 + milli;
    let offset = match rest {
        b"" | b"Z" | b"z" => 0,
        [sign @ (b'+' | b'-'), offset @ ..] => {
            let (hours, after) = digits(offset, 2)?;
            let (minutes, after) = digits(after.strip_prefix(b":").unwrap_or(after), 2)?;
            if !after.is_empty() || hours > 23 || minutes > 59 {
                return None;
            }
            let ahead = (hours * 60 + minutes) * 60_000;
            if *sign == b'+' { -ahead } else { ahead }
        }
        _ => return None,
    };
    clip(local + offset)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn table() -> Value {
        serde_json::from_str(&crate::json::whole_surrogates(include_str!(
            "distill-captured.json"
        )))
        .expect("the captured table is JSON")
    }

    fn text(value: &Value) -> &str {
        value.as_str().expect("a string")
    }

    fn prompt(n: u32, body: &str) -> DigestPrompt {
        DigestPrompt {
            n,
            text: body.to_owned(),
            at: None,
        }
    }

    fn prompts_of(rows: &Value) -> Vec<DigestPrompt> {
        rows.as_array()
            .unwrap()
            .iter()
            .map(|row| DigestPrompt {
                n: row["n"].as_u64().unwrap() as u32,
                text: text(&row["text"]).to_owned(),
                at: row["at"].as_i64(),
            })
            .collect()
    }

    fn known_of(rows: &Value) -> Vec<KnownPage> {
        rows.as_array()
            .unwrap()
            .iter()
            .map(|row| KnownPage {
                path: text(&row["path"]).to_owned(),
                title: text(&row["title"]).to_owned(),
                excerpt: row["excerpt"].as_str().map(str::to_owned),
                id: row["id"].as_str().map(str::to_owned),
                pinned: row["pinned"].as_bool().unwrap_or(false),
                global: row["global"].as_bool().unwrap(),
            })
            .collect()
    }

    fn known_page(path: &str, title: &str, global: bool) -> KnownPage {
        KnownPage {
            path: path.to_owned(),
            title: title.to_owned(),
            global,
            ..KnownPage::default()
        }
    }

    /// An observation as the vitest file builds it; `agent` is what `isAgentPrompt` says of the trimmed body.
    fn observation<'a>(kind: &'a str, body: &'a str, agent: bool) -> PromptObservation<'a> {
        PromptObservation {
            kind,
            body,
            created_at: Some("2026-10-19T01:00:00Z"),
            agent,
        }
    }

    fn window() -> Vec<DigestPrompt> {
        vec![
            prompt(26, "세션 목록 정리해줘"),
            prompt(27, "동시 세션 수 제한은 없애. 몇 개든 열 수 있어야 해"),
            prompt(
                28,
                "아니 그게 아니라,   설정은 최소로 해줘.\n새 토글 만들지 마",
            ),
        ]
    }

    fn good() -> Value {
        json!({
            "kind": "rule",
            "title": "동시 세션 수 제한을 두지 않는다",
            "body": "동시 세션 개수에 어떤 제한도 두지 않는다.\n소유자가 여러 번 제거하라고 요구했다.",
            "confidence": 0.85,
            "evidence": [27, 28],
        })
    }

    fn preference() -> Value {
        json!({
            "kind": "preference",
            "title": "새 설정 항목을 만들지 않는다",
            "body": "기능을 더할 때 설정 토글을 새로 만들지 않는다.\n소유자는 설정을 최소로 두길 원한다.",
            "quote": "설정은 최소로 해줘.\n새 토글 만들지 마",
            "gist_en": "Do not add new settings; keep settings minimal.",
            "confidence": 0.8,
            "evidence": [28],
        })
    }

    /// `{ ...base, ...patch }`.
    fn with(base: &Value, patch: Value) -> Value {
        let mut merged = base.clone();
        for (key, value) in patch.as_object().unwrap() {
            merged[key] = value.clone();
        }
        merged
    }

    fn answer(pages: &[Value]) -> String {
        json!({ "pages": pages }).to_string()
    }

    fn parse(pages: &[Value], known: &[KnownPage]) -> Parsed {
        parse_proposals(&answer(pages), &window(), known)
    }

    fn titles(parsed: &Parsed) -> Vec<&str> {
        parsed
            .proposals
            .iter()
            .map(|page| page.title.as_str())
            .collect()
    }

    #[test]
    fn person_prompts_keep_what_a_person_typed_numbered_in_order() {
        let prompts = person_prompts(&[
            observation("session-start", "claude", false),
            observation("user-prompt", "병렬 세션은 부모 아래에 둬", false),
            observation(
                "user-prompt",
                "<ompdesk-agent-message from=\"부모\">\nTitle: 일\n\nbody\n</ompdesk-agent-message>",
                true,
            ),
            observation(
                "user-prompt",
                "Complete assignment thoroughly:\n\nTitle: x",
                true,
            ),
            observation("post-tool-use", "tool_family: file", false),
            observation("user-prompt", "  ", false),
            observation("user-prompt", "자동승인해", false),
        ]);
        let got: Vec<(u32, &str)> = prompts.iter().map(|p| (p.n, p.text.as_str())).collect();
        assert_eq!(got, [(1, "병렬 세션은 부모 아래에 둬"), (2, "자동승인해")]);
        assert_eq!(prompts[0].at, Some(1_792_371_600_000));
    }

    #[test]
    fn digest_numbers_the_prompts_keeps_the_newest_window_and_clips_a_long_one() {
        let prompts: Vec<DigestPrompt> = (1..=50)
            .map(|n| prompt(n, &format!("메시지 {n}")))
            .collect();
        let digest = build_digest(
            &prompts,
            &[
                TaskTitle {
                    title: "작업 하나",
                    body: "작업 하나",
                },
                TaskTitle {
                    title: "<ompdesk-agent-message …>",
                    body: "Title: 래핑됨\n\nx",
                },
            ],
        );
        assert_eq!(digest.shown[0], 11);
        assert_eq!(digest.shown.last(), Some(&50));
        assert!(digest.text.contains("[50] 메시지 50"));
        assert!(!digest.text.contains("[10] "));
        assert!(digest.text.contains("- 작업 하나"));
        let long = build_digest(&[prompt(1, &"가".repeat(2000))], &[]);
        assert!(long.text.encode_utf16().count() < 900);
        assert!(long.text.contains('…'));
    }

    #[test]
    fn the_message_lists_the_pages_memory_holds_the_projects_and_the_owners_apart_capped() {
        let digest = build_digest(&[prompt(1, "x")], &[]);
        assert_eq!(
            distill_message(&digest, &[], "")
                .user
                .matches("(none)")
                .count(),
            3
        );
        let mut known: Vec<KnownPage> = (0..80)
            .map(|index| {
                known_page(
                    &format!("decisions/d{index}.md"),
                    &format!("제목 {index}"),
                    false,
                )
            })
            .collect();
        known.push(known_page(
            "preferences/minimal-settings.md",
            "설정을 최소로",
            true,
        ));
        let many = distill_message(&digest, &known, "").user;
        assert!(many.contains("- decisions/d29.md · 제목 29"));
        assert!(!many.contains("제목 30"));
        let (project, global) = many
            .split_once("## The owner's preferences, kept for every project")
            .unwrap();
        assert!(!project.contains("설정을 최소로"));
        assert!(global.contains("- preferences/minimal-settings.md · 설정을 최소로"));
        assert!(
            distill_message(&digest, &[], "")
                .system
                .contains("{\"pages\":[]}")
        );
    }

    #[test]
    fn the_message_shows_the_start_of_each_page_and_asks_the_model_to_name_what_it_replaces() {
        let digest = build_digest(&[prompt(1, "x")], &[]);
        let known = [KnownPage {
            excerpt: Some("판단 모델은 자동으로 최신을 쓴다".to_owned()),
            ..known_page("decisions/jev.md", "Jev는 최신", false)
        }];
        let message = distill_message(&digest, &known, "");
        assert!(
            message
                .user
                .contains("- decisions/jev.md · Jev는 최신 · 판단 모델은 자동으로 최신을 쓴다")
        );
        assert!(message.system.contains("\"supersedes\""));
    }

    #[test]
    fn the_message_shows_the_rules_file_outline_and_says_none_without_one() {
        let digest = build_digest(&[prompt(1, "x")], &[]);
        let outline = "## Composer\n- Enter on a touch input adds a line";
        let message = distill_message(&digest, &[], outline);
        assert!(message.user.contains(&format!(
            "## The project's rules file already says (its headings and lead phrases)\n{outline}"
        )));
        assert!(message.system.contains("rules file"));
        assert!(distill_message(&digest, &[], "").user.contains(
            "## The project's rules file already says (its headings and lead phrases)\n(none)"
        ));
    }

    #[test]
    fn accepts_a_page_that_passes_every_check_from_a_fenced_or_chatty_answer_too() {
        let fenced = format!("Here you go:\n```json\n{}\n```", answer(&[good()]));
        let parsed = parse_proposals(&fenced, &window(), &[]);
        assert!(parsed.refused.is_empty());
        assert_eq!(parsed.proposals.len(), 1);
        let page = &parsed.proposals[0];
        assert_eq!(
            (page.kind, page.title.as_str(), page.confidence),
            (DistillKind::Rule, "동시 세션 수 제한을 두지 않는다", 0.85)
        );
        assert_eq!(page.evidence, [27, 28]);
        assert_eq!(
            (&page.quote, &page.gist, &page.supersedes),
            (&None, &None, &None)
        );
    }

    #[test]
    fn drops_evidence_the_digest_did_not_show_and_refuses_a_page_left_with_none() {
        let parsed = parse(&[with(&good(), json!({"evidence": [27, 99]}))], &[]);
        assert_eq!(parsed.proposals[0].evidence, [27]);
        let refused = parse(&[with(&good(), json!({"evidence": [99]}))], &[]);
        assert!(refused.proposals.is_empty());
        assert_eq!(
            refused.refused,
            ["동시 세션 수 제한을 두지 않는다: cites no prompt it was shown"]
        );
    }

    #[test]
    fn refuses_an_unknown_kind_a_thin_body_a_low_confidence_an_overlong_title_and_a_title_memory_has()
     {
        let parsed = parse(
            &[
                with(&good(), json!({"kind": "note"})),
                with(&good(), json!({"body": "짧다"})),
                with(&good(), json!({"confidence": 0.5})),
                with(&good(), json!({"title": "가".repeat(81)})),
                with(
                    &good(),
                    json!({"title": "  동시 세션   수 제한을 두지 않는다 "}),
                ),
            ],
            &[known_page(
                "_rules/x.md",
                "동시 세션 수 제한을 두지 않는다",
                false,
            )],
        );
        assert!(parsed.proposals.is_empty());
        assert_eq!(parsed.refused.len(), 5);
    }

    #[test]
    fn refuses_a_kind_that_only_an_objects_prototype_has_never_filing_a_page_under_undefined() {
        let kinds = ["constructor", "toString", "__proto__", "hasOwnProperty"];
        let pages: Vec<Value> = kinds
            .iter()
            .map(|kind| {
                with(
                    &good(),
                    json!({"kind": kind, "title": format!("제목 {kind}")}),
                )
            })
            .collect();
        let parsed = parse(&pages, &[]);
        assert!(parsed.proposals.is_empty());
        let expected: Vec<String> = kinds
            .iter()
            .map(|kind| format!("제목 {kind}: unknown kind"))
            .collect();
        assert_eq!(parsed.refused, expected);
    }

    #[test]
    fn takes_at_most_the_allowed_pages_never_the_same_title_twice() {
        let pages: Vec<Value> = (0..6)
            .map(|index| with(&good(), json!({"title": format!("제목 {index}")})))
            .collect();
        let parsed = parse(&pages, &[]);
        assert_eq!(titles(&parsed), ["제목 0", "제목 1", "제목 2"]);
        assert_eq!(
            parsed.refused,
            ["제목 3", "제목 4", "제목 5"].map(|title| format!("{title}: over the 3-page limit"))
        );
        let twice = parse(&[good(), good()], &[]);
        assert_eq!(twice.proposals.len(), 1);
        assert_eq!(
            twice.refused,
            ["동시 세션 수 제한을 두지 않는다: title already used"]
        );
    }

    #[test]
    fn an_answer_that_is_no_pages_object_is_refused_whole_an_empty_list_is_a_valid_answer() {
        let refusal = vec!["answer is not a {pages:[…]} object".to_owned()];
        assert_eq!(
            parse_proposals("I could not find anything.", &window(), &[]).refused,
            refusal
        );
        assert_eq!(
            parse_proposals("{\"pages\":\"none\"}", &window(), &[]).refused,
            refusal
        );
        assert_eq!(
            parse_proposals("{\"pages\":[]}", &window(), &[]),
            Parsed::default()
        );
    }

    #[test]
    fn keeps_a_supersedes_that_names_a_page_shown_in_the_pages_own_scope_and_drops_any_other() {
        let known = [
            known_page("_rules/old.md", "옛 규칙", false),
            known_page("preferences/old.md", "옛 취향", true),
        ];
        let named = |supersedes: &str, kind: &str| {
            let page = with(
                &good(),
                json!({"kind": kind, "quote": "몇 개든 열 수 있어야 해", "supersedes": supersedes}),
            );
            parse(&[page], &known).proposals[0].supersedes.clone()
        };
        assert_eq!(
            named("_rules/old.md", "rule").as_deref(),
            Some("_rules/old.md")
        );
        assert_eq!(
            named("preferences/old.md", "preference").as_deref(),
            Some("preferences/old.md")
        );
        assert_eq!(named("preferences/old.md", "rule"), None);
        assert_eq!(named("_rules/invented.md", "rule"), None);
    }

    #[test]
    fn accepts_a_preference_whose_quote_is_an_exact_substring_of_what_the_owner_typed() {
        let parsed = parse(&[preference()], &[]);
        assert!(parsed.refused.is_empty());
        let page = &parsed.proposals[0];
        assert_eq!(page.kind, DistillKind::Preference);
        assert_eq!(
            page.quote.as_deref(),
            Some("설정은 최소로 해줘.\n새 토글 만들지 마")
        );
        assert_eq!(
            page.gist.as_deref(),
            Some("Do not add new settings; keep settings minimal.")
        );
        assert_eq!(page.evidence, [28]);
    }

    #[test]
    fn the_page_carries_a_multi_line_quote_as_one_blockquote_every_line_marked() {
        let parsed = parse(&[preference()], &[]);
        assert!(
            proposal_markdown(&parsed.proposals[0], "s", None)
                .contains("\n> 설정은 최소로 해줘.\n> 새 토글 만들지 마\n")
        );
    }

    #[test]
    fn the_model_reads_the_owners_prompts_with_their_own_line_breaks_and_spacing() {
        let digest = build_digest(&window(), &[]);
        assert!(
            digest
                .text
                .contains("[28] 아니 그게 아니라,   설정은 최소로 해줘.\n새 토글 만들지 마")
        );
    }

    #[test]
    fn refuses_a_quote_that_is_not_a_substring_of_what_the_owner_typed_and_a_preference_without_one()
     {
        let parsed = parse(
            &[
                with(&preference(), json!({"quote": "설정은 최소로 해 주세요"})),
                with(
                    &preference(),
                    json!({"title": "공백이 바뀜", "quote": "설정은 최소로 해줘. 새 토글 만들지 마"}),
                ),
                with(
                    &preference(),
                    json!({"title": "정규화된 인용", "quote": "그게 아니라, 설정은 최소로"}),
                ),
                with(
                    &preference(),
                    json!({"kind": "correction", "title": "교정", "quote": "토글"}),
                ),
                with(&good(), json!({"quote": "제한은 모두 없앨 것"})),
                {
                    let mut page = with(&preference(), json!({"title": "인용 없음"}));
                    page.as_object_mut().unwrap().remove("quote");
                    page
                },
            ],
            &[],
        );
        assert!(parsed.proposals.is_empty());
        assert_eq!(
            parsed.refused,
            [
                "새 설정 항목을 만들지 않는다: quote is not the owner's words",
                "공백이 바뀜: quote is not the owner's words",
                "정규화된 인용: quote is not the owner's words",
                "교정: quote is not the owner's words",
                "동시 세션 수 제한을 두지 않는다: quote is not the owner's words",
                "인용 없음: quotes no evidence",
            ]
        );
    }

    #[test]
    fn a_quote_is_evidence_it_cites_its_prompt_when_the_model_forgot_to() {
        let parsed = parse(&[with(&preference(), json!({"evidence": []}))], &[]);
        assert_eq!(parsed.proposals[0].evidence, [28]);
    }

    #[test]
    fn a_correction_is_accepted_from_065_a_preference_or_project_page_needs_075_and_the_refusal_names_the_kind()
     {
        let correction = with(
            &preference(),
            json!({"kind": "correction", "title": "고치라고 하면 접근부터 바꾼다", "quote": "아니 그게 아니라"}),
        );
        let at = |page: &Value, confidence: f64| {
            parse(&[with(page, json!({"confidence": confidence}))], &[])
        };
        assert_eq!(at(&correction, 0.65).proposals.len(), 1);
        assert_eq!(at(&correction, 0.7).proposals.len(), 1);
        assert_eq!(
            at(&correction, 0.64).refused,
            ["고치라고 하면 접근부터 바꾼다 (correction): confidence 0.64"]
        );
        assert_eq!(
            at(&preference(), 0.7).refused,
            ["새 설정 항목을 만들지 않는다 (preference): confidence 0.7"]
        );
        assert_eq!(
            at(&good(), 0.7).refused,
            ["동시 세션 수 제한을 두지 않는다 (rule): confidence 0.7"]
        );
    }

    #[test]
    fn the_owners_pages_have_their_own_cap_of_2_beside_the_3_project_pages_corrections_first() {
        let mut pages: Vec<Value> = (1..=4)
            .map(|n| with(&good(), json!({"title": format!("규칙 {n}")})))
            .collect();
        pages.extend((1..=2).map(|n| with(&preference(), json!({"title": format!("취향 {n}")}))));
        pages.push(with(
            &preference(),
            json!({"kind": "correction", "title": "교정 하나", "quote": "아니 그게 아니라"}),
        ));
        let parsed = parse(&pages, &[]);
        assert_eq!(
            titles(&parsed),
            ["규칙 1", "규칙 2", "규칙 3", "교정 하나", "취향 1"]
        );
        assert_eq!(
            parsed.refused,
            [
                "규칙 4: over the 3-page limit",
                "취향 2: over the 2-page limit"
            ]
        );
    }

    #[test]
    fn a_preference_late_in_a_long_answer_is_weighed_not_cut_by_the_project_pages_before_it() {
        let mut pages: Vec<Value> = (1..=6)
            .map(|n| with(&good(), json!({"title": format!("규칙 {n}")})))
            .collect();
        pages.push(preference());
        let parsed = parse(&pages, &[]);
        assert!(titles(&parsed).contains(&"새 설정 항목을 만들지 않는다"));
    }

    #[test]
    fn files_each_kind_where_ai_memorys_layout_keeps_it_under_a_readable_slug_of_any_script() {
        assert_eq!(
            proposal_path(DistillKind::Decision, "Use SQLite for the cache!"),
            "decisions/use-sqlite-for-the-cache.md"
        );
        assert_eq!(
            proposal_path(DistillKind::Rule, "동시 세션 수 제한을 두지 않는다"),
            "_rules/동시-세션-수-제한을-두지-않는다.md"
        );
        assert_eq!(proposal_path(DistillKind::Gotcha, "???"), "gotchas/page.md");
        assert!(proposal_path(DistillKind::Procedure, &"a".repeat(100)).len() < 70);
        assert_eq!(
            proposal_path(DistillKind::Preference, "설정은 최소로"),
            "preferences/설정은-최소로.md"
        );
        assert_eq!(
            proposal_path(DistillKind::Correction, "Fix the approach"),
            "preferences/fix-the-approach.md"
        );
    }

    fn proposal(kind: DistillKind, evidence: &[u32], quote: Option<&str>) -> Proposal {
        Proposal {
            kind,
            title: "T".to_owned(),
            body: "본문".to_owned(),
            confidence: 0.9,
            evidence: evidence.to_vec(),
            quote: quote.map(str::to_owned),
            gist: None,
            supersedes: None,
        }
    }

    #[test]
    fn titles_the_page_by_its_h1_and_says_where_it_came_from() {
        let markdown =
            proposal_markdown(&proposal(DistillKind::Rule, &[3, 5], None), "sid-1", None);
        assert!(markdown.starts_with("# T\n\n본문\n"));
        assert!(markdown.contains("#3, #5"));
        assert!(markdown.contains("`sid-1`"));
    }

    #[test]
    fn carries_the_owners_quote_as_the_pages_evidence() {
        let markdown = proposal_markdown(
            &proposal(DistillKind::Preference, &[3], Some("토글 만들지 마")),
            "sid-1",
            None,
        );
        assert!(markdown.contains("\n> 토글 만들지 마\n"));
    }

    #[test]
    fn kinds_constants_and_the_prompt_are_what_the_typescript_holds() {
        let table = table();
        assert_eq!(SYSTEM, text(&table["system"]));
        let constants = &table["constants"];
        let number = |name: &str| constants[name].as_u64().unwrap() as usize;
        assert_eq!(DISTILL_MIN_PROMPTS, number("DISTILL_MIN_PROMPTS"));
        assert_eq!(KNOWN_PROJECT_PAGES, number("KNOWN_PROJECT_PAGES"));
        assert_eq!(KNOWN_GLOBAL_PAGES, number("KNOWN_GLOBAL_PAGES"));
        assert_eq!(KNOWN_EXCERPT_CHARS, number("KNOWN_EXCERPT_CHARS"));
        assert_eq!(DISTILL_MAX_PAGES, number("DISTILL_MAX_PAGES"));
        assert_eq!(DISTILL_MAX_GLOBAL_PAGES, number("DISTILL_MAX_GLOBAL_PAGES"));
        assert_eq!(
            GLOBAL_PROJECT.workspace,
            text(&constants["GLOBAL_PROJECT"]["workspace"])
        );
        assert_eq!(
            GLOBAL_PROJECT.project,
            text(&constants["GLOBAL_PROJECT"]["project"])
        );
        let layout = constants["KIND_LAYOUT"].as_object().unwrap();
        assert_eq!(layout.len(), KIND_LAYOUT.len());
        for ((name, expected), (kind, got)) in layout.iter().zip(KIND_LAYOUT) {
            assert_eq!(name, kind.name());
            assert_eq!(DistillKind::parse(name), Some(kind));
            assert_eq!(text(&expected["folder"]), got.folder);
            assert_eq!(text(&expected["tier"]), got.tier);
            assert_eq!(text(&expected["kind"]), got.kind);
            assert_eq!(expected["global"].as_bool().unwrap(), got.global);
        }
        assert_eq!(DistillKind::parse("constructor"), None);
    }

    #[test]
    fn every_captured_set_of_observations_gives_the_prompts_the_typescript_gave() {
        let table = table();
        for row in table["person"].as_array().unwrap() {
            let observations: Vec<PromptObservation> = row["observations"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| PromptObservation {
                    kind: text(&item["kind"]),
                    body: text(&item["body"]),
                    created_at: item["createdAt"].as_str(),
                    agent: item["agent"].as_bool().unwrap(),
                })
                .collect();
            assert_eq!(
                person_prompts(&observations),
                prompts_of(&row["prompts"]),
                "{row}"
            );
        }
    }

    #[test]
    fn every_captured_digest_is_what_the_typescript_built() {
        let table = table();
        for row in table["digests"].as_array().unwrap() {
            let prompts = prompts_of(&row["prompts"]);
            let tasks: Vec<TaskTitle> = row["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|task| TaskTitle {
                    title: text(&task["title"]),
                    body: text(&task["body"]),
                })
                .collect();
            let digest = build_digest(&prompts, &tasks);
            let expected = &row["digest"];
            assert_eq!(digest.text, text(&expected["text"]), "{row}");
            let shown: Vec<u64> = expected["shown"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap())
                .collect();
            assert_eq!(
                digest
                    .shown
                    .iter()
                    .map(|n| u64::from(*n))
                    .collect::<Vec<_>>(),
                shown
            );
            assert_eq!(digest.prompts, prompts_of(&expected["prompts"]));
        }
    }

    #[test]
    fn every_captured_message_is_what_the_typescript_asked() {
        let table = table();
        for row in table["messages"].as_array().unwrap() {
            let digest = Digest {
                text: text(&row["digest"]).to_owned(),
                shown: vec![],
                prompts: vec![],
            };
            let outline = if row["outlineGiven"].as_bool().unwrap() {
                text(&row["outline"])
            } else {
                ""
            };
            let message = distill_message(&digest, &known_of(&row["known"]), outline);
            assert_eq!(message.user, text(&row["user"]), "{row}");
            assert_eq!(message.system, text(&table["system"]));
        }
    }

    #[test]
    fn every_captured_answer_is_judged_as_the_typescript_judged_it() {
        let table = table();
        let (mut accepted, mut refused) = (0, 0);
        for row in table["parses"].as_array().unwrap() {
            let parsed = parse_proposals(
                text(&row["answer"]),
                &prompts_of(&row["prompts"]),
                &known_of(&row["known"]),
            );
            let expected = row["proposals"].as_array().unwrap();
            assert_eq!(parsed.proposals.len(), expected.len(), "{row}");
            for (got, want) in parsed.proposals.iter().zip(expected) {
                let mut actual = serde_json::to_value(got).unwrap();
                let mut want = want.clone();
                let confidence = want["confidence"].as_f64();
                match confidence {
                    Some(value) => assert_eq!(got.confidence, value, "{row}"),
                    None => assert!(got.confidence.is_infinite(), "{row}"),
                }
                assert_eq!(
                    number_text(got.confidence),
                    text(&want["confidenceText"]),
                    "{row}"
                );
                for value in [&mut actual, &mut want] {
                    let object = value.as_object_mut().unwrap();
                    object.remove("confidence");
                    object.remove("confidenceText");
                }
                assert_eq!(actual, want, "{row}");
            }
            let lines: Vec<&str> = row["refused"]
                .as_array()
                .unwrap()
                .iter()
                .map(text)
                .collect();
            assert_eq!(parsed.refused, lines, "{row}");
            accepted += expected.len();
            refused += lines.len();
        }
        assert!(
            accepted > 50 && refused > 100,
            "the table holds both ({accepted} accepted, {refused} refused)"
        );
    }

    #[test]
    fn every_captured_path_and_page_is_what_the_typescript_wrote() {
        let table = table();
        for row in table["paths"].as_array().unwrap() {
            let kind = DistillKind::parse(text(&row["kind"])).unwrap();
            assert_eq!(
                proposal_path(kind, text(&row["title"])),
                text(&row["path"]),
                "{row}"
            );
        }
        for row in table["markdowns"].as_array().unwrap() {
            let given: Proposal = serde_json::from_value(row["proposal"].clone()).unwrap();
            let markdown =
                proposal_markdown(&given, text(&row["sessionId"]), row["replaces"].as_str());
            assert_eq!(markdown, text(&row["markdown"]), "{row}");
        }
    }

    #[test]
    fn json_nested_past_256_levels_is_no_answer_where_javascript_parsed_it() {
        let deep =
            |levels: usize| format!("{{\"pages\":{}{}}}", "[".repeat(levels), "]".repeat(levels));
        assert_eq!(
            parse_proposals(&deep(200), &window(), &[]).refused,
            ["page: unknown kind"]
        );
        assert_eq!(
            parse_proposals(&deep(300), &window(), &[]).refused,
            ["answer is not a {pages:[…]} object"]
        );
    }

    #[test]
    fn reads_an_iso_moment_as_date_parse_does() {
        for (iso, ms) in [
            ("1970-01-01T00:00:00Z", 0),
            ("1969-12-31T23:59:59.999Z", -1),
            ("2026-10-19T10:00:00+09:00", 1_792_371_600_000),
            ("2026-10-19", 1_792_368_000_000),
            ("2026-10-19T24:00:00Z", 1_792_454_400_000),
        ] {
            assert_eq!(date_parse(iso), Some(ms), "{iso}");
        }
        assert_eq!(date_parse("nope"), None);
        assert_eq!(date_parse("2026-13-01T00:00:00Z"), None);
    }
}
