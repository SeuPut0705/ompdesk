//! Preparing a fresh worktree (was the seeding and the hook lookup of `src/main/local/git/worktree-seed.ts`).
//!
//! `seed` copies what the main checkout's `.worktreeinclude` names into the worktree `worktree add` just made: one
//! path or glob per line (`#` comments; `*`, `?`, `**`), relative to the main checkout. A match is copied only when
//! git ignores it there (`check-ignore`, which never reports a tracked file), so a tracked file is never copied over
//! the checkout git made; a folder's entries are each asked again. Absolute paths, `..`, `.git` and `!` negations are
//! refused; a match whose real path leaves the main checkout is refused, and a link is recreated only when it points
//! inside it. At most `SEED_MAX_FILES` files, and `SEED_MAX_BYTES` bytes unless the volume clones (every file is
//! first asked as a clone; from the first one the volume refuses, the byte cap counts what takes real disk); what
//! does not fit, or is not reached within the time main allows, is skipped with a note. A file the worktree already
//! has is never overwritten.
//!
//! The whole seed is one request under main's hold (`coreGit`): a cancelled one starts no git and makes no further
//! file call. It reads the main checkout and writes the worktree only: every call that creates, links or removes
//! takes a `Place`, which only `Worktree::place` makes, after it checked the path stays in the worktree. The file
//! calls and the entry check are disk care's (`disk/tree.rs`); a junction is this module's own need (`sys.rs`).
//!
//! `hook` finds the repository's script for a worktree hook and where its log goes; main runs the script itself
//! (`runWorktreeHook`), under the supervisor that ends a script's whole process tree.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::runtime::Handle;

use super::orphans::inside;
use super::read::{self, blocking};
use super::run::Git;
use super::worktree::real;
use crate::disk::tree;
use crate::fs::error::Codes;
use crate::fs::order::js_trim;
use crate::server::{Fault, Scope};

const INCLUDE_FILE: &str = ".worktreeinclude";
const SEED_MAX_BYTES: u64 = 50 * 1024 * 1024;
const SEED_MAX_FILES: u32 = 10_000;
const MAX_INCLUDE_BYTES: u64 = 64 * 1024;
const MAX_PATTERNS: usize = 200;
/// Paths one `check-ignore` is asked about.
const CHECK_IGNORE_PATHS: usize = 100;

/// One line of `.worktreeinclude`: a pattern, or why it is refused.
#[derive(Debug, PartialEq)]
enum Line {
    Pattern(String),
    Refused(&'static str),
}

/// `includePattern`: none for a blank line or a comment.
fn include_pattern(line: &str) -> Option<Line> {
    let text = js_trim(line);
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    if text.starts_with('!') {
        return Some(Line::Refused("negation"));
    }
    let slashed = text.replace('\\', "/");
    let pattern = slashed.trim_end_matches('/');
    let drive = matches!(pattern.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic());
    if pattern.is_empty() || pattern.starts_with('/') || drive {
        return Some(Line::Refused("absolute"));
    }
    if pattern
        .split('/')
        .any(|part| matches!(part, ".." | "." | ""))
    {
        return Some(Line::Refused("outside"));
    }
    if pattern.split('/').any(|part| part == ".git") {
        return Some(Line::Refused("git"));
    }
    Some(Line::Pattern(pattern.to_owned()))
}

/// One step of a glob, over UTF-16 units as the TypeScript's regular expression read them.
enum Step {
    Unit(u16),
    /// `?`: one unit that is not `/`.
    One,
    /// `*`: units that are not `/`.
    Run,
    /// `**`: any units of one line (the expression's `.` matched no line end).
    Deep,
    /// `**/`: nothing, or any units of one line and a `/`.
    DeepSlash,
}

const SLASH: u16 = b'/' as u16;

fn is_glob(pattern: &str) -> bool {
    pattern.contains(['*', '?'])
}

/// `globRegex`: `*`, `?` and `**`; every other character stands for itself.
fn glob(pattern: &str) -> Vec<Step> {
    const STAR: u16 = b'*' as u16;
    let units: Vec<u16> = pattern.encode_utf16().collect();
    let mut steps = Vec::with_capacity(units.len());
    let mut at = 0;
    while at < units.len() {
        let unit = units[at];
        at += 1;
        steps.push(if unit == STAR && units.get(at) == Some(&STAR) {
            at += 1;
            if units.get(at) == Some(&SLASH) {
                at += 1;
                Step::DeepSlash
            } else {
                Step::Deep
            }
        } else if unit == STAR {
            Step::Run
        } else if unit == u16::from(b'?') {
            Step::One
        } else {
            Step::Unit(unit)
        });
    }
    steps
}

/// What ends a line for a regular expression's `.`.
fn ends_line(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// `at[p]` says the steps so far can end before unit `p`; this extends every such end over units `through` allows.
fn extend(at: &mut [bool], path: &[u16], through: impl Fn(u16) -> bool) {
    for (position, unit) in path.iter().enumerate() {
        if at[position] && through(*unit) {
            at[position + 1] = true;
        }
    }
}

/// Whether the whole of `path` matches the glob (`^…$`).
fn glob_matches(steps: &[Step], path: &str) -> bool {
    let path: Vec<u16> = path.encode_utf16().collect();
    let mut at = vec![false; path.len() + 1];
    at[0] = true;
    for step in steps {
        let mut next = vec![false; path.len() + 1];
        match step {
            Step::Unit(_) | Step::One => {
                for (position, &unit) in path.iter().enumerate() {
                    let fits = match step {
                        Step::Unit(wanted) => unit == *wanted,
                        _ => unit != SLASH,
                    };
                    next[position + 1] = at[position] && fits;
                }
            }
            Step::Run => {
                next.copy_from_slice(&at);
                extend(&mut next, &path, |unit| unit != SLASH);
            }
            Step::Deep => {
                next.copy_from_slice(&at);
                extend(&mut next, &path, |unit| !ends_line(unit));
            }
            Step::DeepSlash => {
                let mut deep = at.clone();
                extend(&mut deep, &path, |unit| !ends_line(unit));
                next.copy_from_slice(&at);
                for (position, &unit) in path.iter().enumerate() {
                    if deep[position] && unit == SLASH {
                        next[position + 1] = true;
                    }
                }
            }
        }
        at = next;
    }
    at[path.len()]
}

/// The order of JavaScript's default `sort`: by UTF-16 units.
fn js_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `path.join(folder, name)` for an entry of a relative folder: the platform's separators.
fn entry_of(folder: &str, name: &str) -> String {
    let folder = if cfg!(windows) {
        folder.replace('/', "\\")
    } else {
        folder.to_owned()
    };
    format!("{folder}{MAIN_SEPARATOR}{name}")
}

/// The worktree a seed fills: the one folder it creates anything in. `real` is its real path.
struct Worktree {
    real: String,
}

/// A path in the worktree that a seed may create. Only `Worktree::place` makes one, and every call that creates,
/// links or removes takes one, so nothing is written where `place` did not look.
struct Place(PathBuf);

impl Worktree {
    /// Where `relative` goes in the worktree, when that is in it: it is a path inside (`tree::relative_entries`: no
    /// `..`, not absolute, on Windows no `:`, which is a drive or a file's stream), no part of it is one Windows reads
    /// as another name (a `.` or a space at a part's end is dropped there, so `secret.` would be the file `secret`),
    /// its nearest folder that exists is a folder (a folder the branch checked out as a link would carry the write
    /// away) and that folder's real path is the worktree or inside it (`destinationInside`).
    fn place(&self, relative: &str) -> Option<Place> {
        let renamed = cfg!(windows)
            && relative
                .split(['/', '\\'])
                .any(|part| part.ends_with(['.', ' ']));
        if renamed || tree::relative_entries([relative]).is_err() {
            return None;
        }
        let to = tree::under(&self.real, relative);
        let top = Path::new(&self.real);
        let mut dir = to.parent()?;
        while dir != top && dir.starts_with(top) {
            match fs::symlink_metadata(dir) {
                Ok(meta) if meta.is_dir() => break,
                Ok(_) => return None,
                Err(_) => dir = dir.parent()?,
            }
        }
        let resolved = real(&dir.to_string_lossy()).ok()?;
        (resolved == self.real || inside(&self.real, &resolved)).then_some(Place(to))
    }

    /// `path.join(worktree, path.relative(checkout, inside))`: where the main checkout's `inside` is in the worktree.
    fn mirror(&self, checkout: &str, inside: &str) -> PathBuf {
        let depth = Path::new(checkout).components().count();
        let mut path = PathBuf::from(&self.real);
        path.extend(Path::new(inside).components().skip(depth));
        path
    }
}

impl Place {
    fn path(&self) -> &Path {
        &self.0
    }

    /// `mkdir(path.dirname(to), { recursive: true })`.
    fn make_parent(&self) -> Result<(), Fault> {
        self.0
            .parent()
            .map_or(Ok(()), |parent| tree::make_dirs(parent, 0o777))
    }

    /// `copyFile(from, to)`: the file's bytes and mode.
    fn copy(&self, from: &Path) -> Result<(), Fault> {
        tree::copy(from, &self.0)
    }

    /// A link with the text `text`, as it was read.
    #[cfg(not(windows))]
    fn link(&self, text: &Path) -> Result<(), Fault> {
        tree::symlink(text, &self.0)
    }

    /// A junction to the folder `target`: it needs no privilege, where a symlink needs Developer Mode or an
    /// administrator (pnpm's `node_modules` are junctions).
    #[cfg(windows)]
    fn link(&self, target: &Path) -> Result<(), Fault> {
        crate::sys::junction(target, &self.0).map_err(|error| {
            crate::fs::error::NodeError::with_dest(
                &error,
                "symlink",
                Some(&target.to_string_lossy()),
                Some(&self.0.to_string_lossy()),
            )
            .fault(Codes::None)
        })
    }

    /// `rm(to, { force: true })` of a link this seed made: the link itself, never what it names.
    fn unlink(&self, scope: &Scope) -> Result<(), Fault> {
        tree::remove(&self.0, false, scope)
    }
}

/// Makes `to` a clone of the file `from` or fails leaving no file: what `copyFile` with `COPYFILE_FICLONE_FORCE` was.
type Cloner = Box<dyn FnMut(&Path, &Place) -> io::Result<()> + Send>;

/// The volume's own clone: APFS `clonefile` (was `/bin/cp -c`, one process a file) and Linux's reflink (Btrfs, XFS).
/// Windows has none here, as libuv had none (`ENOSYS`).
fn volume_cloner() -> Cloner {
    Box::new(|from, to| {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        return crate::sys::clone_file(from, to.path());
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (from, to);
            Err(io::ErrorKind::Unsupported.into())
        }
    })
}

/// A test's stand-in for a volume: the first `clones` files count as cloned (each a plain copy), every later one is
/// refused as a volume without reflinks refuses it.
fn pretend_cloner(mut clones: u32) -> Cloner {
    Box::new(move |from, to| {
        if clones == 0 {
            return Err(io::ErrorKind::Unsupported.into());
        }
        clones -= 1;
        fs::copy(from, to.path()).map(drop)
    })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Skipped {
    path: String,
    reason: String,
}

/// `WorktreeSeedReport`: `cloned` only when every file was a clone.
#[derive(Serialize, Debug)]
pub struct Report {
    copied: u32,
    bytes: u64,
    cloned: bool,
    skipped: Vec<Skipped>,
}

/// One seed under way.
struct Seed<'a> {
    git: &'a Git,
    gits: &'a Handle,
    scope: &'a Scope,
    /// The main checkout's real path.
    root: String,
    worktree: Worktree,
    cloner: Cloner,
    /// Whether the volume clones: unknown until the first file was tried.
    clone: Option<bool>,
    files: u32,
    bytes: u64,
    /// Bytes that took real disk (a clone takes none): what `SEED_MAX_BYTES` bounds.
    disk: u64,
    skipped: Vec<Skipped>,
    full: bool,
    /// Links made with an absolute target in the main checkout, and where that target is in the worktree.
    absolute: Vec<(Place, PathBuf)>,
    deadline: Instant,
}

impl Seed<'_> {
    /// Before every git and every file call: a cancelled request does no more.
    fn live(&self) -> Result<(), Fault> {
        tree::live(self.scope)
    }

    fn skip(&mut self, path: &str, reason: &str) {
        self.skipped.push(Skipped {
            path: path.to_owned(),
            reason: reason.to_owned(),
        });
    }

    /// The paths git ignores among `paths` (relative to the main checkout), named with `/` as git prints them; a
    /// tracked file is never among them. A `\` in an argument would come back quoted on Windows.
    fn ignored_among(&self, paths: &[String]) -> Result<HashSet<String>, Fault> {
        let mut ignored = HashSet::new();
        for chunk in paths.chunks(CHECK_IGNORE_PATHS) {
            self.live()?;
            let slashed: Vec<String> = chunk.iter().map(|path| path.replace('\\', "/")).collect();
            let mut args = vec!["check-ignore", "--"];
            args.extend(slashed.iter().map(String::as_str));
            let output = self.gits.block_on(self.git.raw(&self.root, &args))?;
            if output.code > 1 {
                continue;
            }
            for item in output.text().split('\n').filter(|item| !item.is_empty()) {
                ignored.insert(item.strip_suffix('/').unwrap_or(item).to_owned());
            }
        }
        Ok(ignored)
    }

    /// What the patterns name in the main checkout, in JavaScript's sort order: a plain path that exists, and for
    /// globs the ignored, untracked paths git lists (an ignored folder once, its contents not walked). Only a path
    /// inside the checkout is looked at (`tree::relative_entries`; on Windows a `:` part names a drive or a stream).
    fn candidates(&self, patterns: &[String]) -> Result<Vec<String>, Fault> {
        let within = |path: &str| tree::relative_entries([path]).is_ok();
        let mut found = HashSet::new();
        for pattern in patterns.iter().filter(|pattern| !is_glob(pattern)) {
            self.live()?;
            if within(pattern) && fs::symlink_metadata(tree::under(&self.root, pattern)).is_ok() {
                found.insert(pattern.clone());
            }
        }
        let globs: Vec<Vec<Step>> = patterns
            .iter()
            .filter(|pattern| is_glob(pattern))
            .map(|pattern| glob(pattern))
            .collect();
        if !globs.is_empty() {
            self.live()?;
            let args = [
                "ls-files",
                "-z",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
            ];
            let listed = self.gits.block_on(self.git.raw(&self.root, &args))?;
            if listed.code == 0 {
                for raw in listed.text().split('\0') {
                    let item = raw.strip_suffix('/').unwrap_or(raw);
                    if within(item) && globs.iter().any(|steps| glob_matches(steps, item)) {
                        found.insert(item.to_owned());
                    }
                }
            }
        }
        let mut found: Vec<String> = found.into_iter().collect();
        found.sort_by(|a, b| js_order(a, b));
        Ok(found)
    }

    /// Copies `relative`, which the caller found ignored; a folder's entries are each asked again (a force-added file
    /// in an ignored folder is tracked).
    fn copy_entry(&mut self, relative: &str) -> Result<(), Fault> {
        self.live()?;
        if Instant::now() >= self.deadline {
            self.skip(relative, "budget");
            self.full = true;
            return Ok(());
        }
        let from = tree::under(&self.root, relative);
        let Ok(meta) = fs::symlink_metadata(&from) else {
            return Ok(());
        };
        let kind = meta.file_type();
        if kind.is_dir() {
            let listed = fs::read_dir(&from)
                .and_then(Iterator::collect::<io::Result<Vec<_>>>)
                .map_err(|error| tree::fault(&error, "scandir", &from))?;
            let mut names: Vec<String> = listed
                .iter()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name != ".git")
                .collect();
            names.sort_by(|a, b| js_order(a, b));
            let entries: Vec<String> = names.iter().map(|name| entry_of(relative, name)).collect();
            let ignored = self.ignored_among(&entries)?;
            for entry in &entries {
                if !ignored.contains(&entry.replace('\\', "/")) {
                    self.skip(entry, "not_ignored");
                    continue;
                }
                self.copy_entry(entry)?;
                if self.full {
                    return Ok(());
                }
            }
            return Ok(());
        }
        if !kind.is_file() && !kind.is_symlink() {
            return Ok(());
        }
        self.live()?;
        if fs::symlink_metadata(tree::under(&self.worktree.real, relative)).is_ok() {
            self.skip(relative, "exists");
            return Ok(());
        }
        let Some(place) = self.worktree.place(relative) else {
            self.skip(relative, "destination_outside");
            return Ok(());
        };
        if kind.is_symlink() {
            let resolved = real(&from.to_string_lossy()).ok();
            let Some(resolved) = resolved.filter(|resolved| inside(&self.root, resolved)) else {
                self.skip(relative, "symlink_outside");
                return Ok(());
            };
            // A file link on Windows is copied: a symlink there needs Developer Mode or an administrator.
            let recreated = !cfg!(windows) || fs::metadata(&from).is_ok_and(|meta| meta.is_dir());
            if recreated {
                self.live()?;
                place.make_parent()?;
                let text = tree::read_link(&from)?.to_string_lossy().into_owned();
                #[cfg(windows)]
                let target = {
                    let parent = place.path().parent().unwrap_or(Path::new(""));
                    read::resolve(&parent.to_string_lossy(), &text)
                };
                #[cfg(not(windows))]
                let target = &text;
                place.link(Path::new(&target))?;
                if read::is_absolute(&text) {
                    let mirrored = self.worktree.mirror(&self.root, &resolved);
                    self.absolute.push((place, mirrored));
                }
                return Ok(());
            }
        }
        // A link's size is its text's, as libuv's `lstat` gave it.
        let size = tree::entry_size(&from, &meta)?;
        if self.files + 1 > SEED_MAX_FILES
            || (self.clone == Some(false) && self.disk + size > SEED_MAX_BYTES)
        {
            self.skip(relative, "budget");
            self.full = true;
            return Ok(());
        }
        self.live()?;
        place.make_parent()?;
        if self.clone != Some(false) {
            // Every file of a cloning seed is a clone: a plain copy would take real disk past the byte budget, which
            // cloning switched off. A refused clone leaves no file, so the plain copy below starts clean.
            if (self.cloner)(&from, &place).is_ok() {
                self.clone = Some(true);
                self.files += 1;
                self.bytes += size;
                return Ok(());
            }
            // The bytes cloned so far took no disk: the byte budget starts here.
            self.clone = Some(false);
            if size > SEED_MAX_BYTES {
                self.skip(relative, "budget");
                self.full = true;
                return Ok(());
            }
            self.live()?;
        }
        place.copy(&from)?;
        self.files += 1;
        self.bytes += size;
        self.disk += size;
        Ok(())
    }

    /// A link written with an absolute path into the main checkout points at the worktree's own copy once there is
    /// one (a tracked file, or one this seed copied): the worktree's edits then reach what it links to, never the main
    /// checkout's file. A target the worktree has no copy of keeps the main checkout's (a shared store).
    fn point_links_at_worktree(&mut self) -> Result<(), Fault> {
        for (place, mirrored) in std::mem::take(&mut self.absolute) {
            self.live()?;
            if fs::symlink_metadata(&mirrored).is_err() {
                continue;
            }
            place.unlink(self.scope)?;
            #[cfg(windows)]
            place.link(&mirrored)?;
            #[cfg(not(windows))]
            {
                let parent = place.path().parent().unwrap_or(Path::new("/"));
                place.link(&relative(parent, &mirrored))?;
            }
        }
        Ok(())
    }
}

/// `path.relative(from, to)` for two absolute, resolved paths.
#[cfg(not(windows))]
fn relative(from: &Path, to: &Path) -> PathBuf {
    let shared = from
        .components()
        .zip(to.components())
        .take_while(|(a, b)| a == b)
        .count();
    let mut path = PathBuf::new();
    for _ in from.components().skip(shared) {
        path.push("..");
    }
    path.extend(to.components().skip(shared));
    path
}

/// What a seed may take beyond the paths: `budget` is how long it may start new entries, `pretend_clones` a test's
/// stand-in for the volume (`pretend_cloner`).
pub struct Limits {
    pub budget: Duration,
    pub pretend_clones: Option<u32>,
}

/// Copies the main checkout's `.worktreeinclude` matches into the worktree at `target`; none when the repository has
/// no such file.
pub async fn seed(
    git: Git,
    scope: Scope,
    primary: String,
    target: String,
    limits: Limits,
) -> Result<Option<Report>, Fault> {
    let cloner = limits
        .pretend_clones
        .map_or_else(volume_cloner, pretend_cloner);
    seed_cloning(git, scope, primary, target, limits.budget, cloner).await
}

/// `seed` with the way a file is cloned.
async fn seed_cloning(
    git: Git,
    scope: Scope,
    primary: String,
    target: String,
    budget: Duration,
    cloner: Cloner,
) -> Result<Option<Report>, Fault> {
    let gits = Handle::current();
    // The walk is file calls with a git between them: it runs whole on the blocking pool and waits for each git there.
    blocking(move || run(&git, &gits, &scope, &primary, &target, budget, cloner)).await?
}

fn run(
    git: &Git,
    gits: &Handle,
    scope: &Scope,
    primary: &str,
    target: &str,
    budget: Duration,
    cloner: Cloner,
) -> Result<Option<Report>, Fault> {
    if scope.cancelled() {
        return Err(Fault::cancelled());
    }
    let root = real(primary).map_err(|error| error.fault(Codes::None))?;
    let list_file = tree::under(&root, INCLUDE_FILE);
    let Some(list) = fs::metadata(&list_file).ok().filter(fs::Metadata::is_file) else {
        return Ok(None);
    };
    let worktree = Worktree {
        real: real(target).map_err(|error| error.fault(Codes::None))?,
    };
    let mut seed = Seed {
        git,
        gits,
        scope,
        root,
        worktree,
        cloner,
        clone: None,
        files: 0,
        bytes: 0,
        disk: 0,
        skipped: Vec::new(),
        full: false,
        absolute: Vec::new(),
        deadline: Instant::now() + budget,
    };
    if list.len() > MAX_INCLUDE_BYTES {
        seed.skip(INCLUDE_FILE, "too_large");
        return Ok(Some(seed.report()));
    }
    let text = fs::read(&list_file).map_err(|error| tree::fault(&error, "open", &list_file))?;
    let mut patterns = Vec::new();
    for line in String::from_utf8_lossy(&text).split('\n') {
        match include_pattern(line) {
            Some(Line::Refused(reason)) => seed.skip(js_trim(line), reason),
            Some(Line::Pattern(pattern)) if patterns.len() < MAX_PATTERNS => patterns.push(pattern),
            // Past `MAX_PATTERNS` a pattern is dropped without a note, as a blank line is.
            Some(Line::Pattern(_)) | None => {}
        }
    }
    // A parent folder that is a link would carry the copy out of the checkout (and git refuses such a path).
    let mut found = Vec::new();
    for candidate in seed.candidates(&patterns)? {
        seed.live()?;
        let parent = tree::under(&seed.root, &candidate);
        let parent = parent.parent().map(Path::to_string_lossy);
        let resolved = parent.and_then(|parent| real(&parent).ok());
        if resolved.is_some_and(|parent| parent == seed.root || inside(&seed.root, &parent)) {
            found.push(candidate);
        } else {
            seed.skip(&candidate, "symlink_outside");
        }
    }
    let ignored = seed.ignored_among(&found)?;
    for candidate in &found {
        seed.live()?;
        // git never reports a folder that holds a tracked file as ignored; `copy_entry` asks about each entry instead.
        let folder = fs::symlink_metadata(tree::under(&seed.root, candidate))
            .is_ok_and(|meta| meta.is_dir());
        if !folder && !ignored.contains(candidate) {
            seed.skip(candidate, "not_ignored");
        } else if seed.full {
            seed.skip(candidate, "budget");
        } else if let Err(failure) = seed.copy_entry(candidate) {
            if scope.cancelled() {
                return Err(Fault::cancelled());
            }
            seed.skip(candidate, &failure.message);
        }
    }
    seed.point_links_at_worktree()?;
    Ok(Some(seed.report()))
}

impl Seed<'_> {
    fn report(self) -> Report {
        Report {
            copied: self.files,
            bytes: self.bytes,
            cloned: self.clone == Some(true),
            skipped: self.skipped,
        }
    }
}

/// A worktree hook's script and where its log goes.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    script: String,
    log_path: String,
}

/// The repository's script `script` (`.ompdesk/worktree-setup`, relative) for the worktree at `worktree`: its own
/// file before the main checkout's, none when neither has one. The log `log` goes in the worktree's git dir, in the
/// worktree itself when git names none.
pub async fn hook(
    git: &Git,
    primary: &str,
    worktree: &str,
    script: &str,
    log: &str,
) -> Result<Option<Hook>, Fault> {
    let found = [worktree, primary]
        .into_iter()
        .map(|dir| tree::under(&read::native(dir), script))
        .find(|file| fs::metadata(file).is_ok_and(|meta| meta.is_file()));
    let Some(script) = found else {
        return Ok(None);
    };
    let git_dir = git
        .raw(worktree, &["rev-parse", "--absolute-git-dir"])
        .await?;
    let text = git_dir.text();
    let log_dir = if git_dir.code == 0 {
        js_trim(&text)
    } else {
        worktree
    };
    let log_path = tree::under(&read::native(log_dir), log);
    Ok(Some(Hook {
        script: script.to_string_lossy().into_owned(),
        log_path: log_path.to_string_lossy().into_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{Value, json};

    use super::*;
    use crate::git::run::tests::{git, runner};
    use crate::git::scm::tests::{repo_at, sh};

    /// What the TypeScript answered for the same inputs, before it was deleted.
    fn captured(table: &str) -> Vec<Value> {
        let rows: Value = serde_json::from_str(include_str!("seed-captured.json")).unwrap();
        rows[table].as_array().unwrap().clone()
    }

    #[test]
    fn reads_a_line_as_the_typescript_did() {
        let rows = captured("includePattern");
        assert_eq!(rows.len(), 97);
        for row in rows {
            let line = row[0].as_str().unwrap();
            let read = match include_pattern(line) {
                None => Value::Null,
                Some(Line::Pattern(pattern)) => json!({ "pattern": pattern }),
                Some(Line::Refused(reason)) => json!({ "refused": reason }),
            };
            assert_eq!(read, row[1], "{line:?}");
        }
    }

    #[test]
    fn matches_a_glob_as_the_typescript_s_regular_expression_did() {
        let paths: Vec<Value> = captured("globPaths");
        let rows = captured("glob");
        assert_eq!(rows.len() * paths.len(), 3496);
        for row in rows {
            let pattern = row[0].as_str().unwrap();
            let steps = glob(pattern);
            let matched: Vec<&Value> = paths
                .iter()
                .filter(|path| glob_matches(&steps, path.as_str().unwrap()))
                .collect();
            assert_eq!(json!(matched), row[1], "{pattern:?}");
        }
    }

    #[test]
    fn sorts_as_javascript_s_default_sort_did() {
        for row in captured("sort") {
            let mut names: Vec<&str> = row[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect();
            names.sort_by(|a, b| js_order(a, b));
            assert_eq!(json!(names), row[1]);
        }
    }

    #[test]
    fn names_a_folder_s_entry_as_node_s_path_join_did() {
        let entry = if cfg!(windows) { r"a\b\c" } else { "a/b/c" };
        assert_eq!(entry_of("a/b", "c"), entry);
    }

    #[cfg(not(windows))]
    #[test]
    fn spells_a_relative_link_as_node_s_path_relative_did() {
        for (from, to, spelled) in [
            ("/w", "/w/conf", "conf"),
            ("/w/sub", "/w/conf", "../conf"),
            ("/w/a/b", "/w/c/d", "../../c/d"),
            ("/w/a", "/w/a", ""),
        ] {
            assert_eq!(relative(Path::new(from), Path::new(to)), Path::new(spelled));
        }
    }

    /// A folder link no privilege is needed for: a junction on Windows, a symlink elsewhere.
    fn link_folder(target: &Path, link: &Path) {
        #[cfg(windows)]
        crate::sys::junction(target, link).unwrap();
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// Every entry under `dir` but those in `skip`, no link followed: what it is, what it holds and when it changed.
    fn snapshot(dir: &Path, skip: &[&Path]) -> BTreeMap<String, String> {
        let mut found = BTreeMap::new();
        let mut pending = vec![dir.to_owned()];
        while let Some(folder) = pending.pop() {
            for entry in fs::read_dir(&folder).unwrap() {
                let path = entry.unwrap().path();
                if skip.contains(&path.as_path()) {
                    continue;
                }
                let meta = fs::symlink_metadata(&path).unwrap();
                let held = if meta.file_type().is_symlink() {
                    format!("link to {}", fs::read_link(&path).unwrap().display())
                } else if meta.is_dir() {
                    pending.push(path.clone());
                    "folder".to_owned()
                } else {
                    let bytes = fs::read(&path).unwrap();
                    format!("file of {bytes:?} changed {:?}", meta.modified().unwrap())
                };
                found.insert(path.to_string_lossy().into_owned(), held);
            }
        }
        found
    }

    /// A main checkout (`repo`) with one commit and room beside it for its worktree (`target`) and for what must stay
    /// untouched (`base`).
    struct World {
        base: PathBuf,
        repo: PathBuf,
        target: PathBuf,
    }

    impl World {
        fn new(name: &str) -> World {
            let base = std::env::temp_dir()
                .join(format!("ompdesk-core-seed-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            fs::create_dir_all(&base).unwrap();
            let base = PathBuf::from(real(&base.to_string_lossy()).unwrap());
            let repo = base.join("repo");
            repo_at(&repo);
            World {
                target: base.join("wt"),
                repo,
                base,
            }
        }

        fn write(&self, relative: &str, content: &str) {
            let path = self.repo.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        /// A file of `bytes` zeros.
        fn sized(&self, relative: &str, bytes: u64) {
            let file = fs::File::create(self.repo.join(relative)).unwrap();
            file.set_len(bytes).unwrap();
        }

        /// Commits `.gitignore`; call it before the ignored files exist.
        fn ignore(&self, lines: &str) {
            self.write(".gitignore", lines);
            sh(&self.repo, &["add", "-A"]);
            sh(&self.repo, &["commit", "-qm", "ignore"]);
        }

        fn worktree(&self) {
            let target = self.target.to_str().unwrap();
            sh(
                &self.repo,
                &["worktree", "add", "-q", "-b", "seeded", target],
            );
        }

        async fn seed_cloning(
            &self,
            scope: Scope,
            budget: Duration,
            cloner: Cloner,
        ) -> Result<Option<Report>, Fault> {
            seed_cloning(
                Git::new(runner(), scope.clone()),
                scope,
                self.repo.to_string_lossy().into_owned(),
                self.target.to_string_lossy().into_owned(),
                budget,
                cloner,
            )
            .await
        }

        async fn seed(&self, cloner: Cloner) -> Report {
            self.seed_cloning(Scope::detached(), Duration::from_secs(180), cloner)
                .await
                .unwrap()
                .unwrap()
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn skipped(report: &Report) -> Vec<(&str, &str)> {
        report
            .skipped
            .iter()
            .map(|skipped| (skipped.path.as_str(), skipped.reason.as_str()))
            .collect()
    }

    /// The patterns, links and folders that could carry a seed out of the worktree or back into the main checkout:
    /// `..`, an absolute path, a link in the main checkout to a folder outside it (a junction on Windows), such a
    /// link inside a copied folder, a path under such a link, and a folder of the worktree that is itself a link out.
    #[tokio::test(flavor = "multi_thread")]
    async fn writes_only_in_the_worktree_and_leaves_everything_else_as_it_was() {
        let world = World::new("contained");
        let outside = world.base.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), "nope\n").unwrap();
        fs::write(outside.join(".env"), "nope\n").unwrap();
        fs::create_dir_all(outside.join("deep")).unwrap();
        world.ignore(".env\nstore/\naway\nbundle/\nvia\ntrap/\nleak\n");
        world.write(".env", "A=1\n");
        world.write("store/pkg.js", "x\n");
        world.write("bundle/file", "f\n");
        world.write("trap/x", "t\n");
        world.write("trap/deep/y", "t\n");
        link_folder(&outside, &world.repo.join("away"));
        link_folder(&outside, &world.repo.join("via"));
        link_folder(&outside, &world.repo.join("bundle").join("out"));
        link_folder(
            &world.repo.join("store"),
            &world.repo.join("bundle").join("in"),
        );
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(outside.join("secret"), world.repo.join("leak")).unwrap();
        let absolute = outside.join("secret").to_string_lossy().into_owned();
        world.write(
            INCLUDE_FILE,
            &format!(
                ".env\n../outside/secret\n..\\outside\\secret\n{absolute}\n/etc/passwd\naway\nvia/.env\nbundle\nstore\ntrap/x\ntrap/deep/y\nleak\n"
            ),
        );
        world.worktree();
        // The branch has `trap` as a link that leads out of the worktree.
        link_folder(&outside, &world.target.join("trap"));
        let kept = [world.target.as_path(), &world.repo.join(".git")];
        let before = snapshot(&world.base, &kept);

        let report = world.seed(volume_cloner()).await;

        assert_eq!(snapshot(&world.base, &kept), before);
        assert_eq!(report.copied, 3);
        let out = entry_of("bundle", "out");
        let mut refused = vec![
            ("../outside/secret", "outside"),
            ("..\\outside\\secret", "outside"),
            (absolute.as_str(), "absolute"),
            ("/etc/passwd", "absolute"),
            ("away", "symlink_outside"),
            ("via/.env", "symlink_outside"),
            (out.as_str(), "symlink_outside"),
            ("trap/x", "destination_outside"),
            // Its folder exists, through the link: only the folder's real path shows it is outside.
            ("trap/deep/y", "destination_outside"),
        ];
        if cfg!(not(windows)) {
            refused.push(("leak", "symlink_outside"));
        }
        let mut left_out = skipped(&report);
        left_out.sort_unstable();
        refused.sort_unstable();
        assert_eq!(left_out, refused);
        let made: Vec<String> = snapshot(&world.target, &[&world.target.join(".git")])
            .into_keys()
            .map(|path| path[world.target.to_string_lossy().len() + 1..].replace('\\', "/"))
            .collect();
        assert_eq!(
            made,
            [
                ".env",
                ".gitignore",
                "README.md",
                "bundle",
                "bundle/file",
                "bundle/in",
                "store",
                "store/pkg.js",
                "trap"
            ]
        );
        // The link written with an absolute path names the worktree's own copy.
        assert_eq!(
            fs::canonicalize(world.target.join("bundle").join("in")).unwrap(),
            fs::canonicalize(world.target.join("store")).unwrap()
        );
    }

    #[test]
    fn places_nothing_outside_the_worktree() {
        let world = World::new("place");
        fs::create_dir_all(world.target.join("sub")).unwrap();
        let worktree = Worktree {
            real: world.target.to_string_lossy().into_owned(),
        };
        for inside in ["a", "sub/a", "new/deep/a", "..a", ".env"] {
            let place = worktree.place(inside).unwrap();
            assert!(place.path().starts_with(&world.target), "{inside}");
        }
        let root = if cfg!(windows) { r"C:\x" } else { "/x" };
        for outside in [
            "",
            "/",
            "..",
            "../x",
            "a/../../x",
            "sub/../../x",
            "/x",
            root,
        ] {
            assert!(worktree.place(outside).is_none(), "{outside:?}");
        }
        #[cfg(windows)]
        for outside in [
            r"..\x",
            r"a\..\..\x",
            r"\x",
            "C:x",
            "sub/a:stream",
            "a::$DATA",
            "secret.",
            "sub/name ",
            ".../x",
        ] {
            assert!(worktree.place(outside).is_none(), "{outside:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn counts_only_what_took_disk_once_the_volume_refuses_a_clone() {
        let world = World::new("clone-then-not");
        world.ignore("*.bin\n");
        // In order: a clones, b is refused and copied within the budget, c is over it, d is never reached.
        world.sized("a.bin", SEED_MAX_BYTES + 1);
        world.sized("b.bin", SEED_MAX_BYTES - 10);
        world.sized("c.bin", 100);
        world.sized("d.bin", 1);
        world.write(INCLUDE_FILE, "*.bin\n");
        world.worktree();

        let report = world.seed(pretend_cloner(1)).await;

        assert_eq!((report.copied, report.cloned), (2, false));
        assert_eq!(report.bytes, 2 * SEED_MAX_BYTES - 9);
        assert_eq!(skipped(&report), [("c.bin", "budget"), ("d.bin", "budget")]);
        assert!(world.target.join("b.bin").exists());
        assert!(!world.target.join("c.bin").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn clones_past_the_byte_budget_where_the_volume_clones() {
        let world = World::new("clone");
        world.ignore("*.bin\n");
        world.sized("a.bin", SEED_MAX_BYTES + 1);
        world.sized("b.bin", SEED_MAX_BYTES + 1);
        world.write(INCLUDE_FILE, "*.bin\n");
        world.worktree();

        let report = world.seed(volume_cloner()).await;

        // A Mac's temporary folder is on APFS; Windows has no clone here.
        assert!(report.cloned || !cfg!(target_os = "macos"));
        assert!(!report.cloned || !cfg!(windows));
        if report.cloned {
            assert_eq!((report.copied, skipped(&report).len()), (2, 0));
            let cloned = fs::metadata(world.target.join("b.bin")).unwrap();
            assert_eq!(cloned.len(), SEED_MAX_BYTES + 1);
        } else {
            assert_eq!(report.copied, 0);
            assert_eq!(skipped(&report), [("a.bin", "budget"), ("b.bin", "budget")]);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cancelled_seed_makes_no_further_file() {
        let world = World::new("cancelled");
        world.ignore("*.env\n");
        world.write("a.env", "a\n");
        world.write("b.env", "b\n");
        world.write(INCLUDE_FILE, "*.env\n");
        world.worktree();
        // The request is cancelled while its first file is made.
        let scope = Scope::detached();
        let cancelled = scope.clone();
        let cloner: Cloner = Box::new(move |from, to| {
            cancelled.cancel();
            fs::copy(from, to.path()).map(drop)
        });

        let stopped = world
            .seed_cloning(scope, Duration::from_secs(180), cloner)
            .await;

        assert_eq!(stopped.err(), Some(Fault::cancelled()));
        assert!(world.target.join("a.env").exists());
        assert!(!world.target.join("b.env").exists());
        let never = Scope::detached();
        never.cancel();
        let refused = world
            .seed_cloning(never, Duration::from_secs(180), volume_cloner())
            .await;
        assert_eq!(refused.err(), Some(Fault::cancelled()));
        assert!(!world.target.join("b.env").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn skips_what_it_does_not_reach_in_its_time() {
        let world = World::new("late");
        world.ignore("*.env\n");
        world.write("a.env", "a\n");
        world.write("b.env", "b\n");
        world.write(INCLUDE_FILE, "*.env\n");
        world.worktree();

        let report = world
            .seed_cloning(Scope::detached(), Duration::ZERO, volume_cloner())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(report.copied, 0);
        assert_eq!(skipped(&report), [("a.env", "budget"), ("b.env", "budget")]);
        assert!(!world.target.join("a.env").exists());
    }

    #[tokio::test]
    async fn finds_a_hook_s_script_and_its_log() {
        let world = World::new("hook");
        world.worktree();
        let (primary, worktree) = (world.repo.to_string_lossy(), world.target.to_string_lossy());
        let script = ".ompdesk/worktree-setup";
        let log = "ompdesk-worktree-setup.log";
        let none = hook(&git(), &primary, &worktree, script, log).await;
        assert_eq!(none.unwrap(), None);
        world.write(script, "echo primary\n");

        let found = hook(&git(), &primary, &worktree, script, log)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(Path::new(&found.script), world.repo.join(script));
        let git_dir = world.repo.join(".git").join("worktrees").join("wt");
        assert_eq!(Path::new(&found.log_path), git_dir.join(log));
        // The worktree's own script wins over the main checkout's.
        fs::create_dir_all(world.target.join(".ompdesk")).unwrap();
        fs::write(world.target.join(script), "echo own\n").unwrap();
        let own = hook(&git(), &primary, &worktree, script, log)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(Path::new(&own.script), world.target.join(script));
        let other = hook(
            &git(),
            &primary,
            &worktree,
            ".ompdesk/worktree-pre-merge",
            log,
        )
        .await;
        assert_eq!(other.unwrap(), None);
    }

    #[cfg(windows)]
    #[test]
    fn makes_a_junction_as_node_did() {
        let world = World::new("junction");
        let store = world.base.join("store");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("pkg.js"), "x\n").unwrap();
        let link = world.base.join("modules");
        // The target as node hands it over: verbatim, any separators.
        let spelled = format!(r"\\?\{}", store.to_string_lossy().replace('\\', "/"));

        crate::sys::junction(Path::new(&spelled), &link).unwrap();

        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // Spelled as libuv spells it: no separator at its end, which a path comparison would not see.
        assert_eq!(
            fs::read_link(&link).unwrap().to_string_lossy(),
            store.to_string_lossy()
        );
        assert_eq!(fs::read_to_string(link.join("pkg.js")).unwrap(), "x\n");
        assert!(crate::sys::junction(Path::new("store"), &world.base.join("relative")).is_err());
        assert!(!world.base.join("relative").exists());
        // Removing the link leaves what it names.
        fs::remove_dir(&link).unwrap();
        assert!(store.join("pkg.js").exists());
    }
}
