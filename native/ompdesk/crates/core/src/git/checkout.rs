//! Claimed-path presence and the folders watched for git fingerprints. Porcelain parsing, submodule reads and NFC
//! comparisons stay here; main keeps the session claims and watcher state.

use std::collections::HashSet;
use std::pin::Pin;

use icu_normalizer::ComposingNormalizerBorrowed;

use super::read::native;
use super::run::Git;
use crate::fs::order::js_trim;
use crate::run::Opts;
use crate::server::Fault;

const STATUS_TIMEOUT_MS: u64 = 5_000;
/// Past this the status is unknown (a failed read): a cut listing would drop claims.
const STATUS_MAX_BYTES: usize = 16 * 1024 * 1024;
/// UTF-16 units of pathspecs per `git status`: its command line stays far below Windows' 32 767 characters.
const ARGS_BUDGET: usize = 6_000;
const SEP: char = if cfg!(windows) { '\\' } else { '/' };

fn is_sep(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn nfc(text: &str) -> String {
    ComposingNormalizerBorrowed::new_nfc()
        .normalize(text)
        .into_owned()
}

/// node's `path.normalize` for the paths here (relative, or rooted; a Windows drive prefix kept as it is).
fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let bytes = path.as_bytes();
    let device = if cfg!(windows)
        && bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
    {
        &path[..2]
    } else {
        ""
    };
    let rest = &path[device.len()..];
    let absolute = rest.starts_with(is_sep);
    let trailing = rest.ends_with(is_sep);
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(is_sep) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            part => parts.push(part),
        }
    }
    let mut tail = parts.join(&SEP.to_string());
    if tail.is_empty() && !absolute {
        tail.push('.');
    }
    if !tail.is_empty() && trailing {
        tail.push(SEP);
    }
    if absolute {
        format!("{device}{SEP}{tail}")
    } else {
        format!("{device}{tail}")
    }
}

/// node's `path.dirname` of a relative or rooted path.
fn dirname(path: &str) -> &str {
    if path.is_empty() {
        return ".";
    }
    let rooted = path.starts_with(is_sep);
    let mut end = None;
    let mut matched_sep = true;
    for (at, c) in path.char_indices().rev() {
        if at == 0 {
            break;
        }
        if is_sep(c) {
            if !matched_sep {
                end = Some(at);
                break;
            }
        } else {
            matched_sep = false;
        }
    }
    match end {
        None if rooted => &path[..1],
        None => ".",
        Some(1) if rooted => &path[..2],
        Some(end) => &path[..end],
    }
}

/// A listed path as a claim compares with it.
fn key(path: &str) -> String {
    nfc(&normalize(path))
}

/// The text of a record past its first `skip` UTF-16 units (`String.prototype.slice`).
fn after_units(record: &str, skip: usize) -> &str {
    let mut seen = 0;
    for (at, c) in record.char_indices() {
        if seen >= skip {
            return &record[at..];
        }
        seen += c.len_utf16();
    }
    ""
}

/// The paths `git status --porcelain=v1 -z` lists as changed (both of a rename or copy), as `parseGitStatus` reads
/// the records, each normalized and in NFC.
fn listed(status: &str) -> HashSet<String> {
    let moved = |unit: Option<u16>| matches!(unit, Some(0x52 | 0x43));
    let mut listed = HashSet::new();
    let mut records = status.split('\0');
    while let Some(record) = records.next() {
        if units(record) < 4 {
            continue;
        }
        let mut letters = record.encode_utf16();
        let (index, worktree) = (letters.next(), letters.next());
        let old = if moved(index) || moved(worktree) {
            records.next()
        } else {
            None
        };
        listed.insert(key(after_units(record, 3)));
        if let Some(old) = old.filter(|old| !old.is_empty()) {
            listed.insert(key(old));
        }
    }
    listed
}

/// `rel` is still uncommitted: git lists it, a folder above it, or a path under it (a submodule, a folder).
fn holds(listed: &HashSet<String>, rel: &str) -> bool {
    if listed.contains(rel) {
        return true;
    }
    let mut dir = dirname(rel);
    while dir != "." && dir != dirname(dir) {
        if listed.contains(dir) {
            return true;
        }
        dir = dirname(dir);
    }
    let prefix = format!("{rel}{SEP}");
    listed.iter().any(|entry| entry.starts_with(&prefix))
}

/// A pathspec with `/` for the platform's separator.
fn slashed(spec: &str) -> String {
    if SEP == '/' {
        spec.to_owned()
    } else {
        spec.replace(SEP, "/")
    }
}

/// The pathspecs cut into command lines of `ARGS_BUDGET` UTF-16 units (each spec and its space).
fn chunks(specs: &[String]) -> Vec<Vec<&str>> {
    let mut chunks: Vec<Vec<&str>> = Vec::new();
    let mut size = 0;
    for spec in specs {
        let length = units(spec);
        match chunks.last_mut() {
            Some(chunk) if size + length <= ARGS_BUDGET => chunk.push(spec),
            _ => {
                chunks.push(vec![spec]);
                size = 0;
            }
        }
        size += length + 1;
    }
    chunks
}

/// The submodule roots `git config -f .gitmodules -z --get-regexp` prints (`<key>\n<value>` per record), normalized.
fn submodule_paths(config: &str) -> Vec<String> {
    config
        .split('\0')
        .filter_map(|entry| entry.split_once('\n'))
        .filter(|(_, value)| !value.is_empty())
        .map(|(_, value)| normalize(value))
        .collect()
}

/// One `git status` of `chunk`; git's failure, its timeout or a listing past the cap fail it.
async fn one_status(git: &Git, toplevel: &str, chunk: &[&str]) -> Result<String, Fault> {
    let mut args = vec![
        "--literal-pathspecs",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
    ];
    args.extend_from_slice(chunk);
    let opts = Opts {
        timeout_ms: Some(STATUS_TIMEOUT_MS),
        max_bytes: Some(STATUS_MAX_BYTES),
        ..Opts::default()
    };
    let output = git.run(toplevel, &args, opts).await?;
    if output.code != 0 || output.truncated {
        let stderr = js_trim(&output.stderr);
        let message = if stderr.is_empty() {
            "git status failed"
        } else {
            stderr
        };
        return Err(Fault::new("git_exit", message));
    }
    Ok(output.text())
}

// Join every git even on failure; each chunk writes its own slot and the output is concatenated once.
fn statuses<'a>(
    git: &'a Git,
    toplevel: &'a str,
    chunks: &'a [Vec<&'a str>],
    outputs: &'a mut [Result<String, Fault>],
) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        if chunks.is_empty() {
            return;
        }
        if chunks.len() == 1 {
            outputs[0] = one_status(git, toplevel, &chunks[0]).await;
            return;
        }
        let middle = chunks.len() / 2;
        let (left, right) = chunks.split_at(middle);
        let (left_outputs, right_outputs) = outputs.split_at_mut(middle);
        tokio::join!(
            statuses(git, toplevel, left, left_outputs),
            statuses(git, toplevel, right, right_outputs)
        );
    })
}

async fn status_of(git: &Git, toplevel: &str, specs: &[String]) -> Result<String, Fault> {
    let chunks = chunks(specs);
    let mut outputs: Vec<_> = (0..chunks.len()).map(|_| Ok(String::new())).collect();
    statuses(git, toplevel, &chunks, &mut outputs).await;
    let capacity = outputs
        .iter()
        .filter_map(|out| out.as_ref().ok())
        .map(String::len)
        .sum();
    let mut text = String::with_capacity(capacity);
    for output in outputs {
        text.push_str(&output?);
    }
    Ok(text)
}

async fn submodule_roots(git: &Git, toplevel: &str) -> Result<Vec<String>, Fault> {
    let args = [
        "config",
        "-f",
        ".gitmodules",
        "-z",
        "--get-regexp",
        r"^submodule\..*\.path$",
    ];
    let opts = Opts {
        timeout_ms: Some(STATUS_TIMEOUT_MS),
        ..Opts::default()
    };
    let output = git.run(toplevel, &args, opts).await?;
    if output.code != 0 {
        return Ok(Vec::new());
    }
    Ok(submodule_paths(&output.text()))
}

/// `git status --porcelain=v1 -z --untracked-files=all` of `toplevel` asked only about `paths` (relative to it,
/// literal): a full-tree status of a large repository costs seconds. git does not look inside a submodule for a path
/// in it, so a path nothing lists is asked again through the submodule that holds it.
pub async fn status(git: &Git, toplevel: &str, paths: &[String]) -> Result<Vec<String>, Fault> {
    let mut specs: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for spec in paths.iter().map(|spec| slashed(spec)) {
        if seen.insert(spec.clone()) {
            specs.push(spec);
        }
    }
    let text = status_of(git, toplevel, &specs).await?;
    let mut listing = listed(&text);
    let unlisted: Vec<String> = paths
        .iter()
        .map(|spec| normalize(spec))
        .filter(|spec| !holds(&listing, &nfc(spec)))
        .collect();
    if !unlisted.is_empty() {
        let roots: Vec<String> = submodule_roots(git, toplevel)
            .await?
            .into_iter()
            .filter(|root| {
                let prefix = format!("{root}{SEP}");
                unlisted.iter().any(|spec| spec.starts_with(&prefix))
            })
            .map(|root| slashed(&root))
            .collect();
        if !roots.is_empty() {
            listing.extend(listed(&status_of(git, toplevel, &roots).await?));
        }
    }
    let mut asked = HashSet::new();
    Ok(paths
        .iter()
        .filter(|path| asked.insert(path.as_str()) && holds(&listing, &key(path)))
        .cloned()
        .collect())
}

/// The worktree root, git directory and common git directory of `cwd`, absolute and native; none outside a
/// repository.
pub async fn dirs(git: &Git, cwd: &str) -> Result<Option<Vec<String>>, Fault> {
    let output = git
        .raw(
            cwd,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--absolute-git-dir",
                "--git-common-dir",
            ],
        )
        .await?;
    if output.code != 0 {
        return Ok(None);
    }
    let text = output.text();
    let dirs: Vec<String> = text
        .split('\n')
        .map(js_trim)
        .filter(|line| !line.is_empty())
        .map(native)
        .collect();
    Ok((dirs.len() == 3).then_some(dirs))
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use serde_json::Value;

    use super::*;
    use crate::git::run::tests::git;

    /// Rows captured from the TypeScript (`path.posix` and `path.win32`) before it was deleted.
    fn captured() -> Value {
        serde_json::from_str(include_str!("checkout-captured.json")).unwrap()
    }

    fn flavor() -> Value {
        captured()[if cfg!(windows) { "win32" } else { "posix" }].clone()
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }

    #[test]
    fn normalizes_as_node_did() {
        for row in flavor()["normalize"].as_array().unwrap() {
            assert_eq!(normalize(text(&row[0])), text(&row[1]), "{}", row[0]);
        }
    }

    #[test]
    fn lists_and_holds_as_the_typescript_did() {
        let flavor = flavor();
        for row in flavor["listed"].as_array().unwrap() {
            let want: HashSet<String> = row[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| text(path).to_owned())
                .collect();
            assert_eq!(listed(text(&row[0])), want, "{:?}", row[0]);
        }
        for row in flavor["holds"].as_array().unwrap() {
            let rel = nfc(&normalize(text(&row[1])));
            assert_eq!(
                holds(&listed(text(&row[0])), &rel),
                row[2].as_bool().unwrap(),
                "{:?} {:?}",
                row[0],
                row[1]
            );
        }
    }

    #[test]
    fn reads_submodule_roots_as_the_typescript_did() {
        for row in flavor()["submodules"].as_array().unwrap() {
            let want: Vec<&str> = row[1].as_array().unwrap().iter().map(text).collect();
            assert_eq!(submodule_paths(text(&row[0])), want, "{:?}", row[0]);
        }
    }

    #[test]
    fn cuts_pathspecs_as_the_typescript_did() {
        for row in captured()["chunks"].as_array().unwrap() {
            let specs: Vec<String> = row[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|spec| match spec {
                    Value::String(spec) => spec.clone(),
                    long => {
                        let piece = text(&long["repeat"]);
                        let length = long["units"].as_u64().unwrap() as usize;
                        let repeated = piece.repeat(length.div_ceil(units(piece)));
                        String::from_utf16_lossy(
                            &repeated.encode_utf16().take(length).collect::<Vec<_>>(),
                        )
                    }
                })
                .collect();
            let sizes: Vec<u64> = chunks(&specs)
                .iter()
                .map(|chunk| chunk.len() as u64)
                .collect();
            let want: Vec<u64> = row[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap())
                .collect();
            assert_eq!(sizes, want);
        }
    }

    #[test]
    fn holds_a_decomposed_name_git_prints_composed() {
        let nfd = "\u{1112}\u{1161}\u{11ab}.ts";
        let nfc_name = "\u{d55c}.ts";
        assert_eq!(nfc(nfd), nfc_name);
        let listing = listed(&format!("?? src/{nfc_name}\0 M caf\u{e9}/x\0"));
        for (asked, held) in [
            (format!("src{SEP}{nfd}"), true),
            (format!("src{SEP}{nfc_name}"), true),
            (format!("cafe\u{301}{SEP}x"), true),
            (format!("cafe\u{301}{SEP}{nfd}"), false),
            ("cafe\u{301}".to_owned(), true),
        ] {
            assert_eq!(holds(&listing, &key(&asked)), held, "{asked:?}");
        }
    }

    fn sh(dir: &std::path::Path, args: &[&str]) {
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

    #[tokio::test]
    async fn asks_git_only_about_the_claimed_paths_and_finds_the_checkout() {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-checkout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        sh(&dir, &["init", "-q"]);
        std::fs::create_dir_all(dir.join("src").join("old")).unwrap();
        std::fs::write(dir.join("src").join("old").join("x.ts"), "x").unwrap();
        std::fs::write(dir.join("a.ts"), "a").unwrap();
        std::fs::write(dir.join("[ab].ts"), "glob").unwrap();
        let top = dir.to_str().unwrap();
        let git = git();
        let asked: Vec<String> = ["a.ts", "gone.ts", "a.ts"].map(String::from).to_vec();
        let one = status(&git, top, &asked).await.unwrap();
        assert_eq!(one, ["a.ts"]);
        let literal = status(&git, top, &["[ab].ts".into()]).await.unwrap();
        assert_eq!(literal, ["[ab].ts"]);
        let folder = format!("src{SEP}old");
        let under = status(&git, top, std::slice::from_ref(&folder))
            .await
            .unwrap();
        assert_eq!(under, [folder]);
        let none = status(&git, top, &[]).await.unwrap();
        assert!(none.is_empty());
        let found = dirs(&git, top).await.unwrap().unwrap();
        assert_eq!(found.len(), 3);
        assert!(found[1].ends_with(".git") && found[1] == found[2]);
        let outside = std::env::temp_dir();
        assert!(
            dirs(&git, outside.to_str().unwrap())
                .await
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
