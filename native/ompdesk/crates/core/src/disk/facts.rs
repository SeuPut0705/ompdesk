//! What disk care reads of one worktree before it touches it (was `src/main/disk/worktree-facts.ts`): its files split
//! by what git and the project say about them, when anyone last changed anything in it, whether a git operation is
//! half done, its HEAD, and the working folders of this user's running processes. Read-only.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use super::regenerable::{self, Disk, Evidence, Regenerable};
use super::tree::under;
use crate::fs::disk::{self, mtime_ms};
use crate::fs::order::js_trim;
use crate::git::read::{blocking, resolve};
use crate::git::run::Git;
use crate::run::{Exec, Opts, Runner};
use crate::server::{Fault, Scope};

/// git's output kept for a worktree's status and file lists.
const LIST_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Entries an activity walk reads before it gives up and calls the worktree active (fail closed).
const ACTIVITY_WALK_LIMIT: usize = 20_000;
/// Markers git leaves while a rebase, merge, cherry-pick, revert or bisect waits to be finished.
const IN_PROGRESS: [&str; 6] = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
];

/// An entry outside HEAD, relative and `/`-separated (a directory ends with `/`), with the evidence that the project
/// makes it again, or none.
#[derive(Serialize)]
pub struct Verdict {
    path: String,
    regenerable: Option<Regenerable>,
}

/// `WorktreeFiles`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Files {
    /// Ignored entries.
    ignored: Vec<Verdict>,
    /// Untracked entries git does not ignore, collapsed to a directory where git collapses them.
    untracked: Vec<Verdict>,
    /// Every untracked file, one per file (what a commit of the worktree would add).
    untracked_files: Vec<String>,
    /// Tracked paths with changes (modified, added, deleted, renamed).
    changed: Vec<String>,
    /// Every tracked path (`git ls-files`).
    tracked: Vec<String>,
    /// `git status` as printed: equal before and after means nothing moved in between.
    fingerprint: String,
}

/// `git status --porcelain=v1 -z` split by kind. A rename or copy prints its old path as one more NUL field.
fn parse_status(output: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (mut ignored, mut untracked, mut changed) = (Vec::new(), Vec::new(), Vec::new());
    let mut fields = output.split('\0');
    while let Some(field) = fields.next() {
        if field.encode_utf16().count() < 4 {
            continue;
        }
        let code: String = field.chars().take(2).collect();
        let file: String = field.chars().skip(3).collect();
        match code.as_str() {
            "!!" => ignored.push(file),
            "??" => untracked.push(file),
            _ => {
                changed.push(file);
                if code.contains(['R', 'C']) {
                    fields.next();
                }
            }
        }
    }
    (ignored, untracked, changed)
}

fn nul_list(text: &str) -> impl Iterator<Item = &str> {
    text.split('\0').filter(|part| !part.is_empty())
}

fn git_failure(message: String) -> Fault {
    Fault::new("git_exit", message)
}

/// `readWorktreeFiles`: status and the untracked files, then the evidence the rules read (the tracked files and
/// `check-ignore -v` of the ignored entries), then each entry classified.
pub async fn files(git: &Git, worktree: &str) -> Result<Files, Fault> {
    let status_args = [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignored=traditional",
    ];
    let others_args = ["ls-files", "--others", "--exclude-standard", "-z"];
    let (status, others) = tokio::join!(
        git.capped(worktree, &status_args, LIST_MAX_BYTES),
        git.capped(worktree, &others_args, LIST_MAX_BYTES)
    );
    let (status, others) = (status?, others?);
    if status.code != 0 || status.truncated {
        return Err(git_failure(format!("git status failed in {worktree}")));
    }
    if others.code != 0 || others.truncated {
        return Err(git_failure(format!("git ls-files failed in {worktree}")));
    }
    let fingerprint = status.text();
    let (ignored, untracked, changed) = parse_status(&fingerprint);
    let trimmed: Vec<&str> = ignored
        .iter()
        .map(|entry| entry.trim_end_matches('/'))
        .collect();
    let mut check = vec!["check-ignore", "-v", "--"];
    check.extend(&trimmed);
    let (listed, checked) = tokio::join!(
        git.capped(worktree, &["ls-files", "-z"], LIST_MAX_BYTES),
        async {
            if trimmed.is_empty() {
                Ok(None)
            } else {
                git.raw(worktree, &check).await.map(Some)
            }
        }
    );
    let (listed, checked) = (listed?, checked?);
    if listed.code != 0 {
        return Err(git_failure(format!(
            "git ls-files failed in {worktree}: {}",
            js_trim(&listed.stderr)
        )));
    }
    let listed = listed.text();
    let mut seen = HashSet::new();
    let tracked: Vec<String> = nul_list(&listed)
        .filter(|path| seen.insert(*path))
        .map(str::to_owned)
        .collect();
    let mut ignored_by = std::collections::HashMap::new();
    if let Some(checked) = checked.filter(|checked| checked.code == 0) {
        for record in checked.text().split('\n') {
            if let Some((source, line, path)) = regenerable::check_ignore_record(record) {
                ignored_by.insert(
                    path.trim_end_matches('/').to_owned(),
                    (source.to_owned(), line),
                );
            }
        }
    }
    let untracked_files = nul_list(&others.text()).map(str::to_owned).collect();
    let root = worktree.to_owned();
    let tracked_set: HashSet<String> = tracked.iter().cloned().collect();
    let (ignored, untracked) = blocking(move || {
        let evidence = Evidence {
            tracked: tracked_set,
            ignored_by,
            source: Disk { root },
        };
        let verdicts = |entries: Vec<String>| -> Result<Vec<Verdict>, Fault> {
            let found = evidence.classify(&entries)?;
            Ok(entries
                .into_iter()
                .zip(found)
                .map(|(path, regenerable)| Verdict { path, regenerable })
                .collect())
        };
        Ok::<_, Fault>((verdicts(ignored)?, verdicts(untracked)?))
    })
    .await??;
    Ok(Files {
        ignored,
        untracked,
        untracked_files,
        changed,
        tracked,
        fingerprint,
    })
}

/// The worktree's git dir as `git rev-parse --git-dir` names it, read from its `.git`: the folder itself, or the file
/// a linked worktree has (`gitdir: <path>`, absolute or relative to the worktree). git itself when neither is there.
pub async fn git_dir(git: &Git, worktree: &str) -> Result<String, Fault> {
    let dot_git = resolve(worktree, ".git");
    let base = worktree.to_owned();
    let named =
        blocking(move || -> Result<Option<String>, Fault> {
            match std::fs::metadata(&dot_git) {
                Ok(meta) if meta.is_dir() => Ok(Some(dot_git)),
                Ok(meta) if meta.is_file() => {
                    let bytes = std::fs::read(&dot_git)
                        .map_err(|error| super::tree::fault(&error, "open", Path::new(&dot_git)))?;
                    Ok(gitdir_line(&String::from_utf8_lossy(&bytes))
                        .map(|named| resolve(&base, named)))
                }
                _ => Ok(None),
            }
        })
        .await??;
    if let Some(named) = named {
        return Ok(named);
    }
    Ok(resolve(
        worktree,
        js_trim(&git.text(worktree, &["rev-parse", "--git-dir"]).await?),
    ))
}

/// `/^gitdir: (.+)$/m`, trimmed: the first line that starts so and names something.
fn gitdir_line(text: &str) -> Option<&str> {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .find_map(|line| {
            line.strip_prefix("gitdir: ")
                .filter(|rest| !rest.is_empty())
        })
        .map(js_trim)
        .filter(|named| !named.is_empty())
}

/// The half-done git operation in the worktree, or none.
pub async fn in_progress(git: &Git, worktree: &str) -> Result<Option<&'static str>, Fault> {
    let dir = git_dir(git, worktree).await?;
    blocking(move || {
        IN_PROGRESS
            .into_iter()
            .find(|marker| std::fs::metadata(Path::new(&dir).join(marker)).is_ok())
    })
    .await
}

/// `git rev-parse HEAD`.
pub async fn head(git: &Git, worktree: &str) -> Result<String, Fault> {
    Ok(js_trim(&git.text(worktree, &["rev-parse", "HEAD"]).await?).to_owned())
}

/// What `lastActivity` reads besides git: the tracked and untracked files (`stamps`, relative), the ignored entries
/// no tool makes again (`ignored`), and stock omp's session folder for the worktree (main resolves it).
pub struct Activity {
    pub stamps: Vec<String>,
    pub ignored: Vec<String>,
    pub sessions: Option<String>,
}

/// When anything in the worktree last changed (epoch ms): its HEAD commit, its git dir's HEAD, index and reflog, the
/// folder, every tracked and untracked file, every ignored entry no tool makes again and the newest session file stock
/// omp wrote for it. None (`Infinity`) when the ignored entries hold more than `ACTIVITY_WALK_LIMIT` entries.
pub async fn last_activity(
    git: &Git,
    worktree: &str,
    activity: Activity,
    scope: &Scope,
) -> Result<Option<f64>, Fault> {
    super::tree::relative_entries(
        activity
            .stamps
            .iter()
            .chain(&activity.ignored)
            .map(String::as_str),
    )?;
    let (committed, dir) = tokio::join!(
        git.text(worktree, &["log", "-1", "--format=%ct", "HEAD"]),
        git_dir(git, worktree)
    );
    let dir = dir?;
    let committed = committed.map_or(0.0, |text| js_number(js_trim(&text)));
    let worktree = worktree.to_owned();
    let scope = scope.clone();
    blocking(move || {
        let mut newest = committed * 1000.0;
        let mut stamp = |path: &Path| {
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                newest = newest.max(mtime_ms(&meta));
            }
        };
        stamp(Path::new(&worktree));
        for name in ["HEAD", "index", "logs/HEAD"] {
            stamp(&under(&dir, name));
        }
        for (index, relative) in activity.stamps.iter().enumerate() {
            if index % 256 == 0 {
                super::tree::live(&scope)?;
            }
            stamp(&under(&worktree, relative));
        }
        let mut left = ACTIVITY_WALK_LIMIT;
        for entry in &activity.ignored {
            super::tree::live(&scope)?;
            let path = format!(
                "{}{}{entry}",
                worktree.trim_end_matches(std::path::MAIN_SEPARATOR),
                std::path::MAIN_SEPARATOR
            );
            match newest_under(Path::new(&path), &mut left) {
                Some(time) => newest = newest.max(time),
                None => return Ok(None),
            }
        }
        if let Some(sessions) = &activity.sessions
            && let Ok(entries) = std::fs::read_dir(sessions)
        {
            for entry in entries.flatten() {
                if let Ok(meta) = std::fs::metadata(entry.path()) {
                    newest = newest.max(mtime_ms(&meta));
                }
            }
        }
        Ok(Some(newest))
    })
    .await?
}

/// `Number(text) || 0` for git's `%ct`: decimal digits, else 0.
fn js_number(text: &str) -> f64 {
    text.parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

/// The newest mtime under `target` (itself included), not following links; none once more than `left` names were
/// read in all. Every name counts, whatever it is.
fn newest_under(target: &Path, left: &mut usize) -> Option<f64> {
    let mut newest = 0.0f64;
    let mut pending = vec![target.to_owned()];
    while let Some(path) = pending.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        newest = newest.max(mtime_ms(&meta));
        if !meta.is_dir() {
            continue;
        }
        let Ok(entries) = disk::entries(&path) else {
            continue;
        };
        for entry in entries {
            if *left == 0 {
                return None;
            }
            *left -= 1;
            pending.push(path.join(&entry.raw));
        }
    }
    Some(newest)
}

/// The working folders of this user's running processes; none where this platform cannot tell (Windows), and every
/// caller then keeps what it would have touched. macOS: `lsof -d cwd` over every process, run with this process's
/// environment, 30 s and 64 MiB at most; output with a failing exit is lsof complaining about processes it may not
/// read, and the ones it lists are the ones that count. Linux: each `/proc/<pid>/cwd`.
pub async fn process_folders(scope: &Scope) -> Result<Option<Vec<String>>, Fault> {
    if cfg!(target_os = "macos") {
        let runner = Runner {
            bin: "lsof".into(),
            args: Vec::new(),
            env: std::env::vars().collect(),
            timeout_ms: 30_000,
            max_bytes: LIST_MAX_BYTES,
        };
        let exec = Exec::new(runner, scope.clone(), "lsof");
        let output = match exec
            .run("/", &["-a", "-d", "cwd", "-Fn", "-w"], Opts::default())
            .await
        {
            Ok(output) => output,
            Err(fault) if fault == Fault::cancelled() => return Err(fault),
            Err(_) => return Ok(None),
        };
        if output.truncated || (output.code != 0 && output.stdout.is_empty()) {
            return Ok(None);
        }
        return Ok(Some(
            output
                .text()
                .split('\n')
                .filter(|line| line.starts_with("n/"))
                .map(|line| line[1..].to_owned())
                .collect(),
        ));
    }
    if cfg!(target_os = "linux") {
        return blocking(|| {
            let mut folders = Vec::new();
            for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
                let name = entry.file_name();
                if !name
                    .to_str()
                    .is_some_and(|pid| pid.bytes().all(|b| b.is_ascii_digit()))
                {
                    continue;
                }
                if let Ok(cwd) = std::fs::read_link(entry.path().join("cwd")) {
                    folders.push(cwd.to_string_lossy().into_owned());
                }
            }
            Some(folders)
        })
        .await;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Captured {
        status: String,
        ignored: Vec<String>,
        untracked: Vec<String>,
        changed: Vec<String>,
        #[serde(rename = "checkIgnore")]
        check_ignore: String,
        #[serde(rename = "ignoredBy")]
        ignored_by: Vec<(String, IgnoredBy)>,
    }

    #[derive(serde::Deserialize)]
    struct IgnoredBy {
        source: String,
        line: u64,
    }

    /// git's raw answers on three worktrees with what the TypeScript made of them (`status-captured.json`).
    #[test]
    fn parses_git_s_answers_as_the_typescript_did() {
        let captured: std::collections::BTreeMap<String, Captured> =
            serde_json::from_str(include_str!("status-captured.json")).unwrap();
        assert_eq!(captured.len(), 3);
        for (name, case) in captured {
            let raw = decode_base64(&case.status);
            let (ignored, untracked, changed) = parse_status(&String::from_utf8_lossy(&raw));
            assert_eq!(
                (ignored, untracked, changed),
                (case.ignored, case.untracked, case.changed),
                "{name}"
            );
            let parsed: Vec<(String, (String, u64))> = case
                .check_ignore
                .split('\n')
                .filter_map(regenerable::check_ignore_record)
                .map(|(source, line, path)| {
                    (
                        path.trim_end_matches('/').to_owned(),
                        (source.to_owned(), line),
                    )
                })
                .collect();
            let expected: Vec<(String, (String, u64))> = case
                .ignored_by
                .into_iter()
                .map(|(path, by)| (path, (by.source, by.line)))
                .collect();
            assert_eq!(parsed, expected, "{name}");
        }
    }

    fn decode_base64(text: &str) -> Vec<u8> {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut bits = 0u32;
        let mut count = 0;
        for byte in text.bytes().filter(|byte| *byte != b'=') {
            let value = ALPHABET.iter().position(|c| *c == byte).unwrap() as u32;
            bits = (bits << 6) | value;
            count += 6;
            if count >= 8 {
                count -= 8;
                out.push((bits >> count) as u8);
            }
        }
        out
    }

    #[test]
    fn splits_status_fields_as_the_typescript_did() {
        let (ignored, untracked, changed) =
            parse_status("R  new\0old\0C  copy\0src\0?? a b\0!! dir/\0M  x\0 M\0\0");
        assert_eq!(ignored, ["dir/"]);
        assert_eq!(untracked, ["a b"]);
        assert_eq!(changed, ["new", "copy", "x"]);
    }

    #[test]
    fn reads_a_linked_worktree_s_git_dir_line() {
        assert_eq!(gitdir_line("gitdir: /a/b\n"), Some("/a/b"));
        assert_eq!(gitdir_line("x\r\ngitdir:  ../c  \n"), Some("../c"));
        assert_eq!(gitdir_line("gitdir: \n"), None);
        assert_eq!(gitdir_line("gitdir:x"), None);
    }

    #[test]
    fn stops_an_activity_walk_past_its_budget() {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-activity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/b")).unwrap();
        for name in ["a/one", "a/b/two", "three"] {
            std::fs::write(dir.join(name), "x").unwrap();
        }
        let mut left = 5;
        assert!(newest_under(&dir, &mut left).is_some(), "five names fit");
        let mut left = 4;
        assert_eq!(newest_under(&dir, &mut left), None);
        let mut left = 10;
        assert_eq!(newest_under(&dir.join("missing"), &mut left), Some(0.0));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
