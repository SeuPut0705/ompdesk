//! Fresh, the pure part (7d; was `namedItems` of `src/main/ai-memory/freshness.ts`): the repository paths and code
//! symbols a page's markdown names. What the page only says it removed, `rm`s in a fence, URLs, `~/` paths and globs
//! name nothing. Every regular expression of the TypeScript is translated by hand (the crate has no regex engine);
//! each function names the expression it stands for. `\w`, `\b` and `\d` are ASCII as in a JavaScript regular
//! expression without the `u` flag, `\s` and `trim` are JavaScript's whitespace, and `i` folds ASCII letters only
//! (a non-ASCII character whose upper case is ASCII, such as U+017F, never equals the ASCII letter).
//! The checkout side (`git.freshness*`) is `crate::git::freshness`, which `check_freshness` calls in process with the
//! git runner main handed over; then the check itself (`check_freshness`).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::engine::Writer;
use super::{Ctx, is_cancelled};
use crate::aimemory::ops::{PageAt, ProjectRef, RetireInput};
use crate::fs::order::{is_js_space, js_trim};
use crate::git::freshness::{self as git_freshness, Named, State};
use crate::git::run::Git;
use crate::run::Runner;
use crate::server::{Fault, Scope};
use crate::upkeep::store::Retired;

/// Paths a page may name that are checked.
pub const MAX_PATHS: usize = 30;
/// Symbols a page may name that are checked.
pub const MAX_SYMBOLS: usize = 12;
/// Top-level directories that count as repo paths even when the ref no longer has them (a deleted top-level dir).
pub const BASE_ROOTS: [&str; 10] = [
    "src",
    "resources",
    "scripts",
    "e2e",
    "native",
    "docs",
    "build",
    "tests",
    "test",
    "packages",
];

const BRAND_WORDS: [&str; 8] = [
    "GitHub",
    "TypeScript",
    "JavaScript",
    "OpenAI",
    "VSCode",
    "MacBook",
    "iPhone",
    "GitLab",
];

/// `REMOVAL_WORDS`'s English alternatives, each between `\b`s, case-insensitive. `deletes?` is two entries.
const REMOVAL_ENGLISH: [&str; 13] = [
    "removed",
    "deleted",
    "delete",
    "deletes",
    "dropped",
    "no longer",
    "gone",
    "retired",
    "replaced",
    "obsolete",
    "deprecated",
    "renamed",
    "moved",
];

/// `REMOVAL_WORDS`'s alternatives without `\b`.
const REMOVAL_KOREAN: [&str; 9] = [
    "삭제",
    "제거",
    "없앴",
    "없어",
    "사라",
    "대체",
    "폐기",
    "이동",
    "이름을 바꿨",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NamedItems {
    pub paths: Vec<String>,
    pub symbols: Vec<String>,
}

/// `\w`.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `[\w.@+-]`, the characters before a `/` in a word that holds one.
fn is_slash_word_head(c: char) -> bool {
    is_word(c) || matches!(c, '.' | '@' | '+' | '-')
}

/// What may not precede a path: `[\w~./@:<{$*-]`.
fn blocks_path(c: char) -> bool {
    is_word(c) || matches!(c, '~' | '.' | '/' | '@' | ':' | '<' | '{' | '$' | '*' | '-')
}

/// `markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")`: the front matter, up to the first line that is `---`
/// and is itself followed by a line break.
fn without_front_matter(markdown: &str) -> &str {
    let Some(rest) = markdown.strip_prefix("---") else {
        return markdown;
    };
    let opened = if rest.starts_with("\r\n") {
        2
    } else if rest.starts_with('\n') {
        1
    } else {
        return markdown;
    };
    let from = 3 + opened;
    let bytes = markdown.as_bytes();
    for at in from..markdown.len() {
        if bytes[at] != b'\r' && bytes[at] != b'\n' {
            continue;
        }
        let tail = &markdown[at..];
        let break_len = if tail.starts_with("\r\n") {
            2
        } else if tail.starts_with('\n') {
            1
        } else {
            continue;
        };
        let Some(after_dashes) = tail[break_len..].strip_prefix("---") else {
            continue;
        };
        let closed = if after_dashes.starts_with("\r\n") {
            2
        } else if after_dashes.starts_with('\n') {
            1
        } else {
            continue;
        };
        return &markdown[at + break_len + 3 + closed..];
    }
    markdown
}

/// `body.split(/\r?\n/)`: a lone `\r` stays in its line.
fn split_lines(body: &str) -> impl Iterator<Item = &str> {
    let mut parts = body.split('\n').peekable();
    std::iter::from_fn(move || {
        let part = parts.next()?;
        // Every part but the last was ended by a newline, and one `\r` before it went with it.
        Some(if parts.peek().is_some() {
            part.strip_suffix('\r').unwrap_or(part)
        } else {
            part
        })
    })
}

/// `/^\s*(```|~~~)/.exec(line)?.[1]`.
fn fence_marker(line: &str) -> Option<&'static str> {
    let rest = line.trim_start_matches(is_js_space);
    if rest.starts_with("```") {
        Some("```")
    } else if rest.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

/// `line.replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")`.
fn without_urls(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if let Some(end) = url_end(&chars, i) {
            out.push(' ');
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Where a URL starting at `start` ends: a scheme at a word boundary, `://` and at least one non-space character.
fn url_end(chars: &[char], start: usize) -> Option<usize> {
    if !chars[start].is_ascii_alphabetic() || (start > 0 && is_word(chars[start - 1])) {
        return None;
    }
    let mut at = start + 1;
    while at < chars.len()
        && (chars[at].is_ascii_alphanumeric() || matches!(chars[at], '+' | '.' | '-'))
    {
        at += 1;
    }
    if !(chars.get(at) == Some(&':')
        && chars.get(at + 1) == Some(&'/')
        && chars.get(at + 2) == Some(&'/'))
    {
        return None;
    }
    let mut end = at + 3;
    while end < chars.len() && !is_js_space(chars[end]) {
        end += 1;
    }
    (end > at + 3).then_some(end)
}

/// `line.replaceAll(/`[^`]*`/g, " ").replaceAll(/[\w.@+-]*\/[\w./@+-]*/g, " ")`: the line without its code spans and
/// without the words that hold a slash, what is left being prose.
fn prose_of(line: &str) -> String {
    let mut spanless = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('`') {
        let Some(close) = rest[open + 1..].find('`') else {
            break;
        };
        spanless.push_str(&rest[..open]);
        spanless.push(' ');
        rest = &rest[open + 1 + close + 1..];
    }
    spanless.push_str(rest);

    let chars: Vec<char> = spanless.chars().collect();
    let mut out = String::with_capacity(spanless.len());
    let mut i = 0;
    while i < chars.len() {
        let mut head_end = i;
        while head_end < chars.len() && is_slash_word_head(chars[head_end]) {
            head_end += 1;
        }
        if chars.get(head_end) == Some(&'/') {
            let mut end = head_end + 1;
            while end < chars.len() && (is_slash_word_head(chars[end]) || chars[end] == '/') {
                end += 1;
            }
            out.push(' ');
            i = end;
        } else {
            // Every start inside the run ends at the same character, so none of them matches either.
            let stop = (head_end + 1).min(chars.len());
            out.extend(&chars[i..stop]);
            i = stop;
        }
    }
    out
}

/// `text.toLowerCase` for ASCII only: the characters equal ignoring ASCII case.
fn equals_ascii_folded(chars: &[char], word: &str) -> bool {
    let mut at = chars.iter();
    word.chars()
        .all(|expected| at.next().is_some_and(|c| c.eq_ignore_ascii_case(&expected)))
}

/// `REMOVAL_WORDS.test(prose)`:
/// `/\b(removed|deleted|deletes?|dropped|no longer|gone|retired|replaced|obsolete|deprecated|renamed|moved)\b|삭제|제거|없앴|없어|사라|대체|폐기|이동|이름을 바꿨/i`.
fn says_removal(prose: &str) -> bool {
    if REMOVAL_KOREAN.iter().any(|word| prose.contains(word)) {
        return true;
    }
    let chars: Vec<char> = prose.chars().collect();
    (0..chars.len()).any(|start| {
        chars[start].is_ascii_alphabetic()
            && (start == 0 || !is_word(chars[start - 1]))
            && REMOVAL_ENGLISH.iter().any(|word| {
                let end = start + word.len();
                end <= chars.len()
                    && equals_ascii_folded(&chars[start..end], word)
                    && chars.get(end).is_none_or(|c| !is_word(*c))
            })
    })
}

/// A word end: `\b` after a word character.
fn word_ends(rest: &str) -> bool {
    rest.chars().next().is_none_or(|c| !is_word(c))
}

/// `/^(?:\$\s*)?(?:git\s+(?:rm|mv)|rm|mv|rmdir|mkdir|touch)\b/.test(line)`.
fn is_shell_removal(line: &str) -> bool {
    let line = match line.strip_prefix('$') {
        Some(rest) => rest.trim_start_matches(is_js_space),
        None => line,
    };
    if let Some(rest) = line.strip_prefix("git") {
        let command = rest.trim_start_matches(is_js_space);
        if command.len() < rest.len() {
            for word in ["rm", "mv"] {
                if command.strip_prefix(word).is_some_and(word_ends) {
                    return true;
                }
            }
        }
    }
    ["rm", "mv", "rmdir", "mkdir", "touch"]
        .into_iter()
        .any(|word| line.strip_prefix(word).is_some_and(word_ends))
}

/// The end of `ROOT/[\w.@+\-/]*\w` starting at `at`, for the first root (in order) that fits.
fn path_end(line: &str, at: usize, roots: &[&str]) -> Option<usize> {
    for root in roots {
        let Some(after_root) = line[at..].strip_prefix(root) else {
            continue;
        };
        if !after_root.starts_with('/') {
            continue;
        }
        let tail_start = at + root.len() + 1;
        let mut end = None;
        for (offset, c) in line[tail_start..].char_indices() {
            if !(is_slash_word_head(c) || c == '/') {
                break;
            }
            if is_word(c) {
                end = Some(tail_start + offset + c.len_utf8());
            }
        }
        if end.is_some() {
            return end;
        }
    }
    None
}

/// The whole match and the path's span (`(?:\.\/)?((?:ROOTS)\/[\w.@+\-\/]*\w)`) starting at `start`, after the
/// lookbehind `(?<![\w~.\/@:<{$*-])`.
fn path_at(line: &str, start: usize, roots: &[&str]) -> Option<(usize, usize, usize)> {
    if line[..start].chars().next_back().is_some_and(blocks_path) {
        return None;
    }
    if line[start..].starts_with("./")
        && let Some(end) = path_end(line, start + 2, roots)
    {
        return Some((start + 2, end, end));
    }
    path_end(line, start, roots).map(|end| (start, end, end))
}

/// The extension rule: `/\.[A-Za-z][A-Za-z0-9]{0,7}$/`.
fn has_extension(path: &str) -> bool {
    let Some(dot) = path.rfind('.') else {
        return false;
    };
    let ext = &path[dot + 1..];
    let mut chars = ext.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && ext.len() <= 8
        && chars.all(|c| c.is_ascii_alphanumeric())
}

/// `/\.\w+$/`.
fn ends_with_dot_word(path: &str) -> bool {
    path.rfind('.').is_some_and(|dot| {
        let ext = &path[dot + 1..];
        !ext.is_empty() && ext.chars().all(is_word)
    })
}

/// `looksLikeSymbol`: an identifier of 6 to 60 characters that is camelCase or snake_case, not a brand name.
fn looks_like_symbol(token: &str) -> bool {
    let units = token.encode_utf16().count();
    if !(6..=60).contains(&units) || BRAND_WORDS.contains(&token) {
        return false;
    }
    let mut chars = token.chars();
    let identifier = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| is_word(c) || c == '$');
    if !identifier {
        return false;
    }
    let bytes = token.as_bytes();
    let camel = bytes
        .windows(2)
        .any(|pair| pair[0].is_ascii_lowercase() && pair[1].is_ascii_uppercase());
    camel || {
        let parts: Vec<&str> = token.split('_').collect();
        parts.len() >= 2
            && parts.iter().all(|part| {
                !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
    }
}

/// The spans of ``/`([^`\n]{2,80})`/g``: a backtick, 2 to 80 UTF-16 units that are neither a backtick nor a newline,
/// a backtick. A start that fails lets the next backtick start a span of its own.
fn code_spans(line: &str) -> Vec<&str> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(found) = line[from..].find('`') {
        let open = from + found;
        let inner = open + 1;
        let closed = line[inner..]
            .find(['`', '\n'])
            .map(|at| inner + at)
            .filter(|at| line.as_bytes()[*at] == b'`');
        match closed {
            Some(close) if (2..=80).contains(&line[inner..close].encode_utf16().count()) => {
                spans.push(&line[inner..close]);
                from = close + 1;
            }
            _ => from = open + 1,
        }
    }
    spans
}

/// An insertion-ordered set of strings: a JavaScript `Set` of text.
#[derive(Default)]
struct Ordered {
    seen: HashSet<String>,
    items: Vec<String>,
}

impl Ordered {
    fn add(&mut self, item: &str) {
        if self.seen.insert(item.to_owned()) {
            self.items.push(item.to_owned());
        }
    }
}

/// The repo paths and code symbols a page's markdown names; what the page only says it removed, or runs `rm` on, is
/// not named. `roots` are the top-level folders of the checkout's ref, added to `BASE_ROOTS` (in that order, without
/// repeats).
pub fn named_items<S: AsRef<str>>(markdown: &str, roots: &[S]) -> NamedItems {
    let body = without_front_matter(markdown);
    let mut all: Vec<&str> = Vec::new();
    for root in BASE_ROOTS
        .iter()
        .copied()
        .chain(roots.iter().map(AsRef::as_ref))
    {
        if !all.contains(&root) {
            all.push(root);
        }
    }
    let mut paths = Ordered::default();
    let mut symbols = Ordered::default();
    let mut fence: Option<&str> = None;
    for raw in split_lines(body) {
        if let Some(marker) = fence_marker(raw) {
            fence = match fence {
                None => Some(marker),
                Some(open) if open == marker => None,
                other => other,
            };
            continue;
        }
        let line = without_urls(raw);
        if says_removal(&prose_of(&line)) || (fence.is_some() && is_shell_removal(js_trim(&line))) {
            continue;
        }
        let mut start = 0;
        while start <= line.len() {
            let Some((path_start, path_end, match_end)) = path_at(&line, start, &all) else {
                start += line[start..].chars().next().map_or(1, char::len_utf8);
                continue;
            };
            let path = &line[path_start..path_end];
            let after = line[match_end..].chars().next();
            let blocked = after.is_some_and(|c| matches!(c, '*' | '<' | '{' | '$' | '['))
                || (after == Some('/') && !ends_with_dot_word(path));
            if !blocked && has_extension(path) && !path.contains("..") {
                paths.add(path);
            }
            start = match_end;
        }
        if fence.is_some() {
            continue;
        }
        for span in code_spans(&line) {
            let token = js_trim(span);
            let token = token.strip_suffix("()").unwrap_or(token);
            if looks_like_symbol(token) {
                symbols.add(token);
            }
        }
    }
    paths.items.truncate(MAX_PATHS);
    symbols.items.truncate(MAX_SYMBOLS);
    NamedItems {
        paths: paths.items,
        symbols: symbols.items,
    }
}

pub const FRESHNESS_KINDS: [&str; 3] = ["decision", "gotcha", "procedure"];
const DEFAULT_MAX_PAGES: usize = 100;
const DEFAULT_MAX_CHANGES: usize = 10;
const SESSION_WINDOW: u64 = 50;
/// Each git's timeout.
const GIT_TIMEOUT_MS: u64 = 20_000;

/// What a check is asked.
#[derive(Default)]
pub struct Options {
    /// Report what would change; write and log nothing.
    pub dry_run: bool,
    pub max_pages: Option<usize>,
    pub max_changes: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct Change {
    pub path: String,
    pub kind: String,
    /// `retire` or `flag`.
    pub action: &'static str,
    /// The names that are gone (deleted or moved).
    pub names: Vec<String>,
    pub pinned: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub dry_run: bool,
    /// The main checkout the names were looked up in; none when no session's folder is a live checkout.
    pub checkout: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub pages: usize,
    pub checked: usize,
    pub retired: Vec<Change>,
    pub flagged: Vec<Change>,
    pub errors: usize,
}

/// `git.freshnessCheckout`'s answer.
#[derive(Deserialize)]
struct CheckoutFacts {
    checkout: String,
    #[serde(rename = "ref")]
    reference: String,
    roots: Vec<String>,
}

/// `git.freshnessVerdict`'s answer.
#[derive(Deserialize)]
struct Verdict {
    action: String,
    gone: Vec<String>,
    state: Value,
}

/// A runner is main's rules for one process; each git of the check is run with its own copy.
fn copy_of(runner: &Runner) -> Runner {
    Runner {
        bin: runner.bin.clone(),
        args: runner.args.clone(),
        env: runner.env.clone(),
        timeout_ms: runner.timeout_ms,
        max_bytes: runner.max_bytes,
    }
}

fn log_details(project: &ProjectRef, change: &Change) -> Value {
    json!({
        "action": change.action,
        "kind": change.kind,
        "workspace": project.workspace,
        "project": project.project,
        "path": change.path,
        "names": change.names.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
        "pinned": change.pinned,
    })
}

/// Decisions, gotchas and procedures that name repo files or code symbols the repo no longer has. The page is checked
/// against the project's main checkout (resolved from its sessions' folders, the default branch read with read-only
/// git, never the working tree, never a fetch): `git.freshnessCheckout` finds the checkout, its ref and the ref's
/// top-level folders, and `git.freshnessVerdict` judges one page; each verdict answers the check's state, which is
/// handed unread to the next page's verdict, so a name is asked once per check and the pickaxe budget is the check's.
/// A page whose names are all deleted (no moved, no existing, no never-seen path) is retired through the restorable
/// `retirePage`; a page with some deleted or moved names is flagged `stale` once per page version; the rest stays. A
/// pinned page is the owner's: flagged at most. `flagged` (`workspace/project/path` to the page id flagged) is kept by
/// the caller between runs. A runner that is none (git is not installed) is git not knowing: no checkout, nothing
/// checked.
pub async fn check_freshness(
    ctx: &Ctx,
    writer: &Writer<'_>,
    project: &ProjectRef,
    git: Option<&Runner>,
    scope: &Scope,
    flagged: &mut Map<String, Value>,
    options: &Options,
) -> Result<Report, Fault> {
    let max_pages = options.max_pages.unwrap_or(DEFAULT_MAX_PAGES);
    let max_changes = options.max_changes.unwrap_or(DEFAULT_MAX_CHANGES);
    let mut report = Report {
        dry_run: options.dry_run,
        checkout: None,
        reference: None,
        pages: 0,
        checked: 0,
        retired: Vec::new(),
        flagged: Vec::new(),
        errors: 0,
    };
    let sessions = ctx
        .store
        .sessions(project, Some(SESSION_WINDOW), None)
        .await?;
    let cwds: Vec<String> = sessions.iter().map(|session| session.cwd.clone()).collect();
    let Some(runner) = git else {
        return Ok(report);
    };
    let git = || Git::new(copy_of(runner), scope.clone());
    // A git that fails is git not knowing: no checkout, nothing checked.
    let Some(facts) = git_freshness::checkout(&git(), &cwds, GIT_TIMEOUT_MS)
        .await
        .and_then(|checkout| serde_json::from_value::<CheckoutFacts>(json!(checkout)).ok())
    else {
        return Ok(report);
    };
    report.checkout = Some(facts.checkout.clone());
    report.reference = Some(facts.reference.clone());
    let candidates: Vec<_> = ctx
        .store
        .pages(project)
        .await?
        .into_iter()
        .filter(|page| FRESHNESS_KINDS.contains(&page.kind.as_deref().unwrap_or("")))
        .collect();
    report.pages = candidates.len();
    let mut state: Option<Value> = None;
    for candidate in candidates.iter().take(max_pages) {
        if report.retired.len() + report.flagged.len() >= max_changes {
            break;
        }
        let outcome = async {
            let at = PageAt {
                project: project.clone(),
                path: candidate.path.clone(),
            };
            let page = ctx.store.page(&at).await?;
            report.checked += 1;
            let items = super::freshness::named_items(&page.markdown, &facts.roots);
            let named: Named = serde_json::from_value(json!({
                "paths": items.paths,
                "symbols": items.symbols,
            }))
            .map_err(|error| Fault::new("internal", error.to_string()))?;
            let before = state
                .as_ref()
                .and_then(|state| serde_json::from_value::<State>(state.clone()).ok());
            let judged = git_freshness::verdict(
                &git(),
                &facts.checkout,
                &facts.reference,
                &named,
                before,
                GIT_TIMEOUT_MS,
            )
            .await;
            let verdict: Verdict = serde_json::from_value(json!(judged))
                .map_err(|error| Fault::new("internal", error.to_string()))?;
            state = Some(verdict.state);
            if verdict.action == "leave" {
                return Ok::<_, Fault>(());
            }
            let action = if verdict.action == "retire" {
                "retire"
            } else {
                "flag"
            };
            let change = Change {
                path: page.path.clone(),
                kind: candidate.kind.clone().unwrap_or_default(),
                action,
                names: verdict.gone.clone(),
                pinned: page.pinned,
            };
            if action == "retire" && !page.pinned {
                if options.dry_run {
                    report.retired.push(change);
                    return Ok(());
                }
                let reason = format!(
                    "names {} which no longer exist",
                    verdict
                        .gone
                        .iter()
                        .take(3)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                let input = RetireInput {
                    when: ctx.clock.iso(),
                    expected_page_id: Some(page.id.clone()),
                    successor: None,
                    reason: Some(reason),
                };
                match writer.retire_page(&at, &input).await? {
                    Retired::Retired => {
                        ctx.log("care-fresh", log_details(project, &change));
                        report.retired.push(change);
                        return Ok(());
                    }
                    Retired::Changed => return Ok(()),
                    Retired::Pinned => {}
                }
            }
            let change = Change {
                action: "flag",
                ..change
            };
            let key = format!("{}/{}/{}", project.workspace, project.project, page.path);
            if flagged.get(&key).and_then(Value::as_str) == Some(page.id.as_str()) {
                return Ok(());
            }
            let details = log_details(project, &change);
            // Counted before it is written: a refused write still shows in the report.
            report.flagged.push(change);
            if options.dry_run {
                return Ok(());
            }
            writer.feedback(&at, "stale").await?;
            flagged.insert(key, json!(page.id));
            ctx.log("care-fresh", details);
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => {}
            Err(fault) if is_cancelled(&fault) => return Err(fault),
            Err(_) => report.errors += 1,
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn named_items_match_the_captured_rows() {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("freshness-captured.json")).unwrap();
        assert_eq!(rows.len(), 244);
        for row in &rows {
            let markdown = row["markdown"].as_str().unwrap();
            let roots = row.get("roots").map(strings).unwrap_or_default();
            let got = named_items(markdown, &roots);
            assert_eq!(
                got.paths,
                strings(&row["paths"]),
                "paths of {markdown:?} with {roots:?}"
            );
            assert_eq!(
                got.symbols,
                strings(&row["symbols"]),
                "symbols of {markdown:?} with {roots:?}"
            );
        }
    }

    #[test]
    fn the_default_roots_are_the_base_roots() {
        let none: [&str; 0] = [];
        let items = named_items("src/a.ts and lib/b.ts", &none);
        assert_eq!(items.paths, ["src/a.ts"]);
    }
}
