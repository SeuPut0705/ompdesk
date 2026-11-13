//! A check's input set and its digest: a previous result is reused only while every input it depended on is proven
//! unchanged, and without knowing which inputs each test read, that is all of them:
//!
//! - every file of the checkout (product code, test code, dependency manifests and lockfiles, configuration, the
//!   check's own scripts, `node_modules`, build output such as `out/` that an end-to-end test runs against), by
//!   content: a file whose size, modification and change times and inode are what the stat cache last saw keeps its
//!   hash, any other is hashed again, so an edit that is not committed counts and a touch that changes nothing does
//!   not;
//! - except what can never be an input: `.git`, folders tagged as caches (`CACHEDIR.TAG`, which cargo's `target/`
//!   carries) and, among the files git ignores, the usual cache and report folders (`CACHE_NAMES`);
//! - files the command names outside the checkout (a wrapper script such as `~/.cache/heavy-run.sh`);
//! - the environment, every variable but a terminal's or OMPdesk's own plumbing (`volatile_env`), each by a hash of
//!   its value, so the evidence names a variable without showing it;
//! - the tools: `node`, `bun` and, for cargo, `rustc` and `cargo` by their version, the operating system, this
//!   program's own version and its reporters.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Cache and report folders that are never inputs, when git ignores them (or the folder is no git checkout).
const CACHE_NAMES: &[&str] = &[
    ".cache",
    ".vite",
    ".vitest",
    ".turbo",
    ".parcel-cache",
    ".nyc_output",
    ".pytest_cache",
    "__pycache__",
    "test-results",
    "playwright-report",
    "blob-report",
    "coverage",
];

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn git(dir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// The checkout `cwd` is in (git's top level), else `cwd` itself.
pub fn root_of(cwd: &Path) -> PathBuf {
    git(cwd, &["rev-parse", "--show-toplevel"])
        .and_then(|out| String::from_utf8(out).ok())
        .map(|s| PathBuf::from(s.trim_end_matches(['\n', '\r'])))
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| cwd.to_path_buf())
}

/// HEAD and whether the work tree has changes, for people reading a verdict.
pub fn head(root: &Path) -> (Option<String>, bool) {
    let head = git(root, &["rev-parse", "--short=12", "HEAD"])
        .and_then(|o| String::from_utf8(o).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let dirty = git(root, &["status", "--porcelain", "--untracked-files=normal"])
        .is_some_and(|o| !o.is_empty());
    (head, dirty)
}

/// What git ignores under `root` (folders end in `/`), `None` outside a git checkout.
pub fn ignored(root: &Path) -> Option<Vec<String>> {
    let out = git(
        root,
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ],
    )?;
    Some(
        out.split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect(),
    )
}

pub fn is_ignored(ignored: Option<&[String]>, path: &str) -> bool {
    match ignored {
        None => true,
        Some(list) => list.iter().any(|entry| match entry.strip_suffix('/') {
            Some(dir) => path == dir || path.starts_with(entry.as_str()),
            None => path == entry,
        }),
    }
}

/// The stat a file is judged unchanged by.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Stat {
    size: u64,
    mtime: i128,
    ctime: i128,
    ino: u64,
    exec: bool,
}

#[cfg(unix)]
fn stat_of(meta: &fs::Metadata) -> Stat {
    use std::os::unix::fs::MetadataExt;
    Stat {
        size: meta.size(),
        mtime: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
        ctime: i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
        ino: meta.ino(),
        exec: meta.mode() & 0o111 != 0,
    }
}

#[cfg(windows)]
fn stat_of(meta: &fs::Metadata) -> Stat {
    use std::os::windows::fs::MetadataExt;
    Stat {
        size: meta.file_size(),
        mtime: i128::from(meta.last_write_time()),
        ctime: i128::from(meta.creation_time()),
        ino: 0,
        exec: false,
    }
}

/// Per checkout, what each input file's stat was when it was last hashed.
pub struct StatCache {
    path: PathBuf,
    map: HashMap<String, (Stat, String)>,
}

impl StatCache {
    pub fn load(store: &Path, root: &Path) -> StatCache {
        let name = &sha256_hex(root.to_string_lossy().as_bytes())[..16];
        let path = store.join("inputs").join(format!("{name}.tsv"));
        let mut map = HashMap::new();
        if let Ok(text) = fs::read_to_string(&path) {
            for line in text.lines() {
                let f: Vec<&str> = line.split('\t').collect();
                if let [p, size, mtime, ctime, ino, exec, hash] = f[..] {
                    let (Ok(size), Ok(mtime), Ok(ctime), Ok(ino)) =
                        (size.parse(), mtime.parse(), ctime.parse(), ino.parse())
                    else {
                        continue;
                    };
                    let stat = Stat {
                        size,
                        mtime,
                        ctime,
                        ino,
                        exec: exec == "1",
                    };
                    map.insert(p.to_string(), (stat, hash.to_string()));
                }
            }
        }
        StatCache { path, map }
    }

    pub fn save(&self) -> io::Result<()> {
        let mut out = Vec::with_capacity(self.map.len() * 120);
        for (p, (s, h)) in &self.map {
            if p.contains(['\t', '\n']) {
                continue;
            }
            writeln!(
                out,
                "{p}\t{}\t{}\t{}\t{}\t{}\t{h}",
                s.size,
                s.mtime,
                s.ctime,
                s.ino,
                u8::from(s.exec)
            )?;
        }
        let tmp = self.path.with_extension("tsv.tmp");
        fs::write(&tmp, out)?;
        fs::rename(tmp, &self.path)
    }
}

/// The files of the input set, by path relative to the root (`/`-separated), each with its content hash.
#[derive(Clone, Debug, Default)]
pub struct Files {
    pub files: Vec<(String, String)>,
}

impl Files {
    pub fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        for (p, h) in &self.files {
            hasher.update(p.as_bytes());
            hasher.update([0]);
            hasher.update(h.as_bytes());
            hasher.update(b"\n");
        }
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

fn excluded_dir(dir: &Path, rel: &str, name: &str, ignored: Option<&[String]>) -> bool {
    if name == ".git" {
        return true;
    }
    if dir.join("CACHEDIR.TAG").is_file() {
        return true;
    }
    CACHE_NAMES.contains(&name) && is_ignored(ignored, rel)
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// A file modified this close to the moment it was hashed may change again within the same timestamp tick (Windows
/// updates a write time at the clock's 1-16 ms resolution, HFS+ and FAT keep whole seconds), leaving size and times
/// as the cache saw them with new bytes: git's "racy clean" case. Its hash is not cached, so the next look hashes it.
const RACY: Duration = Duration::from_secs(3);

/// Walks the checkout and hashes what the cache cannot vouch for; the cache learns the new hashes.
pub fn snapshot(root: &Path, ignored: Option<&[String]>, cache: &mut StatCache) -> Files {
    let racy_after = std::time::SystemTime::now()
        .checked_sub(RACY)
        .unwrap_or(std::time::UNIX_EPOCH);
    let mut racy: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut found: Vec<(String, PathBuf, Option<Stat>, Option<String>)> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".DS_Store" {
                continue;
            }
            let path = entry.path();
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !excluded_dir(&path, &child, &name, ignored) {
                    stack.push((path, child));
                }
            } else if kind.is_symlink() {
                let target = fs::read_link(&path)
                    .map(|t| t.to_string_lossy().into_owned())
                    .unwrap_or_default();
                found.push((
                    child,
                    path,
                    None,
                    Some(format!("link:{}", sha256_hex(target.as_bytes()))),
                ));
            } else if let Ok(meta) = entry.metadata() {
                let stat = stat_of(&meta);
                if meta.modified().map_or(true, |m| m >= racy_after) {
                    racy.insert(child.clone());
                }
                let known = cache
                    .map
                    .get(&child)
                    .filter(|(s, _)| *s == stat)
                    .map(|(_, h)| h.clone());
                found.push((child, path, Some(stat), known));
            }
        }
    }
    // Hash what the cache could not vouch for, on every core.
    let todo: Vec<usize> = found
        .iter()
        .enumerate()
        .filter(|(_, f)| f.3.is_none())
        .map(|(i, _)| i)
        .collect();
    if !todo.is_empty() {
        let workers = std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .min(8);
        let chunk = todo.len().div_ceil(workers);
        let hashed: Vec<(usize, Option<String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = todo
                .chunks(chunk.max(1))
                .map(|part| {
                    let found = &found;
                    scope.spawn(move || {
                        part.iter()
                            .map(|&i| (i, hash_file(&found[i].1).ok()))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        });
        for (i, hash) in hashed {
            // A file that vanished or cannot be read is an input in a state of its own.
            found[i].3 = Some(hash.unwrap_or_else(|| "unreadable".into()));
        }
    }
    let mut files = Vec::with_capacity(found.len());
    for (rel, _, stat, hash) in found {
        let hash = hash.unwrap_or_default();
        if let Some(stat) = stat {
            if racy.contains(&rel) {
                cache.map.remove(&rel);
            } else {
                cache.map.insert(rel.clone(), (stat, hash.clone()));
            }
            let mark = if stat.exec { "x" } else { "" };
            files.push((rel, format!("{hash}{mark}")));
        } else {
            files.push((rel, hash));
        }
    }
    files.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let keep: std::collections::HashSet<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    cache.map.retain(|p, _| keep.contains(p.as_str()));
    Files { files }
}

/// Variables that differ between terminals, sessions and agents without changing what a test does.
pub fn volatile_env(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "PWD",
        "OLDPWD",
        "SHLVL",
        "_",
        "COLUMNS",
        "LINES",
        "WINDOWID",
        "SECURITYSESSIONID",
        "LaunchInstanceID",
        "Apple_PubSub_Socket_Render",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "GPG_TTY",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "SSH_CLIENT",
        "SSH_CONNECTION",
        "SSH_TTY",
        "TERM_SESSION_ID",
        "COLORTERM",
        "GIT_ASKPASS",
        "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_MAIN",
        "VSCODE_GIT_IPC_HANDLE",
    ];
    const PREFIXES: &[&str] = &[
        "OMP_GUI_",
        "OMPDESK_",
        "TERM_PROGRAM",
        "ITERM_",
        "TMUX",
        "KITTY_",
        "WEZTERM_",
        "XPC_",
        "__CF",
        "XDG_SESSION_",
        "VSCODE_INJECTION",
    ];
    EXACT.contains(&name) || PREFIXES.iter().any(|p| name.starts_with(p))
}

fn version_of(program: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let line = out.lines().next()?.trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// The tools a check's results depend on beyond the checkout.
pub fn tools(cargo: bool) -> BTreeMap<String, String> {
    let mut tools = BTreeMap::new();
    tools.insert(
        "os".into(),
        format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    );
    #[cfg(unix)]
    if let Some(v) = version_of("uname", &["-sr"]) {
        tools.insert("kernel".into(), v);
    }
    let mut programs = vec![("node", "--version"), ("bun", "--version")];
    if cargo {
        programs.extend([("rustc", "-V"), ("cargo", "-V")]);
    }
    for (program, flag) in programs {
        tools.insert(
            program.into(),
            version_of(program, &[flag]).unwrap_or_else(|| "absent".into()),
        );
    }
    tools.insert(
        "ompdesk".into(),
        format!(
            "{} reporters {}",
            env!("CARGO_PKG_VERSION"),
            &crate::runner::reporters_digest()[..12]
        ),
    );
    tools
}

/// The whole input set of one run of a check.
#[derive(Clone, Debug, Default)]
pub struct InputSet {
    pub files: Files,
    /// Files the command names outside the checkout.
    pub outside: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
    pub tools: BTreeMap<String, String>,
    pub argv: Vec<String>,
}

impl InputSet {
    pub fn env_hashes(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        env.iter()
            .filter(|(k, _)| !volatile_env(k))
            .map(|(k, v)| (k.clone(), sha256_hex(v.as_bytes())[..16].to_string()))
            .collect()
    }

    /// Files outside `root` that `argv` names (a wrapper script), by content.
    pub fn outside_files(root: &Path, cwd: &Path, argv: &[String]) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for arg in argv {
            if arg.starts_with('-') || !(arg.contains('/') || arg.contains('\\')) {
                continue;
            }
            let path = cwd.join(arg);
            if path.starts_with(root) || !path.is_file() {
                continue;
            }
            if let Ok(hash) = hash_file(&path) {
                out.insert(path.display().to_string(), hash);
            }
        }
        out
    }

    pub fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.files.digest().as_bytes());
        for (k, v) in self
            .outside
            .iter()
            .chain(&self.env)
            .chain(&self.tools)
            .map(|(k, v)| (k.as_str(), v.as_str()))
        {
            hasher.update(k.as_bytes());
            hasher.update([0]);
            hasher.update(v.as_bytes());
            hasher.update(b"\n");
        }
        for a in &self.argv {
            hasher.update(a.as_bytes());
            hasher.update([0]);
        }
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// `F`, `X`, `E`, `T` lines: files, outside files, environment, tools.
    pub fn to_tsv(&self) -> String {
        let mut out = String::new();
        for (p, h) in &self.files.files {
            if !p.contains(['\t', '\n']) {
                out.push_str(&format!("F\t{p}\t{h}\n"));
            }
        }
        for (kind, map) in [("X", &self.outside), ("E", &self.env), ("T", &self.tools)] {
            for (k, v) in map {
                out.push_str(&format!(
                    "{kind}\t{}\t{}\n",
                    k.replace(['\t', '\n'], " "),
                    v.replace(['\t', '\n'], " ")
                ));
            }
        }
        out
    }
}

/// What differs between an earlier input list (`inputs.tsv`) and now, as lines of evidence (at most `limit` paths).
pub fn differences(earlier: &str, now: &InputSet, limit: usize) -> Vec<String> {
    let mut before: [BTreeMap<&str, &str>; 4] = Default::default();
    for line in earlier.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(kind), Some(k), Some(v)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let at = match kind {
            "F" => 0,
            "X" => 1,
            "E" => 2,
            "T" => 3,
            _ => continue,
        };
        before[at].insert(k, v);
    }
    let after: [BTreeMap<&str, &str>; 4] = [
        now.files
            .files
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
        now.outside
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
        now.env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
        now.tools
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect(),
    ];
    let labels = ["file", "outside file", "environment variable", "tool"];
    let mut lines = Vec::new();
    for at in 0..4 {
        let mut changed = Vec::new();
        for (k, v) in &after[at] {
            match before[at].get(k) {
                Some(old) if old == v => {}
                Some(old) if at == 3 => changed.push(format!("{k} {old} → {v}")),
                Some(_) => changed.push(format!("{k} changed")),
                None => changed.push(format!("{k} added")),
            }
        }
        for k in before[at].keys() {
            if !after[at].contains_key(k) {
                changed.push(format!("{k} removed"));
            }
        }
        if changed.is_empty() {
            continue;
        }
        let total = changed.len();
        let shown: Vec<String> = changed.into_iter().take(limit).collect();
        let more = if total > shown.len() {
            format!(" (+{} more)", total - shown.len())
        } else {
            String::new()
        };
        lines.push(format!(
            "{total} {}{} changed: {}{more}",
            labels[at],
            if total == 1 { "" } else { "s" },
            shown.join(", ")
        ));
    }
    lines
}

/// Paths whose hash differs between two file lists, the paths of `a` order.
pub fn changed_paths(a: &Files, b: &Files) -> Vec<String> {
    let before: HashMap<&str, &str> = a
        .files
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let after: HashMap<&str, &str> = b
        .files
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let mut out: Vec<String> = after
        .iter()
        .filter(|(k, v)| before.get(*k) != Some(*v))
        .map(|(k, _)| k.to_string())
        .chain(
            before
                .keys()
                .filter(|k| !after.contains_key(*k))
                .map(|k| k.to_string()),
        )
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        use std::hash::{BuildHasher, RandomState};
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-inputs-{name}-{}-{:x}",
            std::process::id(),
            RandomState::new().hash_one(0u8)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_edit_changes_the_digest_and_a_touch_does_not() {
        let root = temp("edit");
        let store = temp("store");
        fs::create_dir_all(store.join("inputs")).unwrap();
        fs::write(root.join("a.ts"), "one").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("target/CACHEDIR.TAG"), "Signature").unwrap();
        fs::write(root.join("target/out.bin"), "x").unwrap();
        let mut cache = StatCache::load(&store, &root);
        let first = snapshot(&root, None, &mut cache);
        assert_eq!(first.files.len(), 1, "the tagged cache is no input");
        cache.save().unwrap();

        let mut cache = StatCache::load(&store, &root);
        fs::write(root.join("target/out.bin"), "y").unwrap();
        let same = snapshot(&root, None, &mut cache);
        assert_eq!(first.digest(), same.digest());

        // Same bytes written again: new times, same content.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(root.join("a.ts"), "one").unwrap();
        let touched = snapshot(&root, None, &mut cache);
        assert_eq!(first.digest(), touched.digest());

        fs::write(root.join("a.ts"), "two").unwrap();
        let edited = snapshot(&root, None, &mut cache);
        assert_ne!(first.digest(), edited.digest());
        assert_eq!(changed_paths(&first, &edited), vec!["a.ts".to_string()]);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(store);
    }

    #[test]
    fn a_file_written_just_now_is_hashed_again_next_time() {
        // Windows keeps a write time at the clock's tick: two same-size writes in one tick look unchanged, so a
        // hash of a file that fresh is never kept (it failed exactly so on windows-latest, 13 Nov 2026).
        let root = temp("racy");
        fs::write(root.join("fresh.ts"), "one").unwrap();
        fs::write(root.join("old.ts"), "one").unwrap();
        let hour_ago = std::time::SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(root.join("old.ts"))
            .unwrap()
            .set_modified(hour_ago)
            .unwrap();
        let mut cache = StatCache {
            path: root.join("cache.tsv"),
            map: HashMap::new(),
        };
        snapshot(&root, None, &mut cache);
        assert!(!cache.map.contains_key("fresh.ts"));
        assert!(cache.map.contains_key("old.ts"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_names_are_skipped_only_where_git_ignores_them() {
        let root = temp("names");
        fs::create_dir_all(root.join("coverage")).unwrap();
        fs::write(root.join("coverage/lib.ts"), "source").unwrap();
        let mut cache = StatCache {
            path: root.join("cache.tsv"),
            map: HashMap::new(),
        };
        let tracked = snapshot(&root, Some(&[]), &mut cache);
        assert_eq!(
            tracked.files.len(),
            1,
            "a tracked folder named coverage is an input"
        );
        let ignored = snapshot(&root, Some(&["coverage/".to_string()]), &mut cache);
        assert!(ignored.files.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plumbing_variables_are_not_inputs() {
        assert!(volatile_env("OMP_GUI_SESSION_TAG"));
        assert!(volatile_env("TERM_SESSION_ID"));
        assert!(!volatile_env("PATH"));
        assert!(!volatile_env("CI"));
        assert!(!volatile_env("NODE_OPTIONS"));
    }

    #[test]
    fn differences_name_what_changed() {
        let mut a = InputSet::default();
        a.files.files = vec![("a.ts".into(), "1".into()), ("b.ts".into(), "2".into())];
        a.env.insert("NODE_ENV".into(), "x".into());
        a.tools.insert("node".into(), "v22".into());
        let earlier = a.to_tsv();
        let mut b = a.clone();
        b.files.files = vec![("a.ts".into(), "9".into()), ("c.ts".into(), "3".into())];
        b.env.insert("NODE_ENV".into(), "y".into());
        b.tools.insert("node".into(), "v24".into());
        let lines = differences(&earlier, &b, 20);
        assert_eq!(
            lines,
            vec![
                "3 files changed: a.ts changed, c.ts added, b.ts removed".to_string(),
                "1 environment variable changed: NODE_ENV changed".to_string(),
                "1 tool changed: node v22 → v24".to_string(),
            ]
        );
        assert_ne!(a.digest(), b.digest());
    }
}
