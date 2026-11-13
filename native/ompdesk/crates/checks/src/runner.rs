//! What runs a check: the test runner a command invokes, the reporter that records each result as it ends, and the
//! narrowed command that runs only what has no reusable pass.
//!
//! Known runners: Playwright (`playwright test`), Vitest, Jest and `cargo test`, called directly (`npx`, `bunx`,
//! `pnpm exec`, a path to the binary) or through a package script that is that one command (`bun run e2e` where
//! `"e2e": "playwright test"`). Playwright's reporter also rides in the environment (`PW_TEST_REPORTER`), so a
//! Playwright run inside any script is recorded. Anything else is a plain command: one result, its exit code.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const PLAYWRIGHT_REPORTER: &str = include_str!("reporters/playwright.cjs");
pub const VITEST_REPORTER: &str = include_str!("reporters/vitest.mjs");
pub const JEST_REPORTER: &str = include_str!("reporters/jest.cjs");
pub const RESULTS_ENV: &str = "OMPDESK_CHECK_RESULTS";

pub fn reporters_digest() -> String {
    crate::inputs::sha256_hex(
        [PLAYWRIGHT_REPORTER, VITEST_REPORTER, JEST_REPORTER]
            .concat()
            .as_bytes(),
    )
}

pub struct Reporters {
    pub playwright: PathBuf,
    pub vitest: PathBuf,
    pub jest: PathBuf,
}

/// Writes the reporters into the store, once per version of them.
pub fn install_reporters(store: &Path) -> io::Result<Reporters> {
    let dir = store.join("reporters").join(&reporters_digest()[..12]);
    fs::create_dir_all(&dir)?;
    let put = |name: &str, text: &str| -> io::Result<PathBuf> {
        let path = dir.join(name);
        if fs::read_to_string(&path).ok().as_deref() != Some(text) {
            let tmp = dir.join(format!("{name}.tmp{}", std::process::id()));
            fs::write(&tmp, text)?;
            fs::rename(&tmp, &path)?;
        }
        Ok(path)
    };
    Ok(Reporters {
        playwright: put("playwright-reporter.cjs", PLAYWRIGHT_REPORTER)?,
        vitest: put("vitest-reporter.mjs", VITEST_REPORTER)?,
        jest: put("jest-reporter.cjs", JEST_REPORTER)?,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Playwright,
    Vitest,
    Jest,
    Cargo,
    Command,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Playwright => "playwright",
            Kind::Vitest => "vitest",
            Kind::Jest => "jest",
            Kind::Cargo => "cargo test",
            Kind::Command => "command",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Detected {
    pub kind: Kind,
    /// npm passes arguments on to a script only after `--`.
    pub needs_dashdash: bool,
    /// The command runs through this package script.
    pub script: Option<String>,
}

fn base(token: &str) -> String {
    let name = token.rsplit(['/', '\\']).next().unwrap_or(token);
    let name = name.to_ascii_lowercase();
    for ext in [".cmd", ".exe", ".ps1", ".js", ".mjs", ".cjs"] {
        if let Some(stem) = name.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    name
}

/// The runner a single command line invokes, if any.
fn runner_in(tokens: &[String]) -> Option<Kind> {
    for (at, token) in tokens.iter().enumerate() {
        let next = tokens[at + 1..]
            .iter()
            .find(|t| !t.starts_with('-'))
            .map(String::as_str);
        match base(token).as_str() {
            "playwright" if next == Some("test") => return Some(Kind::Playwright),
            "vitest" => return Some(Kind::Vitest),
            "jest" => return Some(Kind::Jest),
            "cargo" if matches!(next, Some("test")) => return Some(Kind::Cargo),
            _ => {}
        }
    }
    None
}

/// A package script that is one plain command (no `&&`, `;`, pipes, redirects or substitutions), split in words.
fn plain_script(text: &str) -> Option<Vec<String>> {
    const SHELL: &[&str] = &["&&", "||", ";", "|", ">", "<", "$(", "`", "&"];
    if SHELL.iter().any(|s| text.contains(s)) {
        return None;
    }
    Some(text.split_whitespace().map(str::to_string).collect())
}

fn script_text(cwd: &Path, name: &str) -> Option<String> {
    let text = fs::read_to_string(cwd.join("package.json")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    json.get("scripts")?.get(name)?.as_str().map(str::to_string)
}

pub fn detect(argv: &[String], cwd: &Path) -> Detected {
    let plain = |kind| Detected {
        kind,
        needs_dashdash: false,
        script: None,
    };
    if let Some(kind) = runner_in(argv) {
        return plain(kind);
    }
    // `bun run X`, `npm run X`, `npm test`, `pnpm X`, `yarn X`.
    let pm = argv.first().map(|t| base(t)).unwrap_or_default();
    if !matches!(pm.as_str(), "bun" | "npm" | "pnpm" | "yarn") {
        return plain(Kind::Command);
    }
    let words: Vec<&str> = argv[1..]
        .iter()
        .map(String::as_str)
        .filter(|w| !w.starts_with('-'))
        .collect();
    let name = match words.as_slice() {
        ["run", name, ..] | ["run-script", name, ..] => *name,
        ["test", ..] | ["t", ..] if pm != "bun" => "test",
        [name, ..] if pm == "pnpm" || pm == "yarn" => *name,
        _ => return plain(Kind::Command),
    };
    let Some(text) = script_text(cwd, name) else {
        return plain(Kind::Command);
    };
    match plain_script(&text).and_then(|words| runner_in(&words)) {
        // cargo through a package script is left alone: its arguments would land after `--`.
        Some(kind) if kind != Kind::Cargo => Detected {
            kind,
            needs_dashdash: pm == "npm" && !argv.iter().any(|a| a == "--"),
            script: Some(name.to_string()),
        },
        _ => plain(Kind::Command),
    }
}

/// One result line a reporter wrote.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Record {
    /// What identifies the result across runs.
    pub key: String,
    pub status: String,
    pub ms: u64,
    /// A file's own record (Vitest, Jest): narrowing works by file.
    pub file_record: bool,
    pub runner: String,
    pub project: String,
    /// Relative to the runner's root (Playwright's `rootDir`, Vitest's `root`, Jest's `rootDir`).
    pub file: String,
    /// The file's absolute path, where the reporter knows it.
    #[serde(default)]
    pub abs: String,
    pub titles: Vec<String>,
    pub config: String,
}

/// Results in the order written; the last line for a key wins where they are merged. Two Vitest or Jest tests with
/// the same full name in one file (allowed there) get `#2`, `#3` after the first, so a failure is never folded into a
/// pass of its namesake; Playwright refuses duplicate titles, and its repeated lines are one test's retries.
pub fn read_results(path: &Path) -> (Vec<Record>, Option<String>) {
    let mut out = Vec::new();
    let mut end = None;
    let mut seen: HashMap<String, usize> = HashMap::new();
    let Ok(text) = fs::read_to_string(path) else {
        return (out, end);
    };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(e) = v.get("end").and_then(Value::as_str) {
            end = Some(e.to_string());
            continue;
        }
        let runner = s("runner");
        let titles: Vec<String> = v
            .get("titles")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let kind = s("kind");
        let file_record = kind == "file";
        let (project, file, config) = (s("project"), s("file"), s("config"));
        let key = match (runner.as_str(), kind.as_str()) {
            // An error outside any test: never reusable (its status is always failed).
            (_, "error") => format!("{runner} error|{}", titles.join(" ")),
            ("playwright", _) => format!(
                "playwright|{config}|{}",
                test_list_line(&project, &file, &titles)
            ),
            ("vitest", "file") => format!("vitest file|{project}|{file}"),
            ("vitest", _) => format!("vitest|{project}|{file}|{}", titles.join(" > ")),
            ("jest", "file") => format!("jest file|{file}"),
            ("jest", _) => format!("jest|{file}|{}", titles.join(" > ")),
            ("cargo", _) => format!("cargo|{file}|{}", titles.join("")),
            _ => format!("{runner}|{file}|{}", titles.join(" > ")),
        };
        let key = if matches!(runner.as_str(), "vitest" | "jest") && !file_record {
            let n = seen.entry(key.clone()).or_default();
            *n += 1;
            if *n > 1 { format!("{key} #{n}") } else { key }
        } else {
            key
        };
        out.push(Record {
            key,
            status: s("status"),
            ms: v.get("ms").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as u64,
            file_record,
            runner,
            project,
            file,
            abs: s("abs"),
            titles,
            config,
        });
    }
    (out, end)
}

/// A test as Playwright's `--test-list` names it.
pub fn test_list_line(project: &str, file: &str, titles: &[String]) -> String {
    let mut line = format!("[{project}] › {file}");
    for t in titles {
        line.push_str(" › ");
        line.push_str(t);
    }
    line
}

/// The binary a `Running …` line names, without the build hash: `unittests src/lib.rs (ompdesk_checks)`.
fn cargo_binary(line: &str) -> String {
    match line.rsplit_once(" (") {
        Some((desc, path)) => {
            let stem = path
                .trim_end_matches(')')
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .trim_end_matches(".exe");
            let krate = stem.rsplit_once('-').map_or(stem, |(name, _)| name);
            format!("{desc} ({krate})")
        }
        None => line.to_string(),
    }
}

/// `cargo test`'s per-test lines in a log (`Running …` and `Doc-tests …` name the binary, `test name ... ok` a
/// result), and whether every binary reported as many results as its `running N tests` line announced.
pub fn cargo_results(log: &str) -> (Vec<Record>, bool) {
    let mut binary = String::new();
    let mut out = Vec::new();
    let mut announced: Vec<(usize, usize)> = Vec::new();
    for line in log.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Running ") {
            binary = cargo_binary(rest);
            continue;
        }
        if let Some(rest) = t.strip_prefix("Doc-tests ") {
            binary = format!("doc-tests {rest}");
            continue;
        }
        if let Some(n) = t
            .strip_prefix("running ")
            .and_then(|r| r.split_whitespace().next())
            .and_then(|n| n.parse::<usize>().ok())
        {
            announced.push((n, 0));
            continue;
        }
        let Some(rest) = t.strip_prefix("test ") else {
            continue;
        };
        let Some((name, outcome)) = rest.rsplit_once(" ... ") else {
            continue;
        };
        let status = match outcome
            .split_whitespace()
            .next()
            .map(|w| w.trim_end_matches(','))
        {
            Some("ok") => "passed",
            Some("FAILED") => "failed",
            Some("ignored") => "skipped",
            _ => continue,
        };
        if let Some(last) = announced.last_mut() {
            last.1 += 1;
        }
        out.push(Record {
            key: format!("cargo|{binary}|{name}"),
            status: status.into(),
            ms: 0,
            file_record: false,
            runner: "cargo".into(),
            project: String::new(),
            file: binary.clone(),
            abs: String::new(),
            titles: vec![name.to_string()],
            config: String::new(),
        });
    }
    let complete = !announced.is_empty() && announced.iter().all(|(n, seen)| n == seen);
    (out, complete)
}

/// What a run of the command becomes: the runner's reporter, and when narrowing, what is left out.
#[derive(Default, Debug, PartialEq)]
pub struct Rewrite {
    /// The whole command to run.
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// Files written for the run (a test list).
    pub files: Vec<(PathBuf, String)>,
    /// Why some earlier passes are run again anyway.
    pub notes: Vec<String>,
    /// Earlier passes this run leaves out, by key.
    pub skipped: BTreeSet<String>,
    /// Every test has a reusable pass: nothing to run.
    pub nothing_left: bool,
}

/// What narrowing reads.
pub struct Earlier<'a> {
    /// The earlier results that may be reused: every result of the run reused from (the last per key), less those of
    /// test files changed since.
    pub records: &'a [Record],
    /// That run went through to its end, so its list of tests is whole.
    pub complete: bool,
    /// Nothing changed since that run: only what did not pass runs again, by test name where the runner allows.
    pub failed_only: bool,
    /// Where Playwright's test list goes.
    pub list_path: &'a Path,
    /// Every Jest test file (`--listTests`), when asked.
    pub jest_files: Option<&'a [String]>,
}

/// Escapes a path for a glob (picomatch, tinyglobby).
fn glob_escape(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if "\\*?[]{}()!+@|#".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Escapes text for a JavaScript regular expression.
fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if "\\^$.*+?()[]{}|/".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The command for `detected`; with `narrow`, what has a reusable pass is left out.
pub fn rewrite(
    detected: &Detected,
    argv: &[String],
    reporters: &Reporters,
    narrow: Option<&Earlier>,
) -> Rewrite {
    let mut rw = Rewrite::default();
    rw.env.insert(
        "PW_TEST_REPORTER".into(),
        reporters.playwright.display().to_string(),
    );
    let mut extra: Vec<String> = Vec::new();
    let mut command = argv.to_vec();
    match detected.kind {
        Kind::Vitest => {
            if !argv.iter().any(|a| a.starts_with("--reporter")) {
                extra.push("--reporter=default".into());
            }
            extra.push(format!("--reporter={}", reporters.vitest.display()));
        }
        Kind::Jest => {
            if !argv.iter().any(|a| a.starts_with("--reporters")) {
                extra.push("--reporters=default".into());
            }
            extra.push(format!("--reporters={}", reporters.jest.display()));
        }
        // Every test binary runs even after one failed, so a failed run still says what passed.
        Kind::Cargo if !argv.iter().any(|a| a == "--no-fail-fast") => {
            let dashdash = argv.iter().position(|a| a == "--").unwrap_or(argv.len());
            if let Some(at) = argv[..dashdash].iter().position(|a| a == "test") {
                command.insert(at + 1, "--no-fail-fast".into());
            }
        }
        _ => {}
    }
    if let Some(e) = narrow {
        match detected.kind {
            Kind::Playwright => narrow_playwright(e, &mut extra, &mut rw),
            Kind::Vitest => narrow_vitest(e, &mut extra, &mut rw),
            Kind::Jest => narrow_jest(e, &mut extra, &mut rw),
            Kind::Cargo => narrow_cargo(e, argv, &mut extra, &mut rw),
            Kind::Command => {}
        }
    }
    if !extra.is_empty() && detected.needs_dashdash {
        command.push("--".into());
    }
    command.extend(extra);
    rw.argv = command;
    rw
}

fn narrow_playwright(e: &Earlier, extra: &mut Vec<String>, rw: &mut Rewrite) {
    let tests: Vec<&Record> = e
        .records
        .iter()
        .filter(|r| r.runner == "playwright" && !r.key.contains(" error|"))
        .collect();
    let configs: BTreeSet<&str> = tests.iter().map(|r| r.config.as_str()).collect();
    if configs.len() > 1 {
        rw.notes.push(format!(
            "the earlier run recorded {} Playwright configs; everything runs again",
            configs.len()
        ));
        return;
    }
    // A list of what to leave out rather than Playwright's --last-failed: its `.last-run.json` is the last run of any
    // command in that output folder, and it does not name the tests a run that was cut off never reached.
    let mut lines = Vec::new();
    for t in tests.iter().filter(|r| r.status == "passed") {
        // --test-list splits at `›` and matches a title path as a prefix: a title holding `›`, or a test whose
        // titles begin another test's, cannot be named alone.
        let unnameable = t.titles.iter().any(|x| x.contains('›') || x.contains('>'))
            || t.project.contains(['[', ']'])
            || tests.iter().any(|u| {
                u.project == t.project
                    && u.file == t.file
                    && u.titles.len() > t.titles.len()
                    && u.titles[..t.titles.len()] == t.titles[..]
            });
        if unnameable {
            continue;
        }
        lines.push(test_list_line(&t.project, &t.file, &t.titles));
        rw.skipped.insert(t.key.clone());
    }
    if lines.is_empty() {
        return;
    }
    rw.files
        .push((e.list_path.to_path_buf(), lines.join("\n") + "\n"));
    extra.push("--test-list-invert".into());
    extra.push(e.list_path.display().to_string());
    extra.push("--pass-with-no-tests".into());
}

fn narrow_vitest(e: &Earlier, extra: &mut Vec<String>, rw: &mut Rewrite) {
    let records: Vec<&Record> = e.records.iter().filter(|r| r.runner == "vitest").collect();
    let files: Vec<&&Record> = records.iter().filter(|r| r.file_record).collect();
    let projects: BTreeSet<&str> = files.iter().map(|r| r.project.as_str()).collect();
    // Rerun by test name: the files that failed, and in them only the tests that did not pass (`-t`, matched against
    // the test's full name, its suites and its own name joined by spaces). Only where every failed file has a failed
    // test to name (a file that did not load, or a failed hook, names none) and no name holds `>`, which the
    // reporter's split cannot give back.
    if e.failed_only && e.complete {
        let failed_files: BTreeSet<(&str, &str)> = files
            .iter()
            .filter(|f| f.status != "passed")
            .map(|f| (f.project.as_str(), f.file.as_str()))
            .collect();
        let failed_tests: Vec<&&Record> = records
            .iter()
            .filter(|r| !r.file_record && !matches!(r.status.as_str(), "passed" | "skipped"))
            .collect();
        let nameable = !failed_files.is_empty()
            && failed_files
                .iter()
                .all(|(p, f)| failed_tests.iter().any(|t| t.project == *p && t.file == *f))
            && failed_tests
                .iter()
                .all(|t| !t.titles.iter().any(|x| x.contains('>')))
            && !records.iter().any(|r| r.key.starts_with("vitest error|"));
        if nameable {
            let names: BTreeSet<String> = failed_tests
                .iter()
                .map(|t| regex_escape(&t.titles.join(" ")))
                .collect();
            let paths: BTreeSet<&str> = failed_files.iter().map(|(_, f)| *f).collect();
            extra.extend(paths.iter().map(|p| (*p).to_string()));
            extra.push("-t".into());
            extra.push(format!(
                "(?:^| )(?:{})$",
                names.into_iter().collect::<Vec<_>>().join("|")
            ));
            for r in &records {
                if r.status == "passed" && !r.file_record {
                    rw.skipped.insert(r.key.clone());
                }
                if r.file_record && r.status == "passed" {
                    rw.skipped.insert(r.key.clone());
                }
            }
            return;
        }
    }
    if !e.complete && projects.len() > 1 {
        rw.notes.push(
            "the earlier run stopped part way through several Vitest projects; a file left out by --exclude would be \
             left out of every project, so everything runs again"
                .into(),
        );
        return;
    }
    // A file is left out only when it passed in every project it ran in.
    let mut by_file: HashMap<&str, bool> = HashMap::new();
    for f in &files {
        let entry = by_file.entry(f.file.as_str()).or_insert(true);
        *entry &= f.status == "passed";
    }
    let mut passed: Vec<&str> = by_file
        .into_iter()
        .filter(|(_, ok)| *ok)
        .map(|(f, _)| f)
        .collect();
    passed.sort_unstable();
    if passed.is_empty() {
        return;
    }
    for f in &passed {
        extra.push(format!("--exclude={}", glob_escape(f)));
    }
    for r in &records {
        if passed.contains(&r.file.as_str()) {
            rw.skipped.insert(r.key.clone());
        }
    }
    extra.push("--passWithNoTests".into());
}

fn narrow_jest(e: &Earlier, extra: &mut Vec<String>, rw: &mut Rewrite) {
    // Jest has no exclusion that keeps the configuration's own (`--testPathIgnorePatterns` replaces it), so the files
    // to run are named instead: every test file (`--listTests`, which `check` asks for first) but those that passed.
    // Not `--onlyFailures`: it reads Jest's own cache of the last run of any command, not the run reused from.
    let Some(all) = e.jest_files else {
        return;
    };
    let passed: BTreeSet<&str> = e
        .records
        .iter()
        .filter(|r| r.runner == "jest" && r.file_record && r.status == "passed")
        .map(|r| r.abs.as_str())
        .collect();
    if passed.is_empty() {
        return;
    }
    let remaining: Vec<&String> = all
        .iter()
        .filter(|f| !passed.contains(f.as_str()))
        .collect();
    for r in e.records.iter().filter(|r| r.runner == "jest") {
        if passed.contains(r.abs.as_str()) {
            rw.skipped.insert(r.key.clone());
        }
    }
    if remaining.is_empty() {
        rw.nothing_left = true;
        return;
    }
    extra.push("--passWithNoTests".into());
    extra.push("--runTestsByPath".into());
    extra.extend(remaining.into_iter().cloned());
}

fn narrow_cargo(e: &Earlier, argv: &[String], extra: &mut Vec<String>, rw: &mut Rewrite) {
    // By exact test name, after `--`: only when nothing changed, the earlier run reported every test of every
    // binary, and the command passes nothing to the test binaries itself.
    if !e.failed_only || !e.complete || argv.iter().any(|a| a == "--") {
        return;
    }
    let tests: Vec<&Record> = e.records.iter().filter(|r| r.runner == "cargo").collect();
    let name = |r: &Record| r.titles.first().cloned().unwrap_or_default();
    let failed: BTreeSet<String> = tests
        .iter()
        .filter(|r| !matches!(r.status.as_str(), "passed" | "skipped"))
        .map(|r| name(r))
        .collect();
    if failed.is_empty() {
        return;
    }
    for r in &tests {
        // A pass reused only where no test of the same name failed in another binary: the filter runs it everywhere.
        if r.status == "passed" && !failed.contains(&name(r)) {
            rw.skipped.insert(r.key.clone());
        }
    }
    extra.push("--".into());
    extra.push("--exact".into());
    extra.extend(failed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn finds_the_runner_a_command_invokes() {
        let cwd = std::env::temp_dir();
        assert_eq!(
            detect(&argv("npx playwright test --project=chromium"), &cwd).kind,
            Kind::Playwright
        );
        assert_eq!(
            detect(&argv("bunx playwright test"), &cwd).kind,
            Kind::Playwright
        );
        assert_eq!(
            detect(&argv("node_modules/.bin/vitest run"), &cwd).kind,
            Kind::Vitest
        );
        assert_eq!(detect(&argv("pnpm exec jest"), &cwd).kind, Kind::Jest);
        assert_eq!(
            detect(&argv("cargo test --workspace"), &cwd).kind,
            Kind::Cargo
        );
        assert_eq!(detect(&argv("cargo build"), &cwd).kind, Kind::Command);
        assert_eq!(
            detect(&argv("playwright install"), &cwd).kind,
            Kind::Command
        );
        assert_eq!(
            detect(&argv("./scripts/release-check.sh"), &cwd).kind,
            Kind::Command
        );
    }

    #[test]
    fn reads_a_package_script_that_is_one_runner_command() {
        let dir = std::env::temp_dir().join(format!("ompdesk-detect-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"e2e":"playwright test","test":"vitest run","gate":"tsc && vitest run"}}"#,
        )
        .unwrap();
        let e2e = detect(&argv("bun run e2e"), &dir);
        assert_eq!(e2e.kind, Kind::Playwright);
        assert!(!e2e.needs_dashdash);
        let npm = detect(&argv("npm test"), &dir);
        assert_eq!(npm.kind, Kind::Vitest);
        assert!(npm.needs_dashdash);
        assert_eq!(detect(&argv("npm run gate"), &dir).kind, Kind::Command);
        let _ = fs::remove_dir_all(dir);
    }

    fn rec(
        runner: &str,
        project: &str,
        file: &str,
        titles: &[&str],
        status: &str,
        file_record: bool,
    ) -> Record {
        Record {
            key: format!(
                "{runner}|{project}|{file}|{}|{file_record}",
                titles.join(">")
            ),
            status: status.into(),
            ms: 10,
            file_record,
            runner: runner.into(),
            project: project.into(),
            file: file.into(),
            abs: format!("/r/{file}"),
            titles: titles.iter().map(|t| t.to_string()).collect(),
            config: "/r/playwright.config.ts".into(),
        }
    }

    fn reporters() -> Reporters {
        Reporters {
            playwright: "/s/p.cjs".into(),
            vitest: "/s/v.mjs".into(),
            jest: "/s/j.cjs".into(),
        }
    }

    #[test]
    fn playwright_leaves_out_only_what_passed_and_can_be_named() {
        let earlier = vec![
            rec("playwright", "", "a.spec.ts", &["opens"], "passed", false),
            rec("playwright", "", "a.spec.ts", &["closes"], "failed", false),
            rec("playwright", "", "b.spec.ts", &["group"], "passed", false),
            rec(
                "playwright",
                "",
                "b.spec.ts",
                &["group", "inner"],
                "failed",
                false,
            ),
            rec("playwright", "", "c.spec.ts", &["a › b"], "passed", false),
            rec("playwright", "", "d.spec.ts", &["slow"], "flaky", false),
        ];
        let d = Detected {
            kind: Kind::Playwright,
            needs_dashdash: false,
            script: None,
        };
        let e = Earlier {
            records: &earlier,
            complete: false,
            failed_only: true,
            list_path: Path::new("/s/list.txt"),
            jest_files: None,
        };
        let rw = rewrite(&d, &argv("npx playwright test"), &reporters(), Some(&e));
        assert_eq!(rw.files.len(), 1);
        assert_eq!(rw.files[0].1, "[] › a.spec.ts › opens\n");
        assert_eq!(
            rw.argv,
            argv("npx playwright test --test-list-invert /s/list.txt --pass-with-no-tests")
        );
        assert_eq!(rw.skipped.len(), 1);
        assert_eq!(rw.env["PW_TEST_REPORTER"], "/s/p.cjs");
    }

    #[test]
    fn vitest_leaves_out_files_that_passed_in_every_project() {
        let earlier = vec![
            rec("vitest", "node", "a.test.ts", &[], "passed", true),
            rec("vitest", "node", "a.test.ts", &["x"], "passed", false),
            rec("vitest", "node", "b[1].test.ts", &[], "passed", true),
            rec("vitest", "node", "c.test.ts", &[], "failed", true),
            rec("vitest", "renderer", "d.test.ts", &[], "passed", true),
            rec("vitest", "node", "d.test.ts", &[], "failed", true),
        ];
        let d = Detected {
            kind: Kind::Vitest,
            needs_dashdash: true,
            script: Some("test".into()),
        };
        let mut e = Earlier {
            records: &earlier,
            complete: true,
            failed_only: false,
            list_path: Path::new("/x"),
            jest_files: None,
        };
        let rw = rewrite(&d, &argv("npm test"), &reporters(), Some(&e));
        assert_eq!(
            rw.argv,
            argv(
                "npm test -- --reporter=default --reporter=/s/v.mjs --exclude=a.test.ts --exclude=b\\[1\\].test.ts --passWithNoTests"
            )
        );
        assert_eq!(rw.skipped.len(), 3);
        e.complete = false;
        let partial = rewrite(&d, &argv("npm test"), &reporters(), Some(&e));
        assert!(partial.skipped.is_empty());
        assert_eq!(partial.notes.len(), 1);
    }

    #[test]
    fn vitest_reruns_failed_tests_by_name_when_nothing_changed() {
        let earlier = vec![
            rec("vitest", "node", "a.test.ts", &[], "failed", true),
            rec(
                "vitest",
                "node",
                "a.test.ts",
                &["suite", "breaks (1)"],
                "failed",
                false,
            ),
            rec(
                "vitest",
                "node",
                "a.test.ts",
                &["suite", "works"],
                "passed",
                false,
            ),
            rec("vitest", "node", "b.test.ts", &[], "passed", true),
            rec("vitest", "node", "b.test.ts", &["fine"], "passed", false),
        ];
        let d = Detected {
            kind: Kind::Vitest,
            needs_dashdash: false,
            script: None,
        };
        let mut e = Earlier {
            records: &earlier,
            complete: true,
            failed_only: true,
            list_path: Path::new("/x"),
            jest_files: None,
        };
        let rw = rewrite(&d, &argv("vitest run"), &reporters(), Some(&e));
        assert_eq!(
            rw.argv,
            vec![
                "vitest",
                "run",
                "--reporter=default",
                "--reporter=/s/v.mjs",
                "a.test.ts",
                "-t",
                "(?:^| )(?:suite breaks \\(1\\))$"
            ]
        );
        assert_eq!(rw.skipped.len(), 3);
        // A file that failed with no failed test to name (it did not load) runs whole instead.
        let mut more = earlier.clone();
        more.push(rec("vitest", "node", "c.test.ts", &[], "failed", true));
        e.records = &more;
        let rw = rewrite(&d, &argv("vitest run"), &reporters(), Some(&e));
        assert!(!rw.argv.contains(&"-t".to_string()));
        assert!(rw.argv.contains(&"--exclude=b.test.ts".to_string()));
    }

    #[test]
    fn cargo_reruns_failed_tests_by_exact_name() {
        let earlier = vec![
            rec("cargo", "", "unit (x)", &["a::b"], "passed", false),
            rec("cargo", "", "unit (x)", &["a::c"], "failed", false),
            rec("cargo", "", "unit (y)", &["a::c"], "passed", false),
        ];
        let d = Detected {
            kind: Kind::Cargo,
            needs_dashdash: false,
            script: None,
        };
        let e = Earlier {
            records: &earlier,
            complete: true,
            failed_only: true,
            list_path: Path::new("/x"),
            jest_files: None,
        };
        let rw = rewrite(&d, &argv("cargo test --workspace"), &reporters(), Some(&e));
        assert_eq!(
            rw.argv,
            argv("cargo test --no-fail-fast --workspace -- --exact a::c")
        );
        assert_eq!(rw.skipped.len(), 1);
        let plain = rewrite(&d, &argv("cargo test -- --nocapture"), &reporters(), None);
        assert_eq!(plain.argv, argv("cargo test --no-fail-fast -- --nocapture"));
    }

    #[test]
    fn namesakes_in_one_file_keep_their_own_results() {
        let path =
            std::env::temp_dir().join(format!("ompdesk-namesakes-{}.jsonl", std::process::id()));
        let line = |status: &str| {
            format!(
                r#"{{"runner":"vitest","project":"node","file":"a.test.ts","titles":["same"],"status":"{status}"}}"#
            )
        };
        fs::write(&path, format!("{}\n{}\n", line("passed"), line("failed"))).unwrap();
        let (records, _) = read_results(&path);
        let _ = fs::remove_file(&path);
        assert_eq!(records.len(), 2);
        assert_ne!(records[0].key, records[1].key);
        assert_eq!(records[1].status, "failed");
    }

    #[test]
    fn reads_cargo_test_lines() {
        let log = "     Running unittests src/lib.rs (target/debug/deps/x_y-1a2b)\n\nrunning 3 tests\ntest a::b ... ok\ntest a::c ... FAILED\ntest a::d ... ignored, slow\n   Doc-tests x\n\nrunning 1 test\ntest src/lib.rs - f (line 3) ... ok\n";
        let (r, complete) = cargo_results(log);
        assert!(complete);
        assert_eq!(r.len(), 4);
        assert_eq!(r[0].key, "cargo|unittests src/lib.rs (x_y)|a::b");
        assert_eq!(r[1].status, "failed");
        assert_eq!(r[2].status, "skipped");
        assert_eq!(r[3].key, "cargo|doc-tests x|src/lib.rs - f (line 3)");
        let (_, cut) = cargo_results(&log.replace("test src/lib.rs - f (line 3) ... ok\n", ""));
        assert!(!cut);
    }
}
