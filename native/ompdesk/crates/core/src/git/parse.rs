//! What git prints, read the way the TypeScript read it (`split("\0")` records, prefixes, JavaScript string lengths
//! where the answer counted in them).

use std::collections::HashMap;

use serde::Serialize;

use crate::fs::order::js_trim;

/// Paths a fingerprint stats and files a change list keeps.
pub const MAX_FILES: usize = 1000;

/// One status entry as `--porcelain=v1` spells it: its two status letters (` ` unchanged), its path, and the origin
/// of a rename or copy.
#[derive(Debug, PartialEq)]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub index: char,
    pub worktree: char,
}

/// The entries of `git status --porcelain=v2 -z` in the order git prints them: changed, unmerged, untracked.
#[derive(Debug, Default)]
pub struct Entries {
    changed: Vec<StatusEntry>,
    unmerged: Vec<StatusEntry>,
    untracked: Vec<StatusEntry>,
}

/// `.` (v2's "unchanged") is v1's space.
fn letter(byte: Option<&u8>) -> char {
    match byte {
        Some(b'.') | None => ' ',
        Some(byte) => char::from(*byte),
    }
}

/// `git status --porcelain=v2 -z`, paths kept whole (spaces included); a rename or copy pairs with its origin.
pub fn status_v2_entries(text: &str) -> Entries {
    let mut entries = Entries::default();
    let mut records = text.split('\0');
    while let Some(record) = records.next() {
        if let Some(path) = record.strip_prefix("? ") {
            entries.untracked.push(StatusEntry {
                path: path.to_owned(),
                old_path: None,
                index: '?',
                worktree: '?',
            });
            continue;
        }
        // Fields before the path: `1` has 8, `2` has 9 (and a second record holds the old path), `u` has 10.
        let skip = match record.get(..2) {
            Some("1 ") => 8,
            Some("2 ") => 9,
            Some("u ") => 10,
            _ => continue,
        };
        let bytes = record.as_bytes();
        let entry = StatusEntry {
            path: record
                .splitn(skip + 1, ' ')
                .nth(skip)
                .unwrap_or("")
                .to_owned(),
            old_path: if skip == 9 {
                records.next().map(str::to_owned)
            } else {
                None
            },
            index: letter(bytes.get(2)),
            worktree: letter(bytes.get(3)),
        };
        if skip == 10 {
            entries.unmerged.push(entry);
        } else {
            entries.changed.push(entry);
        }
    }
    entries
}

impl Entries {
    /// The paths in git's order.
    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.changed
            .iter()
            .chain(&self.unmerged)
            .chain(&self.untracked)
            .map(|entry| entry.path.as_str())
    }

    /// How many paths are unmerged (a merge, cherry-pick, revert, rebase or stash pop stopped on them): the entries
    /// porcelain v1 lists as `DD`, `AU`, `UD`, `UA`, `DU`, `AA` or `UU`.
    pub fn unmerged(&self) -> usize {
        self.unmerged.len()
    }

    /// The entries as `--porcelain=v1` lists them: git sorts its changes by path (bytes, `strcmp`) and v1 prints an
    /// unmerged one in its place among them, where v2 prints them all after; untracked ones come last in both.
    pub fn in_v1_order(self) -> Vec<StatusEntry> {
        let mut ordered =
            Vec::with_capacity(self.changed.len() + self.unmerged.len() + self.untracked.len());
        let mut changed = self.changed.into_iter().peekable();
        let mut unmerged = self.unmerged.into_iter().peekable();
        loop {
            let next = match (changed.peek(), unmerged.peek()) {
                (Some(a), Some(b)) if b.path.as_bytes() < a.path.as_bytes() => unmerged.next(),
                (Some(_), _) => changed.next(),
                (None, _) => unmerged.next(),
            };
            let Some(next) = next else { break };
            ordered.push(next);
        }
        ordered.extend(self.untracked);
        ordered
    }
}

/// Branch and counts from `git status --porcelain=v2 --branch -z --untracked-files=all`.
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Summary {
    pub branch: Option<String>,
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
}

const HEAD: &str = "# branch.head ";

fn branch_name(name: &str) -> Option<String> {
    (name != "(detached)").then(|| name.to_owned())
}

pub fn status_v2(text: &str) -> Summary {
    let mut summary = Summary::default();
    let mut records = text.split('\0');
    while let Some(record) = records.next() {
        if let Some(name) = record.strip_prefix(HEAD) {
            summary.branch = branch_name(name);
        } else if record.starts_with("1 ") || record.starts_with("2 ") {
            let bytes = record.as_bytes();
            if bytes.get(2) != Some(&b'.') {
                summary.staged += 1;
            }
            if bytes.get(3) != Some(&b'.') {
                summary.unstaged += 1;
            }
            // A rename or copy carries its origin as the next record.
            if record.starts_with("2 ") {
                records.next();
            }
        } else if record.starts_with("u ") {
            summary.unstaged += 1;
        } else if record.starts_with("? ") {
            summary.untracked += 1;
        }
    }
    summary
}

/// Branch, upstream and ahead/behind from the `# branch.*` headers of `git status --porcelain=v2 --branch -z`.
#[derive(Debug, PartialEq, Default)]
pub struct Branch {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
}

pub fn branch_headers(text: &str) -> Branch {
    let mut head = Branch::default();
    for record in text.split('\0') {
        if let Some(name) = record.strip_prefix(HEAD) {
            head.branch = branch_name(name);
        } else if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            head.upstream = Some(upstream.to_owned());
        } else if let Some(counts) = record.strip_prefix("# branch.ab ") {
            let parsed = counts
                .strip_prefix('+')
                .and_then(|rest| rest.split_once(" -"))
                .and_then(|(ahead, behind)| Some((digits(ahead)?, digits(behind)?)));
            if let Some((ahead, behind)) = parsed {
                head.ahead = ahead;
                head.behind = behind;
            }
        }
    }
    head
}

/// A run of ASCII digits (`\d+`) as its number.
fn digits(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Lines added and removed per path from `git diff --numstat -z --find-renames`, keyed by the new path; binary
/// files (`-`) have none.
pub fn numstat(text: &str) -> HashMap<String, (u64, u64)> {
    let records: Vec<&str> = text.split('\0').collect();
    let mut counts = HashMap::new();
    let mut at = 0;
    while at < records.len() {
        let mut fields = records[at].splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            at += 1;
            continue;
        };
        let count = |field: &str| {
            (field == "-")
                .then_some(None)
                .or_else(|| digits(field).map(Some))
        };
        let (Some(added), Some(removed)) = (count(added), count(removed)) else {
            at += 1;
            continue;
        };
        // A rename is an empty path field followed by its old and new paths as records of their own.
        let path = if path.is_empty() {
            at += 2;
            records.get(at).copied()
        } else {
            Some(path)
        };
        if let (Some(path), Some(added), Some(removed)) = (path, added, removed)
            && !path.is_empty()
        {
            counts.insert(path.to_owned(), (added, removed));
        }
        at += 1;
    }
    counts
}

/// Binary when the bytes hold a NUL or are not UTF-8 (a sequence the cut left unfinished at the end is fine).
pub fn is_probably_binary(header: &[u8]) -> bool {
    if header.contains(&0) {
        return true;
    }
    match std::str::from_utf8(header) {
        Ok(_) => false,
        Err(error) => error.error_len().is_some(),
    }
}

/// The all-added hunk of a new or untracked file.
pub fn new_file_diff(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    let body = content.strip_suffix('\n').unwrap_or(content);
    let lines: Vec<&str> = body.split('\n').collect();
    let mut diff = format!("@@ -0,0 +1,{} @@\n", lines.len());
    for (at, line) in lines.iter().enumerate() {
        if at > 0 {
            diff.push('\n');
        }
        diff.push('+');
        diff.push_str(line);
    }
    diff
}

/// `text.slice(0, max)` and whether `text.length > max`, both in UTF-16 units. A cut through a surrogate pair keeps
/// U+FFFD for its first half, which is what the lone half JavaScript kept displays as.
pub fn utf16_prefix(text: &str, max: usize) -> (&str, Option<char>, bool) {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        let width = c.len_utf16();
        if units + width > max {
            let half = (units < max).then_some('\u{fffd}');
            return (&text[..at], half, true);
        }
        units += width;
    }
    (text, None, false)
}

/// Branch and tag names from `git log --format=%D` (`HEAD -> main, tag: v1, origin/main`).
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Decorations {
    pub refs: Vec<String>,
    pub tags: Vec<String>,
}

pub fn decorations(text: &str) -> Decorations {
    let mut found = Decorations::default();
    for raw in text.split(", ") {
        let entry = js_trim(raw);
        if entry.is_empty() || entry == "HEAD" {
            continue;
        }
        if let Some(tag) = entry.strip_prefix("tag: ") {
            found.tags.push(tag.to_owned());
        } else {
            found
                .refs
                .push(entry.strip_prefix("HEAD -> ").unwrap_or(entry).to_owned());
        }
    }
    found
}

/// What the history asks `git log` for: sha, short sha, author, author time, subject, decorations and parents, NUL
/// between fields and 0x1e after each commit.
pub const LOG_FORMAT: &str = "%H%x00%h%x00%an%x00%at%x00%s%x00%D%x00%P%x1e";

/// One commit of the history.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub date: u64,
    pub subject: String,
    #[serde(flatten)]
    pub decorations: Decorations,
    pub parents: Vec<String>,
}

/// One record of `LOG_FORMAT` output (the ones after the first start with git's newline); none without a sha.
pub fn log_record(record: &str) -> Option<Commit> {
    let record = record.strip_prefix('\n').unwrap_or(record);
    let mut fields = record.split('\0');
    let mut next = || fields.next().unwrap_or("");
    let (sha, short_sha) = (next(), next());
    if sha.is_empty() || short_sha.is_empty() {
        return None;
    }
    let (author, date, subject, decoration, parents) = (next(), next(), next(), next(), next());
    Some(Commit {
        sha: sha.to_owned(),
        short_sha: short_sha.to_owned(),
        author: author.to_owned(),
        date: seconds(date),
        subject: subject.to_owned(),
        decorations: decorations(decoration),
        parents: parents
            .split(' ')
            .filter(|parent| !parent.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}

/// `Number(text) || 0` of the Unix time git prints (`%at`, `%(committerdate:unix)`: digits, or nothing).
pub fn seconds(text: &str) -> u64 {
    digits(text).unwrap_or(0)
}

/// A file of one commit, from its `show --numstat -z` and `show --name-status -z` (renames found, first parent).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u64>,
}

/// `\d+` or `-`, a numstat count field.
fn count_field(field: &str) -> bool {
    field == "-" || digits(field).is_some()
}

/// The files of a commit in `--name-status` order, each with the lines `--numstat` counted for its path (none for a
/// binary file). A record may start with the newline git puts after the empty `--format=`.
pub fn commit_files(numstat: &str, names: &str) -> Vec<CommitFile> {
    let records: Vec<&str> = numstat.split('\0').collect();
    let mut counts: HashMap<&str, (u64, u64)> = HashMap::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        let record = record.strip_prefix('\n').unwrap_or(record);
        let mut fields = record.splitn(3, '\t');
        if let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
            && count_field(added)
            && count_field(removed)
        {
            // A rename is an empty path field followed by its old and new paths as records of their own.
            let path = if path.is_empty() {
                index += 2;
                records.get(index).copied()
            } else {
                Some(path)
            };
            if let (Some(path), Some(added), Some(removed)) = (path, digits(added), digits(removed))
                && !path.is_empty()
            {
                counts.insert(path, (added, removed));
            }
        }
        index += 1;
    }
    let fields: Vec<&str> = names
        .split('\0')
        .map(|field| field.strip_prefix('\n').unwrap_or(field))
        .collect();
    let field = |at: usize| fields.get(at).copied().unwrap_or("");
    let mut files = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let status = fields[index];
        if !status.is_empty() {
            let (path, old_path) = if status.starts_with('R') || status.starts_with('C') {
                index += 2;
                (field(index), Some(field(index - 1).to_owned()))
            } else {
                index += 1;
                (field(index), None)
            };
            let count = counts.get(path);
            files.push(CommitFile {
                path: path.to_owned(),
                old_path,
                status: status.chars().take(1).collect(),
                added: count.map(|(added, _)| *added),
                removed: count.map(|(_, removed)| *removed),
            });
        }
        index += 1;
    }
    files
}

/// JavaScript's `/^<prefix>/m`: `text` has a line (after a `\n`, `\r`, U+2028 or U+2029) that starts with `prefix`.
pub fn has_line_starting(text: &str, prefix: &str) -> bool {
    text.starts_with(prefix)
        || text
            .match_indices(['\n', '\r', '\u{2028}', '\u{2029}'])
            .any(|(at, end)| text[at + end.len()..].starts_with(prefix))
}

/// `String(number)` for a count git is given (`-n`, `--skip`): no fraction digits for a whole number, an exponent
/// past 1e21 and under 1e-6, as JavaScript spells them.
pub fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let size = value.abs();
    if !(1e-6..1e21).contains(&size) {
        let spelled = format!("{value:e}");
        return match spelled.split_once('e') {
            Some((digits, exponent)) if !exponent.starts_with('-') => {
                format!("{digits}e+{exponent}")
            }
            _ => spelled,
        };
    }
    format!("{value}")
}

/// `[\w.-]`.
fn scp_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

/// `user@host:path` (`/^[\w.-]+@([\w.-]+):(?!\/)(.+)$/`): its host and path.
fn scp_remote(url: &str) -> Option<(&str, &str)> {
    let (user, rest) = url.split_once('@')?;
    let (host, path) = rest.split_once(':')?;
    let word = |part: &str| !part.is_empty() && part.chars().all(scp_char);
    let one_line = !path.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (word(user) && word(host) && !path.is_empty() && !path.starts_with('/') && one_line)
        .then_some((host, path))
}

/// Web base of a hosted remote (`https://host/owner/repo`) from its fetch URL: https, ssh `git@host:owner/repo.git`
/// and `ssh://git@host/owner/repo` forms, the URL read as the WHATWG URL standard reads it (node's `URL`). None for
/// local paths and anything else that has no web page.
pub fn remote_web_base(url: &str) -> Option<String> {
    let trimmed = js_trim(url);
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('/').unwrap_or(trimmed);
    let (host, path) = match scp_remote(trimmed) {
        Some((host, path)) => (host.to_owned(), path.to_owned()),
        None => {
            let parsed = url::Url::parse(trimmed).ok()?;
            if !matches!(parsed.scheme(), "https" | "http" | "ssh" | "git") {
                return None;
            }
            let path = parsed.path();
            (
                parsed.host_str().unwrap_or("").to_owned(),
                path.strip_prefix('/').unwrap_or(path).to_owned(),
            )
        }
    };
    if host.is_empty() || path.split('/').filter(|part| !part.is_empty()).count() < 2 {
        return None;
    }
    Some(format!("https://{host}/{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cases of `parse.test.ts` (parseStatusV2, newFileDiff) and `scm.test.ts` (parseBranchHeaders) the functions
    // left with.

    #[test]
    fn counts_staged_unstaged_untracked_and_skips_rename_origins() {
        let text = [
            "# branch.oid abc",
            "# branch.head feature/x",
            "1 M. N... 100644 100644 100644 a b staged.ts",
            "1 .M N... 100644 100644 100644 a b unstaged.ts",
            "1 MM N... 100644 100644 100644 a b both.ts",
            "2 R. N... 100644 100644 100644 a b R100 new.ts",
            "? old-looking-like-record.ts",
            "u UU N... 1 2 3 4 a b c conflict.ts",
            "? untracked.ts",
        ]
        .join("\0");
        // The record after the `2` entry is its origin path, not an untracked file.
        assert_eq!(
            status_v2(&text),
            Summary {
                branch: Some("feature/x".into()),
                staged: 3,
                unstaged: 3,
                untracked: 1
            }
        );
    }

    #[test]
    fn reports_detached_head_as_null_branch() {
        assert_eq!(status_v2("# branch.head (detached)\0").branch, None);
    }

    #[test]
    fn new_file_diff_synthesizes_an_all_added_hunk() {
        assert_eq!(new_file_diff("a\nb\n"), "@@ -0,0 +1,2 @@\n+a\n+b");
        assert_eq!(new_file_diff(""), "");
    }

    #[test]
    fn reads_branch_headers() {
        assert_eq!(
            branch_headers(
                "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0"
            ),
            Branch {
                branch: Some("main".into()),
                upstream: Some("origin/main".into()),
                ahead: 2,
                behind: 3
            }
        );
        assert_eq!(
            branch_headers("# branch.head (detached)\0"),
            Branch::default()
        );
    }

    // Captured from the TypeScript (`newFileDiff`, the numstat loop of `getGitChanges`, the path loop of
    // `getGitFingerprint`, `isProbablyBinaryHeader`, `slice`) before it was deleted, and from git itself.

    #[test]
    fn lists_v2_entries_as_porcelain_v1_does() {
        // `git status -z --untracked-files=all` of one checkout, in v2 and in v1 (git 2.54): a merge stopped on `c` and
        // `g` while `a`, `e` and `z` changed and `b.txt` moved.
        let v2 = [
            "1 .M N... 100644 100644 100644 df96 df96 a",
            "2 R. N... 100644 100644 100644 587b 587b R100 d.txt",
            "b.txt",
            "1 M. N... 100644 100644 100644 df96 2680 e",
            "1 .M N... 100644 100644 100644 df96 df96 z",
            "u UU N... 100644 100644 100644 100644 df96 ba29 2299 c",
            "u UU N... 100644 100644 100644 100644 df96 ba29 2299 g",
            "? f",
            "? untr",
            "",
        ]
        .join("\0");
        let v1 = "\u{20}M a\0UU c\0R  d.txt\0b.txt\0M  e\0UU g\0 M z\0?? f\0?? untr\0";
        let entries = status_v2_entries(&v2);
        assert_eq!(
            entries.paths().collect::<Vec<_>>(),
            ["a", "d.txt", "e", "z", "c", "g", "f", "untr"]
        );
        let spelled: String = entries
            .in_v1_order()
            .into_iter()
            .map(|entry| {
                let old = entry
                    .old_path
                    .map(|old| format!("{old}\0"))
                    .unwrap_or_default();
                format!("{}{} {}\0{old}", entry.index, entry.worktree, entry.path)
            })
            .collect();
        assert_eq!(spelled, v1);
    }

    #[test]
    fn keeps_spaces_in_v2_paths_and_reads_every_kind() {
        let text = [
            "# stash 1",
            "2 .C N... 1 2 3 a b C75 c opy",
            "s rc",
            "1 .A N... 000000 000000 100644 0 0 sp ace.txt",
            "u AA N... 1 2 3 4 a b c two words",
            "? dir/x y",
            "! ignored",
            "",
        ]
        .join("\0");
        let seen: Vec<(char, char, String, Option<String>)> = status_v2_entries(&text)
            .in_v1_order()
            .into_iter()
            .map(|e| (e.index, e.worktree, e.path, e.old_path))
            .collect();
        let at = |index, worktree, path: &str, old: Option<&str>| {
            (index, worktree, path.to_owned(), old.map(String::from))
        };
        assert_eq!(
            seen,
            [
                at(' ', 'C', "c opy", Some("s rc")),
                at(' ', 'A', "sp ace.txt", None),
                at('A', 'A', "two words", None),
                at('?', '?', "dir/x y", None),
            ]
        );
    }

    #[test]
    fn counts_lines_by_new_path() {
        let counts = numstat(
            &[
                "3\t1\ta b.txt",
                "-\t-\tbin.dat",
                "2\t0\t",
                "old",
                "new",
                "x\ty\tz",
                "007\t\t1\tbad",
                "",
            ]
            .join("\0"),
        );
        let mut seen: Vec<(&str, (u64, u64))> =
            counts.iter().map(|(path, n)| (path.as_str(), *n)).collect();
        seen.sort();
        assert_eq!(seen, [("a b.txt", (3, 1)), ("new", (2, 0))]);
    }

    #[test]
    fn lists_the_paths_a_fingerprint_stats() {
        let text = [
            "# branch.oid x",
            "# stash 2",
            "1 .M N... 100644 100644 100644 a b sp ace.txt",
            "2 R. N... 100644 100644 100644 a b R100 new",
            "old",
            "1 short",
            "u UU N... 1 2 3 4 a b c conflict",
            "? new file",
            "",
        ]
        .join("\0");
        assert_eq!(
            status_v2_entries(&text).paths().collect::<Vec<_>>(),
            ["sp ace.txt", "new", "", "conflict", "new file"]
        );
    }

    #[test]
    fn synthesizes_new_file_hunks_and_reads_counts_as_the_typescript() {
        assert_eq!(new_file_diff("x"), "@@ -0,0 +1,1 @@\n+x");
        assert_eq!(new_file_diff("\n"), "@@ -0,0 +1,1 @@\n+");
        assert_eq!(new_file_diff("a\r\n\nb"), "@@ -0,0 +1,3 @@\n+a\r\n+\n+b");
        let head = branch_headers("# branch.ab +1 -x\0# branch.ab +007 -2\0");
        assert_eq!((head.ahead, head.behind), (7, 2));
    }

    #[test]
    fn tells_binary_from_text_as_the_fatal_streaming_decoder() {
        for (bytes, binary) in [
            (&b"plain"[..], false),
            (b"a\0b", true),
            (b"caf\xc3\xa9", false),
            (b"caf\xc3", false),
            (b"\xf0\x9f\x98", false),
            (b"caf\xe9 au", true),
            (b"\xed\xa0\x80", true),
            (b"\xc0\xaf", true),
            (b"\xf0\x80", true),
            (b"\xef\xbb\xbfbom", false),
        ] {
            assert_eq!(is_probably_binary(bytes), binary, "{bytes:?}");
        }
    }

    #[test]
    fn cuts_where_javascript_slices() {
        assert_eq!(utf16_prefix("abc", 3), ("abc", None, false));
        assert_eq!(utf16_prefix("abcd", 3), ("abc", None, true));
        assert_eq!(utf16_prefix("a😀b", 2), ("a", Some('\u{fffd}'), true));
        assert_eq!(utf16_prefix("a😀b", 3), ("a😀", None, true));
        assert_eq!(utf16_prefix("한글", 1), ("한", None, true));
    }

    // The cases of `scm.test.ts` "parsers" (parseDecorations, remoteWebBase) and tables captured from the TypeScript
    // before it was deleted (`remoteWebBase`, `parseDecorations`, the loops of `log` and `commitDetail`).

    #[test]
    fn splits_decorations_into_refs_and_tags() {
        let refs = |refs: &[&str], tags: &[&str]| Decorations {
            refs: refs.iter().map(|r| r.to_string()).collect(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
        };
        for (text, expected) in [
            (
                "HEAD -> main, tag: v1.0, origin/main, origin/HEAD",
                refs(&["main", "origin/main", "origin/HEAD"], &["v1.0"]),
            ),
            ("", refs(&[], &[])),
            ("HEAD", refs(&[], &[])),
            ("tag: a, tag: b", refs(&[], &["a", "b"])),
            (" HEAD -> x ,  y ", refs(&["x", "y"], &[])),
            ("grafted, HEAD -> main", refs(&["grafted", "main"], &[])),
            ("main,tag: v2", refs(&["main,tag: v2"], &[])),
            (
                "HEAD -> feature/한글, tag: v1 ",
                refs(&["feature/한글"], &["v1"]),
            ),
        ] {
            assert_eq!(decorations(text), expected, "{text:?}");
        }
    }

    #[test]
    fn derives_a_hosted_remote_s_web_base_as_the_typescript_did() {
        for (url, base) in [
            ("git@github.com:o/r.git", Some("https://github.com/o/r")),
            (
                "https://gitlab.com/group/sub/r.git\n",
                Some("https://gitlab.com/group/sub/r"),
            ),
            ("ssh://git@github.com/o/r", Some("https://github.com/o/r")),
            ("/srv/git/r.git", None),
            ("file:///srv/git/r.git", None),
            ("https://github.com/o/r", Some("https://github.com/o/r")),
            ("https://github.com/o/r/", Some("https://github.com/o/r")),
            (
                "https://github.com/o/r.git/",
                Some("https://github.com/o/r.git"),
            ),
            (
                "https://user:tok@GitHub.COM:443/O/R.git",
                Some("https://github.com/O/R"),
            ),
            (
                "http://host.example:8080/a/b/c",
                Some("https://host.example/a/b/c"),
            ),
            ("git://host/o/r.git", Some("https://host/o/r")),
            ("ssh://git@host:2222/o/r.git", Some("https://host/o/r")),
            ("git@host:/abs/path.git", None),
            ("me@host:o", None),
            ("me@host:o/r", Some("https://host/o/r")),
            ("https://host/only", None),
            ("https://host//o//r", Some("https://host//o//r")),
            ("https://host/o/my repo", Some("https://host/o/my%20repo")),
            ("https://host/o/%41r", Some("https://host/o/%41r")),
            (
                "https://bücher.example/o/r",
                Some("https://xn--bcher-kva.example/o/r"),
            ),
            ("https://[::1]/o/r", Some("https://[::1]/o/r")),
            ("HTTPS://Host/o/r", Some("https://host/o/r")),
            ("svn://host/o/r", None),
            ("https:///o/r", None),
            ("  https://host/o/r.git  ", Some("https://host/o/r")),
            ("https://host/o/r?x=1#frag", Some("https://host/o/r")),
            ("https://host/o/./r/../s", Some("https://host/o/s")),
            ("https://host/o\\r\\s", Some("https://host/o/r/s")),
            ("x@y.z:a/b.git", Some("https://y.z/a/b")),
            ("a_b-c.d@h-1.e_f:p/q", Some("https://h-1.e_f/p/q")),
            ("git+ssh://host/o/r", None),
            ("", None),
        ] {
            assert_eq!(remote_web_base(url).as_deref(), base, "{url:?}");
        }
    }

    #[test]
    fn reads_log_records_as_the_history_lists_them() {
        let output = "a1\0a\0Ann Ö\x001767225600\0subject one\0HEAD -> main, tag: v1\0p1 p2\x1e\nb2\0b\0\0\0\0\0\x1e\n";
        let commits: Vec<Commit> = output.split('\x1e').filter_map(log_record).collect();
        assert_eq!(
            commits,
            [
                Commit {
                    sha: "a1".into(),
                    short_sha: "a".into(),
                    author: "Ann Ö".into(),
                    date: 1767225600,
                    subject: "subject one".into(),
                    decorations: Decorations {
                        refs: vec!["main".into()],
                        tags: vec!["v1".into()]
                    },
                    parents: vec!["p1".into(), "p2".into()],
                },
                Commit {
                    sha: "b2".into(),
                    short_sha: "b".into(),
                    author: String::new(),
                    date: 0,
                    subject: String::new(),
                    decorations: Decorations::default(),
                    parents: Vec::new(),
                }
            ]
        );
        assert_eq!(log_record("\nonly-sha"), None);
        assert_eq!(seconds("x"), 0);
    }

    #[test]
    fn lists_a_commit_s_files_with_their_counts() {
        // `show --format= --numstat -z` and `--name-status -z` of one commit (git 2.54): a leading newline, a rename,
        // a binary file, a path with a tab.
        let numstat = "\n1\t0\t\0a.txt\0b.txt\0-\t-\tbin.dat\x00002\t1\ttab\there.txt\0";
        let names = "\nR087\0a.txt\0b.txt\0A\0bin.dat\0M\0tab\there.txt\0D\0gone.txt\0";
        let files = commit_files(numstat, names);
        let file =
            |path: &str, old: Option<&str>, status: &str, counts: Option<(u64, u64)>| CommitFile {
                path: path.into(),
                old_path: old.map(String::from),
                status: status.into(),
                added: counts.map(|c| c.0),
                removed: counts.map(|c| c.1),
            };
        assert_eq!(
            files,
            [
                file("b.txt", Some("a.txt"), "R", Some((1, 0))),
                file("bin.dat", None, "A", None),
                file("tab\there.txt", None, "M", Some((2, 1))),
                file("gone.txt", None, "D", None),
            ]
        );
        assert_eq!(commit_files("", ""), []);
    }

    #[test]
    fn finds_a_binary_line_and_spells_counts_as_javascript() {
        assert!(has_line_starting(
            "Binary files a and b differ",
            "Binary files "
        ));
        assert!(has_line_starting("x\r\nBinary files a", "Binary files "));
        assert!(has_line_starting(
            "x\u{2028}Binary files a",
            "Binary files "
        ));
        assert!(!has_line_starting("x Binary files a", "Binary files "));
        for (value, spelled) in [
            (101.0, "101"),
            (3.5, "3.5"),
            (0.0, "0"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1.5e22, "1.5e+22"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
        ] {
            assert_eq!(js_number(value), spelled, "{value}");
        }
    }
}
