//! The listing's gitignore subset, matched exactly as the TypeScript's compiled regular expressions matched:
//! `!` negates, a trailing `/` matches folders only, any other `/` anchors to the root, `*` and `?` stay within a
//! segment, `**` crosses segments, a match also covers everything beneath it, and the last matching rule wins.
//! JavaScript matched UTF-16 code units (`?` is one unit, so it never matches an emoji) and its `.` stops at line
//! terminators; this matcher does the same.

use std::path::Path;

/// Always-skipped names, applied like root `.gitignore` patterns before the root's own.
pub const DEFAULTS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "out",
    ".next",
    "target",
    "build",
    ".turbo",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".codegraph",
    "bazel-*",
];

const SLASH: u16 = b'/' as u16;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Token {
    Unit(u16),
    /// `?`: one unit but `/` (`[^/]`).
    One,
    /// `*`: any units but `/` (`[^/]*`).
    Segment,
    /// `**` not before a `/`: any units but line terminators (`.*`).
    Line,
    /// `**/`: whole segments (`(?:[^/]+/)*`).
    Folders,
}

#[derive(Debug)]
struct Rule {
    negated: bool,
    dir_only: bool,
    anchored: bool,
    tokens: Vec<Token>,
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn compile(raw: &str) -> Option<Rule> {
    let mut line = raw.trim_end_matches(super::order::is_js_space);
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut negated = false;
    if let Some(rest) = line.strip_prefix('!') {
        negated = true;
        line = rest;
    } else if line.starts_with("\\!") || line.starts_with("\\#") {
        line = &line[1..];
    }
    let mut dir_only = false;
    if let Some(rest) = line.strip_suffix('/') {
        dir_only = true;
        line = rest;
    }
    if line.is_empty() {
        return None;
    }
    let anchored = line.contains('/');
    let line = line.strip_prefix('/').unwrap_or(line);
    let units: Vec<u16> = line.encode_utf16().collect();
    let star = b'*' as u16;
    let mut tokens = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let token = match units[i] {
            unit if unit == star => {
                if units.get(i + 1) == Some(&star) {
                    if units.get(i + 2) == Some(&SLASH) {
                        i += 3;
                        Token::Folders
                    } else {
                        i += 2;
                        Token::Line
                    }
                } else {
                    i += 1;
                    Token::Segment
                }
            }
            unit if unit == b'?' as u16 => {
                i += 1;
                Token::One
            }
            unit => {
                i += 1;
                Token::Unit(unit)
            }
        };
        tokens.push(token);
    }
    Some(Rule {
        negated,
        dir_only,
        anchored,
        tokens,
    })
}

/// The rules of one listing: the defaults, then the root's `.gitignore`.
pub struct Ignore {
    rules: Vec<Rule>,
    units: Vec<u16>,
    /// Failed (token, position) pairs of the current match, stamped with `generation` instead of cleared.
    failed: Vec<u32>,
    generation: u32,
}

impl Ignore {
    pub fn new<'a>(patterns: impl IntoIterator<Item = &'a str>) -> Ignore {
        Ignore {
            rules: patterns.into_iter().filter_map(compile).collect(),
            units: Vec::new(),
            failed: Vec::new(),
            generation: 0,
        }
    }

    /// The defaults and the lines of `<root>/.gitignore` when it is readable.
    pub fn load(root: &Path) -> Ignore {
        let content = std::fs::read(root.join(".gitignore"))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        let lines = content
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line));
        Ignore::new(DEFAULTS.iter().copied().chain(lines))
    }

    /// Whether `rel` (root-relative, `/`-separated) is ignored: the last rule that matches decides.
    pub fn is_ignored(&mut self, rel: &str, is_dir: bool) -> bool {
        self.units.clear();
        self.units.extend(rel.encode_utf16());
        for index in (0..self.rules.len()).rev() {
            let rule = &self.rules[index];
            if rule.dir_only && !is_dir {
                continue;
            }
            if self.matches(index) {
                return !self.rules[index].negated;
            }
        }
        false
    }

    fn matches(&mut self, rule: usize) -> bool {
        let Ignore {
            rules,
            units,
            failed,
            generation,
        } = self;
        let rule = &rules[rule];
        let cells = (rule.tokens.len() + 1) * (units.len() + 1);
        if failed.len() < cells {
            failed.resize(cells, 0);
        }
        *generation = match generation.checked_add(1) {
            Some(next) => next,
            None => {
                failed.fill(0);
                1
            }
        };
        let mut search = Search {
            tokens: &rule.tokens,
            units,
            last_terminator: units.iter().rposition(|&unit| is_line_terminator(unit)),
            failed,
            generation: *generation,
        };
        if rule.anchored {
            return search.from(0, 0);
        }
        if search.from(0, 0) {
            return true;
        }
        (0..units.len()).any(|at| units[at] == SLASH && search.from(0, at + 1))
    }
}

struct Search<'a> {
    tokens: &'a [Token],
    units: &'a [u16],
    last_terminator: Option<usize>,
    failed: &'a mut [u32],
    generation: u32,
}

impl Search<'_> {
    /// `(?:/.*)?$` at `at`: the end, or a `/` with no line terminator after it.
    fn tail(&self, at: usize) -> bool {
        at == self.units.len()
            || (self.units[at] == SLASH && self.last_terminator.is_none_or(|last| last < at))
    }

    /// Whether `tokens[token..]` then the tail match from `at`.
    fn from(&mut self, token: usize, at: usize) -> bool {
        let Some(&current) = self.tokens.get(token) else {
            return self.tail(at);
        };
        let cell = token * (self.units.len() + 1) + at;
        if self.failed[cell] == self.generation {
            return false;
        }
        let units = self.units;
        let matched = match current {
            Token::Unit(unit) => units.get(at) == Some(&unit) && self.from(token + 1, at + 1),
            Token::One => {
                units.get(at).is_some_and(|&unit| unit != SLASH) && self.from(token + 1, at + 1)
            }
            Token::Segment => {
                let end = units[at..]
                    .iter()
                    .position(|&unit| unit == SLASH)
                    .map_or(units.len(), |offset| at + offset);
                (at..=end).rev().any(|next| self.from(token + 1, next))
            }
            Token::Line => {
                let end = units[at..]
                    .iter()
                    .position(|&unit| is_line_terminator(unit))
                    .map_or(units.len(), |offset| at + offset);
                (at..=end).rev().any(|next| self.from(token + 1, next))
            }
            Token::Folders => {
                let mut next = at;
                loop {
                    if self.from(token + 1, next) {
                        break true;
                    }
                    match units[next..].iter().position(|&unit| unit == SLASH) {
                        Some(offset) if offset > 0 => next += offset + 1,
                        _ => break false,
                    }
                }
            }
        };
        if !matched {
            self.failed[cell] = self.generation;
        }
        matched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// (patterns, path, is a folder, ignored), each result captured from the TypeScript (`compileIgnoreRule`,
    /// `isIgnored`) before it was deleted.
    const CAPTURED: &[(&[&str], &str, bool, bool)] = &[
        (&["node_modules"], "node_modules", true, true),
        (&["node_modules"], "a/node_modules", true, true),
        (&["node_modules"], "a/node_modules/x/y.js", false, true),
        (&["node_modules"], "node_modules_x", true, false),
        (&["node_modules"], "xnode_modules", true, false),
        (&["bazel-*"], "bazel-out", true, true),
        (&["bazel-*"], "src/bazel-bin/x", false, true),
        (&["bazel-*"], "bazel", true, false),
        (&["*.log"], "a.log", false, true),
        (&["*.log"], "dir/sub/a.log", false, true),
        (&["*.log"], "a.log.txt", false, false),
        (&["*.log"], "a.log/inner", false, true),
        (&["/build"], "build", true, true),
        (&["/build"], "src/build", true, false),
        (&["build/"], "build", false, false),
        (&["build/"], "build", true, true),
        (&["build/"], "src/build", true, true),
        (&["build/"], "build/x.ts", false, false),
        (&["src/*.ts"], "src/a.ts", false, true),
        (&["src/*.ts"], "src/sub/a.ts", false, false),
        (&["src/*.ts"], "x/src/a.ts", false, false),
        (&["**/foo"], "foo", false, true),
        (&["**/foo"], "a/b/foo", false, true),
        (&["**/foo"], "a/b/foo/c", false, true),
        (&["a/**/b"], "a/b", false, true),
        (&["a/**/b"], "a/x/y/b", false, true),
        (&["a/**"], "a/x", false, true),
        (&["a/**"], "a", false, false),
        (&["a**b"], "a/x/b", false, true),
        (&["a**b"], "ab", false, true),
        (&["fil?.txt"], "file.txt", false, true),
        (&["fil?.txt"], "fil/.txt", false, false),
        (&["fil?.txt"], "fi.txt", false, false),
        (&["?"], "😀", false, false),
        (&["??"], "😀", false, true),
        (&["*"], "😀", false, true),
        (&["*.log", "!keep.log"], "keep.log", false, false),
        (&["*.log", "!keep.log"], "drop.log", false, true),
        (&["!keep.log", "*.log"], "keep.log", false, true),
        (&["logs/", "!logs/"], "logs", true, false),
        (&["\\!important"], "!important", false, true),
        (&["\\#hash"], "#hash", false, true),
        (&["#comment"], "#comment", false, false),
        (&["a.b"], "aXb", false, false),
        (&["a+b(c)[d]{e}|f$^"], "a+b(c)[d]{e}|f$^", false, true),
        (&["a\\b"], "a\\b", false, true),
        (&["trailing   "], "trailing", false, true),
        (&["trailing\t"], "trailing", false, true),
        (&[" lead"], " lead", false, true),
        (&[" lead"], "lead", false, false),
        (&["a/"], "a", false, false),
        (&["/"], "x", false, false),
        (&["!"], "x", false, false),
        (&["a"], "a/b\nc", false, false),
        (&["a"], "a/b\u{2028}c", false, false),
        (&["a?b"], "a\nb", false, true),
        (&["a**"], "ab\nc", false, false),
        (&["a**"], "a\rc", false, false),
        (&["*/x"], "a/x", false, true),
        (&["*/x"], "a/b/x", false, false),
        (&["//x"], "x", false, false),
        (&["//x"], "/x", false, true),
        (&["x/"], "x/", true, true),
        (&["Docs"], "docs", false, false),
        (&["ß"], "ss", false, false),
        (&["été"], "dir/été", false, true),
        (&["é"], "e\u{301}", false, false),
        (&["**"], "anything/at/all", false, true),
        (&["***"], "a/b", false, true),
        (&["a/**/"], "a/b", true, true),
        (&["a/**/"], "a/b", false, false),
        (&["**/"], "a", true, true),
        (&["\u{feff}bom"], "bom", false, false),
        (&["bom\u{feff}"], "bom", false, true),
        (&["x\u{a0}"], "x", false, true),
        (&["x\u{85}"], "x", false, false),
    ];

    #[test]
    fn matches_what_the_typescript_matched() {
        let mut wrong = Vec::new();
        for &(patterns, rel, is_dir, ignored) in CAPTURED {
            let mut rules = Ignore::new(patterns.iter().copied());
            if rules.is_ignored(rel, is_dir) != ignored {
                wrong.push((patterns, rel, is_dir, ignored));
            }
        }
        assert!(wrong.is_empty(), "{wrong:?}");
        assert!(CAPTURED.len() >= 40);
    }

    #[test]
    fn skips_comments_and_empty_rules() {
        assert_eq!(Ignore::new(["#x", "", "  ", "!", "/", "!/"]).rules.len(), 0);
    }

    #[test]
    fn keeps_pathological_patterns_linear() {
        let pattern = "*a*a*a*a*a*a*a*a*a*a*a*a*b";
        let path = "a".repeat(400);
        let mut rules = Ignore::new([pattern]);
        assert!(!rules.is_ignored(&path, false));
    }
}
