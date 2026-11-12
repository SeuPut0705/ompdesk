//! The judge behind memory curation, pure parts (7d; was the text and parsing of `src/main/ai-memory/memory-judge.ts`):
//! what a page looks like to a judge, the Jev request and its verdict, the batched message to the cheap model and the
//! strict reading of its answer; then the runs: Jev through stock's judge chain (`jev`), the cheap model (`smol_judge`),
//! the chain of both that production asks (`production`) and a test's own judge asked of main (`Judge::Main`).
//!
//! Text is cut and counted in UTF-16 units as the TypeScript did. A page cut in the middle of a surrogate pair leaves
//! a lone high surrogate in JavaScript, which a Rust string cannot hold: it reads U+FFFD here, which is what the
//! cheap model's stdin carries too (node's UTF-8 encoding of a lone surrogate); only Jev's request, which
//! `JSON.stringify` wrote as an escape, differs (`page_text`).
//!
//! `parse_smol_verdicts` reads the answer with serde_json where the TypeScript used `JSON.parse`; the three inputs
//! that differ are named at that function.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Command;

use super::{is_cancelled, js_round, truthy};
use crate::aimemory::value::one_line;
use crate::fs::disk::make_temp_dir;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::{is_js_space, js_trim};
use crate::json::whole_surrogates;
use crate::run::{KILL_GRACE, Runner, terminate};
use crate::server::Fault;
use crate::upkeep::asks::Asker;
use crate::upkeep::model::{Message, ModelResult, OmpLaunch, run_smol};

/// A page is read up to this long (UTF-16 units): enough to tell a changed fact from a neighbour's.
pub const PAGE_CHARS: usize = 600;

/// The probability Jev's top relation needs before it is a verdict.
pub const JEV_MIN_CONFIDENCE: f64 = 0.6;

pub const JEV_PURPOSE: &str = "ompdesk-memory-curate";

/// What the cheap model is told (verbatim from the TypeScript).
pub const SMOL_SYSTEM: &str = r#"You compare notes from one person's memory about their software project. Each pair has an older note A and a newer note B. For every pair, say how they relate:
- "duplicate": they state the same decision or rule in other words; dropping one loses nothing.
- "a_outdated": both answer the same question and B's answer replaces A's, so following A would now be a mistake.
- "b_outdated": the same, but the OLDER note A is the current one.
- "unrelated": different facts, layers or rules that can all be true at once, even when they share many words (a rule for pushing and a rule for merging; a version pin and a rule about working without it; a project override of a general default).
When you are not sure, say "unrelated". A page that is only on the same topic is unrelated. Answer with JSON only, one object, no prose:
{"pairs":[{"id":"p1","relation":"duplicate"}]}
Give exactly one entry per pair, with the id it was shown under."#;

/// Jev's question, `QUESTION.instructions` (verbatim from the TypeScript).
const QUESTION_INSTRUCTIONS: &str = r#"Two notes from the same person's memory about their software project: noteA is older, noteB is newer. Do they say the same thing, or does one of them make the other wrong to follow now? Choose duplicate only when they state the same decision or rule in other words. Choose A_outdated only when both answer the same question and noteB's answer replaces noteA's, so following noteA would now be a mistake. Choose B_outdated only when they conflict the same way but noteA is the current one. Notes about the same topic that state different facts, different layers or different rules, and that can all be true together, are unrelated, even when they share many words."#;

/// Where a page lives: one project's page, or the owner's `_global` page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Project,
    Global,
}

/// A durable page as a judge reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageDigest {
    pub path: String,
    pub title: String,
    pub kind: String,
    /// `YYYY-MM-DD` of its last change.
    pub saved: String,
    pub scope: Scope,
    /// The body without its H1 and its `_Source:` line, cut to `PAGE_CHARS`.
    pub text: String,
}

/// Two pages that may say the same thing; `a` is the older one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PagePair {
    pub a: PageDigest,
    pub b: PageDigest,
}

/// - `duplicate`: the same decision or rule in other words; dropping one loses nothing.
/// - `a_outdated`: they answer one question and the newer page `b` makes `a` wrong to follow.
/// - `b_outdated`: the same, but the OLDER page `a` is the current one.
/// - `unrelated`: different facts, layers or rules that can all be true at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    Duplicate,
    AOutdated,
    BOutdated,
    Unrelated,
}

/// `RELATIONS`, in the TypeScript's order.
pub const RELATIONS: [Relation; 4] = [
    Relation::Duplicate,
    Relation::AOutdated,
    Relation::BOutdated,
    Relation::Unrelated,
];

impl Relation {
    pub fn as_str(self) -> &'static str {
        match self {
            Relation::Duplicate => "duplicate",
            Relation::AOutdated => "a_outdated",
            Relation::BOutdated => "b_outdated",
            Relation::Unrelated => "unrelated",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairVerdict {
    pub relation: Relation,
    /// The judge's probability for that relation (Jev); 1 for a model's plain answer.
    pub confidence: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JudgedBy {
    Jev,
    Smol,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairJudgment {
    pub by: JudgedBy,
    /// One entry per asked pair, in order; `None` when the judge gave none the code accepts.
    pub verdicts: Vec<Option<PairVerdict>>,
    pub model: String,
    pub cost_usd: f64,
    pub ms: f64,
}

/// `\n` and the other characters `.` does not match in JavaScript.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `markdown.replace(/^# .*\n+/, "")`: `.` stops at any line terminator, so a title line ended by `\r\n` (or holding
/// U+2028) is not removed.
fn without_title(markdown: &str) -> &str {
    let Some(rest) = markdown.strip_prefix("# ") else {
        return markdown;
    };
    match rest.find(is_line_terminator) {
        Some(at) if rest[at..].starts_with('\n') => rest[at..].trim_start_matches('\n'),
        _ => markdown,
    }
}

/// `text.replace(/\n*_Source:[^\n]*\s*$/, "")`: the leftmost `_Source:` after which only whitespace follows the
/// first newline; the newlines before it go too.
fn without_source(text: &str) -> &str {
    for (at, _) in text.match_indices("_Source:") {
        let tail = &text[at + "_Source:".len()..];
        let closes = match tail.find('\n') {
            None => true,
            Some(line_end) => tail[line_end..].chars().all(is_js_space),
        };
        if closes {
            return text[..at].trim_end_matches('\n');
        }
    }
    text
}

/// The page body whole: no H1 (the title is shown), no `_Source:` line, whitespace folded.
pub fn body_text(markdown: &str) -> String {
    one_line(without_source(without_title(markdown)))
}

/// The page body as a judge reads it: the whole body cut at `PAGE_CHARS` UTF-16 units (a pair cut in two reads U+FFFD).
pub fn page_text(markdown: &str) -> String {
    cut_units(&body_text(markdown), PAGE_CHARS)
}

/// `text.slice(0, units)` with a cut surrogate pair as U+FFFD.
pub fn cut_units(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let width = c.len_utf16();
        if used + width > units {
            if used < units {
                out.push('\u{FFFD}');
            }
            break;
        }
        used += width;
        out.push(c);
    }
    out
}

/// One judgment per pair: the same request twice is one cached answer. The object as the TypeScript built it, keys in
/// the same order.
pub fn jev_request(pair: &PagePair) -> Value {
    let note = |page: &PageDigest| {
        json!({
            "title": page.title,
            "kind": page.kind,
            "saved": page.saved,
            "scope": page.scope,
            "text": page.text,
        })
    };
    json!({
        "state": { "noteA": note(&pair.a), "noteB": note(&pair.b) },
        "questions": {
            "relation": {
                "type": "choice",
                "instructions": QUESTION_INSTRUCTIONS,
                "criteria": {
                    "unrelated": "Different facts or rules; both can be true; or you are not sure",
                    "duplicate": "The same decision or rule, said differently",
                    "A_outdated": "They conflict on one point and noteB is the current one",
                    "B_outdated": "They conflict on one point and noteA is the current one",
                },
            },
        },
    })
}

/// `value[key]` when `value` is an object holding it.
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

/// The verdict in a judgment's `answers`, or `None` (not a choice answer, an unknown option, under the bar).
pub fn jev_verdict(answers: &Value) -> Option<PairVerdict> {
    let answer = field(answers, "relation")?;
    let choice = field(answer, "choice")?.as_str()?;
    let relation = match choice {
        "unrelated" => Relation::Unrelated,
        "duplicate" => Relation::Duplicate,
        "A_outdated" => Relation::AOutdated,
        "B_outdated" => Relation::BOutdated,
        _ => return None,
    };
    let probability = field(field(answer, "probabilities")?, choice)?
        .as_f64()
        .filter(|probability| probability.is_finite())?;
    (probability >= JEV_MIN_CONFIDENCE).then_some(PairVerdict {
        relation,
        confidence: probability,
    })
}

/// A message for the cheap model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SmolMessage {
    pub system: &'static str,
    pub user: String,
}

/// The batched message for every pair, shown as `p1`, `p2`, …; the rules-file outline (when any) is what is current.
pub fn smol_message(pairs: &[PagePair], rules: &str) -> SmolMessage {
    let note = |label: &str, page: &PageDigest| {
        let whose = match page.scope {
            Scope::Global => "owner's general note",
            Scope::Project => "this project",
        };
        format!(
            "  {label} ({}, {whose}): {} \u{2014} {}",
            page.saved, page.title, page.text
        )
    };
    let blocks: Vec<String> = pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| {
            format!(
                "p{}\n{}\n{}",
                index + 1,
                note("A", &pair.a),
                note("B", &pair.b)
            )
        })
        .collect();
    let known = if rules.is_empty() {
        String::new()
    } else {
        format!("What the project's rules file already says is current (outline):\n{rules}\n\n")
    };
    SmolMessage {
        system: SMOL_SYSTEM,
        user: format!("{known}Pairs:\n\n{}\n", blocks.join("\n\n")),
    }
}

/// The text inside a code fence: `/^```(?:json)?\s*\n([\s\S]*?)\n```$/` on an already trimmed answer. After the opening
/// fence (and `json`, in lower case only) the whitespace run must hold a newline (the last one that leaves room for
/// the closing fence), and the answer must end with a newline and the closing fence (`$` is the end of the text only).
fn fenced(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix("```")?;
    let rest = rest.strip_prefix("json").unwrap_or(rest);
    let run = rest.len() - rest.trim_start_matches(is_js_space).len();
    // The greedy `\s*` backs off one character at a time until a newline follows it.
    let mut newlines: Vec<usize> = rest[..run]
        .char_indices()
        .filter(|(_, c)| *c == '\n')
        .map(|(at, _)| at)
        .collect();
    while let Some(at) = newlines.pop() {
        let inner = &rest[at + 1..];
        if let Some(body) = inner.strip_suffix("\n```") {
            return Some(body);
        }
    }
    None
}

/// `^p(\d+)$` read as a zero-based index below `count`: `p1` is 0, `p01` is 0 too, `p0` and a number past `count`
/// are none.
fn shown_index(id: &str, count: usize) -> Option<usize> {
    let digits = id.strip_prefix('p')?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let digits = digits.trim_start_matches('0');
    // `Number("9007199254740993")` is no exact integer, but it is far past any count.
    if digits.len() > 18 {
        return None;
    }
    let number: u64 = digits.parse().ok()?;
    let index = usize::try_from(number.checked_sub(1)?).ok()?;
    (index < count).then_some(index)
}

/// The model's answer as one verdict per pair. Strict: a single JSON object (optionally in one code fence) whose
/// `pairs` entries each carry a shown id and a known relation. An id shown twice, an unknown id or relation, or any
/// other shape leaves that pair `None`; text that is not JSON leaves them all `None`.
///
/// serde_json reads the text where the TypeScript used `JSON.parse`. The grammar is the same (JSON whitespace only,
/// no trailing commas, no leading zeros, raw control characters refused, a duplicate key's last value kept); three
/// inputs differ, each leaving every pair `None` here where V8 read the object:
/// - a string escape holding half a surrogate pair (`"\ud800"`): serde refuses it, V8 keeps the lone surrogate;
/// - a number past the `f64` range (`1e999`): serde refuses it, V8 reads Infinity (the shipped workspace build, with the
///   CLI's `arbitrary_precision`, reads it too);
/// - nesting deeper than 128 levels: serde refuses it, V8 reads thousands of levels.
///
/// Nothing serde accepts is refused by V8 (the captured rows hold every malformed form tried).
pub fn parse_smol_verdicts(answer: &str, count: usize) -> Vec<Option<PairVerdict>> {
    let mut verdicts: Vec<Option<PairVerdict>> = vec![None; count];
    let trimmed = js_trim(answer);
    let source = fenced(trimmed).unwrap_or(trimmed);
    let Ok(root) = serde_json::from_str::<Value>(source) else {
        return verdicts;
    };
    let Some(Value::Array(entries)) = field(&root, "pairs") else {
        return verdicts;
    };
    let mut seen = vec![false; count];
    let mut bad = vec![false; count];
    for entry in entries {
        let Some(index) = field(entry, "id")
            .and_then(Value::as_str)
            .and_then(|id| shown_index(id, count))
        else {
            continue;
        };
        if seen[index] {
            bad[index] = true;
        }
        seen[index] = true;
        let known = field(entry, "relation")
            .and_then(Value::as_str)
            .and_then(|name| {
                RELATIONS
                    .into_iter()
                    .find(|candidate| candidate.as_str() == name)
            });
        if let Some(relation) = known {
            verdicts[index] = Some(PairVerdict {
                relation,
                confidence: 1.0,
            });
        }
    }
    for (index, bad) in bad.into_iter().enumerate() {
        if bad {
            verdicts[index] = None;
        }
    }
    verdicts
}

const JEV_TIMEOUT_MS: u64 = 25_000;
const JEV_CONCURRENCY: u64 = 4;
const JEV_RUN_TIMEOUT: Duration = Duration::from_secs(180);
const HOST_POLL: Duration = Duration::from_millis(100);

/// How production judges: Settings › Agent behavior's judge switch read for this run, the bridge's host file
/// (`resources/gui-bridge/memory-judge-host.ts`) and an empty folder for omp to run in (a repository's would load its
/// AGENTS.md).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeConfig {
    pub enabled: bool,
    pub host_file: String,
    pub cwd: String,
}

/// A scratch folder that goes when this goes, whatever ended the run (a cancelled request included).
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `Number(id)` for an index into the asked pairs: a string of digits (the empty one is 0) or a whole number.
fn index_of(id: Option<&Value>) -> Option<usize> {
    match id? {
        Value::String(text) => {
            let text = js_trim(text);
            if text.is_empty() {
                Some(0)
            } else if text.bytes().all(|byte| byte.is_ascii_digit()) {
                text.parse().ok()
            } else {
                None
            }
        }
        Value::Number(number) => number
            .as_u64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|number| number.fract() == 0.0 && *number >= 0.0)
                    .map(|number| number as u64)
            })
            .and_then(|number| usize::try_from(number).ok()),
        _ => None,
    }
}

/// What the host wrote: a verdict per asked pair, the models that billed and what they billed. None when the host
/// says there is no native judge, wrote something else than its answer, or no pair got a verdict the code accepts.
fn host_judgment(count: usize, out: &Value, elapsed: Duration) -> Option<PairJudgment> {
    if !out.get("available").is_some_and(truthy) {
        return None;
    }
    // A results member that is no array is no list of answers (a string has no `id`s; the rest cannot be iterated).
    let results = out
        .get("results")
        .filter(|results| truthy(results))?
        .as_array()?;
    let mut verdicts: Vec<Option<PairVerdict>> = vec![None; count];
    // A verdict under an id past the asked pairs is in the TypeScript's array too and keeps it from being all null.
    let mut beyond = false;
    for result in results {
        if result.is_null() {
            return None;
        }
        let verdict = jev_verdict(result.get("answers").unwrap_or(&Value::Null));
        match index_of(result.get("id")) {
            Some(index) if index < count => verdicts[index] = verdict,
            Some(_) => beyond |= verdict.is_some(),
            None => {}
        }
    }
    if !beyond && verdicts.iter().all(Option::is_none) {
        return None;
    }
    let usage: &[Value] = match out.get("usage") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(entries)) => entries,
        Some(_) => return None,
    };
    let mut cost = 0.0;
    let mut models: Vec<&str> = Vec::new();
    for entry in usage {
        if entry.is_null() {
            return None;
        }
        cost += entry
            .get("usage")
            .and_then(|usage| usage.get("cost"))
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if let Some(model) = entry.get("model").and_then(Value::as_str)
            && !model.is_empty()
            && !models.contains(&model)
        {
            models.push(model);
        }
    }
    Some(PairJudgment {
        by: JudgedBy::Jev,
        verdicts,
        model: if models.is_empty() {
            "jev".to_owned()
        } else {
            models.join(",")
        },
        cost_usd: cost,
        ms: js_round(elapsed.as_secs_f64() * 1000.0),
    })
}

/// Asks the process to end and kills it when it has not exited `KILL_GRACE` later.
async fn end(child: &mut tokio::process::Child) {
    terminate(child);
    if tokio::time::timeout(KILL_GRACE, child.wait())
        .await
        .is_err()
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

/// Runs the host omp until it has written `output` (or exits, or 180 s are up) and then stops it. Its stdin stays open
/// on purpose: omp's RPC mode quits on end of input, before the judgments finish. The host writes the answers
/// atomically, so the file's existence means it is whole. An omp that cannot start leaves no file.
async fn run_host(launch: &OmpLaunch, host_file: &str, cwd: &str, input: &Path, output: &Path) {
    let runner = Runner {
        bin: launch.bin.clone(),
        args: Vec::new(),
        env: launch.env.clone(),
        timeout_ms: 0,
        max_bytes: 0,
    };
    let mut command = Command::new(&launch.bin);
    command
        .args([
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-rules",
            "-e",
            host_file,
        ])
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let (input_path, output_path) = (
        input.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
    );
    runner.environment(
        &mut command,
        &[
            ("OMP_GUI_MEMORY_JUDGE_IN", &input_path),
            ("OMP_GUI_MEMORY_JUDGE_OUT", &output_path),
            ("OMP_GUI_JUDGE_ASSIST", "1"),
            ("OTEL_SDK_DISABLED", "true"),
        ],
    );
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = command.spawn() else {
        return;
    };
    let _stdin = child.stdin.take();
    let deadline = Instant::now() + JEV_RUN_TIMEOUT;
    while matches!(child.try_wait(), Ok(None)) && !output.exists() && Instant::now() < deadline {
        tokio::time::sleep(HOST_POLL).await;
    }
    end(&mut child).await;
}

/// Jev through stock's judge chain: a one-shot `omp --mode rpc -e memory-judge-host.ts` in an empty folder, asked of
/// stock's own `judge` role chain; none when the switch is off, there is nothing to ask, there is no native judge or
/// the run failed. Only a scratch folder that cannot be made fails the call.
pub async fn jev(
    launch: &OmpLaunch,
    config: &JudgeConfig,
    pairs: &[PagePair],
) -> Result<Option<PairJudgment>, Fault> {
    if !config.enabled || pairs.is_empty() {
        return Ok(None);
    }
    let started = Instant::now();
    let dir = tokio::task::spawn_blocking(|| make_temp_dir("ompdesk-memory-judge-"))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?
        .map_err(|error| error.fault(Codes::None))?;
    let _scratch = Scratch(dir.clone());
    let (input, output) = (dir.join("in.json"), dir.join("out.json"));
    let requests: Vec<Value> = pairs
        .iter()
        .enumerate()
        .map(|(index, pair)| json!({ "id": index.to_string(), "request": jev_request(pair) }))
        .collect();
    let body = json!({ "requests": requests, "timeoutMs": JEV_TIMEOUT_MS, "concurrency": JEV_CONCURRENCY });
    let Ok(body) = serde_json::to_vec(&body) else {
        return Ok(None);
    };
    if std::fs::write(&input, body).is_err() {
        return Ok(None);
    }
    run_host(launch, &config.host_file, &config.cwd, &input, &output).await;
    let Ok(written) = std::fs::read(&output) else {
        return Ok(None);
    };
    let text = String::from_utf8_lossy(&written);
    let Ok(out) = serde_json::from_str::<Value>(&whole_surrogates(&text)) else {
        return Ok(None);
    };
    Ok(host_judgment(pairs.len(), &out, started.elapsed()))
}

/// One batched call on the cheap model (`call` runs it); none when it failed or answered nothing readable. Never
/// asks for no pairs.
pub async fn smol_judge<F, Fut>(pairs: &[PagePair], rules: &str, call: F) -> Option<PairJudgment>
where
    F: FnOnce(Message) -> Fut,
    Fut: Future<Output = Result<ModelResult, Fault>>,
{
    if pairs.is_empty() {
        return None;
    }
    let started = Instant::now();
    let message = smol_message(pairs, rules);
    let result = call(Message {
        system: message.system.to_owned(),
        user: message.user,
    })
    .await
    .ok()?;
    let verdicts = parse_smol_verdicts(&result.text, pairs.len());
    if verdicts.iter().all(Option::is_none) {
        return None;
    }
    Some(PairJudgment {
        by: JudgedBy::Smol,
        verdicts,
        model: result.model,
        cost_usd: result.cost_usd,
        ms: js_round(started.elapsed().as_secs_f64() * 1000.0),
    })
}

/// One judge of a chain, started only when the ones before it answered nothing.
pub type Step<'a> = Box<
    dyn FnOnce() -> Pin<Box<dyn Future<Output = Result<Option<PairJudgment>, Fault>> + Send + 'a>>
        + Send
        + 'a,
>;

/// Judges in order of preference: the first that answers judges the whole batch. A pair the answering judge leaves
/// undecided is not passed on (the cheap model asked about the one pair Jev left cost more than Jev's 29 answers, and
/// the code rule retires only what it is sure of).
pub async fn chain_judges(steps: Vec<Step<'_>>) -> Result<Option<PairJudgment>, Fault> {
    for step in steps {
        if let Some(judgment) = step().await? {
            return Ok(Some(judgment));
        }
    }
    Ok(None)
}

/// `omp`'s launch as main answers it, or none when there is no omp that can run (or main answered another shape).
pub async fn launch_of(asker: &Asker) -> Result<Option<OmpLaunch>, Fault> {
    match asker.ask("omp", json!({})).await {
        Ok(value) => Ok(serde_json::from_value(value).ok()),
        Err(fault) if is_cancelled(&fault) => Err(fault),
        Err(_) => Ok(None),
    }
}

/// Production's judge: the user's omp (none: no judge, the code rule alone), an empty folder for it to run in, then
/// Jev while its switch is on, then the cheap model. The cheap model reads stored pages to the provider, as learning
/// reads conversations.
pub async fn production(
    asker: &Asker,
    config: &JudgeConfig,
    pairs: &[PagePair],
    rules: &str,
) -> Result<Option<PairJudgment>, Fault> {
    let Some(launch) = launch_of(asker).await? else {
        return Ok(None);
    };
    let cwd = PathBuf::from(&config.cwd);
    {
        let folder = cwd.clone();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(&folder))
            .await
            .map_err(|error| Fault::new("internal", error.to_string()))?
            .map_err(|error| {
                NodeError::new(&error, "mkdir", Some(&config.cwd)).fault(Codes::None)
            })?;
    }
    let (launch, cwd) = (&launch, cwd.as_path());
    chain_judges(vec![
        Box::new(move || Box::pin(jev(launch, config, pairs))),
        Box::new(move || {
            Box::pin(async move {
                Ok(smol_judge(pairs, rules, |message| async move {
                    run_smol(launch, &message, cwd).await
                })
                .await)
            })
        }),
    ])
    .await
}

/// A pair judge: a test's own function asked of main, or production's chain.
pub enum Judge<'a> {
    /// `judge` `{pairs, rules}` → `PairJudgment | null`.
    Main(&'a Asker),
    Production(&'a Asker, &'a JudgeConfig),
}

impl<'a> Judge<'a> {
    /// A test's judge when main answers `judge`, else production's when it is configured, else none (the code rule
    /// alone).
    pub fn choose(
        asker: &'a Asker,
        asked: bool,
        config: Option<&'a JudgeConfig>,
    ) -> Option<Judge<'a>> {
        if asked {
            Some(Judge::Main(asker))
        } else {
            config.map(|config| Judge::Production(asker, config))
        }
    }

    pub async fn judge(
        &self,
        pairs: &[PagePair],
        rules: &str,
    ) -> Result<Option<PairJudgment>, Fault> {
        match self {
            Judge::Main(asker) => {
                let answer = asker
                    .ask("judge", json!({ "pairs": pairs, "rules": rules }))
                    .await?;
                serde_json::from_value(answer).map_err(|error| {
                    Fault::new(
                        "memory_main",
                        format!("judge answered another shape than a judgment: {error}"),
                    )
                })
            }
            Judge::Production(asker, config) => production(asker, config, pairs, rules).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(name: &str) -> Vec<Value> {
        let table: Value = serde_json::from_str(include_str!("judge-captured.json")).unwrap();
        table[name].as_array().unwrap().clone()
    }

    fn text<'a>(row: &'a Value, key: &str) -> &'a str {
        row[key].as_str().unwrap()
    }

    fn verdict_json(verdict: &Option<PairVerdict>) -> Value {
        match verdict {
            None => Value::Null,
            Some(verdict) => {
                json!({ "relation": verdict.relation.as_str(), "confidence": verdict.confidence })
            }
        }
    }

    /// Both numbers as the same double (`1` and `1.0` are one number in JavaScript).
    fn same(left: &Value, right: &Value) -> bool {
        match (left, right) {
            (Value::Number(left), Value::Number(right)) => {
                left.as_f64().map(f64::to_bits) == right.as_f64().map(f64::to_bits)
            }
            (Value::Object(left), Value::Object(right)) => {
                left.len() == right.len()
                    && left
                        .iter()
                        .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
            }
            _ => left == right,
        }
    }

    #[test]
    fn texts_are_verbatim_from_the_typescript() {
        let request = jev_request(&PagePair {
            a: digest("a", Scope::Project),
            b: digest("b", Scope::Project),
        });
        let instructions = request["questions"]["relation"]["instructions"]
            .as_str()
            .unwrap();
        assert!(instructions.starts_with("Two notes from the same person's memory"));
        assert!(SMOL_SYSTEM.ends_with("with the id it was shown under."));
    }

    fn digest(title: &str, scope: Scope) -> PageDigest {
        PageDigest {
            path: format!("decisions/{title}.md"),
            title: title.into(),
            kind: "decision".into(),
            saved: "2026-10-18".into(),
            scope,
            text: "body".into(),
        }
    }

    #[test]
    fn page_text_matches_the_captured_rows() {
        let rows = rows("page");
        assert_eq!(rows.len(), 47);
        for row in &rows {
            let markdown = text(row, "markdown");
            assert_eq!(
                body_text(markdown),
                text(row, "body"),
                "body of {markdown:?}"
            );
            assert_eq!(
                page_text(markdown),
                text(row, "page"),
                "page of {markdown:?}"
            );
            if row["lone"].as_bool().unwrap() {
                assert_eq!(page_text(markdown).encode_utf16().count(), PAGE_CHARS);
                assert!(page_text(markdown).ends_with('\u{FFFD}'));
            }
        }
    }

    #[test]
    fn jev_requests_match_the_captured_rows_key_for_key() {
        let rows = rows("jevRequest");
        assert_eq!(rows.len(), 4);
        for row in &rows {
            let pair: PagePair = serde_json::from_value(row["pair"].clone()).unwrap();
            assert_eq!(
                serde_json::to_string(&jev_request(&pair)).unwrap(),
                serde_json::to_string(&row["request"]).unwrap()
            );
        }
    }

    #[test]
    fn smol_messages_match_the_captured_rows() {
        let rows = rows("smolMessage");
        assert_eq!(rows.len(), 16);
        for row in &rows {
            let pairs: Vec<PagePair> = serde_json::from_value(row["pairs"].clone()).unwrap();
            let message = smol_message(&pairs, text(row, "rules"));
            assert_eq!(message.system, text(&row["message"], "system"));
            assert_eq!(message.user, text(&row["message"], "user"));
        }
    }

    #[test]
    fn jev_verdicts_match_the_captured_rows() {
        let rows = rows("jevVerdict");
        assert_eq!(rows.len(), 61);
        for row in &rows {
            let json = text(row, "json");
            let Ok(answers) = serde_json::from_str::<Value>(json) else {
                // serde refuses a number past the f64 range that V8 reads as Infinity (never a verdict).
                assert!(json.contains("e999"), "{json}");
                assert_eq!(row["verdict"], Value::Null, "{json}");
                continue;
            };
            let got = verdict_json(&jev_verdict(&answers));
            assert!(
                same(&got, &row["verdict"]),
                "{json}: {got} against {}",
                row["verdict"]
            );
        }
    }

    #[test]
    fn smol_answers_match_the_captured_rows() {
        let rows = rows("parseSmol");
        assert_eq!(rows.len(), 137);
        let mut serde_refused = 0;
        for row in &rows {
            let answer = text(row, "answer");
            let count = row["count"].as_u64().unwrap() as usize;
            let got: Vec<Value> = parse_smol_verdicts(answer, count)
                .iter()
                .map(verdict_json)
                .collect();
            let want = row["verdicts"].as_array().unwrap();
            if row["serdeRefuses"].as_bool() == Some(true) && got.iter().all(Value::is_null) {
                serde_refused += 1;
                assert!(got.iter().all(Value::is_null), "{answer:?}");
                assert!(want.iter().any(|verdict| !verdict.is_null()), "{answer:?}");
                continue;
            }
            assert_eq!(got.len(), want.len(), "{answer:?}");
            for (got, want) in got.iter().zip(want) {
                assert!(same(got, want), "{answer:?}: {got} against {want}");
            }
        }
        // Past f64's range, a half surrogate escape, nesting past 128 levels: see `parse_smol_verdicts`. The
        // workspace build (the shipped core) unifies the CLI's `arbitrary_precision`, under which `1e999` parses and
        // the answer reads as V8 read it.
        let big = rows
            .iter()
            .filter(|row| row["serdeRefuses"] == true && text(row, "answer").contains("e999"))
            .count();
        let big_parses = serde_json::from_str::<Value>("1e999").is_ok();
        assert_eq!(serde_refused, if big_parses { 8 - big } else { 8 });
    }
}

#[cfg(test)]
mod host_tests {
    use super::*;

    fn answers(choice: &str, probability: f64) -> Value {
        json!({ "relation": { "type": "choice", "choice": choice, "probabilities": { choice: probability } } })
    }

    fn read(count: usize, out: &Value) -> Option<PairJudgment> {
        host_judgment(count, out, Duration::from_millis(7))
    }

    #[test]
    fn reads_the_hosts_verdicts_models_and_cost() {
        let out = json!({
            "available": true,
            "results": [{ "id": "1", "answers": answers("duplicate", 0.9), "ms": 1 }],
            "usage": [
                { "model": "a", "usage": { "cost": { "total": 0.5 } } },
                { "model": "a", "usage": { "cost": { "total": 0.25 } } },
                { "model": "", "usage": null },
                { "usage": { "cost": { "total": "x" } } },
                { "model": "b" },
            ],
        });
        let judgment = read(2, &out).unwrap();
        assert_eq!(judgment.by, JudgedBy::Jev);
        assert_eq!(judgment.model, "a,b");
        assert_eq!(judgment.cost_usd, 0.75);
        assert_eq!(judgment.ms, 7.0);
        assert_eq!(judgment.verdicts.len(), 2);
        assert!(judgment.verdicts[0].is_none());
        assert_eq!(judgment.verdicts[1].unwrap().relation, Relation::Duplicate);
    }

    #[test]
    fn a_model_of_no_usage_entry_is_jev() {
        let out = json!({ "available": true, "results": [{ "id": "0", "answers": answers("duplicate", 0.9) }] });
        assert_eq!(read(1, &out).unwrap().model, "jev");
        assert_eq!(read(1, &out).unwrap().cost_usd, 0.0);
    }

    #[test]
    fn the_host_saying_nothing_usable_is_no_judgment() {
        let good = json!([{ "id": "0", "answers": answers("duplicate", 0.9) }]);
        for out in [
            json!(null),
            json!([]),
            json!({}),
            json!({ "available": false, "results": good }),
            json!({ "available": 0, "results": good }),
            json!({ "available": true }),
            json!({ "available": true, "results": null }),
            json!({ "available": true, "results": {} }),
            json!({ "available": true, "results": "abc" }),
            json!({ "available": true, "results": [] }),
            // An entry that is null has no `id` to read: the TypeScript threw there.
            json!({ "available": true, "results": [null, { "id": "0", "answers": answers("duplicate", 0.9) }] }),
            json!({ "available": true, "results": good, "usage": {} }),
            json!({ "available": true, "results": good, "usage": [null] }),
            // Under the bar.
            json!({ "available": true, "results": [{ "id": "0", "answers": answers("duplicate", 0.2) }] }),
        ] {
            assert!(read(1, &out).is_none(), "{out}");
        }
    }

    #[test]
    fn an_id_is_the_number_it_spells() {
        let verdict = |id: Value| {
            let out = json!({ "available": true, "results": [{ "id": id, "answers": answers("duplicate", 0.9) }] });
            read(3, &out).map(|judgment| judgment.verdicts.iter().position(Option::is_some))
        };
        assert_eq!(verdict(json!("2")), Some(Some(2)));
        assert_eq!(verdict(json!(" 1 ")), Some(Some(1)));
        // `Number("007")` is 7: past the three pairs.
        assert_eq!(verdict(json!("007")), Some(None));
        assert_eq!(verdict(json!("")), Some(Some(0)));
        assert_eq!(verdict(json!(1)), Some(Some(1)));
        assert_eq!(verdict(json!(2.0)), Some(Some(2)));
        // Past the asked pairs, a verdict still keeps the answer from being all null, and lands on no pair.
        assert_eq!(verdict(json!("9")), Some(None));
        // Not an index at all: nothing.
        assert_eq!(verdict(json!("x")), None);
        assert_eq!(verdict(json!(-1)), None);
        assert_eq!(verdict(json!(1.5)), None);
    }

    #[test]
    fn a_later_answer_for_an_id_replaces_an_earlier_one_even_with_none() {
        let out = json!({
            "available": true,
            "results": [
                { "id": "0", "answers": answers("duplicate", 0.9) },
                { "id": "0", "answers": answers("duplicate", 0.1) },
                { "id": "1", "answers": answers("a_outdated", 0.9) },
                { "id": "1", "answers": answers("A_outdated", 0.9) },
            ],
        });
        let judgment = read(2, &out).unwrap();
        assert!(judgment.verdicts[0].is_none());
        assert_eq!(judgment.verdicts[1].unwrap().relation, Relation::AOutdated);
    }
}
