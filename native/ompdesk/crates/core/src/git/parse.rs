//! What git prints, read the way the TypeScript read it (`split("\0")` records, prefixes, JavaScript string lengths
//! where the answer counted in them).

use std::collections::HashMap;

use serde::Serialize;

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
}
