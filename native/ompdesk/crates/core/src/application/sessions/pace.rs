use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

use regex::Regex;
use serde_json::{Value, json};

struct Cached {
    stamp: (Option<SystemTime>, u64),
    value: Value,
}

#[derive(Default)]
pub struct PaceCache {
    entries: HashMap<PathBuf, Cached>,
}

impl PaceCache {
    pub fn invalidate(&mut self, path: &Path) {
        self.entries.remove(path);
    }
    pub fn clear(&mut self) {
        self.entries.clear();
    }
    pub fn read(&mut self, path: &Path) -> Option<Value> {
        let metadata = path.metadata().ok()?;
        let stamp = (metadata.modified().ok(), metadata.len());
        if let Some(cached) = self.entries.get(path).filter(|entry| entry.stamp == stamp) {
            return Some(cached.value.clone());
        }
        let raw = std::fs::read(path).ok()?;
        let text = String::from_utf8_lossy(&raw);
        let value = calculate(text.lines());
        self.entries.insert(
            path.to_owned(),
            Cached {
                stamp,
                value: value.clone(),
            },
        );
        Some(value)
    }
}

fn seconds(value: &Value) -> Option<f64> {
    let stamp = value
        .get("timestamp")
        .filter(|stamp| !stamp.is_null())
        .or_else(|| value.pointer("/message/timestamp"))?;
    stamp
        .as_f64()
        .or_else(|| {
            stamp.as_str().and_then(|date| {
                crate::schedules::rules::date_parse(date, &crate::schedules::rules::Local)
                    .map(|ms| ms as f64)
            })
        })
        .map(|ms| ms / 1000.0)
}

fn union(intervals: &[(f64, f64)]) -> f64 {
    let mut sorted = intervals.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut total = 0.0;
    let mut open: Option<(f64, f64)> = None;
    for (start, end) in sorted {
        match open {
            Some((left, right)) if start <= right => open = Some((left, right.max(end))),
            Some((left, right)) => {
                total += right - left;
                open = Some((start, end));
            }
            None => open = Some((start, end)),
        }
    }
    if let Some((left, right)) = open {
        total += right - left;
    }
    total
}

fn read_target(value: &Value) -> Option<String> {
    if value["type"] != "toolCall" || value["name"] != "read" {
        return None;
    }
    let path = value.pointer("/arguments/path")?.as_str()?;
    let colon = path.rfind(':');
    Some(match colon {
        Some(index) if index > 0 && !path[index + 1..].contains(['/', '\\']) => {
            path[..index].to_owned()
        }
        _ => path.to_owned(),
    })
}

fn result_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item["text"].as_str().unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[derive(Default)]
struct Tool {
    seconds: f64,
    calls: u64,
    errors: u64,
}

fn calculate<'a>(lines: impl IntoIterator<Item = &'a str>) -> Value {
    let mut starts = HashMap::<String, f64>::new();
    let mut tools = BTreeMap::<String, Tool>::new();
    let mut intervals = Vec::new();
    let mut think_gaps = Vec::new();
    let mut reads: Vec<(String, u64)> = Vec::new();
    let mut first = None;
    let mut previous = None;
    let mut model_calls = 0u64;
    let mut output_tokens = 0.0;
    let mut gaps = Vec::new();
    let mut polls = Polls::default();
    let mut check_calls = HashSet::<String>::new();
    let mut check_jobs = HashSet::<String>::new();
    let mut check_intervals = Vec::new();
    let mut saved = HashMap::<String, f64>::new();
    for line in lines {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(at) = seconds(&entry) else { continue };
        if entry["type"] == "custom" && entry["customType"] == "tool_execution_start" {
            if let Some(id) = entry
                .pointer("/data/toolCallId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                starts.insert(id.into(), at);
            }
            continue;
        }
        let Some(message) = entry.get("message").filter(|_| entry["type"] == "message") else {
            continue;
        };
        first.get_or_insert(at);
        if let Some(prev) = previous
            && at - prev > 600.0
        {
            gaps.push((prev, at));
        }
        let since = previous.map(|prev| at - prev);
        previous = Some(at);
        match message["role"].as_str() {
            Some("assistant") => {
                model_calls += 1;
                output_tokens += message
                    .pointer("/usage/output")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                if let Some(since) = since.filter(|since| *since <= 600.0) {
                    think_gaps.push(since);
                }
                for part in message["content"].as_array().into_iter().flatten() {
                    if let Some(path) = read_target(part) {
                        if let Some((_, count)) = reads.iter_mut().find(|(old, _)| old == &path) {
                            *count += 1;
                        } else {
                            reads.push((path, 1));
                        }
                    }
                    if part["type"] != "toolCall" {
                        continue;
                    }
                    let Some(name) = part["name"].as_str() else {
                        continue;
                    };
                    let Some(arguments) = part.get("arguments").filter(|value| value.is_object())
                    else {
                        continue;
                    };
                    polls.observe(name, arguments);
                    if name == "bash"
                        && let (Some(id), Some(command)) =
                            (part["id"].as_str(), arguments["command"].as_str())
                        && check_run(command)
                    {
                        check_calls.insert(id.into());
                    }
                }
            }
            Some("toolResult") => {
                let name = message["toolName"].as_str().unwrap_or("?");
                let id = message["toolCallId"].as_str();
                let began = id.and_then(|id| starts.get(id)).copied();
                let row = tools.entry(name.into()).or_default();
                if let Some(began) = began {
                    row.seconds += at - began;
                    intervals.push((began, at));
                }
                row.calls += 1;
                if message["isError"] == true {
                    row.errors += 1;
                }
                saved_checks(&result_text(&message["content"]), &mut saved);
                let details = &message["details"];
                if name == "bash"
                    && let Some(id) = id
                {
                    let check = check_calls.contains(id);
                    if check && let Some(began) = began {
                        check_intervals.push((began, at));
                    }
                    if let Some(job) = details
                        .pointer("/async/jobId")
                        .and_then(Value::as_str)
                        .filter(|job| !job.is_empty())
                    {
                        if check {
                            check_jobs.insert(job.into());
                        } else {
                            check_jobs.remove(job);
                        }
                    }
                }
                if name == "wait" {
                    if message["useless"] == true
                        && details["op"] == "wait"
                        && details["jobs"].as_array().is_some_and(|jobs| {
                            !jobs.is_empty() && jobs.iter().all(|job| job["status"] == "running")
                        })
                    {
                        polls.add("wait");
                    }
                    if let Some(began) = began {
                        for job in details["jobs"].as_array().into_iter().flatten() {
                            if job["type"] != "bash"
                                || !job["id"].as_str().is_some_and(|id| check_jobs.contains(id))
                            {
                                continue;
                            }
                            let end = at.min(
                                job["settledAtMs"]
                                    .as_f64()
                                    .map(|ms| ms / 1000.0)
                                    .unwrap_or(at),
                            );
                            let from =
                                began.max(end - job["durationMs"].as_f64().unwrap_or(0.0) / 1000.0);
                            if end > from {
                                check_intervals.push((from, end));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let wall = first
        .zip(previous)
        .map_or(0.0, |(first, last)| last - first);
    let tool = union(&intervals);
    let idle: f64 = gaps
        .into_iter()
        .map(|(from, to)| {
            let overlap: Vec<_> = intervals
                .iter()
                .filter_map(|&(start, end)| {
                    let clipped = (start.max(from), end.min(to));
                    (clipped.1 > clipped.0).then_some(clipped)
                })
                .collect();
            to - from - union(&overlap)
        })
        .sum();
    let rows: serde_json::Map<_, _> = tools
        .into_iter()
        .map(|(name, row)| {
            (
                name,
                json!({"seconds":row.seconds,"calls":row.calls,"errors":row.errors}),
            )
        })
        .collect();
    let mut result = json!({"wallS":wall,"toolS":tool,"modelS":(wall-tool-idle).max(0.0),"idleS":idle,"modelCalls":model_calls,"outputTokens":output_tokens,"tools":rows,"thinkGaps":think_gaps,"polls":polls.count});
    if let Some((path, count)) = reads
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .reduce(|best, next| if next.1 > best.1 { next } else { best })
    {
        result["repeatRead"] = json!({"path":path,"count":count});
    }
    if polls.count > 0 {
        result["pollKinds"] = json!(polls.kinds);
    }
    if !check_calls.is_empty() {
        let saved: f64 = saved.values().sum();
        let mut checks = json!({"runs":check_calls.len(),"seconds":union(&check_intervals)});
        if saved > 0.0 {
            checks["savedS"] = saved.into();
        }
        result["checks"] = checks;
    }
    result
}

#[derive(Default)]
struct Polls {
    seen: HashSet<String>,
    kinds: serde_json::Map<String, Value>,
    count: u64,
}

impl Polls {
    fn add(&mut self, kind: &str) {
        self.count += 1;
        let count = self.kinds.get(kind).and_then(Value::as_u64).unwrap_or(0) + 1;
        self.kinds.insert(kind.into(), count.into());
    }
    fn look(&mut self, kind: &str, key: Option<String>) -> bool {
        key.is_none_or(|key| !self.seen.insert(format!("{kind}\0{key}")))
    }
    fn observe(&mut self, name: &str, args: &Value) {
        if name == "read" {
            if let Some(id) = args["path"]
                .as_str()
                .and_then(|path| path.strip_prefix("proc://"))
                .and_then(|path| path.split(['/', ':', '?', '#']).next())
                .filter(|id| !id.is_empty())
                && self.look("proc", Some(id.into()))
            {
                self.add("proc");
            }
            return;
        }
        if name != "bash" || args["async"] == true {
            return;
        }
        let Some(command) = args["command"].as_str() else {
            return;
        };
        let command = strip_poll_heredocs(command);
        let segments = shell_segments(&command);
        let mut found = Vec::new();
        if sleep_poll(&command) {
            found.push("sleep");
        }
        for segment in segments {
            let words = shell_words(&segment);
            if let Some(at) = words.windows(3).position(|words| {
                words[0] == "gh"
                    && words[1] == "run"
                    && matches!(words[2].as_str(), "view" | "list" | "watch")
            }) {
                let sub = words[at + 2].as_str();
                let args = &words[at + 3..];
                let key = match sub {
                    "watch" => Some(None),
                    "list" => Some(Some(format!("list {}", args.join(" ")))),
                    "view"
                        if !args
                            .iter()
                            .any(|arg| arg == "--log" || arg == "--log-failed") =>
                    {
                        let mut run = None;
                        let mut job = None;
                        let mut i = 0;
                        while i < args.len() {
                            let arg = &args[i];
                            if let Some(value) = arg
                                .strip_prefix("--job=")
                                .or_else(|| arg.strip_prefix("-j="))
                                .filter(|value| !value.is_empty())
                            {
                                job = Some(value.to_owned());
                            } else if matches!(arg.as_str(), "--job" | "-j") {
                                i += 1;
                                job = args.get(i).cloned();
                            } else if matches!(
                                arg.as_str(),
                                "-a" | "--attempt"
                                    | "--json"
                                    | "-q"
                                    | "--jq"
                                    | "-t"
                                    | "--template"
                                    | "-R"
                                    | "--repo"
                            ) {
                                i += 1;
                            } else if run.is_none() {
                                if arg.chars().all(|ch| ch.is_ascii_digit()) && !arg.is_empty() {
                                    run = Some(arg.clone());
                                } else if let Some(rest) = arg.split("/runs/").nth(1) {
                                    let digits: String =
                                        rest.chars().take_while(char::is_ascii_digit).collect();
                                    if !digits.is_empty() {
                                        run = Some(digits);
                                    }
                                }
                            }
                            i += 1;
                        }
                        let target = match (run, job) {
                            (Some(run), Some(job)) => format!("{run} job {job}"),
                            (Some(run), None) => run,
                            (None, Some(job)) => format!("job {job}"),
                            (None, None) => args.join(" "),
                        };
                        Some(Some(format!("view {target}")))
                    }
                    _ => None,
                };
                if let Some(key) = key
                    && self.look("gh-run", key)
                    && !found.contains(&"gh-run")
                {
                    found.push("gh-run");
                }
            }
            if let Some(at) = words
                .iter()
                .position(|word| word == "pgrep" || word.ends_with("/pgrep"))
                && self.look("pgrep", Some(words[at + 1..].join(" ")))
                && !found.contains(&"pgrep")
            {
                found.push("pgrep");
            }
        }
        if tail_follow(&command) {
            found.push("tail-f");
        }
        if let Some(first) = found.first() {
            self.add(first);
        }
    }
}

// The polling expressions in resources/gui-bridge/waste-guards-core.ts.
static SLEEP_POLL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)sleep\s+[0-9.]+[smhd]?\s*(?:;|&&|\|\||\||&|\n)\s*\S")
        .expect("sleep pattern")
});
static WHILE_SLEEP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)(?-u:\b)while(?-u:\b).*(?-u:\b)sleep(?-u:\b)").expect("while pattern")
});
static TAIL_FOLLOW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)tail(?-u:\b)[^|;&\n]*?\s(?:-[A-Za-z]*[fF][A-Za-z0-9]*|--follow(?:=[A-Za-z0-9_]+)?)(?:\s|$)").expect("tail pattern")
});

fn sleep_poll(command: &str) -> bool {
    SLEEP_POLL.is_match(command) || WHILE_SLEEP.is_match(command)
}
fn tail_follow(command: &str) -> bool {
    TAIL_FOLLOW.is_match(command)
}

// scan and withoutHeredocs in resources/gui-bridge/waste-guards-core.ts.
fn closing(bytes: &[u8], at: usize, quote: u8) -> usize {
    let mut i = at + 1;
    while i < bytes.len() {
        if quote == b'"' && bytes[i] == b'\\' {
            i += 2;
        } else if bytes[i] == quote {
            return i;
        } else {
            i += 1;
        }
    }
    bytes.len()
}

fn skip_balanced(bytes: &[u8], mut i: usize) -> usize {
    let mut depth = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            quote @ (b'\'' | b'"') => i = closing(bytes, i, quote).saturating_add(1),
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => i += 1,
        }
    }
    bytes.len()
}

fn scan_word(bytes: &[u8], i: &mut usize) -> Vec<u8> {
    let mut word = Vec::new();
    while *i < bytes.len()
        && !matches!(
            bytes[*i],
            b' ' | b'\t' | b'\r' | b'\n' | b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')'
        )
    {
        match bytes[*i] {
            b'\\' => {
                if bytes.get(*i + 1) == Some(&b'\n') {
                    *i += 2;
                } else {
                    if let Some(&next) = bytes.get(*i + 1) {
                        word.push(next);
                    }
                    *i += 2;
                }
            }
            quote @ (b'\'' | b'"') => {
                let end = closing(bytes, *i, quote);
                word.extend_from_slice(&bytes[*i + 1..end]);
                *i = end.saturating_add(1);
            }
            b'$' if bytes.get(*i + 1) == Some(&b'(') => {
                let end = skip_balanced(bytes, *i + 1);
                word.extend_from_slice(&bytes[*i..end]);
                *i = end;
            }
            b'`' => {
                let end = closing(bytes, *i, b'`');
                word.extend_from_slice(&bytes[*i..end.saturating_add(1).min(bytes.len())]);
                *i = end.saturating_add(1);
            }
            byte => {
                word.push(byte);
                *i += 1;
            }
        }
    }
    word
}

fn strip_poll_heredocs(command: &str) -> String {
    let bytes = command.as_bytes();
    let mut pending: Vec<(Vec<u8>, bool)> = Vec::new();
    let mut bodies = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\r' | b')' => i += 1,
            b'\\' if bytes.get(i + 1) == Some(&b'\n') => i += 2,
            b'\n' => {
                i += 1;
                for (tag, strip) in pending.drain(..) {
                    let start = i;
                    while i < bytes.len() {
                        let end = bytes[i..]
                            .iter()
                            .position(|byte| *byte == b'\n')
                            .map_or(bytes.len(), |at| i + at);
                        let mut line = &bytes[i..end];
                        i = if end == bytes.len() { end } else { end + 1 };
                        if strip {
                            while line.first() == Some(&b'\t') {
                                line = &line[1..];
                            }
                        }
                        if line == tag.as_slice() {
                            break;
                        }
                    }
                    bodies.push((start, i));
                }
            }
            b'#' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b';' | b'&' | b'|' => i += 1,
            b'(' => i = skip_balanced(bytes, i),
            b'<' => {
                if bytes.get(i + 1) == Some(&b'<') {
                    if bytes.get(i + 2) == Some(&b'<') {
                        i += 3;
                        while bytes
                            .get(i)
                            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
                        {
                            i += 1;
                        }
                        scan_word(bytes, &mut i);
                    } else {
                        i += 2;
                        let strip = bytes.get(i) == Some(&b'-');
                        if strip {
                            i += 1;
                        }
                        while bytes
                            .get(i)
                            .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
                        {
                            i += 1;
                        }
                        let tag = scan_word(bytes, &mut i);
                        if !tag.is_empty() {
                            pending.push((tag, strip));
                        }
                    }
                } else if bytes.get(i + 1) == Some(&b'(') {
                    i = skip_balanced(bytes, i + 1);
                } else {
                    i += 1;
                    while bytes
                        .get(i)
                        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
                    {
                        i += 1;
                    }
                    scan_word(bytes, &mut i);
                }
            }
            b'>' => {
                i += 1;
                if bytes
                    .get(i)
                    .is_some_and(|byte| matches!(byte, b'>' | b'&' | b'|'))
                {
                    i += 1;
                }
                while bytes
                    .get(i)
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
                {
                    i += 1;
                }
                if bytes.get(i) == Some(&b'(') {
                    i = skip_balanced(bytes, i);
                } else {
                    scan_word(bytes, &mut i);
                }
            }
            _ => {
                scan_word(bytes, &mut i);
            }
        }
    }
    let mut result = Vec::with_capacity(bytes.len());
    let mut from = 0;
    for (start, end) in bodies {
        result.extend_from_slice(&bytes[from..start]);
        from = end;
    }
    result.extend_from_slice(&bytes[from..]);
    String::from_utf8_lossy(&result).into_owned()
}
fn strip_heredocs(command: &str) -> String {
    let mut kept = Vec::new();
    let mut lines = command.lines();
    while let Some(line) = lines.next() {
        let mut quote = None;
        let mut escaped = false;
        let mut operator = None;
        let bytes = line.as_bytes();
        for (at, ch) in line.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' && quote != Some('\'') {
                escaped = true;
                continue;
            }
            if let Some(open) = quote {
                if ch == open {
                    quote = None;
                }
                continue;
            }
            if ch == '\'' || ch == '"' {
                quote = Some(ch);
                continue;
            }
            if ch == '<'
                && bytes.get(at + 1) == Some(&b'<')
                && bytes.get(at + 2) != Some(&b'<')
                && (at == 0 || bytes.get(at - 1) != Some(&b'<'))
            {
                operator = Some(at);
                break;
            }
        }
        let Some(at) = operator else {
            kept.push(line.to_owned());
            continue;
        };
        let tail = &line[at + 2..];
        let tail = tail
            .strip_prefix('-')
            .unwrap_or(tail)
            .trim_start_matches([' ', '\t']);
        let (tag, tail) =
            if let Some(quote) = tail.chars().next().filter(|ch| *ch == '\'' || *ch == '"') {
                let rest = &tail[quote.len_utf8()..];
                match rest.find(quote) {
                    Some(end) => (&rest[..end], &rest[end + quote.len_utf8()..]),
                    None => ("", tail),
                }
            } else {
                let plain = tail.strip_prefix('\\').unwrap_or(tail);
                let end = plain
                    .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
                    .unwrap_or(plain.len());
                if !plain
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
                {
                    ("", tail)
                } else {
                    (&plain[..end], &plain[end..])
                }
            };
        if tag.is_empty() {
            kept.push(line.to_owned());
            continue;
        }
        kept.push(format!("{}{tail}", &line[..at]));
        for body in lines.by_ref() {
            if body.trim() == tag {
                break;
            }
        }
    }
    kept.join("\n")
}

fn check_segments(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut skipping_pipeline = false;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if escaped {
            if !skipping_pipeline {
                current.push(ch);
            }
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            if !skipping_pipeline {
                current.push(ch);
            }
            escaped = true;
            continue;
        }
        if let Some(open) = quote {
            if !skipping_pipeline {
                current.push(ch);
            }
            if ch == open {
                quote = None;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            if !skipping_pipeline {
                current.push(ch);
            }
            continue;
        }
        if ch == '|' && chars.peek() != Some(&'|') {
            skipping_pipeline = true;
            continue;
        }
        if matches!(ch, ';' | '\n') || (matches!(ch, '&' | '|') && chars.peek() == Some(&ch)) {
            if chars.peek() == Some(&ch) && matches!(ch, '&' | '|') {
                chars.next();
            }
            out.push(std::mem::take(&mut current));
            skipping_pipeline = false;
        } else if !skipping_pipeline {
            current.push(ch);
        }
    }
    out.push(current);
    out
}

fn shell_segments(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for ch in command.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            current.push(ch);
            escaped = true;
            continue;
        }
        if let Some(open) = quote {
            current.push(ch);
            if ch == open {
                quote = None;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
        } else if matches!(ch, ';' | '&' | '|' | '\n') {
            out.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    out.push(current);
    out
}

fn shell_words(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut has = false;
    for ch in segment.chars() {
        if escaped {
            current.push(ch);
            has = true;
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            has = true;
        } else if ch.is_whitespace() || matches!(ch, '(' | ')' | '`') {
            if has {
                out.push(std::mem::take(&mut current));
            }
            has = false;
        } else {
            current.push(ch);
            has = true;
        }
    }
    if escaped {
        current.push('\\');
        has = true;
    }
    if has {
        out.push(current);
    }
    out.retain(|word| {
        let rest = word.trim_start_matches(|ch: char| ch.is_ascii_digit());
        !rest.starts_with('<') && !rest.starts_with('>')
    });
    out
}

// CHECKS, EXEC_WRAPPER and SCRIPT_RUNNER in command-verdict-core.ts.
static CHECK_WRAPPER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:[A-Za-z0-9_]+=\S*|npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|python3?\s+-m|time|env|ompdesk\s+check(?:\s+--(?:full|light|release))*(?:\s+--)?|ompdesk\s+run\s+--heavy(?:\s+--all)?(?:\s+--)?|timeout(?:\s+(?:-[ks]\s*[0-9]+(?:\.[0-9]+)?[smhd]?|-\S+))*\s+[0-9]+(?:\.[0-9]+)?[smhd]?)\s+)+").expect("check wrapper")
});
static CHECK_TOOLS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:vitest|jest|mocha|pytest|rspec|phpunit|ava|playwright\s+test|(?:bun|deno|cargo|go|swift|dotnet|mix|gradle|mvn)\s+test|make\s+test|tsc|mypy|pyright|vue-tsc|svelte-check|cargo\s+check|flow\s+check|biome|eslint|prettier\s+--check|ruff|flake8|pylint|cargo\s+clippy|golangci-lint|stylelint|shellcheck|rubocop|(?:vite|next|electron-vite|cargo|go|swift|dotnet|gradle|mvn|docker)\s+build|webpack|rollup|esbuild|make|cmake\s+--build|xcodebuild)(?-u:\b)|^node\s+\S*lint[A-Za-z0-9_-]*\.m?js(?-u:\b)").expect("check tools")
});
static CHECK_SCRIPT_RUNNER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(\S+)").expect("script runner")
});
static CHECK_SCRIPTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:test(?::[A-Za-z0-9_:-]+)?|check:changed|check:types|typecheck|type-check|types|lint(?::[A-Za-z0-9_:-]+)?|build(?::[A-Za-z0-9_:-]+)?|package:[A-Za-z0-9_]+)$").expect("check scripts")
});
static CI_WATCH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)gh\s+run\s+watch(?-u:\b)|(?-u:\b)watch-run\.ts(?-u:\b)").expect("CI watch")
});

fn check_run(command: &str) -> bool {
    if CI_WATCH.is_match(command) {
        return true;
    }
    for segment in check_segments(&strip_heredocs(command)) {
        let grouped =
            segment.trim_start_matches(|ch: char| ch == '(' || ch == '{' || ch.is_whitespace());
        let normalized = grouped.split_whitespace().collect::<Vec<_>>().join(" ");
        let program = CHECK_WRAPPER.replace(&normalized, "");
        if CHECK_TOOLS.is_match(&program) {
            return true;
        }
        if CHECK_SCRIPT_RUNNER
            .captures(&program)
            .and_then(|captures| captures.get(1))
            .is_some_and(|script| CHECK_SCRIPTS.is_match(script.as_str()))
        {
            return true;
        }
    }
    false
}

// CHECK_SAVED in session-pace.ts.
static CHECK_SAVED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"ompdesk check: ([0-9]{8}-[0-9]{6}-[0-9a-f]{4}): [A-Za-z0-9_]+ in [^\n]*? reuse saved about [^\n(]*\(([0-9]+) s\)").expect("check saved")
});

fn saved_checks(text: &str, saved: &mut HashMap<String, f64>) {
    for captures in CHECK_SAVED.captures_iter(text) {
        if let (Some(id), Some(seconds)) = (
            captures.get(1),
            captures
                .get(2)
                .and_then(|value| value.as_str().parse::<f64>().ok()),
        ) {
            saved.insert(id.as_str().to_owned(), seconds);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_counts_once_and_repeated_looks_count_after_first() {
        let entries = [
            json!({"type":"message","timestamp":0,"message":{"role":"user"}}),
            json!({"type":"message","timestamp":5000,"message":{"role":"assistant","usage":{"output":10},"content":[{"type":"toolCall","id":"a","name":"read","arguments":{"path":"proc://bg_1"}},{"type":"toolCall","id":"b","name":"read","arguments":{"path":"proc://bg_1/streams"}}]}}),
            json!({"type":"custom","timestamp":5000,"customType":"tool_execution_start","data":{"toolCallId":"a"}}),
            json!({"type":"custom","timestamp":5000,"customType":"tool_execution_start","data":{"toolCallId":"b"}}),
            json!({"type":"message","timestamp":15000,"message":{"role":"toolResult","toolName":"read","toolCallId":"a"}}),
            json!({"type":"message","timestamp":15000,"message":{"role":"toolResult","toolName":"read","toolCallId":"b"}}),
        ];
        let lines: Vec<_> = entries.iter().map(Value::to_string).collect();
        let result = calculate(lines.iter().map(String::as_str));
        assert_eq!(result["wallS"], 15.0);
        assert_eq!(result["toolS"], 10.0);
        assert_eq!(result["tools"]["read"]["seconds"], 20.0);
        assert_eq!(result["polls"], 1);
    }

    #[test]
    fn check_reuse_is_counted_once() {
        let mut saved = HashMap::new();
        let line = "ompdesk check: 20261113-021507-ab12: passed in 3s reuse saved about 50s (50 s)";
        saved_checks(line, &mut saved);
        saved_checks(line, &mut saved);
        assert_eq!(saved.values().sum::<f64>(), 50.0);
        assert!(check_run("ompdesk check -- bunx vitest run"));
        assert!(!check_run("git status"));
    }

    #[test]
    fn background_check_includes_only_its_running_part_of_wait() {
        let entries = [
            json!({"type":"message","timestamp":0,"message":{"role":"user"}}),
            json!({"type":"message","timestamp":5000,"message":{"role":"assistant","content":[{"type":"toolCall","id":"a","name":"bash","arguments":{"command":"bun run check:changed --no-e2e","async":true}}]}}),
            json!({"type":"custom","timestamp":5000,"customType":"tool_execution_start","data":{"toolCallId":"a"}}),
            json!({"type":"message","timestamp":6000,"message":{"role":"toolResult","toolName":"bash","toolCallId":"a","details":{"async":{"jobId":"bg_1"}}}}),
            json!({"type":"message","timestamp":15000,"message":{"role":"assistant","content":[{"type":"toolCall","id":"w","name":"wait","arguments":{}}]}}),
            json!({"type":"custom","timestamp":15000,"customType":"tool_execution_start","data":{"toolCallId":"w"}}),
            json!({"type":"message","timestamp":115000,"message":{"role":"toolResult","toolName":"wait","toolCallId":"w","details":{"op":"wait","jobs":[{"id":"bg_1","type":"bash","durationMs":70000,"settledAtMs":75000}]}}}),
        ];
        let lines: Vec<_> = entries.iter().map(Value::to_string).collect();
        let result = calculate(lines.iter().map(String::as_str));
        assert_eq!(result["checks"]["runs"], 1);
        assert_eq!(result["checks"]["seconds"], 61.0);
    }

    // Captured from command-verdict-core.ts and bridge-waste-guards.test.ts.
    #[test]
    fn shell_checks_and_poll_fixtures() {
        for command in [
            "bunx vitest run",
            "cd app && bun run test:platform",
            "cargo test -p core",
            "python -m pytest -q",
            "npx tsc --noEmit",
            "bunx biome check src",
            "(bunx vitest run) && bun run build",
        ] {
            assert!(check_run(command), "{command}");
        }
        for command in [
            "git status",
            "ls tests",
            "grep vitest package.json",
            "echo 'npm test'",
            "cat build.log",
            "cat > check.sh <<'EOF'\ncargo test\nEOF",
            "echo foo | cargo test",
        ] {
            assert!(!check_run(command), "{command}");
        }
        for command in [
            "sleep 5; echo hi",
            "sleep 15 && gh run list --limit 3",
            "while ! curl -s localhost:3000; do sleep 2; done",
            "gh run watch 42 --exit-status",
            "tail -n 20 -f t.log",
        ] {
            let mut polls = Polls::default();
            polls.observe("bash", &json!({"command":command}));
            assert_eq!(polls.count, 1, "{command}");
        }
        for command in [
            "sleep 5",
            "echo start; sleep 5",
            "gh run view 42 --log-failed",
            "cat > poll.sh <<'EOF'\nsleep 5; gh run list; pgrep x\nEOF",
            "cat <<A <<B\nfirst\nA\nsleep 5; echo x\nB",
            "grep -c \"gh run watch\" log.txt",
        ] {
            let mut polls = Polls::default();
            polls.observe("bash", &json!({"command":command}));
            polls.observe("bash", &json!({"command":command}));
            assert_eq!(polls.count, 0, "{command}");
        }
        let mut polls = Polls::default();
        polls.observe("bash", &json!({"command":"gh run view 1 --json status"}));
        polls.observe("bash", &json!({"command":"gh run view 1 --json jobs"}));
        polls.observe("bash", &json!({"command":"gh run watch 1","async":true}));
        assert_eq!(polls.count, 1);
        for (tool, input, expected) in [
            ("bash", json!({"command":"gh run list --limit 3"}), 1),
            ("bash", json!({"command":"gh run list --limit 3"}), 2),
            ("bash", json!({"command":"gh run list --limit 5"}), 2),
            ("bash", json!({"command":"pgrep -f vitest"}), 2),
            ("bash", json!({"command":"pgrep -f vitest"}), 3),
            ("read", json!({"path":"proc://bg_1"}), 3),
            ("read", json!({"path":"proc://bg_1/streams/0"}), 4),
            ("bash", json!({"command":"gh run view 1 --log-failed"}), 4),
            ("bash", json!({"command":"gh run view 1 --log-failed"}), 4),
        ] {
            polls.observe(tool, &input);
            assert_eq!(polls.count, expected, "{input}");
        }
    }

    #[test]
    fn captured_typescript_classifiers_match() {
        let rows: Vec<Value> = serde_json::from_str(include_str!("pace-captured.json")).unwrap();
        for row in rows {
            let command = row["command"].as_str().unwrap();
            assert_eq!(
                check_run(command),
                row["check"].as_bool().unwrap(),
                "command: {command:?}"
            );
            let mut polls = Polls::default();
            let input = json!({ "command": command });
            polls.observe("bash", &input);
            polls.observe("bash", &input);
            assert_eq!(
                polls.count,
                row["polls"].as_u64().unwrap(),
                "command: {command:?}"
            );
            assert_eq!(
                Value::Object(polls.kinds),
                row["kinds"],
                "command: {command:?}"
            );
        }
    }
}
