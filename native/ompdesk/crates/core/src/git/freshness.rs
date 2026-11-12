//! The memory freshness check's git (was `RepoReader`, `resolveRef`, `mainCheckout` and `judgePage` of
//! `src/main/ai-memory/freshness.ts`): the project's main checkout among its sessions' folders, the ref the names are
//! read at and that ref's top-level folders (`checkout`), then a page's verdict from what git says of each path and
//! symbol it names (`verdict`). A check is one `checkout` and one `verdict` per page, in the order main reads them;
//! what the check learned so far (each name's status, the `git log -S` runs left of `PICKAXE_BUDGET`) is a `State`
//! each verdict answers and main hands to the next one unread, so a name is asked once per check and the budget is
//! the check's, with no state kept here between requests. Read-only: no optional locks (main's runner sets
//! `GIT_OPTIONAL_LOCKS=0`), never the working tree, never the network. Every git gets main's timeout, and one that
//! cannot run or runs past it counts as git not knowing, as the TypeScript caught it. Main keeps the memory client,
//! which pages are read and when the check stops, the page parser (`namedItems`) and what a verdict does to a page.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::pin::Pin;
use std::task::Poll;

use serde::{Deserialize, Serialize};

use super::read::{blocking, is_absolute};
use super::run::Git;
use crate::fs::order::js_trim;
use crate::run::{Opts, Output};

/// `git log -S` walks the whole history (1-2 s on this repository): a check spends at most this many on symbols.
const PICKAXE_BUDGET: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum NameStatus {
    Exists,
    /// History deleted it.
    Deleted,
    /// History renamed it and the new name exists.
    Moved,
    /// History never held it: an external name, an example, a file of an unmerged branch.
    Unknown,
}

/// What `git grep -q` said of a symbol at the ref. A grep that could not run counts as found, as the TypeScript had it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Grep {
    Found,
    Absent,
    Failed,
}

impl Grep {
    /// The status without a pickaxe.
    fn status(self) -> NameStatus {
        match self {
            Grep::Found => NameStatus::Exists,
            Grep::Absent | Grep::Failed => NameStatus::Unknown,
        }
    }
}

/// The main checkout, the ref its names are read at, and the ref's top-level folders (more roots for `namedItems`).
#[derive(Serialize)]
pub struct Checkout {
    checkout: String,
    #[serde(rename = "ref")]
    reference: String,
    roots: Vec<String>,
}

/// The repository paths and code symbols one page names (main's `namedItems`).
#[derive(Deserialize)]
pub struct Named {
    paths: Vec<String>,
    symbols: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Retire,
    Flag,
    Leave,
}

/// What to do with a page, and its names that are gone (deleted or moved), paths first.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Verdict {
    action: Action,
    gone: Vec<String>,
}

/// What one check learned so far: each name's status and the pickaxe runs left. Main passes it on as it came.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    paths: HashMap<String, NameStatus>,
    symbols: HashMap<String, NameStatus>,
    pickaxe_left: usize,
}

impl Default for State {
    fn default() -> State {
        State {
            paths: HashMap::new(),
            symbols: HashMap::new(),
            pickaxe_left: PICKAXE_BUDGET,
        }
    }
}

/// A page's verdict and the check's state after it.
#[derive(Serialize)]
pub struct Judged {
    #[serde(flatten)]
    verdict: Verdict,
    state: State,
}

/// A git's output; none when it could not run or ran past its timeout (the TypeScript caught both as `null`).
async fn output(git: &Git, cwd: &str, args: &[&str], timeout_ms: u64) -> Option<Output> {
    let opts = Opts {
        timeout_ms: Some(timeout_ms),
        ..Opts::default()
    };
    git.run(cwd, args, opts).await.ok()
}

/// The trimmed stdout of a git that succeeded with some.
fn said(output: Option<&Output>) -> Option<String> {
    let output = output.filter(|output| output.code == 0)?;
    let text = output.text();
    let text = js_trim(&text);
    (!text.is_empty()).then(|| text.to_owned())
}

/// stdout's non-empty lines of a git that succeeded, untrimmed.
fn lines(output: Option<&Output>) -> Vec<String> {
    output
        .filter(|output| output.code == 0)
        .map(|output| {
            output
                .text()
                .split('\n')
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `existsSync`.
async fn exists(path: &str) -> bool {
    let path = path.to_owned();
    blocking(move || Path::new(&path).exists())
        .await
        .unwrap_or(false)
}

/// The checkout holding a common git dir named `.git`, as node's `dirname` spells it.
fn checkout_of(common: &str) -> Option<&str> {
    let path = Path::new(common);
    if path.file_name()? != ".git" {
        return None;
    }
    path.parent()?.to_str()
}

/// The refs a check may read, in order: what `origin/HEAD` names, then the usual default branches, then `HEAD`.
fn ref_candidates(origin: Option<&str>) -> impl Iterator<Item = &str> {
    origin.into_iter().chain(["main", "master", "HEAD"])
}

/// The project's main checkout: the first of `cwds` (newest first) that is a live folder in a repository whose
/// common git dir is a `.git` folder, taken to the checkout that holds it.
async fn main_checkout(git: &Git, cwds: &[String], timeout_ms: u64) -> Option<String> {
    let mut tried: HashSet<&str> = HashSet::new();
    for cwd in cwds {
        if cwd.is_empty() || !is_absolute(cwd) || tried.contains(cwd.as_str()) || !exists(cwd).await
        {
            continue;
        }
        tried.insert(cwd);
        let args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
        let common = said(output(git, cwd, &args, timeout_ms).await.as_ref());
        if let Some(common) = common
            && let Some(checkout) = checkout_of(&common)
            && exists(checkout).await
        {
            return Some(checkout.to_owned());
        }
    }
    None
}

/// The first candidate ref that names a commit.
async fn resolve_ref(git: &Git, checkout: &str, timeout_ms: u64) -> Option<String> {
    let args = ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"];
    let origin = said(output(git, checkout, &args, timeout_ms).await.as_ref());
    for candidate in ref_candidates(origin.as_deref()) {
        let commit = format!("{candidate}^{{commit}}");
        let args = ["rev-parse", "--verify", "-q", commit.as_str()];
        if said(output(git, checkout, &args, timeout_ms).await.as_ref()).is_some() {
            return Some(candidate.to_owned());
        }
    }
    None
}

/// The main checkout among `cwds`, its ref and the ref's top-level folders; none when no folder is a live checkout
/// or no ref names a commit.
pub async fn checkout(git: &Git, cwds: &[String], timeout_ms: u64) -> Option<Checkout> {
    let checkout = main_checkout(git, cwds, timeout_ms).await?;
    let reference = resolve_ref(git, &checkout, timeout_ms).await?;
    let args = ["ls-tree", "-d", "--name-only", reference.as_str()];
    let roots = lines(output(git, &checkout, &args, timeout_ms).await.as_ref());
    Some(Checkout {
        checkout,
        reference,
        roots,
    })
}

/// The new names `git show -M --name-status` gives `path`: lines `R<score>\t<path>\t<new>`, split on tabs as the
/// TypeScript split them (nothing trimmed, a fourth field ignored).
fn renamed_to<'a>(shown: &'a str, path: &'a str) -> impl Iterator<Item = &'a str> {
    shown.split('\n').filter_map(move |line| {
        let mut fields = line.split('\t');
        let (status, from, to) = (fields.next()?, fields.next()?, fields.next()?);
        (status.starts_with('R') && from == path && !to.is_empty()).then_some(to)
    })
}

fn grep_says(output: Option<&Output>) -> Grep {
    match output.map(|output| output.code) {
        None | Some(0) => Grep::Found,
        Some(1) => Grep::Absent,
        Some(_) => Grep::Failed,
    }
}

/// A page with no gone name stays; one whose gone names stand alone (nothing existing or moved beside them, no path
/// history never held) is retired; the rest is flagged.
fn judge(paths: &[(&str, NameStatus)], symbols: &[(&str, NameStatus)]) -> Verdict {
    let all = || paths.iter().chain(symbols);
    let gone: Vec<String> = all()
        .filter(|(_, status)| matches!(status, NameStatus::Deleted | NameStatus::Moved))
        .map(|(name, _)| (*name).to_owned())
        .collect();
    if gone.is_empty() {
        return Verdict {
            action: Action::Leave,
            gone,
        };
    }
    let blocked = all().any(|(_, status)| matches!(status, NameStatus::Exists | NameStatus::Moved));
    let unseen_path = paths
        .iter()
        .any(|(_, status)| *status == NameStatus::Unknown);
    Verdict {
        action: if blocked || unseen_path {
            Action::Flag
        } else {
            Action::Retire
        },
        gone,
    }
}

/// Runs every future at once and answers their outputs in order (`Promise.all` of futures that never fail).
async fn join_all<F: Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut futures: Vec<Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
    let mut outputs: Vec<Option<F::Output>> = futures.iter().map(|_| None).collect();
    std::future::poll_fn(|context| {
        let mut pending = false;
        for (future, output) in futures.iter_mut().zip(outputs.iter_mut()) {
            if output.is_none() {
                match future.as_mut().poll(context) {
                    Poll::Ready(value) => *output = Some(value),
                    Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
    outputs.into_iter().flatten().collect()
}

/// `names` not yet known, once each, in order.
fn unknown<'a>(names: &'a [String], known: &HashMap<String, NameStatus>) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    names
        .iter()
        .map(String::as_str)
        .filter(|name| !known.contains_key(*name) && seen.insert(*name))
        .collect()
}

fn statuses<'a>(
    names: &'a [String],
    known: &HashMap<String, NameStatus>,
) -> Vec<(&'a str, NameStatus)> {
    names
        .iter()
        .map(|name| (name.as_str(), known[name]))
        .collect()
}

/// Read-only git against one checkout at one ref.
struct Reader<'a> {
    git: &'a Git,
    checkout: &'a str,
    reference: &'a str,
    timeout_ms: u64,
}

impl Reader<'_> {
    async fn git(&self, args: &[&str]) -> Option<Output> {
        output(self.git, self.checkout, args, self.timeout_ms).await
    }

    async fn exists(&self, path: &str) -> bool {
        let spec = format!("{}:{path}", self.reference);
        let found = self.git(&["cat-file", "-e", spec.as_str()]).await;
        found.is_some_and(|found| found.code == 0)
    }

    async fn path_status(&self, path: &str) -> NameStatus {
        if self.exists(path).await {
            return NameStatus::Exists;
        }
        let args = [
            "log",
            "--diff-filter=D",
            "--format=%H",
            "-1",
            self.reference,
            "--",
            path,
        ];
        let Some(commit) = said(self.git(&args).await.as_ref()) else {
            return NameStatus::Unknown;
        };
        // Read whatever git printed, also from a failed or cut `show`: a rename past it reads as a deletion.
        let shown = self
            .git(&["show", "-M", "--name-status", "--format=", commit.as_str()])
            .await
            .map(|shown| shown.text())
            .unwrap_or_default();
        for to in renamed_to(&shown, path) {
            if self.exists(to).await {
                return NameStatus::Moved;
            }
        }
        NameStatus::Deleted
    }

    async fn grep(&self, symbol: &str) -> Grep {
        let args = ["grep", "-w", "-q", "-F", "-e", symbol, self.reference];
        grep_says(self.git(&args).await.as_ref())
    }

    async fn pickaxe(&self, symbol: &str) -> NameStatus {
        let search = format!("-S{symbol}");
        let args = ["log", search.as_str(), "--format=%H", "-1", self.reference];
        if said(self.git(&args).await.as_ref()).is_some() {
            NameStatus::Deleted
        } else {
            NameStatus::Unknown
        }
    }

    /// Each symbol's status by `git grep` at the ref; the absent ones, in order while `budget` lasts, by whether
    /// history ever added or removed them. Answers the statuses and the pickaxe runs spent.
    async fn symbols(&self, symbols: &[&str], budget: usize) -> (Vec<NameStatus>, usize) {
        let greps = join_all(symbols.iter().map(|symbol| self.grep(symbol)).collect()).await;
        let mut statuses: Vec<NameStatus> = greps.iter().map(|grep| grep.status()).collect();
        let searched: Vec<usize> = greps
            .iter()
            .enumerate()
            .filter(|(_, grep)| **grep == Grep::Absent)
            .map(|(index, _)| index)
            .take(budget)
            .collect();
        let found = join_all(
            searched
                .iter()
                .map(|&index| self.pickaxe(symbols[index]))
                .collect(),
        )
        .await;
        for (&index, status) in searched.iter().zip(found) {
            statuses[index] = status;
        }
        (statuses, searched.len())
    }

    /// Asks git about the names of `page` the check does not know yet, all at once.
    async fn learn(&self, page: &Named, state: &mut State) {
        let paths = unknown(&page.paths, &state.paths);
        let symbols = unknown(&page.symbols, &state.symbols);
        let (path_statuses, (symbol_statuses, spent)) = tokio::join!(
            join_all(paths.iter().map(|path| self.path_status(path)).collect()),
            self.symbols(&symbols, state.pickaxe_left),
        );
        state.pickaxe_left -= spent;
        state
            .paths
            .extend(paths.into_iter().map(str::to_owned).zip(path_statuses));
        state
            .symbols
            .extend(symbols.into_iter().map(str::to_owned).zip(symbol_statuses));
    }
}

/// `page`'s verdict against `checkout` at `reference`, given what the check learned before it (none for its first
/// page), and what the check knows after it.
pub async fn verdict(
    git: &Git,
    checkout: &str,
    reference: &str,
    page: &Named,
    state: Option<State>,
    timeout_ms: u64,
) -> Judged {
    let reader = Reader {
        git,
        checkout,
        reference,
        timeout_ms,
    };
    let mut state = state.unwrap_or_default();
    reader.learn(page, &mut state).await;
    let verdict = judge(
        &statuses(&page.paths, &state.paths),
        &statuses(&page.symbols, &state.symbols),
    );
    Judged { verdict, state }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use serde_json::Value;

    use super::*;
    use crate::git::run::tests::git;

    /// Rows captured from the TypeScript (`freshness.ts` with a scripted `gitRaw`) before it was deleted.
    fn captured(table: &str) -> Vec<Value> {
        let rows: Value = serde_json::from_str(include_str!("freshness-captured.json")).unwrap();
        rows[table].as_array().unwrap().clone()
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }

    fn texts(value: &Value) -> Vec<&str> {
        value.as_array().unwrap().iter().map(text).collect()
    }

    /// A captured git answer: `null` for a git that could not run, else its exit code and stdout.
    fn reply(value: &Value) -> Option<Output> {
        (!value.is_null()).then(|| Output {
            code: value["code"].as_i64().unwrap() as i32,
            stdout: text(&value["stdout"]).as_bytes().to_vec(),
            stderr: String::new(),
            truncated: false,
        })
    }

    fn status(value: &Value) -> NameStatus {
        match text(value) {
            "exists" => NameStatus::Exists,
            "deleted" => NameStatus::Deleted,
            "moved" => NameStatus::Moved,
            "unknown" => NameStatus::Unknown,
            other => panic!("{other}"),
        }
    }

    /// A captured list of statuses as names `<prefix><index>` with them.
    fn statuses_of(value: &Value, prefix: &str) -> Vec<(String, NameStatus)> {
        value
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, value)| (format!("{prefix}{index}"), status(value)))
            .collect()
    }

    fn borrowed(named: &[(String, NameStatus)]) -> Vec<(&str, NameStatus)> {
        named
            .iter()
            .map(|(name, status)| (name.as_str(), *status))
            .collect()
    }

    #[test]
    fn judges_pages_as_the_typescript_did() {
        let rows = captured("judge");
        assert_eq!(rows.len(), 441);
        for row in rows {
            let paths = statuses_of(&row[0], "p");
            let symbols = statuses_of(&row[1], "s");
            let verdict = judge(&borrowed(&paths), &borrowed(&symbols));
            assert_eq!(
                serde_json::to_value(verdict.action).unwrap(),
                row[2],
                "{row}"
            );
            assert_eq!(verdict.gone, texts(&row[3]), "{row}");
        }
    }

    #[test]
    fn reads_renames_as_the_typescript_did() {
        for row in captured("renames") {
            let path = text(&row[0]);
            let asked: Vec<&str> = renamed_to(text(&row[1]), path).collect();
            assert_eq!(asked, texts(&row[2]), "{row}");
            // The capture's second run had every name but `path` itself exist.
            assert_eq!(status(&row[3]), NameStatus::Deleted, "{row}");
            let moved = asked.iter().any(|to| *to != path);
            assert_eq!(status(&row[4]) == NameStatus::Moved, moved, "{row}");
        }
    }

    #[test]
    fn reads_git_s_answers_as_the_typescript_did() {
        for row in captured("deleted") {
            let commit = said(reply(&row[0]).as_ref());
            assert_eq!(commit.as_deref(), row[2].as_str(), "{row}");
            let want = if commit.is_some() {
                NameStatus::Deleted
            } else {
                NameStatus::Unknown
            };
            assert_eq!(status(&row[1]), want, "{row}");
        }
        for row in captured("exists") {
            let found = reply(&row[0]).is_some_and(|found| found.code == 0);
            assert_eq!(status(&row[1]) == NameStatus::Exists, found, "{row}");
        }
        for row in captured("verify") {
            let verified = said(reply(&row[0]).as_ref()).is_some();
            assert_eq!(row[1].as_str() == Some("main"), verified, "{row}");
        }
        for row in captured("roots") {
            assert_eq!(lines(reply(&row[0]).as_ref()), texts(&row[1]), "{row}");
        }
    }

    #[test]
    fn spends_the_pickaxe_as_the_typescript_did() {
        let rows = captured("symbols");
        assert_eq!(rows.len(), 98);
        for row in rows {
            let grep = grep_says(reply(&row[0]).as_ref());
            let ran = grep == Grep::Absent && row[1].as_u64().unwrap() > 0;
            assert_eq!(row[4].as_bool().unwrap(), ran, "{row}");
            let want = if !ran {
                grep.status()
            } else if said(reply(&row[2]).as_ref()).is_some() {
                NameStatus::Deleted
            } else {
                NameStatus::Unknown
            };
            assert_eq!(status(&row[3]), want, "{row}");
        }
    }

    #[test]
    fn picks_the_ref_as_the_typescript_did() {
        for row in captured("refs") {
            let origin = said(reply(&row[0]).as_ref());
            let verified = texts(&row[1]);
            let mut asked = Vec::new();
            let mut chosen = None;
            for candidate in ref_candidates(origin.as_deref()) {
                asked.push(candidate);
                if verified.contains(&candidate) {
                    chosen = Some(candidate);
                    break;
                }
            }
            assert_eq!(chosen, row[2].as_str(), "{row}");
            assert_eq!(asked, texts(&row[3]), "{row}");
        }
    }

    #[test]
    fn finds_the_checkout_of_a_common_dir_as_node_did() {
        let rows: Value = serde_json::from_str(include_str!("freshness-captured.json")).unwrap();
        let flavor = if cfg!(windows) { "win32" } else { "posix" };
        for row in rows["common"][flavor].as_array().unwrap() {
            assert_eq!(checkout_of(text(&row[0])), row[1].as_str(), "{row}");
        }
    }

    fn sh(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    fn named(paths: &[&str], symbols: &[&str]) -> Named {
        Named {
            paths: paths.iter().map(|path| (*path).to_owned()).collect(),
            symbols: symbols.iter().map(|symbol| (*symbol).to_owned()).collect(),
        }
    }

    fn expected(action: Action, gone: &[&str]) -> Verdict {
        Verdict {
            action,
            gone: gone.iter().map(|name| (*name).to_owned()).collect(),
        }
    }

    #[tokio::test]
    async fn checks_pages_in_order_with_one_pickaxe_budget_per_check() {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-freshness-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let main = dir.join("main");
        std::fs::create_dir_all(main.join("src/main")).unwrap();
        sh(&main, &["init", "-q", "-b", "main"]);
        let gone: Vec<String> = (0..10).map(|n| format!("goneSymbol{n}")).collect();
        let body: String = gone
            .iter()
            .map(|name| format!("export const {name} = 1;\n"))
            .collect();
        std::fs::write(main.join("src/main/old.ts"), body).unwrap();
        std::fs::write(
            main.join("src/main/keep.ts"),
            "export function keepAlive() {}\n",
        )
        .unwrap();
        std::fs::write(
            main.join("src/main/moved-old.ts"),
            "export const movedThing = 1;\n".repeat(5),
        )
        .unwrap();
        sh(&main, &["add", "-A"]);
        sh(&main, &["commit", "-qm", "one"]);
        std::fs::create_dir_all(main.join("src/lib")).unwrap();
        sh(&main, &["rm", "-q", "src/main/old.ts"]);
        sh(
            &main,
            &["mv", "src/main/moved-old.ts", "src/lib/moved-new.ts"],
        );
        sh(&main, &["commit", "-qm", "two"]);
        let worktree = dir.join("wt");
        sh(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                worktree.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );

        let git = git();
        let cwds: Vec<String> = [
            String::new(),
            "relative/folder".to_owned(),
            dir.join("missing").to_string_lossy().into_owned(),
            worktree.to_string_lossy().into_owned(),
        ]
        .into();
        let found = checkout(&git, &cwds, 20_000).await.unwrap();
        assert_eq!(
            std::fs::canonicalize(&found.checkout).unwrap(),
            std::fs::canonicalize(&main).unwrap()
        );
        assert_eq!(found.reference, "main");
        assert_eq!(found.roots, ["src"]);
        assert!(checkout(&git, &cwds[..3], 20_000).await.is_none());

        let ten: Vec<&str> = gone.iter().map(String::as_str).collect();
        let pages = [
            named(&[], &ten),
            named(&[], &["goneSymbol9"]),
            named(&["src/main/old.ts"], &["goneSymbol0"]),
            named(&["src/main/moved-old.ts"], &[]),
            named(
                &["src/main/keep.ts", "src/main/never-was.ts"],
                &["keepAlive"],
            ),
            named(&["src/main/old.ts", "src/main/never-was.ts"], &[]),
            named(&[], &[]),
        ];
        let mut state: Option<State> = None;
        let mut answered = Vec::new();
        for page in &pages {
            let judged =
                verdict(&git, &found.checkout, &found.reference, page, state, 20_000).await;
            // Main hands the state on as JSON, unread.
            let wire = serde_json::to_value(&judged.state).unwrap();
            state = Some(serde_json::from_value(wire).unwrap());
            answered.push(judged.verdict);
        }
        assert_eq!(
            answered,
            [
                expected(Action::Retire, &ten[..8]),
                expected(Action::Leave, &[]),
                expected(Action::Retire, &["src/main/old.ts", "goneSymbol0"]),
                expected(Action::Flag, &["src/main/moved-old.ts"]),
                expected(Action::Leave, &[]),
                expected(Action::Flag, &["src/main/old.ts"]),
                expected(Action::Leave, &[]),
            ]
        );
        assert_eq!(state.unwrap().pickaxe_left, 0);
        let fresh = verdict(
            &git,
            &found.checkout,
            &found.reference,
            &pages[1],
            None,
            20_000,
        )
        .await;
        assert_eq!(fresh.verdict, expected(Action::Retire, &["goneSymbol9"]));
        assert_eq!(fresh.state.pickaxe_left, PICKAXE_BUDGET - 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
