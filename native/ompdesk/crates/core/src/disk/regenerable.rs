//! Which ignored paths of a worktree its own project can make again, from evidence the repository carries, never from
//! a folder's name alone (was `src/main/disk/regenerable.ts`; a hand-made `dist/` is the user's data). One rule table,
//! first match wins:
//!
//! - `cachedir-tag`: the directory holds a `CACHEDIR.TAG` with the Cache Directory Tagging signature;
//! - `lockfile-dependencies`: `node_modules/` beside a tracked `package.json` with a tracked lockfile at or above it;
//! - `python-bytecode`: `__pycache__/` holding only `.pyc` files;
//! - `build-tool-output`: the output directory of a build tool the package depends on and names in one of its
//!   scripts (or a `--outDir`-style flag a script passes), as that tool's config sets it;
//! - `gitignore-build-section`: the tracked `.gitignore` line that ignores it sits under a comment saying it is build
//!   output, artifacts, generated files, a cache or dependencies.
//!
//! The TypeScript's regular expressions are matched by hand here, as JavaScript read them: `\s` is JavaScript's
//! white space (`is_js_space`), `\b` and `\w` are ASCII, `i` folds ASCII only. Tested against 273 scenarios captured
//! from the TypeScript (`regenerable-captured.json`).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::File;
use std::path::Path;

use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use super::tree::under;
use crate::fs::disk::{self, Kind};
use crate::fs::order::{is_js_space, js_trim};
use crate::server::Fault;

/// The rule that proves an entry regenerable, and what it read.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Regenerable {
    pub reason: String,
    pub evidence: String,
}

/// What the rules read beyond the tracked files and `check-ignore`: file text, the tag, a bytecode folder.
pub trait Source {
    fn read_text(&self, relative: &str) -> Option<String>;
    fn cache_dir_tagged(&self, relative: &str) -> bool;
    /// Every file under the directory ends with `.pyc` (false past `BYTECODE_SCAN_LIMIT` entries).
    fn only_bytecode(&self, relative: &str) -> bool;
}

/// What the rules read of the worktree, gathered once.
pub struct Evidence<S> {
    /// Tracked files, relative and `/`-separated.
    pub tracked: HashSet<String>,
    /// `git check-ignore -v` per ignored path: the file and line of the pattern that ignores it.
    pub ignored_by: HashMap<String, (String, u64)>,
    pub source: S,
}

const CACHEDIR_SIGNATURE: &[u8] = b"Signature: 8a477f597d28d172789f06886806bc55";
const LOCKFILES: [&str; 6] = [
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
];
/// The words a `.gitignore` comment uses for something a tool produces.
const BUILD_SECTION: [&str; 16] = [
    "build",
    "builds",
    "built",
    "output",
    "outputs",
    "artifact",
    "artifacts",
    "generated",
    "cache",
    "caches",
    "dependencies",
    "deps",
    "compiled",
    "bundle",
    "bundles",
    "dist",
];
const BYTECODE_SCAN_LIMIT: usize = 5000;

/// How a script invokes a tool's build: `first` (any of) then, when given, white space and `second` (any of).
/// `dash_before`: a `-` before the first word is allowed (`\b`), where `vite`'s rule refuses one (`(?<![\w-])`), so
/// `electron-vite build` is not `vite build`.
struct Invocation {
    first: &'static [&'static str],
    dash_before: bool,
    second: Option<&'static [&'static str]>,
}

/// Where a tool's config file sets its output.
#[derive(Clone, Copy)]
enum Config {
    /// `outDir: "…"` (any of `"'` and a backtick), key `\boutDir\b`.
    OutDir,
    /// A YAML line `output: …`, key `\boutput\s*:`.
    Output,
    /// tsconfig's `"outDir": "…"`, key `"outDir"`.
    JsonOutDir,
}

/// A build tool and the directories its build writes by default. `pkg` must be a dependency and its invocation one of
/// the package's scripts; a literal output in a config file replaces the default, and one set any other way leaves
/// the output unknown, so nothing of it counts.
struct Tool {
    pkg: &'static str,
    build: Invocation,
    /// `tsc` without `--noEmit` before the end of its command.
    tsc: bool,
    outputs: &'static [&'static str],
    config: Option<(Config, &'static [&'static str])>,
}

const VITE_CONFIGS: &[&str] = &[
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.mts",
];

const BUILD_TOOLS: [Tool; 10] = [
    Tool {
        pkg: "electron-vite",
        build: Invocation {
            first: &["electron-vite"],
            dash_before: true,
            second: Some(&["build"]),
        },
        tsc: false,
        outputs: &["out"],
        config: Some((
            Config::OutDir,
            &[
                "electron.vite.config.ts",
                "electron.vite.config.js",
                "electron.vite.config.mjs",
            ],
        )),
    },
    Tool {
        pkg: "vite",
        build: Invocation {
            first: &["vite"],
            dash_before: false,
            second: Some(&["build"]),
        },
        tsc: false,
        outputs: &["dist"],
        config: Some((Config::OutDir, VITE_CONFIGS)),
    },
    Tool {
        pkg: "electron-builder",
        build: Invocation {
            first: &["electron-builder"],
            dash_before: true,
            second: None,
        },
        tsc: false,
        outputs: &["dist"],
        config: Some((
            Config::Output,
            &["electron-builder.yml", "electron-builder.yaml"],
        )),
    },
    Tool {
        pkg: "next",
        build: Invocation {
            first: &["next"],
            dash_before: true,
            second: Some(&["build"]),
        },
        tsc: false,
        outputs: &[".next"],
        config: None,
    },
    Tool {
        pkg: "next",
        build: Invocation {
            first: &["next"],
            dash_before: true,
            second: Some(&["export"]),
        },
        tsc: false,
        outputs: &["out"],
        config: None,
    },
    // `\bnuxi?\s+…`: `nux` or `nuxi`, so `nuxt build` is no invocation (as the TypeScript read it).
    Tool {
        pkg: "nuxt",
        build: Invocation {
            first: &["nuxi", "nux"],
            dash_before: true,
            second: Some(&["build", "generate"]),
        },
        tsc: false,
        outputs: &[".nuxt", ".output"],
        config: None,
    },
    Tool {
        pkg: "astro",
        build: Invocation {
            first: &["astro"],
            dash_before: true,
            second: Some(&["build"]),
        },
        tsc: false,
        outputs: &["dist", ".astro"],
        config: None,
    },
    Tool {
        pkg: "@sveltejs/kit",
        build: Invocation {
            first: &["vite"],
            dash_before: false,
            second: Some(&["build"]),
        },
        tsc: false,
        outputs: &[".svelte-kit"],
        config: None,
    },
    Tool {
        pkg: "parcel",
        build: Invocation {
            first: &["parcel"],
            dash_before: true,
            second: Some(&["build"]),
        },
        tsc: false,
        outputs: &["dist", ".parcel-cache"],
        config: None,
    },
    Tool {
        pkg: "typescript",
        build: Invocation {
            first: &["tsc"],
            dash_before: true,
            second: None,
        },
        tsc: true,
        outputs: &[],
        config: Some((
            Config::JsonOutDir,
            &["tsconfig.json", "tsconfig.build.json"],
        )),
    },
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn before(text: &str, at: usize) -> Option<char> {
    text[..at].chars().next_back()
}

fn after(text: &str, at: usize) -> Option<char> {
    text[at..].chars().next()
}

/// `\b` at `at` where the word side is after it.
fn word_starts(text: &str, at: usize) -> bool {
    before(text, at).is_none_or(|c| !is_word(c))
}

/// `\b` at `at` where the word side is before it.
fn word_ends(text: &str, at: usize) -> bool {
    after(text, at).is_none_or(|c| !is_word(c))
}

/// `\s*` from `at`.
fn spaces(text: &str, at: usize) -> usize {
    at + text[at..]
        .chars()
        .take_while(|c| is_js_space(*c))
        .map(char::len_utf8)
        .sum::<usize>()
}

/// One of `words` at `at`, the longest first as an alternation with an optional letter reads.
fn word_at(text: &str, at: usize, words: &[&str]) -> Option<usize> {
    words
        .iter()
        .find(|word| text[at..].starts_with(**word))
        .map(|word| at + word.len())
}

impl Tool {
    /// The tool's `build` pattern `.test`s the joined scripts.
    fn invoked(&self, scripts: &str) -> bool {
        let invocation = &self.build;
        invocation.first.iter().any(|first| {
            scripts.match_indices(first).any(|(at, _)| {
                let starts = match before(scripts, at) {
                    None => true,
                    Some(c) => !is_word(c) && (invocation.dash_before || c != '-'),
                };
                let Some(end) = word_at(scripts, at, invocation.first).filter(|_| starts) else {
                    return false;
                };
                let end = match invocation.second {
                    None => end,
                    Some(second) => {
                        let gap = spaces(scripts, end);
                        if gap == end {
                            return false;
                        }
                        match word_at(scripts, gap, second) {
                            Some(end) => end,
                            None => return false,
                        }
                    }
                };
                if !word_ends(scripts, end) {
                    return false;
                }
                // `(?![^\n&|;]*--noEmit)`: `--noEmit` before the end of this command.
                !self.tsc
                    || !scripts[end..]
                        .split(['\n', '&', '|', ';'])
                        .next()
                        .is_some_and(|command| command.contains("--noEmit"))
            })
        })
    }
}

impl Config {
    /// The literal output the file sets (the pattern's first match).
    fn value(self, text: &str) -> Option<&str> {
        match self {
            Config::OutDir => text.match_indices("outDir").find_map(|(at, word)| {
                if !word_starts(text, at) {
                    return None;
                }
                quoted(
                    text,
                    at + word.len(),
                    &['"', '\'', '`'],
                    &['"', '\'', '`', '$'],
                    true,
                )
            }),
            Config::JsonOutDir => text
                .match_indices("\"outDir\"")
                .find_map(|(at, word)| quoted(text, at + word.len(), &['"'], &['"', '$'], true)),
            Config::Output => {
                let starts = std::iter::once(0).chain(
                    text.char_indices()
                        .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
                        .map(|(at, c)| at + c.len_utf8()),
                );
                starts.into_iter().find_map(|line| {
                    let at = spaces(text, line);
                    text[at..].starts_with("output").then_some(())?;
                    let value = quoted(
                        text,
                        at + "output".len(),
                        &['"', '\''],
                        &['"', '\'', '#', '$'],
                        false,
                    )?;
                    Some(value)
                })
            }
        }
    }

    /// Whether the file names the output setting at all.
    fn names_key(self, text: &str) -> bool {
        match self {
            Config::OutDir => text
                .match_indices("outDir")
                .any(|(at, word)| word_starts(text, at) && word_ends(text, at + word.len())),
            Config::Output => text.match_indices("output").any(|(at, word)| {
                word_starts(text, at) && after(text, spaces(text, at + word.len())) == Some(':')
            }),
            Config::JsonOutDir => text.contains("\"outDir\""),
        }
    }
}

/// `\s*:\s*` then the value from `at`: an opening quote (one of `opening`; optional unless `closed`), a run of no
/// `stop` and no white space when `closed` is false, and when `closed` a closing quote of `opening`.
fn quoted<'a>(
    text: &'a str,
    at: usize,
    opening: &[char],
    stop: &[char],
    closed: bool,
) -> Option<&'a str> {
    let at = spaces(text, at);
    if after(text, at) != Some(':') {
        return None;
    }
    let mut at = spaces(text, at + 1);
    match after(text, at) {
        Some(c) if opening.contains(&c) => at += c.len_utf8(),
        _ if closed => return None,
        _ => {}
    }
    let run: usize = text[at..]
        .chars()
        .take_while(|c| !stop.contains(c) && (closed || !is_js_space(*c)))
        .map(char::len_utf8)
        .sum();
    if run == 0 {
        return None;
    }
    if closed && !after(text, at + run).is_some_and(|c| opening.contains(&c)) {
        return None;
    }
    Some(&text[at..at + run])
}

/// `/--out-?dir(?:=|\s+)["']?([^\s"'&|;]+)/gi`: each match, whole and its directory.
fn out_flags(scripts: &str) -> Vec<(&str, &str)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = scripts[from..].find("--") {
        let start = from + offset;
        match out_flag(scripts, start) {
            Some(end_and_value) => {
                found.push((&scripts[start..end_and_value.0], end_and_value.1));
                from = end_and_value.0;
            }
            None => from = start + 1,
        }
    }
    found
}

fn out_flag(text: &str, start: usize) -> Option<(usize, &str)> {
    let ci = |at: usize, word: &str| {
        text.get(at..at + word.len())
            .is_some_and(|found| found.eq_ignore_ascii_case(word))
            .then_some(at + word.len())
    };
    let mut at = ci(start + 2, "out")?;
    if text[at..].starts_with('-') && ci(at + 1, "dir").is_some() {
        at += 1;
    }
    at = ci(at, "dir")?;
    if text[at..].starts_with('=') {
        at += 1;
    } else {
        let gap = spaces(text, at);
        if gap == at {
            return None;
        }
        at = gap;
    }
    if matches!(after(text, at), Some('"' | '\'')) {
        at += 1;
    }
    let run: usize = text[at..]
        .chars()
        .take_while(|c| !is_js_space(*c) && !matches!(c, '"' | '\'' | '&' | '|' | ';'))
        .map(char::len_utf8)
        .sum();
    (run > 0).then(|| (at + run, &text[at..at + run]))
}

/// node's `path.posix.dirname`.
fn dirname(path: &str) -> &str {
    let bytes = path.as_bytes();
    if bytes.is_empty() {
        return ".";
    }
    let rooted = bytes[0] == b'/';
    let mut end = None;
    let mut matched_slash = true;
    for index in (1..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                end = Some(index);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None if rooted => "/",
        None => ".",
        Some(1) if rooted => "//",
        Some(end) => &path[..end],
    }
}

/// node's `path.posix.basename` without an extension.
fn basename(path: &str) -> &str {
    let bytes = path.as_bytes();
    let mut start = 0;
    let mut end = None;
    let mut matched_slash = true;
    for index in (0..bytes.len()).rev() {
        if bytes[index] == b'/' {
            if !matched_slash {
                start = index + 1;
                break;
            }
        } else if end.is_none() {
            matched_slash = false;
            end = Some(index + 1);
        }
    }
    end.map_or("", |end| &path[start..end])
}

/// node's `path.posix.normalize`.
fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let rooted = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push("..");
                }
            }
            part => parts.push(part),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() {
        return if rooted {
            "/".into()
        } else if trailing {
            "./".into()
        } else {
            ".".into()
        };
    }
    if trailing {
        out.push('/');
    }
    if rooted { format!("/{out}") } else { out }
}

fn trim_dir(relative: &str) -> &str {
    relative.trim_end_matches('/')
}

fn parent_of(relative: &str) -> &str {
    match dirname(trim_dir(relative)) {
        "." => "",
        parent => parent,
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// `normalizeOut`: a leading `./` dropped, normalized, trailing slashes dropped.
fn normalize_out(value: &str) -> String {
    normalize(value.strip_prefix("./").unwrap_or(value))
        .trim_end_matches('/')
        .to_owned()
}

/// A tracked lockfile in `dir` or a folder above it inside the worktree.
fn lockfile_for(dir: &str, tracked: &HashSet<String>) -> Option<String> {
    let mut current = dir;
    loop {
        for name in LOCKFILES {
            let candidate = join(current, name);
            if tracked.contains(&candidate) {
                return Some(candidate);
            }
        }
        if current.is_empty() {
            return None;
        }
        current = parent_of(current);
    }
}

/// `Object.values(manifest.scripts ?? {})` filtered to strings, in JavaScript's property order: integer-like keys
/// ascending first, then the rest as first written (a repeated key keeps its first place and its last value).
#[derive(Default)]
struct Scripts(Vec<String>);

impl<'de> Deserialize<'de> for Scripts {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Scripts, D::Error> {
        struct ScriptsVisitor;
        impl<'de> Visitor<'de> for ScriptsVisitor {
            type Value = Scripts;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Scripts, A::Error> {
                let mut entries: Vec<(String, serde_json::Value)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, serde_json::Value>()? {
                    match entries.iter_mut().find(|(seen, _)| *seen == key) {
                        Some(entry) => entry.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                let (mut indexed, named): (Vec<_>, Vec<_>) = entries
                    .into_iter()
                    .partition(|(key, _)| array_index(key).is_some());
                indexed.sort_by_key(|(key, _)| array_index(key));
                Ok(Scripts(
                    indexed
                        .into_iter()
                        .chain(named)
                        .filter_map(|(_, value)| match value {
                            serde_json::Value::String(text) => Some(text),
                            _ => None,
                        })
                        .collect(),
                ))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Scripts, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<serde_json::Value>()? {
                    if let serde_json::Value::String(text) = value {
                        values.push(text);
                    }
                }
                Ok(Scripts(values))
            }
            fn visit_str<E: de::Error>(self, text: &str) -> Result<Scripts, E> {
                Ok(Scripts(text.chars().map(String::from).collect()))
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Scripts, E> {
                Ok(Scripts::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Scripts, E> {
                Ok(Scripts::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Scripts, E> {
                Ok(Scripts::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Scripts, E> {
                Ok(Scripts::default())
            }
            fn visit_unit<E: de::Error>(self) -> Result<Scripts, E> {
                Ok(Scripts::default())
            }
        }
        deserializer.deserialize_any(ScriptsVisitor)
    }
}

/// A canonical array index (`"0"`, `"12"`, below 2^32 − 1): JavaScript lists such keys first.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index < u32::MAX)
}

/// `Object.keys(deps ?? {})` of an object; any other value has no package name among its keys.
#[derive(Default)]
struct Keys(Vec<String>);

impl<'de> Deserialize<'de> for Keys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Keys, D::Error> {
        struct KeysVisitor;
        impl<'de> Visitor<'de> for KeysVisitor {
            type Value = Keys;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Keys, A::Error> {
                let mut keys = Vec::new();
                while let Some((key, _)) = map.next_entry::<String, IgnoredAny>()? {
                    keys.push(key);
                }
                Ok(Keys(keys))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Keys, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Keys::default())
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Keys, E> {
                Ok(Keys::default())
            }
            fn visit_unit<E: de::Error>(self) -> Result<Keys, E> {
                Ok(Keys::default())
            }
        }
        deserializer.deserialize_any(KeysVisitor)
    }
}

/// A `package.json` as `JSON.parse` gives it to the rules: `null` (which the TypeScript threw on), an object's
/// scripts and dependency names, or anything else (no scripts).
enum Manifest {
    Null,
    Object {
        scripts: Scripts,
        deps: HashSet<String>,
    },
    Other,
}

impl<'de> Deserialize<'de> for Manifest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Manifest, D::Error> {
        struct ManifestVisitor;
        impl<'de> Visitor<'de> for ManifestVisitor {
            type Value = Manifest;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Manifest, A::Error> {
                let mut scripts = Scripts::default();
                let (mut dependencies, mut dev) = (Keys::default(), Keys::default());
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "scripts" => scripts = map.next_value()?,
                        "dependencies" => dependencies = map.next_value()?,
                        "devDependencies" => dev = map.next_value()?,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(Manifest::Object {
                    scripts,
                    deps: dependencies.0.into_iter().chain(dev.0).collect(),
                })
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Manifest, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Manifest::Other)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Manifest, E> {
                Ok(Manifest::Other)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Manifest, E> {
                Ok(Manifest::Other)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Manifest, E> {
                Ok(Manifest::Other)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Manifest, E> {
                Ok(Manifest::Other)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Manifest, E> {
                Ok(Manifest::Other)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Manifest, E> {
                Ok(Manifest::Null)
            }
        }
        deserializer.deserialize_any(ManifestVisitor)
    }
}

/// Insertion-ordered output → evidence, a repeated key keeping its place and taking the new evidence (a `Map`).
type Outputs = Vec<(String, String)>;

fn set(outputs: &mut Outputs, key: String, evidence: String) {
    match outputs.iter_mut().find(|(seen, _)| *seen == key) {
        Some(entry) => entry.1 = evidence,
        None => outputs.push((key, evidence)),
    }
}

impl<S: Source> Evidence<S> {
    /// The directories (relative to the package at `dir`) the package's own build makes, with the evidence.
    fn declared_outputs(&self, dir: &str) -> Result<Outputs, Fault> {
        let mut outputs = Outputs::new();
        let manifest_path = join(dir, "package.json");
        if !self.tracked.contains(&manifest_path) {
            return Ok(outputs);
        }
        let Some(text) = self
            .source
            .read_text(&manifest_path)
            .filter(|text| !text.is_empty())
        else {
            return Ok(outputs);
        };
        let (scripts, deps) = match serde_json::from_str::<Manifest>(&text) {
            Ok(Manifest::Object { scripts, deps }) => (scripts.0.join("\n"), deps),
            Ok(Manifest::Null) => {
                return Err(Fault::new(
                    "type_error",
                    "Cannot read properties of null (reading 'scripts')",
                ));
            }
            Ok(Manifest::Other) => (String::new(), HashSet::new()),
            Err(_) => return Ok(outputs),
        };
        for (whole, value) in out_flags(&scripts) {
            let out = normalize_out(value);
            if !out.is_empty() && !out.starts_with("..") {
                set(
                    &mut outputs,
                    out,
                    format!("{manifest_path} script passes {}", js_trim(whole)),
                );
            }
        }
        for tool in &BUILD_TOOLS {
            if !deps.contains(tool.pkg) || !tool.invoked(&scripts) {
                continue;
            }
            let mut configured = None;
            let mut unknown = false;
            if let Some((config, files)) = tool.config {
                for file in files {
                    let config_path = join(dir, file);
                    if !self.tracked.contains(&config_path) {
                        continue;
                    }
                    let text = self.source.read_text(&config_path).unwrap_or_default();
                    if let Some(value) = config.value(&text) {
                        let out = normalize_out(value);
                        set(
                            &mut outputs,
                            out.clone(),
                            format!("{config_path} sets {}'s output to {value}", tool.pkg),
                        );
                        configured = Some(out);
                        break;
                    }
                    if config.names_key(&text) {
                        unknown = true;
                    }
                }
            }
            if configured.is_some_and(|out| !out.is_empty()) || unknown {
                continue;
            }
            for out in tool.outputs {
                set(
                    &mut outputs,
                    (*out).to_owned(),
                    format!("{} in {manifest_path}, built by its scripts", tool.pkg),
                );
            }
        }
        Ok(outputs)
    }

    /// Each ignored entry with the first rule that proves it regenerable, or none.
    pub fn classify(&self, entries: &[String]) -> Result<Vec<Option<Regenerable>>, Fault> {
        let mut packages: HashMap<String, Outputs> = HashMap::new();
        entries
            .iter()
            .map(|entry| self.rules(entry, &mut packages))
            .collect()
    }

    fn rules(
        &self,
        entry: &str,
        packages: &mut HashMap<String, Outputs>,
    ) -> Result<Option<Regenerable>, Fault> {
        let found = |reason: &str, evidence: String| {
            Ok(Some(Regenerable {
                reason: reason.to_owned(),
                evidence,
            }))
        };
        let folder = entry.ends_with('/');
        let target = trim_dir(entry);
        let name = basename(target);
        if folder && self.source.cache_dir_tagged(target) {
            return found("cachedir-tag", format!("{target}/CACHEDIR.TAG"));
        }
        if folder && name == "node_modules" {
            let dir = parent_of(entry);
            if self.tracked.contains(&join(dir, "package.json"))
                && let Some(lockfile) = lockfile_for(dir, &self.tracked)
            {
                return found("lockfile-dependencies", lockfile);
            }
        }
        if folder && name == "__pycache__" && self.source.only_bytecode(target) {
            return found("python-bytecode", format!("{target} holds only .pyc files"));
        }
        if folder {
            // The nearest package.json above the entry owns it (a monorepo package, else the root).
            let mut dir = parent_of(entry);
            loop {
                if self.tracked.contains(&join(dir, "package.json")) {
                    let relative = if dir.is_empty() {
                        target
                    } else {
                        &target[dir.len() + 1..]
                    };
                    if !packages.contains_key(dir) {
                        let outputs = self.declared_outputs(dir)?;
                        packages.insert(dir.to_owned(), outputs);
                    }
                    let why = packages[dir]
                        .iter()
                        .find(|(out, _)| out == relative)
                        .map(|(_, why)| why.clone());
                    if let Some(why) = why {
                        return found("build-tool-output", why);
                    }
                    break;
                }
                if dir.is_empty() {
                    break;
                }
                dir = parent_of(dir);
            }
        }
        let Some((source, line)) = self
            .ignored_by
            .get(entry)
            .or_else(|| self.ignored_by.get(target))
        else {
            return Ok(None);
        };
        if basename(source) != ".gitignore" || !self.tracked.contains(source) {
            return Ok(None);
        }
        let text = self.source.read_text(source).unwrap_or_default();
        match section_comment(&text, *line) {
            Some(comment) if names_build_output(comment) => found(
                "gitignore-build-section",
                format!("{source}:{line} under \"{comment}\""),
            ),
            _ => Ok(None),
        }
    }
}

/// The comment heading the `.gitignore` block that holds `line` (1-based), or none.
fn section_comment(text: &str, line: u64) -> Option<&str> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let start = usize::try_from(line.checked_sub(2)?).ok()?;
    for index in (0..=start).rev() {
        let current = js_trim(lines.get(index).copied().unwrap_or(""));
        if current.is_empty() {
            return None;
        }
        if current.starts_with('#') {
            return Some(current);
        }
    }
    None
}

/// One of `BUILD_SECTION`'s words stands whole in the comment, any ASCII case.
fn names_build_output(comment: &str) -> bool {
    comment.split(|c: char| !is_word(c)).any(|word| {
        BUILD_SECTION
            .iter()
            .any(|known| known.eq_ignore_ascii_case(word))
    })
}

/// One `git check-ignore -v` record, `<source>:<line>:<pattern>\t<path>` (`/^(.*?):(\d+):[^\t]*\t(.*)$/`): the source
/// is before the first `:<digits>:` the rest of the record fits after, and neither part holds a line break.
pub fn check_ignore_record(record: &str) -> Option<(&str, u64, &str)> {
    let breaks = |text: &str| text.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    for (colon, _) in record.match_indices(':') {
        let source = &record[..colon];
        if breaks(source) {
            return None;
        }
        let rest = &record[colon + 1..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || rest.as_bytes().get(digits) != Some(&b':') {
            continue;
        }
        let Some(tab) = rest[digits + 1..].find('\t') else {
            continue;
        };
        let path = &rest[digits + 1 + tab + 1..];
        if breaks(path) {
            continue;
        }
        if source.is_empty() || path.is_empty() {
            return None;
        }
        let line = rest[..digits].parse::<u64>().unwrap_or(u64::MAX);
        return Some((source, line, path));
    }
    None
}

/// The evidence on disk: files read from the worktree at `root` (lossy UTF-8, as node read them).
pub struct Disk {
    pub root: String,
}

impl Source for Disk {
    fn read_text(&self, relative: &str) -> Option<String> {
        std::fs::read(under(&self.root, relative))
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    fn cache_dir_tagged(&self, relative: &str) -> bool {
        let Ok(mut file) = File::open(under(&self.root, relative).join("CACHEDIR.TAG")) else {
            return false;
        };
        let mut head = [0u8; CACHEDIR_SIGNATURE.len()];
        disk::read_into(&mut file, &mut head).is_ok_and(|_| head == CACHEDIR_SIGNATURE)
    }

    fn only_bytecode(&self, relative: &str) -> bool {
        let mut seen = 0;
        only_bytecode(&under(&self.root, relative), &mut seen)
    }
}

/// Every file under `dir` ends with `.pyc`, within `BYTECODE_SCAN_LIMIT` entries. A folder whose name is not UTF-8
/// fails it, as node's lossy name could not open it.
fn only_bytecode(dir: &Path, seen: &mut usize) -> bool {
    let Ok(entries) = disk::entries(dir) else {
        return false;
    };
    for entry in entries {
        *seen += 1;
        if *seen > BYTECODE_SCAN_LIMIT {
            return false;
        }
        if entry.kind == Kind::Dir {
            if entry.raw.to_str().is_none() || !only_bytecode(&dir.join(&entry.raw), seen) {
                return false;
            }
        } else if !entry.name.ends_with(".pyc") {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        name: String,
        entries: Vec<String>,
        tracked: Vec<String>,
        ignored_by: Vec<(String, IgnoredBy)>,
        texts: HashMap<String, String>,
        tagged: Vec<String>,
        bytecode: Vec<String>,
        verdicts: Option<Vec<Option<Regenerable>>>,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct IgnoredBy {
        source: String,
        line: u64,
    }

    struct Table<'a>(&'a Row);

    impl Source for Table<'_> {
        fn read_text(&self, relative: &str) -> Option<String> {
            self.0.texts.get(relative).cloned()
        }
        fn cache_dir_tagged(&self, relative: &str) -> bool {
            self.0.tagged.iter().any(|tagged| tagged == relative)
        }
        fn only_bytecode(&self, relative: &str) -> bool {
            self.0.bytecode.iter().any(|dir| dir == relative)
        }
    }

    #[test]
    fn classifies_as_the_typescript_did() {
        let rows: Vec<Row> =
            serde_json::from_str(include_str!("regenerable-captured.json")).unwrap();
        assert_eq!(rows.len(), 273);
        for row in &rows {
            let evidence = Evidence {
                tracked: row.tracked.iter().cloned().collect(),
                ignored_by: row
                    .ignored_by
                    .iter()
                    .map(|(path, by)| (path.clone(), (by.source.clone(), by.line)))
                    .collect(),
                source: Table(row),
            };
            match (&row.verdicts, &row.error) {
                (Some(verdicts), _) => assert_eq!(
                    &evidence.classify(&row.entries).unwrap(),
                    verdicts,
                    "{}",
                    row.name
                ),
                (None, Some(error)) => assert_eq!(
                    &evidence.classify(&row.entries).unwrap_err().message,
                    error,
                    "{}",
                    row.name
                ),
                (None, None) => panic!("{} has neither", row.name),
            }
        }
    }

    #[test]
    fn reads_check_ignore_as_the_typescript_did() {
        assert_eq!(
            check_ignore_record(".gitignore:1:.env\t.env"),
            Some((".gitignore", 1, ".env"))
        );
        assert_eq!(
            check_ignore_record("a:b:3:x\ty"),
            Some(("a:b", 3, "y")),
            "the source runs to the first `:<digits>:` that fits"
        );
        assert_eq!(check_ignore_record("s:2:p\tq\tr"), Some(("s", 2, "q\tr")));
        assert_eq!(
            check_ignore_record(":2:p\tq"),
            None,
            "an empty source is no record"
        );
        assert_eq!(check_ignore_record("s:2:p\t"), None);
        assert_eq!(check_ignore_record("s:2:p\tq\r"), None);
        assert_eq!(check_ignore_record("s:x:p\tq"), None);
        assert_eq!(check_ignore_record("s\r:2:p\tq"), None);
        assert_eq!(check_ignore_record("s:2:p q"), None);
    }

    #[test]
    fn spells_paths_as_node_s_posix_path_does() {
        for (path, dir, base, normalized) in [
            ("a/b", "a", "b", "a/b"),
            ("a/b/", "a", "b", "a/b/"),
            ("a", ".", "a", "a"),
            ("/a", "/", "a", "/a"),
            ("//a", "//", "a", "/a"),
            ("a//b", "a/", "b", "a/b"),
            ("", ".", "", "."),
            ("./x/../../y", "./x/../..", "y", "../y"),
            ("/..", "/", "..", "/"),
            ("./", ".", ".", "./"),
        ] {
            assert_eq!(dirname(path), dir, "dirname {path}");
            assert_eq!(basename(path), base, "basename {path}");
            assert_eq!(normalize(path), normalized, "normalize {path}");
        }
    }
}
