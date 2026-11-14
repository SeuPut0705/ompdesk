//! Reads the test reports that CI jobs upload, so the ledger can learn each test's outcome and duration.
//!
//! Three on-disk shapes cover every runner in the repository: the Jest-compatible JSON that Vitest's `json`
//! reporter and Jest's `--json` write, Playwright's `json` reporter, and JUnit XML (Vitest's and Playwright's
//! `junit` reporters, cargo-nextest and most other tools). `parse` sniffs which one it was given, so callers
//! never need to know which job produced a file.
//!
//! Every format is turned into the same `Case`: one test of one report with one `Attempt` per run, so a retry
//! that passed is visible as a flaky test instead of being averaged away.

use std::collections::HashMap;

use serde_json::Value;

pub use crate::checks::contract::Outcome;

/// How long a first error line may be. A trend row only shows the headline, never the whole stack.
const MAX_ERROR_CHARS: usize = 300;

/// A JUnit file nested deeper than this is no real report; reading stops there and keeps what it has.
const MAX_XML_DEPTH: usize = 128;

/// Source extensions that make a JUnit `classname` read as a file path rather than a Java-style class name.
const SOURCE_EXTENSIONS: &[&str] = &[
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".rs", ".py", ".go", ".java",
    ".kt", ".rb", ".cs", ".swift", ".php", ".c", ".cc", ".cpp", ".h", ".hpp",
];

/// One run of a test inside a report.
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub outcome: Outcome,
    pub ms: u64,
}

/// One test of one report.
#[derive(Clone, Debug, PartialEq)]
pub struct Case {
    /// "vitest", "jest", "playwright" or "junit".
    pub runner: String,
    /// Playwright's project name; empty where the format has none.
    pub project: String,
    /// Relative to the repository root, with `/` separators.
    pub file: String,
    /// Describe blocks, then the test's own title.
    pub titles: Vec<String>,
    /// In the order they ran; never empty.
    pub attempts: Vec<Attempt>,
    /// First non-empty line of the first failed attempt's message, ANSI escapes removed, at most 300 characters;
    /// empty when nothing failed.
    pub first_error: String,
}

impl Case {
    /// `[project] file › title › title`. The project prefix is left out when there is none, and the file stands
    /// alone when the test has no titles (a file that failed to load). A report that names no file reads as
    /// just its titles. This matches `display_name` in the checks crate so a trend row and a run record agree.
    pub fn name(&self) -> String {
        if self.titles.is_empty() {
            return self.file.clone();
        }
        let titles = self.titles.join(" › ");
        if self.file.is_empty() {
            return titles;
        }
        if self.project.is_empty() {
            format!("{} › {titles}", self.file)
        } else {
            format!("[{}] {} › {titles}", self.project, self.file)
        }
    }

    /// The last attempt's outcome, because that is what the run as a whole ended with.
    pub fn outcome(&self) -> Outcome {
        self.attempts.last().map_or(Outcome::Skip, |a| a.outcome)
    }

    /// The last attempt's duration.
    pub fn ms(&self) -> u64 {
        self.attempts.last().map_or(0, |a| a.ms)
    }

    /// Both a passing and a failing attempt in this report, that is, a retry that passed.
    pub fn flaky(&self) -> bool {
        let any = |o| self.attempts.iter().any(|a| a.outcome == o);
        any(Outcome::Pass) && any(Outcome::Fail)
    }
}

/// Reads one report file whatever its format. `repo` is the repository's name ("ompdesk" of
/// "SeuPut0705/ompdesk"), used to turn the runner's absolute paths into repository-relative ones.
pub fn parse(bytes: &[u8], repo: &str) -> Result<Vec<Case>, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_start();
    match text.as_bytes().first() {
        None => Err("the report is empty".into()),
        Some(b'<') => parse_junit(text, repo),
        Some(b'{') => {
            let root: Value = serde_json::from_str(text)
                .map_err(|e| format!("the report is not valid JSON: {e}"))?;
            if root.get("testResults").is_some() {
                parse_jest_json(&root, repo)
            } else if root.get("suites").is_some() && root.get("config").is_some() {
                parse_playwright_json(&root, repo)
            } else {
                Err("the JSON is neither a Jest/Vitest report (testResults) nor a Playwright one (suites and config)".into())
            }
        }
        Some(_) => Err("the report is neither XML nor a JSON object".into()),
    }
}

/// A case while it is still being read. It keeps each attempt's raw error so the headline can come from the
/// first failure that actually has one, and so repeated JUnit testcases can be folded in before that choice.
struct Draft {
    runner: &'static str,
    project: String,
    file: String,
    titles: Vec<String>,
    attempts: Vec<Attempt>,
    errors: Vec<String>,
}

impl Draft {
    fn new(runner: &'static str, project: &str, file: String, titles: Vec<String>) -> Self {
        Draft {
            runner,
            project: project.to_string(),
            file,
            titles,
            attempts: Vec::new(),
            errors: Vec::new(),
        }
    }

    fn attempt(&mut self, outcome: Outcome, ms: u64, error: &str) {
        self.attempts.push(Attempt { outcome, ms });
        self.errors.push(error.to_string());
    }

    fn finish(mut self) -> Case {
        if self.attempts.is_empty() {
            self.attempt(Outcome::Skip, 0, "");
        }
        let first_error = self
            .attempts
            .iter()
            .zip(&self.errors)
            .filter(|(a, _)| a.outcome == Outcome::Fail)
            .map(|(_, e)| headline(e))
            .find(|h| !h.is_empty())
            .unwrap_or_default();
        Case {
            runner: self.runner.to_string(),
            project: self.project,
            file: self.file,
            titles: self.titles,
            attempts: self.attempts,
            first_error,
        }
    }
}

/// GitHub's workspace is `<work>/<repo>/<repo>` on hosted Linux, macOS and Windows runners, so the last such
/// marker splits the runner's own prefix from the path inside the repository. A path without it (already
/// relative, or from a local run) is kept as it is apart from a leading `./`.
fn relative_path(path: &str, repo: &str) -> String {
    let path = path.replace('\\', "/");
    if !repo.is_empty() {
        let marker = format!("/{repo}/{repo}/");
        if let Some(at) = path.rfind(&marker) {
            return path[at + marker.len()..].to_string();
        }
    }
    path.strip_prefix("./").unwrap_or(&path).to_string()
}

/// Removes terminal colour and cursor sequences so an error line can be stored and compared as plain text.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// The first non-empty line of an error message, without colour codes, cut to `MAX_ERROR_CHARS`.
pub(crate) fn headline(message: &str) -> String {
    strip_ansi(message)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(MAX_ERROR_CHARS).collect())
        .unwrap_or_default()
}

/// A duration the reporter wrote as fractional milliseconds, or nothing. Negative, non-finite and missing
/// values count as 0 because a trend needs a number, not a reason.
fn whole_ms(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite() && *f > 0.0)
        .map_or(0, |f| f.round() as u64)
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn array_of<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

// ── Jest-compatible JSON (Vitest `json` reporter, Jest `--json`) ─────────────────────────────────────────────

/// Vitest 3.2.7 writes `testResults[]` with the file's absolute path as `name`, and `assertionResults[]` whose
/// `ancestorTitles` hold only describe names (a top-level test has none). Jest writes the same fields. The one
/// thing only Jest writes at the top is `wasInterrupted` (and `openHandles`), so that decides the runner name.
fn parse_jest_json(root: &Value, repo: &str) -> Result<Vec<Case>, String> {
    let runner = if root.get("wasInterrupted").is_some() || root.get("openHandles").is_some() {
        "jest"
    } else {
        "vitest"
    };
    let files = root
        .get("testResults")
        .and_then(Value::as_array)
        .ok_or("testResults is not an array")?;
    let mut cases = Vec::new();
    for file_result in files.iter().filter(|f| f.is_object()) {
        let file = relative_path(str_of(file_result, "name"), repo);
        let assertions = array_of(file_result, "assertionResults");
        if assertions.is_empty() {
            // A file that failed to load has a status and a message but no tests; it still has to count as a failure.
            if str_of(file_result, "status") == "failed" {
                let mut draft = Draft::new(runner, "", file, Vec::new());
                draft.attempt(Outcome::Fail, 0, str_of(file_result, "message"));
                cases.push(draft.finish());
            }
            continue;
        }
        for assertion in assertions.iter().filter(|a| a.is_object()) {
            let mut titles: Vec<String> = array_of(assertion, "ancestorTitles")
                .iter()
                .filter_map(Value::as_str)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect();
            let title = str_of(assertion, "title");
            if !title.is_empty() {
                titles.push(title.to_string());
            } else if titles.is_empty() {
                titles.push(str_of(assertion, "fullName").to_string());
            }
            let outcome = match str_of(assertion, "status") {
                "passed" => Outcome::Pass,
                "failed" => Outcome::Fail,
                _ => Outcome::Skip,
            };
            let error = array_of(assertion, "failureMessages")
                .iter()
                .filter_map(Value::as_str)
                .find(|m| !headline(m).is_empty())
                .unwrap_or("");
            let mut draft = Draft::new(runner, "", file.clone(), titles);
            draft.attempt(outcome, whole_ms(assertion.get("duration")), error);
            cases.push(draft.finish());
        }
    }
    Ok(cases)
}

// ── Playwright JSON ───────────────────────────────────────────────────────────────────────────────────────

/// Playwright 1.63.0 writes file suites at the top (their `title` is the file), describe suites below them,
/// and `specs[]` with one `tests[]` entry per project. Paths are relative to `config.rootDir`, so they are
/// joined to it before the root rule runs.
fn parse_playwright_json(root: &Value, repo: &str) -> Result<Vec<Case>, String> {
    let suites = root
        .get("suites")
        .and_then(Value::as_array)
        .ok_or("suites is not an array")?;
    let mut reader = PlaywrightReader {
        root_dir: root
            .get("config")
            .map_or("", |c| str_of(c, "rootDir"))
            .replace('\\', "/"),
        repo,
        cases: Vec::new(),
    };
    for file_suite in suites.iter().filter(|s| s.is_object()) {
        reader.suite(file_suite, "", &mut Vec::new(), true);
    }
    Ok(reader.cases)
}

struct PlaywrightReader<'a> {
    root_dir: String,
    repo: &'a str,
    cases: Vec<Case>,
}

impl PlaywrightReader<'_> {
    fn path(&self, file: &str) -> String {
        let file = file.replace('\\', "/");
        let absolute = file.starts_with('/') || file.as_bytes().get(1) == Some(&b':');
        if self.root_dir.is_empty() || absolute {
            relative_path(&file, self.repo)
        } else {
            relative_path(
                &format!("{}/{file}", self.root_dir.trim_end_matches('/')),
                self.repo,
            )
        }
    }

    fn suite(
        &mut self,
        suite: &Value,
        inherited_file: &str,
        titles: &mut Vec<String>,
        is_file_suite: bool,
    ) {
        let file = match str_of(suite, "file") {
            "" => inherited_file,
            own => own,
        };
        let title = str_of(suite, "title");
        let pushed = !is_file_suite && !title.is_empty();
        if pushed {
            titles.push(title.to_string());
        }
        for spec in array_of(suite, "specs").iter().filter(|s| s.is_object()) {
            let spec_file = match str_of(spec, "file") {
                "" => file,
                own => own,
            };
            let path = self.path(spec_file);
            let mut spec_titles = titles.clone();
            spec_titles.push(str_of(spec, "title").to_string());
            for test in array_of(spec, "tests").iter().filter(|t| t.is_object()) {
                let mut draft = Draft::new(
                    "playwright",
                    str_of(test, "projectName"),
                    path.clone(),
                    spec_titles.clone(),
                );
                for result in array_of(test, "results") {
                    let outcome = match str_of(result, "status") {
                        "passed" => Outcome::Pass,
                        "failed" | "timedOut" | "interrupted" => Outcome::Fail,
                        _ => Outcome::Skip,
                    };
                    draft.attempt(
                        outcome,
                        whole_ms(result.get("duration")),
                        &playwright_error(result),
                    );
                }
                self.cases.push(draft.finish());
            }
        }
        for child in array_of(suite, "suites").iter().filter(|s| s.is_object()) {
            self.suite(child, file, titles, false);
        }
        if pushed {
            titles.pop();
        }
    }
}

/// `error.message` is the single-error form; `errors[]` carries every one. The first with text is enough.
fn playwright_error(result: &Value) -> String {
    let single = result.get("error").map_or("", |e| str_of(e, "message"));
    if !headline(single).is_empty() {
        return single.to_string();
    }
    array_of(result, "errors")
        .iter()
        .map(|e| str_of(e, "message"))
        .find(|m| !headline(m).is_empty())
        .unwrap_or("")
        .to_string()
}

// ── JUnit XML ─────────────────────────────────────────────────────────────────────────────────────────────

struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn attr(&self, key: &str) -> &str {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map_or("", |(_, v)| v.as_str())
    }
}

/// Resolves `&lt; &gt; &amp; &quot; &apos; &#N; &#xN;`. Anything else that merely looks like a reference stays
/// as written, because a test title may legitimately contain an ampersand.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest[1..]
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| entity(&rest[1..1 + end]).map(|c| (c, end + 2)));
        match decoded {
            Some((c, used)) => {
                out.push(c);
                rest = &rest[used..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity(name: &str) -> Option<char> {
    match name {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "amp" => Some('&'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => {
            let digits = name.strip_prefix('#')?;
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// Reads one start tag at the beginning of `rest` (which starts with `<`). Returns the node, whether it closed
/// itself, and how many bytes it used. `None` means the input ended inside the tag.
fn read_start_tag(rest: &str) -> Option<(Node, bool, usize)> {
    let b = rest.as_bytes();
    let mut j = 1;
    while j < b.len() && !b[j].is_ascii_whitespace() && b[j] != b'/' && b[j] != b'>' {
        j += 1;
    }
    let mut node = Node {
        name: rest[1..j].to_string(),
        attrs: Vec::new(),
        text: String::new(),
        children: Vec::new(),
    };
    let skip_space = |j: &mut usize| {
        while *j < b.len() && b[*j].is_ascii_whitespace() {
            *j += 1;
        }
    };
    loop {
        skip_space(&mut j);
        match *b.get(j)? {
            b'>' => return Some((node, false, j + 1)),
            b'/' => {
                if b.get(j + 1) == Some(&b'>') {
                    return Some((node, true, j + 2));
                }
                j += 1;
                continue;
            }
            _ => {}
        }
        let start = j;
        while j < b.len() && !b[j].is_ascii_whitespace() && !matches!(b[j], b'=' | b'/' | b'>') {
            j += 1;
        }
        let key = rest[start..j].to_string();
        skip_space(&mut j);
        let mut value = String::new();
        if b.get(j) == Some(&b'=') {
            j += 1;
            skip_space(&mut j);
            match *b.get(j)? {
                quote @ (b'"' | b'\'') => {
                    let from = j + 1;
                    let len = rest[from..].find(quote as char)?;
                    value = decode_entities(&rest[from..from + len]);
                    j = from + len + 1;
                }
                _ => {
                    let from = j;
                    while j < b.len() && !b[j].is_ascii_whitespace() && b[j] != b'>' {
                        j += 1;
                    }
                    value = decode_entities(&rest[from..j]);
                }
            }
        }
        if !key.is_empty() {
            node.attrs.push((key, value));
        }
    }
}

/// Elements whose text is logs and attachments, never an error, so it is not worth holding in memory.
fn keeps_text(name: &str) -> bool {
    name != "system-out" && name != "system-err"
}

/// A small tolerant XML reader, because the reports are machine-written and the only goal is the element tree.
/// It skips the declaration, doctype and comments, reads CDATA as raw text, and treats truncated input as the
/// end of the document: elements still open are closed, so a report cut off mid-upload yields what came before.
fn read_xml(src: &str) -> Vec<Node> {
    fn attach(node: Node, stack: &mut [Node], roots: &mut Vec<Node>) {
        match stack.last_mut() {
            Some(parent) => parent.children.push(node),
            None => roots.push(node),
        }
    }
    fn push_text(stack: &mut [Node], text: &str, decode: bool) {
        if let Some(top) = stack.last_mut().filter(|n| keeps_text(&n.name)) {
            if decode {
                top.text.push_str(&decode_entities(text));
            } else {
                top.text.push_str(text);
            }
        }
    }

    let mut stack: Vec<Node> = Vec::new();
    let mut roots: Vec<Node> = Vec::new();
    let mut i = 0;
    while i < src.len() {
        if src.as_bytes()[i] != b'<' {
            let end = src[i..].find('<').map_or(src.len(), |n| i + n);
            push_text(&mut stack, &src[i..end], true);
            i = end;
            continue;
        }
        let rest = &src[i..];
        if let Some(body) = rest.strip_prefix("<!--") {
            match body.find("-->") {
                Some(n) => i += 4 + n + 3,
                None => break,
            }
        } else if let Some(body) = rest.strip_prefix("<![CDATA[") {
            match body.find("]]>") {
                Some(n) => {
                    push_text(&mut stack, &body[..n], false);
                    i += 9 + n + 3;
                }
                None => {
                    push_text(&mut stack, body, false);
                    break;
                }
            }
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            let closer = if rest.starts_with("<?") { "?>" } else { ">" };
            match rest.find(closer) {
                Some(n) => i += n + closer.len(),
                None => break,
            }
        } else if let Some(body) = rest.strip_prefix("</") {
            let Some(n) = body.find('>') else { break };
            let name = body[..n].trim();
            if let Some(at) = stack.iter().rposition(|open| open.name == name) {
                while stack.len() > at {
                    let done = stack.pop().expect("the stack is longer than `at`");
                    attach(done, &mut stack, &mut roots);
                }
            }
            i += 2 + n + 1;
        } else if rest[1..].starts_with(|c: char| c.is_alphabetic() || c == '_' || c == ':') {
            let Some((node, self_closing, used)) = read_start_tag(rest) else {
                break;
            };
            i += used;
            if self_closing {
                attach(node, &mut stack, &mut roots);
            } else if stack.len() >= MAX_XML_DEPTH {
                break;
            } else {
                stack.push(node);
            }
        } else {
            push_text(&mut stack, "<", false);
            i += 1;
        }
    }
    while let Some(done) = stack.pop() {
        attach(done, &mut stack, &mut roots);
    }
    roots
}

fn looks_like_path(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    s.contains('/') || s.contains('\\') || SOURCE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// JUnit's `time` is seconds with a decimal part.
fn seconds_to_ms(text: &str) -> u64 {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|s| s.is_finite() && *s > 0.0)
        .map_or(0, |s| (s * 1000.0).round() as u64)
}

/// The message attribute is the headline Vitest and Playwright both write; tools that leave it empty put the
/// text in the element body.
fn element_error(node: &Node) -> String {
    let message = node.attr("message");
    if headline(message).is_empty() {
        node.text.clone()
    } else {
        message.to_string()
    }
}

/// Vitest joins describe names and the test title with " > " and Playwright with " › "; the more specific
/// separator wins so a Playwright title that happens to contain ">" is not cut in the wrong place.
fn split_titles(name: &str) -> Vec<String> {
    let separator = if name.contains(" › ") {
        " › "
    } else {
        " > "
    };
    name.split(separator)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Default)]
struct Folder {
    drafts: Vec<Draft>,
    index: HashMap<(String, String, Vec<String>), usize>,
}

impl Folder {
    /// Some tools write one `<testcase>` per retry; folding them by identity turns those into attempts.
    fn add(&mut self, draft: Draft) {
        let key = (
            draft.project.clone(),
            draft.file.clone(),
            draft.titles.clone(),
        );
        match self.index.get(&key) {
            Some(&at) => {
                let into = &mut self.drafts[at];
                into.attempts.extend(draft.attempts);
                into.errors.extend(draft.errors);
            }
            None => {
                self.index.insert(key, self.drafts.len());
                self.drafts.push(draft);
            }
        }
    }
}

#[derive(Clone, Copy)]
struct SuiteContext<'a> {
    name: &'a str,
    file: &'a str,
    host: &'a str,
}

fn parse_junit(text: &str, repo: &str) -> Result<Vec<Case>, String> {
    let roots = read_xml(text);
    if roots.is_empty() {
        return Err("the XML holds no elements".into());
    }
    if !roots
        .iter()
        .any(|r| r.name == "testsuites" || r.name == "testsuite")
    {
        return Err(format!(
            "the XML is not a JUnit report (root element <{}>)",
            roots[0].name
        ));
    }
    let mut folder = Folder::default();
    let context = SuiteContext {
        name: "",
        file: "",
        host: "",
    };
    for root in &roots {
        walk_junit(root, context, repo, &mut folder);
    }
    Ok(folder.drafts.into_iter().map(Draft::finish).collect())
}

fn walk_junit(node: &Node, parent: SuiteContext, repo: &str, folder: &mut Folder) {
    fn inherit<'a>(own: &'a str, inherited: &'a str) -> &'a str {
        if own.is_empty() { inherited } else { own }
    }
    match node.name.as_str() {
        "testcase" => junit_case(node, parent, repo, folder),
        name => {
            let context = if name == "testsuite" {
                SuiteContext {
                    name: inherit(node.attr("name"), parent.name),
                    file: inherit(node.attr("file"), parent.file),
                    host: inherit(node.attr("hostname"), parent.host),
                }
            } else {
                parent
            };
            for child in &node.children {
                walk_junit(child, context, repo, folder);
            }
        }
    }
}

fn junit_case(node: &Node, suite: SuiteContext, repo: &str, folder: &mut Folder) {
    let classname = node.attr("classname");
    let raw_file = [node.attr("file"), suite.file]
        .into_iter()
        .chain(
            [classname, suite.name]
                .into_iter()
                .filter(|s| looks_like_path(s)),
        )
        .find(|f| !f.is_empty())
        .unwrap_or("");
    let file = relative_path(raw_file, repo);

    // Playwright's `includeProjectInTestName` puts "[project] " in front and writes the project as `hostname`.
    let mut name = node.attr("name");
    let mut project = "";
    if !suite.host.is_empty()
        && let Some(stripped) = name.strip_prefix(&format!("[{}] ", suite.host))
    {
        project = suite.host;
        name = stripped;
    }

    // Vitest reports a file that failed to load as a testcase named after the file itself.
    let mut titles = if name == raw_file {
        Vec::new()
    } else {
        split_titles(name)
    };
    if raw_file.is_empty() && !classname.is_empty() {
        titles.insert(0, classname.to_string());
    }

    let mut own = Outcome::Pass;
    let mut own_error = String::new();
    let mut earlier: Vec<(u64, String)> = Vec::new();
    let mut later: Vec<(u64, String)> = Vec::new();
    for child in &node.children {
        match child.name.as_str() {
            "failure" | "error" if own != Outcome::Fail => {
                own = Outcome::Fail;
                own_error = element_error(child);
            }
            "skipped" if own == Outcome::Pass => own = Outcome::Skip,
            "flakyFailure" | "flakyError" => {
                earlier.push((seconds_to_ms(child.attr("time")), element_error(child)))
            }
            "rerunFailure" | "rerunError" => {
                later.push((seconds_to_ms(child.attr("time")), element_error(child)))
            }
            _ => {}
        }
    }

    let mut draft = Draft::new("junit", project, file, titles);
    for (ms, error) in earlier {
        draft.attempt(Outcome::Fail, ms, &error);
    }
    draft.attempt(own, seconds_to_ms(node.attr("time")), &own_error);
    for (ms, error) in later {
        draft.attempt(Outcome::Fail, ms, &error);
    }
    folder.add(draft);
}

#[cfg(test)]
mod tests {
    use super::*;

    const VITEST_JSON: &str = r#"{
  "numTotalTestSuites": 4, "numPassedTestSuites": 2, "numFailedTestSuites": 2, "numPendingTestSuites": 0,
  "numTotalTests": 4, "numPassedTests": 1, "numFailedTests": 1, "numPendingTests": 1, "numTodoTests": 1,
  "snapshot": {"added": 0}, "startTime": 1763100000000, "success": false,
  "testResults": [
    {
      "assertionResults": [
        {"ancestorTitles": ["math"], "fullName": "math adds", "status": "passed", "title": "adds", "duration": 1.4, "failureMessages": [], "location": {"line": 4, "column": 3}, "meta": {}},
        {"ancestorTitles": ["math", "nested"], "fullName": "math nested subtracts", "status": "failed", "title": "subtracts", "duration": 12.6,
         "failureMessages": ["\n\u001b[31mAssertionError\u001b[39m: expected \u001b[31m1\u001b[39m to be \u001b[32m2\u001b[39m\n\n\u001b[32m- Expected\u001b[39m\n\u001b[31m+ Received\u001b[39m\n    at /home/runner/work/ompdesk/ompdesk/src/math.test.ts:9:5"], "location": {"line": 9, "column": 5}, "meta": {}},
        {"ancestorTitles": [], "fullName": "later", "status": "skipped", "title": "later", "duration": null, "failureMessages": [], "meta": {}},
        {"ancestorTitles": [""], "fullName": "soon", "status": "todo", "title": "soon", "failureMessages": [], "meta": {}}
      ],
      "startTime": 1763100000100, "endTime": 1763100000200, "status": "failed", "message": "",
      "name": "/home/runner/work/ompdesk/ompdesk/src/math.test.ts"
    },
    {
      "assertionResults": [], "startTime": 1763100000000, "endTime": 1763100000000, "status": "failed",
      "message": "\u001b[31mError\u001b[39m: Failed to resolve import \"./nope\" from \"src/broken.test.ts\"\nRequire stack",
      "name": "D:\\a\\ompdesk\\ompdesk\\src\\broken.test.ts"
    },
    {
      "assertionResults": [], "status": "passed", "message": "", "name": "/Users/runner/work/ompdesk/ompdesk/src/empty.test.ts"
    }
  ]
}"#;

    const PLAYWRIGHT_JSON: &str = r#"{
  "config": {"rootDir": "/home/runner/work/ompdesk/ompdesk/e2e", "version": "1.63.0", "workers": 2,
             "projects": [{"id": "chromium", "name": "chromium", "retries": 1}, {"id": "webkit", "name": "webkit", "retries": 1}]},
  "suites": [
    {
      "title": "checkout.spec.ts", "file": "checkout.spec.ts", "column": 0, "line": 0,
      "specs": [
        {"title": "opens the cart", "ok": true, "tags": [], "id": "a1", "file": "checkout.spec.ts", "line": 5, "column": 1,
         "tests": [
           {"timeout": 30000, "annotations": [], "expectedStatus": "passed", "projectId": "chromium", "projectName": "chromium", "status": "expected",
            "results": [{"workerIndex": 0, "parallelIndex": 0, "status": "passed", "duration": 812, "errors": [], "stdout": [], "stderr": [], "retry": 0, "startTime": "2026-11-14T00:00:00.000Z", "attachments": []}]},
           {"timeout": 30000, "annotations": [], "expectedStatus": "passed", "projectId": "webkit", "projectName": "webkit", "status": "expected",
            "results": [{"workerIndex": 1, "parallelIndex": 1, "status": "passed", "duration": 1020.5, "errors": [], "stdout": [], "stderr": [], "retry": 0, "startTime": "2026-11-14T00:00:00.000Z", "attachments": []}]}
         ]}
      ],
      "suites": [
        {
          "title": "cart", "file": "checkout.spec.ts", "line": 10, "column": 6,
          "specs": [
            {"title": "total is right", "ok": true, "tags": [], "id": "b1", "file": "checkout.spec.ts", "line": 12, "column": 3,
             "tests": [
               {"projectId": "chromium", "projectName": "chromium", "status": "flaky", "expectedStatus": "passed", "annotations": [], "timeout": 30000,
                "results": [
                  {"workerIndex": 0, "parallelIndex": 0, "status": "failed", "duration": 500,
                   "error": {"message": "Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m\n\nExpected: 12"},
                   "errors": [{"message": "Error: expect(received).toBe(expected)"}], "retry": 0},
                  {"workerIndex": 0, "parallelIndex": 0, "status": "passed", "duration": 420, "errors": [], "retry": 1}
                ]}
             ]}
          ],
          "suites": [
            {
              "title": "promo", "file": "checkout.spec.ts", "line": 20, "column": 8,
              "specs": [
                {"title": "code expires", "ok": false, "tags": [], "id": "c1", "file": "checkout.spec.ts", "line": 22, "column": 3,
                 "tests": [
                   {"projectId": "webkit", "projectName": "webkit", "status": "unexpected", "expectedStatus": "passed", "annotations": [], "timeout": 30000,
                    "results": [{"workerIndex": 1, "parallelIndex": 1, "status": "timedOut", "duration": 30000,
                                 "errors": [{"message": "Test timeout of 30000ms exceeded."}], "retry": 0}]}
                 ]},
                {"title": "not on this os", "ok": true, "tags": [], "id": "c2", "file": "checkout.spec.ts", "line": 30, "column": 3,
                 "tests": [
                   {"projectId": "webkit", "projectName": "webkit", "status": "skipped", "expectedStatus": "skipped", "annotations": [], "timeout": 30000,
                    "results": [{"workerIndex": -1, "parallelIndex": -1, "status": "skipped", "duration": 0, "errors": [], "retry": 0}]},
                   {"projectId": "chromium", "projectName": "chromium", "status": "skipped", "expectedStatus": "skipped", "annotations": [], "timeout": 30000,
                    "results": []}
                 ]}
              ]
            }
          ]
        }
      ]
    }
  ],
  "errors": [], "stats": {"startTime": "2026-11-14T00:00:00.000Z", "duration": 40000, "expected": 2, "skipped": 1, "unexpected": 1, "flaky": 1}
}"#;

    const VITEST_JUNIT: &str = r#"<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4" failures="2" errors="0" time="0.532">
    <testsuite name="src/a.test.ts" timestamp="2026-11-14T00:00:00.000Z" hostname="runner-1" tests="3" failures="1" errors="0" skipped="1" time="0.01">
        <testcase classname="src/a.test.ts" name="parser &gt; reads &quot;a&quot; &amp; &apos;b&apos; &lt;tag&gt;" time="0.0014">
        </testcase>
        <testcase classname="src/a.test.ts" name="parser &gt; later" time="0">
            <skipped/>
        </testcase>
        <testcase classname="src/a.test.ts" name="parser &gt; fails" time="0.0126">
            <failure message="expected 1 to be 2" type="AssertionError">
AssertionError: expected 1 to be 2
 ❯ src/a.test.ts:9:5
            </failure>
        </testcase>
    </testsuite>
    <testsuite name="src/broken.test.ts" timestamp="2026-11-14T00:00:00.000Z" hostname="runner-1" tests="1" failures="1" errors="0" skipped="0" time="0">
        <testcase classname="src/broken.test.ts" name="src/broken.test.ts" time="0">
            <failure message="Failed to resolve import" type="Error">
Error: Failed to resolve import
            </failure>
        </testcase>
    </testsuite>
</testsuites>
"#;

    const PLAYWRIGHT_JUNIT: &str = r#"<testsuites id="" name="" tests="4" failures="1" skipped="1" errors="0" time="41.2">
<testsuite name="checkout.spec.ts" timestamp="2026-11-14T00:00:00.000Z" hostname="chromium" tests="4" failures="1" skipped="1" time="2.3" errors="0">
<testcase name="[chromium] cart › total is right" classname="checkout.spec.ts" time="0.92">
<properties>
<property name="owner" value="a &amp; b">
</property>
</properties>
<system-out>
<![CDATA[line <one> ]]>
</system-out>
<flakyFailure message="expect(received).toBe(expected)" type="expect.toBe" time="0.5">
<stackTrace>
Error: expect(received).toBe(expected)
</stackTrace>
</flakyFailure>
</testcase>
<testcase name="[chromium] cart › promo › code expires" classname="checkout.spec.ts" time="30">
<failure message="Test timeout of 30000ms exceeded." type="FAILURE">
<![CDATA[checkout.spec.ts:22:3 code expires

Test timeout of 30000ms exceeded.
  a <b> && c]]>
</failure>
</testcase>
<testcase name="[chromium] cart › not on this os" classname="checkout.spec.ts">
<skipped>
</skipped>
</testcase>
</testsuite>
</testsuites>"#;

    fn names(cases: &[Case]) -> Vec<String> {
        cases.iter().map(Case::name).collect()
    }

    fn case(file: &str, titles: &[&str], project: &str, outcomes: &[(Outcome, u64)]) -> Case {
        Case {
            runner: "vitest".into(),
            project: project.into(),
            file: file.into(),
            titles: titles.iter().map(|t| t.to_string()).collect(),
            attempts: outcomes
                .iter()
                .map(|&(outcome, ms)| Attempt { outcome, ms })
                .collect(),
            first_error: String::new(),
        }
    }

    #[test]
    fn a_vitest_report_maps_passed_failed_skipped_and_unloadable_files() {
        let cases = parse(VITEST_JSON.as_bytes(), "ompdesk").expect("a Vitest report parses");
        assert_eq!(
            names(&cases),
            vec![
                "src/math.test.ts › math › adds",
                "src/math.test.ts › math › nested › subtracts",
                "src/math.test.ts › later",
                "src/math.test.ts › soon",
                "src/broken.test.ts",
            ]
        );
        assert!(
            cases
                .iter()
                .all(|c| c.runner == "vitest" && c.project.is_empty())
        );
        assert_eq!(
            cases[0].attempts,
            vec![Attempt {
                outcome: Outcome::Pass,
                ms: 1
            }]
        );
        assert_eq!(cases[0].first_error, "");
        assert_eq!(
            cases[1].attempts,
            vec![Attempt {
                outcome: Outcome::Fail,
                ms: 13
            }]
        );
        assert_eq!(cases[1].first_error, "AssertionError: expected 1 to be 2");
        assert_eq!(
            cases[2].attempts,
            vec![Attempt {
                outcome: Outcome::Skip,
                ms: 0
            }]
        );
        assert_eq!(cases[3].outcome(), Outcome::Skip);
        assert_eq!(cases[4].titles, Vec::<String>::new());
        assert_eq!(
            cases[4].attempts,
            vec![Attempt {
                outcome: Outcome::Fail,
                ms: 0
            }]
        );
        assert_eq!(
            cases[4].first_error,
            "Error: Failed to resolve import \"./nope\" from \"src/broken.test.ts\""
        );
    }

    #[test]
    fn a_report_that_only_jest_writes_is_named_jest() {
        let jest = r#"{"numTotalTests":1,"success":true,"wasInterrupted":false,"openHandles":[],
            "testResults":[{"name":"/home/runner/work/ompdesk/ompdesk/web/a.test.js","status":"passed","message":"","summary":"",
              "assertionResults":[{"ancestorTitles":["a"],"title":"works","fullName":"a works","status":"passed","duration":3,"failureMessages":[],"numPassingAsserts":1}]}]}"#;
        let cases = parse(jest.as_bytes(), "ompdesk").expect("a Jest report parses");
        assert_eq!(cases.len(), 1);
        assert_eq!(cases[0].runner, "jest");
        assert_eq!(cases[0].name(), "web/a.test.js › a › works");
        assert_eq!(cases[0].ms(), 3);
    }

    #[test]
    fn runner_paths_become_repository_relative_on_every_hosted_os() {
        for path in [
            "/home/runner/work/ompdesk/ompdesk/src/a.test.ts",
            "D:/a/ompdesk/ompdesk/src/a.test.ts",
            "D:\\a\\ompdesk\\ompdesk\\src\\a.test.ts",
            "/Users/runner/work/ompdesk/ompdesk/src/a.test.ts",
            "./src/a.test.ts",
            "src/a.test.ts",
        ] {
            assert_eq!(relative_path(path, "ompdesk"), "src/a.test.ts", "{path}");
        }
    }

    #[test]
    fn the_last_workspace_marker_wins_and_foreign_paths_are_kept() {
        assert_eq!(
            relative_path("/w/ompdesk/ompdesk/vendor/ompdesk/ompdesk/x.ts", "ompdesk"),
            "x.ts"
        );
        assert_eq!(
            relative_path("/Users/me/code/ompdesk/src/a.ts", "ompdesk"),
            "/Users/me/code/ompdesk/src/a.ts"
        );
        assert_eq!(
            relative_path("/w/other/other/a.ts", "ompdesk"),
            "/w/other/other/a.ts"
        );
        assert_eq!(relative_path("./a.ts", ""), "a.ts");
        assert_eq!(relative_path("/w/x/x/a.ts", ""), "/w/x/x/a.ts");
    }

    #[test]
    fn a_playwright_report_keeps_describes_projects_retries_and_timeouts() {
        let cases =
            parse(PLAYWRIGHT_JSON.as_bytes(), "ompdesk").expect("a Playwright report parses");
        assert_eq!(
            names(&cases),
            vec![
                "[chromium] e2e/checkout.spec.ts › opens the cart",
                "[webkit] e2e/checkout.spec.ts › opens the cart",
                "[chromium] e2e/checkout.spec.ts › cart › total is right",
                "[webkit] e2e/checkout.spec.ts › cart › promo › code expires",
                "[webkit] e2e/checkout.spec.ts › cart › promo › not on this os",
                "[chromium] e2e/checkout.spec.ts › cart › promo › not on this os",
            ]
        );
        assert!(cases.iter().all(|c| c.runner == "playwright"));
        assert_eq!(cases[1].ms(), 1021);

        let flaky = &cases[2];
        assert!(flaky.flaky());
        assert_eq!(flaky.outcome(), Outcome::Pass);
        assert_eq!(
            flaky.attempts,
            vec![
                Attempt {
                    outcome: Outcome::Fail,
                    ms: 500
                },
                Attempt {
                    outcome: Outcome::Pass,
                    ms: 420
                }
            ]
        );
        assert_eq!(flaky.first_error, "Error: expect(received).toBe(expected)");

        let timed_out = &cases[3];
        assert_eq!(
            timed_out.attempts,
            vec![Attempt {
                outcome: Outcome::Fail,
                ms: 30000
            }]
        );
        assert_eq!(timed_out.first_error, "Test timeout of 30000ms exceeded.");
        assert!(!timed_out.flaky());

        assert_eq!(
            cases[4].attempts,
            vec![Attempt {
                outcome: Outcome::Skip,
                ms: 0
            }]
        );
        assert_eq!(
            cases[5].attempts,
            vec![Attempt {
                outcome: Outcome::Skip,
                ms: 0
            }],
            "no results is one skipped attempt"
        );
    }

    #[test]
    fn a_playwright_report_with_windows_paths_is_made_relative() {
        let json = r#"{"config":{"rootDir":"D:\\a\\ompdesk\\ompdesk"},"suites":[{"title":"e2e\\x.spec.ts","file":"e2e\\x.spec.ts","specs":[
            {"title":"t","file":"e2e\\x.spec.ts","tests":[{"projectName":"","results":[{"status":"passed","duration":1}]}]}]}]}"#;
        let cases = parse(json.as_bytes(), "ompdesk").expect("parses");
        assert_eq!(cases[0].file, "e2e/x.spec.ts");
        assert_eq!(cases[0].project, "");
        assert_eq!(cases[0].name(), "e2e/x.spec.ts › t");
    }

    #[test]
    fn a_vitest_junit_report_is_read_with_entities_and_a_self_closing_skip() {
        let cases =
            parse(VITEST_JUNIT.as_bytes(), "ompdesk").expect("a Vitest JUnit report parses");
        assert_eq!(
            names(&cases),
            vec![
                "src/a.test.ts › parser › reads \"a\" & 'b' <tag>",
                "src/a.test.ts › parser › later",
                "src/a.test.ts › parser › fails",
                "src/broken.test.ts",
            ]
        );
        assert!(
            cases
                .iter()
                .all(|c| c.runner == "junit" && c.project.is_empty())
        );
        assert_eq!(
            cases[0].attempts,
            vec![Attempt {
                outcome: Outcome::Pass,
                ms: 1
            }]
        );
        assert_eq!(cases[1].outcome(), Outcome::Skip);
        assert_eq!(
            cases[2].attempts,
            vec![Attempt {
                outcome: Outcome::Fail,
                ms: 13
            }]
        );
        assert_eq!(cases[2].first_error, "expected 1 to be 2");
        assert_eq!(cases[3].outcome(), Outcome::Fail);
        assert_eq!(cases[3].first_error, "Failed to resolve import");
    }

    #[test]
    fn a_playwright_junit_report_is_read_with_cdata_projects_and_flaky_retries() {
        let cases = parse(PLAYWRIGHT_JUNIT.as_bytes(), "ompdesk")
            .expect("a Playwright JUnit report parses");
        assert_eq!(
            names(&cases),
            vec![
                "[chromium] checkout.spec.ts › cart › total is right",
                "[chromium] checkout.spec.ts › cart › promo › code expires",
                "[chromium] checkout.spec.ts › cart › not on this os",
            ]
        );
        let flaky = &cases[0];
        assert!(flaky.flaky());
        assert_eq!(
            flaky.attempts,
            vec![
                Attempt {
                    outcome: Outcome::Fail,
                    ms: 500
                },
                Attempt {
                    outcome: Outcome::Pass,
                    ms: 920
                }
            ]
        );
        assert_eq!(flaky.first_error, "expect(received).toBe(expected)");
        assert_eq!(
            cases[1].attempts,
            vec![Attempt {
                outcome: Outcome::Fail,
                ms: 30000
            }]
        );
        assert_eq!(cases[1].first_error, "Test timeout of 30000ms exceeded.");
        assert_eq!(
            cases[2].attempts,
            vec![Attempt {
                outcome: Outcome::Skip,
                ms: 0
            }]
        );
    }

    #[test]
    fn a_failure_without_a_message_attribute_takes_its_headline_from_the_cdata_body() {
        let xml = "<testsuite name='s'><testcase classname='src/x.rs' name='t' time='1.5'>\
                   <error type='E'><![CDATA[\n\n  \u{1b}[31mboom\u{1b}[0m & more\nsecond]]></error></testcase></testsuite>";
        let cases = parse(xml.as_bytes(), "ompdesk").expect("parses");
        assert_eq!(cases[0].first_error, "boom & more");
        assert_eq!(cases[0].ms(), 1500);
        assert_eq!(cases[0].outcome(), Outcome::Fail);
    }

    #[test]
    fn junit_file_comes_from_the_testcase_then_the_suite_then_a_path_like_classname() {
        let xml = r#"<testsuites>
            <testsuite name="suite one" file="/home/runner/work/ompdesk/ompdesk/tests/s.py">
              <testcase classname="pkg.Klass" name="a" file="tests/own.py"/>
              <testcase classname="pkg.Klass" name="b"/>
            </testsuite>
            <testsuite name="web\ui.spec.ts">
              <testcase classname="C:\w\ompdesk\ompdesk\web\ui.spec.ts" name="c"/>
              <testcase classname="Klass" name="d"/>
            </testsuite>
            <testsuite name="ompdesk-core">
              <testcase classname="ompdesk_core::checks" name="e"/>
            </testsuite>
          </testsuites>"#;
        let cases = parse(xml.as_bytes(), "ompdesk").expect("parses");
        assert_eq!(
            names(&cases),
            vec![
                "tests/own.py › a",
                "tests/s.py › b",
                "web/ui.spec.ts › c",
                "web/ui.spec.ts › d",
                "ompdesk_core::checks › e",
            ]
        );
    }

    #[test]
    fn character_references_comments_doctype_and_single_quotes_are_understood() {
        let xml = "\u{feff}\n<?xml version='1.0'?><!DOCTYPE testsuites><!-- <testcase name='no'/> -->\
                   <testsuites><testsuite name='a.ts'><testcase name='x &#65;&#x42;&#67; &unknown; & done' classname='a.ts' time=0.25 /></testsuite></testsuites>";
        let cases = parse(xml.as_bytes(), "ompdesk").expect("parses");
        assert_eq!(cases.len(), 1);
        assert_eq!(cases[0].titles, vec!["x ABC &unknown; & done".to_string()]);
        assert_eq!(cases[0].ms(), 250);
    }

    #[test]
    fn repeated_junit_testcases_are_folded_into_attempts_in_document_order() {
        let xml = r#"<testsuite name="a.test.ts">
            <testcase classname="a.test.ts" name="s > t" time="0.1"><failure message="first"/></testcase>
            <testcase classname="a.test.ts" name="s > other" time="0.2"/>
            <testcase classname="a.test.ts" name="s > t" time="0.3"><failure message="second"/></testcase>
            <testcase classname="a.test.ts" name="s > t" time="0.4"/>
          </testsuite>"#;
        let cases = parse(xml.as_bytes(), "ompdesk").expect("parses");
        assert_eq!(cases.len(), 2);
        let folded = &cases[0];
        assert_eq!(
            folded.attempts,
            vec![
                Attempt {
                    outcome: Outcome::Fail,
                    ms: 100
                },
                Attempt {
                    outcome: Outcome::Fail,
                    ms: 300
                },
                Attempt {
                    outcome: Outcome::Pass,
                    ms: 400
                },
            ]
        );
        assert!(folded.flaky());
        assert_eq!(folded.first_error, "first");
        assert_eq!(cases[1].titles, vec!["s".to_string(), "other".to_string()]);
    }

    #[test]
    fn rerun_elements_follow_the_testcases_own_failure() {
        let xml = r#"<testsuite name="x.rs"><testcase classname="x.rs" name="t" time="1">
            <failure message="a"/><rerunFailure message="b" time="2"/><rerunError message="c" time="3"/></testcase></testsuite>"#;
        let cases = parse(xml.as_bytes(), "ompdesk").expect("parses");
        let outcomes: Vec<(Outcome, u64)> = cases[0]
            .attempts
            .iter()
            .map(|a| (a.outcome, a.ms))
            .collect();
        assert_eq!(
            outcomes,
            vec![
                (Outcome::Fail, 1000),
                (Outcome::Fail, 2000),
                (Outcome::Fail, 3000)
            ]
        );
        assert!(!cases[0].flaky());
    }

    #[test]
    fn name_has_the_check_display_forms() {
        assert_eq!(
            case("src/a.ts", &["d", "t"], "", &[(Outcome::Pass, 1)]).name(),
            "src/a.ts › d › t"
        );
        assert_eq!(
            case("src/a.ts", &["d", "t"], "webkit", &[(Outcome::Pass, 1)]).name(),
            "[webkit] src/a.ts › d › t"
        );
        assert_eq!(
            case("src/a.ts", &[], "webkit", &[(Outcome::Fail, 0)]).name(),
            "src/a.ts"
        );
        assert_eq!(
            case("", &["Klass", "t"], "", &[(Outcome::Pass, 0)]).name(),
            "Klass › t"
        );
    }

    #[test]
    fn outcome_ms_and_flaky_follow_the_attempts() {
        let retried = case("f", &["t"], "", &[(Outcome::Fail, 5), (Outcome::Pass, 7)]);
        assert_eq!(
            (retried.outcome(), retried.ms(), retried.flaky()),
            (Outcome::Pass, 7, true)
        );
        let lost = case("f", &["t"], "", &[(Outcome::Pass, 5), (Outcome::Fail, 9)]);
        assert_eq!(
            (lost.outcome(), lost.ms(), lost.flaky()),
            (Outcome::Fail, 9, true)
        );
        let steady = case("f", &["t"], "", &[(Outcome::Fail, 5), (Outcome::Fail, 9)]);
        assert!(!steady.flaky());
        let skipped = case("f", &["t"], "", &[(Outcome::Skip, 0)]);
        assert!(!skipped.flaky());
        let outcomes =
            serde_json::to_string(&[Outcome::Pass, Outcome::Fail, Outcome::Skip]).unwrap();
        assert_eq!(outcomes, r#"["pass","fail","skip"]"#);
    }

    #[test]
    fn first_error_is_plain_text_and_at_most_three_hundred_characters() {
        let long = format!("\u{1b}[31m{}\u{1b}[39m\nnext line", "é".repeat(500));
        let json = serde_json::json!({
            "testResults": [{"name": "a.test.ts", "status": "failed", "assertionResults": [
                {"title": "t", "ancestorTitles": [], "status": "failed", "duration": 1, "failureMessages": ["", "  ", long]}
            ]}]
        });
        let cases = parse(json.to_string().as_bytes(), "ompdesk").expect("parses");
        assert_eq!(cases[0].first_error, "é".repeat(300));
    }

    #[test]
    fn a_passing_test_has_no_first_error_even_when_it_failed_earlier_without_a_message() {
        let mut c = Draft::new("junit", "", "f".into(), vec!["t".into()]);
        c.attempt(Outcome::Fail, 1, "");
        c.attempt(Outcome::Pass, 1, "");
        assert_eq!(c.finish().first_error, "");
    }

    #[test]
    fn unknown_or_broken_documents_are_errors_not_panics() {
        for bad in [
            "",
            "   \n",
            "hello",
            "[1, 2]",
            "{}",
            r#"{"suites": []}"#,
            r#"{"testResults": 3}"#,
            r#"{"suites": 1, "config": {}}"#,
            r#"{"testResults": ["#,
            "<html><body>hi</body></html>",
            "<",
            "<!-- never closed",
        ] {
            assert!(parse(bad.as_bytes(), "ompdesk").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_truncated_junit_report_keeps_what_was_read() {
        let marker = "<failure message=\"expected 1 to be 2\" type=\"AssertionError\">\n";
        let cut = &VITEST_JUNIT[..VITEST_JUNIT.find(marker).expect("marker") + marker.len() + 8];
        let cases = parse(cut.as_bytes(), "ompdesk").expect("a truncated report still parses");
        assert_eq!(cases.len(), 3);
        assert_eq!(cases[1].outcome(), Outcome::Skip);
        assert_eq!(cases[2].outcome(), Outcome::Fail);
        assert_eq!(cases[2].first_error, "expected 1 to be 2");
    }

    #[test]
    fn invalid_utf8_is_read_lossily_and_a_bom_is_skipped() {
        let bytes = b"\xEF\xBB\xBF<testsuite name=\"a.ts\"><testcase classname=\"a.ts\" name=\"caf\xE9 ok\"/></testsuite>".to_vec();
        let cases = parse(&bytes, "ompdesk").expect("parses");
        assert_eq!(cases[0].titles, vec!["caf\u{fffd} ok".to_string()]);
        let json = [b"\xEF\xBB\xBF".as_slice(), br#"{"testResults":[]}"#].concat();
        assert_eq!(parse(&json, "ompdesk"), Ok(Vec::new()));
    }

    #[test]
    fn no_prefix_of_any_fixture_panics_or_hangs() {
        for fixture in [VITEST_JSON, PLAYWRIGHT_JSON, VITEST_JUNIT, PLAYWRIGHT_JUNIT] {
            for end in 0..=fixture.len() {
                let _ = parse(&fixture.as_bytes()[..end], "ompdesk");
            }
        }
    }

    #[test]
    fn hostile_xml_shapes_terminate() {
        let deep = "<a>".repeat(10_000);
        let _ = parse(deep.as_bytes(), "ompdesk");
        for hostile in [
            "<testsuite a=>",
            "<testsuite =x></testsuite>",
            "<testsuite a='x",
            "<testsuite / / / >",
            "<testsuite><testcase name=\"é\u{301}\" 日本='語'/></testsuite>",
            "</x></y><testsuite></z></testsuite>",
            "<testsuite>&#xZZ; &#99999999999; &#;</testsuite>",
            "<testsuite><![CDATA[never closed",
        ] {
            let _ = parse(hostile.as_bytes(), "ompdesk");
        }
    }
}
