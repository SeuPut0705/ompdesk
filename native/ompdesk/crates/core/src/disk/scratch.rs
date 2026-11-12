//! A session's scratch folder (`<scratch root>/<tag>`, `src/main/session-scratch.ts`): the throwaway files a tab's omp
//! was told to keep there. Main decides when one may go (no tab holds its tag, no process carries it, idle); the core
//! reads when anything in it last changed (`facts`) and removes it (`sweep`), except the files its sessions' replies
//! name: a reply's picture is read from its path each time the reply is shown, so a file a reply shows or links stays
//! as long as the session does.
//!
//! What a reply names: every assistant text block of the session files (stock's JSONL, one entry per line) and of the
//! subagent files beside them (`<session file without .jsonl>/**/*.jsonl`), plus the forms an `ask` call showed. A
//! path is found by the folder's tag (32 random hex digits, so however the root was spelled: absolute, `~`, a
//! `file://` URL, either slash) followed by a path that is a file in the folder now; `%20` and the like are read both
//! ways. A session file that is not stock's format (an entry that names the tag and is no JSON, a first line that is
//! no object) fails the sweep with `scratch_kept` and nothing goes.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::sizes;
use super::tree::{fault, live, remove};
use crate::fs::disk::linked;
use crate::server::{Fault, Scope};

/// How far past the tag a path is looked for on its line.
const MENTION_MAX: usize = 400;

/// The folder's tag: its name, 32 lowercase hex digits, in a folder named `scratch`. Any other folder is refused
/// before anything is read or removed.
fn tag_of(dir: &Path) -> Result<String, Fault> {
    let name = dir.file_name().map(|name| name.to_string_lossy());
    let tag = name.filter(|name| {
        name.len() == 32
            && name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    let parent = dir.parent().and_then(Path::file_name);
    match tag {
        Some(tag) if parent.is_some_and(|parent| parent == "scratch") => Ok(tag.into_owned()),
        _ => Err(Fault::new(
            "invalid_entry",
            format!(
                "\"{}\" is not a session's scratch folder; nothing was done.",
                dir.display()
            ),
        )),
    }
}

/// A folder whose own entry or scratch root is a link (a symlink, a junction, any reparse point) is kept whole: what
/// is behind the link is not this app's, so nothing there is read or removed. A folder that is gone is no link.
fn unlinked(dir: &Path) -> Result<(), Fault> {
    for (path, what) in [
        (dir, "it"),
        (dir.parent().unwrap_or(dir), "its scratch root"),
    ] {
        match fs::symlink_metadata(path) {
            Ok(meta) if linked(&meta) => {
                return Err(Fault::new(
                    "scratch_kept",
                    format!("{what} is a link to another folder"),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(fault(&error, "lstat", path)),
        }
    }
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    /// When anything in the folder (a file, a folder, the folder itself) last changed, epoch ms.
    newest_ms: f64,
    entries: u64,
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |since| since.as_secs_f64() * 1000.0)
}

fn walk(dir: &Path, facts: &mut Facts, scope: &Scope) -> Result<(), Fault> {
    live(scope)?;
    for entry in fs::read_dir(dir).map_err(|error| fault(&error, "scandir", dir))? {
        let path = entry.map_err(|error| fault(&error, "scandir", dir))?.path();
        let meta = fs::symlink_metadata(&path).map_err(|error| fault(&error, "lstat", &path))?;
        facts.entries += 1;
        facts.newest_ms = facts.newest_ms.max(mtime_ms(&meta));
        if meta.is_dir() {
            walk(&path, facts, scope)?;
        }
    }
    Ok(())
}

pub fn facts(dir: &str, scope: &Scope) -> Result<Facts, Fault> {
    let dir = Path::new(dir);
    tag_of(dir)?;
    unlinked(dir)?;
    let meta = fs::symlink_metadata(dir).map_err(|error| fault(&error, "lstat", dir))?;
    let mut facts = Facts {
        newest_ms: mtime_ms(&meta),
        entries: 0,
    };
    walk(dir, &mut facts, scope)?;
    Ok(facts)
}

fn unreadable(file: &Path) -> Fault {
    Fault::new(
        "scratch_kept",
        format!(
            "its session file {} cannot be read",
            file.file_name()
                .map_or_else(|| file.to_string_lossy(), |name| name.to_string_lossy())
        ),
    )
}

/// The one form a path inside the folder is compared in: `/`-separated, and without case where the file system has
/// none (Windows, macOS).
fn fold(relative: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) {
        relative.to_lowercase()
    } else {
        relative.to_owned()
    }
}

fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = (bytes[at] == b'%')
            .then(|| text.get(at + 1..at + 3))
            .flatten()
            .and_then(|digits| u8::from_str_radix(digits, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                at += 3;
            }
            None => {
                out.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Every start of `after` (what follows the tag and a slash on its line) that is a file in the folder is named: a
/// file reached through real folders only, so a link and what is behind it are never named.
fn files_named(after: &str, dir: &Path, keep: &mut BTreeSet<String>) {
    let after = after.replace('\\', "/");
    for (end, _) in after.char_indices().skip(1).chain([(after.len(), ' ')]) {
        let prefix = &after[..end];
        if prefix.ends_with('/') {
            continue;
        }
        let parts: Vec<&str> = prefix
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect();
        if parts.is_empty() || parts.contains(&"..") {
            continue;
        }
        let mut path = dir.to_owned();
        for (at, part) in parts.iter().enumerate() {
            path.push(part);
            let Ok(meta) = fs::symlink_metadata(&path) else {
                break;
            };
            let last = at + 1 == parts.len();
            if linked(&meta) || (last && !meta.is_file()) || (!last && !meta.is_dir()) {
                break;
            }
            if last {
                keep.insert(fold(&parts.join("/")));
            }
        }
    }
}

fn mentions(text: &str, tag: &str, dir: &Path, keep: &mut BTreeSet<String>) {
    let mut rest = text;
    while let Some(at) = rest.find(tag) {
        rest = &rest[at + tag.len()..];
        let Some(after) = rest.strip_prefix(['/', '\\']) else {
            continue;
        };
        let line: String = after
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(MENTION_MAX)
            .collect();
        files_named(&line, dir, keep);
        let decoded = percent_decoded(&line);
        if decoded != line {
            files_named(&decoded, dir, keep);
        }
    }
}

fn strings(value: &Value, each: &mut impl FnMut(&str)) {
    match value {
        Value::String(text) => each(text),
        Value::Array(items) => items.iter().for_each(|item| strings(item, each)),
        Value::Object(fields) => fields.values().for_each(|field| strings(field, each)),
        _ => {}
    }
}

/// What one session entry shows the reader from a path: an assistant message's text, and the form of an `ask` call.
fn shown(entry: &Value, each: &mut impl FnMut(&str)) {
    let message = &entry["message"];
    if entry["type"] != "message" || message["role"] != "assistant" {
        return;
    }
    match &message["content"] {
        Value::String(text) => each(text),
        Value::Array(blocks) => {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => strings(&block["text"], each),
                    Some("toolCall") if block["name"] == "ask" => {
                        strings(&block["arguments"], each)
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// Reads one session file. Only an entry that holds the tag is parsed (and the first one, to know the file is
/// stock's); `whole`: an empty file is not a session.
fn scan(
    file: &Path,
    whole: bool,
    tag: &str,
    dir: &Path,
    keep: &mut BTreeSet<String>,
    scope: &Scope,
) -> Result<(), Fault> {
    let mut reader = BufReader::new(fs::File::open(file).map_err(|_| unreadable(file))?);
    let mut line = Vec::new();
    let mut first = true;
    loop {
        live(scope)?;
        line.clear();
        if reader
            .read_until(b'\n', &mut line)
            .map_err(|_| unreadable(file))?
            == 0
        {
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let tagged = line
            .windows(tag.len())
            .any(|window| window == tag.as_bytes());
        if !first && !tagged {
            continue;
        }
        let entry: Value = serde_json::from_slice(&line).map_err(|_| unreadable(file))?;
        if first && !entry.is_object() {
            return Err(unreadable(file));
        }
        first = false;
        if tagged {
            shown(&entry, &mut |text| mentions(text, tag, dir, keep));
        }
    }
    if first && whole {
        return Err(unreadable(file));
    }
    Ok(())
}

/// The subagent session files under `dir`; none when there is no such folder.
fn jsonl_under(dir: &Path, found: &mut Vec<PathBuf>) -> Result<(), Fault> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(unreadable(dir)),
    };
    for entry in entries {
        let path = entry.map_err(|_| unreadable(dir))?.path();
        let meta = fs::symlink_metadata(&path).map_err(|_| unreadable(&path))?;
        if meta.is_dir() {
            jsonl_under(&path, found)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            found.push(path);
        }
    }
    Ok(())
}

/// The files of the folder its sessions' replies name, each as `fold` spells it.
fn named(
    dir: &Path,
    tag: &str,
    sessions: &[String],
    scope: &Scope,
) -> Result<BTreeSet<String>, Fault> {
    let mut keep = BTreeSet::new();
    for session in sessions {
        let file = Path::new(session);
        scan(file, true, tag, dir, &mut keep, scope)?;
        let mut subagents = Vec::new();
        jsonl_under(&file.with_extension(""), &mut subagents)?;
        for subagent in subagents {
            scan(&subagent, false, tag, dir, &mut keep, scope)?;
        }
    }
    Ok(keep)
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct Swept {
    bytes: u64,
    /// Entries removed (a folder with nothing named in it counts once).
    removed: u64,
    /// Files left because a reply names them.
    kept: u64,
    /// Entries that could not be removed.
    left: u64,
}

fn drop_unnamed(
    dir: &Path,
    prefix: &str,
    keep: &BTreeSet<String>,
    swept: &mut Swept,
    scope: &Scope,
) -> Result<(), Fault> {
    for entry in fs::read_dir(dir).map_err(|error| fault(&error, "scandir", dir))? {
        live(scope)?;
        let entry = entry.map_err(|error| fault(&error, "scandir", dir))?;
        let path = entry.path();
        let name = entry.file_name();
        let relative = fold(&format!("{prefix}{}", name.to_string_lossy()));
        let meta = fs::symlink_metadata(&path).map_err(|error| fault(&error, "lstat", &path))?;
        let inside = format!("{relative}/");
        if meta.is_dir() && keep.iter().any(|kept| kept.starts_with(&inside)) {
            drop_unnamed(&path, &inside, keep, swept, scope)?;
        } else if keep.contains(&relative) {
            swept.kept += 1;
        } else {
            let bytes = sizes::measure(&path, None, 0.0, scope)?.bytes;
            match remove(&path, true, scope) {
                Ok(()) => {
                    swept.bytes += bytes;
                    swept.removed += 1;
                }
                Err(_) if scope.cancelled() => return Err(Fault::cancelled()),
                Err(_) => swept.left += 1,
            }
        }
    }
    Ok(())
}

/// Removes the folder's files, except the ones the replies of `sessions` name; the folder itself goes too when
/// nothing is named. Without sessions (they were deleted, or none was ever written) everything goes unread.
pub fn sweep(dir: &str, sessions: &[String], scope: &Scope) -> Result<Swept, Fault> {
    live(scope)?;
    let dir = Path::new(dir);
    let tag = tag_of(dir)?;
    unlinked(dir)?;
    let keep = named(dir, &tag, sessions, scope)?;
    let mut swept = Swept::default();
    if keep.is_empty() {
        swept.bytes = sizes::measure(dir, None, 0.0, scope)?.bytes;
        remove(dir, true, scope)?;
        swept.removed = 1;
    } else {
        drop_unnamed(dir, "", &keep, &mut swept, scope)?;
    }
    Ok(swept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TAG: &str = "0123456789abcdef0123456789abcdef";

    struct World {
        root: PathBuf,
        dir: PathBuf,
        session: PathBuf,
    }

    fn world(name: &str) -> World {
        let root = std::env::temp_dir().join(format!("ompdesk-core-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("scratch").join(TAG);
        for file in [
            "a.png",
            "shots/b c.png",
            "shots/d.png",
            "shots/e.png",
            "form.png",
            "notes.txt",
            "repo/src/x.ts",
        ] {
            let path = dir.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        let session = root.join("sessions").join("2026-11-12_abc.jsonl");
        fs::create_dir_all(session.parent().unwrap()).unwrap();
        World { root, dir, session }
    }

    fn message(role: &str, content: Value) -> String {
        json!({ "type": "message", "message": { "role": role, "content": content } }).to_string()
    }

    fn text(role: &str, text: &str) -> String {
        message(role, json!([{ "type": "text", "text": text }]))
    }

    fn write_session(world: &World, entries: &[String]) {
        let header = json!({ "type": "session", "version": 3, "id": "abc" }).to_string();
        fs::write(
            &world.session,
            format!("{header}\n{}\n", entries.join("\n")),
        )
        .unwrap();
    }

    fn left(world: &World) -> Vec<String> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, base, out);
                } else {
                    out.push(
                        path.strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut out = Vec::new();
        if world.dir.exists() {
            walk(&world.dir, &world.dir, &mut out);
        }
        out.sort();
        out
    }

    #[test]
    fn keeps_the_files_replies_name_and_removes_the_rest() {
        let w = world("scratch-named");
        let dir = w.dir.to_string_lossy().into_owned();
        write_session(
            &w,
            &[
                text("user", &format!("see {dir}/notes.txt")),
                text(
                    "assistant",
                    &format!(
                        "Done.\n![Before: the page]({dir}/a.png)\n![After](file://{}/shots/b%20c.png) and more",
                        dir.replace('\\', "/")
                    ),
                ),
                message(
                    "assistant",
                    json!([
                        { "type": "toolCall", "name": "bash", "arguments": { "command": format!("ls {dir}/repo/src/x.ts") } },
                        { "type": "toolCall", "name": "ask", "arguments": { "html": format!("<img src=\"~/.cache/ompdesk/scratch/{TAG}/form.png\" alt=\"A\">") } },
                    ]),
                ),
                message(
                    "toolResult",
                    json!([{ "type": "text", "text": format!("{dir}/repo/src/x.ts") }]),
                ),
            ],
        );
        let subagents = w.session.with_extension("");
        fs::create_dir_all(subagents.join("nested")).unwrap();
        fs::write(
            subagents.join("nested").join("Scout.jsonl"),
            format!(
                "{}\n",
                text("assistant", &format!("the shot is {TAG}\\shots\\d.png."))
            ),
        )
        .unwrap();

        let swept = sweep(
            &dir,
            &[w.session.to_string_lossy().into_owned()],
            &Scope::detached(),
        )
        .unwrap();
        assert_eq!(
            left(&w),
            ["a.png", "form.png", "shots/b c.png", "shots/d.png"]
        );
        assert_eq!((swept.kept, swept.left), (4, 0));
        // notes.txt, shots/e.png and the repo folder as one.
        assert_eq!(swept.removed, 3);
        fs::remove_dir_all(&w.root).unwrap();
    }

    #[test]
    fn takes_the_whole_folder_when_no_reply_names_a_file_or_no_session_is_left() {
        let w = world("scratch-whole");
        let dir = w.dir.to_string_lossy().into_owned();
        write_session(
            &w,
            &[text(
                "assistant",
                &format!("I worked in {dir} and in {dir}/shots."),
            )],
        );
        let scope = Scope::detached();
        let swept = sweep(&dir, &[w.session.to_string_lossy().into_owned()], &scope).unwrap();
        assert!(!w.dir.exists());
        assert_eq!((swept.removed, swept.kept), (1, 0));

        let again = world("scratch-whole");
        sweep(&again.dir.to_string_lossy(), &[], &scope).unwrap();
        assert!(!again.dir.exists());
        fs::remove_dir_all(&again.root).unwrap();
    }

    #[test]
    fn keeps_everything_when_a_session_file_cannot_be_read() {
        let w = world("scratch-unreadable");
        let dir = w.dir.to_string_lossy().into_owned();
        let scope = Scope::detached();
        let all = left(&w);
        let session = w.session.to_string_lossy().into_owned();

        // No such file; an empty one; a first line that is no object; an entry naming the tag cut mid-write.
        assert!(sweep(&dir, std::slice::from_ref(&session), &scope).is_err());
        fs::write(&w.session, "").unwrap();
        assert!(sweep(&dir, std::slice::from_ref(&session), &scope).is_err());
        fs::write(&w.session, "not json\n").unwrap();
        assert!(sweep(&dir, std::slice::from_ref(&session), &scope).is_err());
        let cut = text("assistant", &format!("![x]({TAG}/a.png)"));
        write_session(&w, &[cut[..cut.len() - 9].to_owned()]);
        let failed = sweep(&dir, std::slice::from_ref(&session), &scope).unwrap_err();
        assert_eq!(failed.code, "scratch_kept");
        assert_eq!(left(&w), all);

        // A cut entry that does not name the folder decides nothing.
        write_session(&w, &["{\"type\":\"message\",\"mess".to_owned()]);
        sweep(&dir, &[session], &scope).unwrap();
        assert!(!w.dir.exists());
        fs::remove_dir_all(&w.root).unwrap();
    }

    #[test]
    fn refuses_a_folder_that_is_no_scratch_folder_and_reads_when_one_last_changed() {
        let w = world("scratch-guard");
        let scope = Scope::detached();
        for other in [
            w.root.join("scratch"),
            w.root.clone(),
            w.dir.join("shots"),
            w.root.join("elsewhere").join(TAG),
            w.root.join("scratch").join(TAG.to_uppercase()),
        ] {
            assert!(sweep(&other.to_string_lossy(), &[], &scope).is_err());
            assert!(facts(&other.to_string_lossy(), &scope).is_err());
        }
        assert_eq!(left(&w).len(), 7);

        let read = facts(&w.dir.to_string_lossy(), &scope).unwrap();
        // Seven files and three folders.
        assert_eq!(read.entries, 10);
        let newest = mtime_ms(&fs::metadata(w.dir.join("repo/src/x.ts")).unwrap());
        assert!(read.newest_ms >= newest);

        scope.cancel();
        assert!(sweep(&w.dir.to_string_lossy(), &[], &scope).is_err());
        assert_eq!(left(&w).len(), 7);
        fs::remove_dir_all(&w.root).unwrap();
    }

    /// A link to `target` at `at`: a symlink on POSIX, a junction on Windows (a folder link that needs no privilege).
    fn link(target: &Path, at: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, at).unwrap();
        #[cfg(windows)]
        crate::sys::junction(target, at).unwrap();
    }

    /// Every file under `dir` with its contents, never through a link.
    fn contents(dir: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if fs::symlink_metadata(&path).unwrap().is_dir() {
                    walk(&path, base, out);
                } else {
                    let name = path.strip_prefix(base).unwrap().to_string_lossy();
                    out.push((name.replace('\\', "/"), fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    /// The folder, or the scratch root above it, is a link to a folder elsewhere holding a sentinel, and a reply names
    /// a file through the link: reading when it last changed, the sweep of a deleted session and the idle sweep are
    /// all refused (`scratch_kept`), and the link and everything it points at stay as they were.
    #[test]
    fn keeps_a_folder_or_scratch_root_that_is_a_link_and_touches_nothing_behind_it() {
        for root_linked in [false, true] {
            let w = world(if root_linked {
                "scratch-root-link"
            } else {
                "scratch-folder-link"
            });
            let elsewhere = w.root.join("elsewhere");
            let (moved, linked) = if root_linked {
                (elsewhere.clone(), w.root.join("scratch"))
            } else {
                (elsewhere.join(TAG), w.dir.clone())
            };
            fs::create_dir_all(moved.parent().unwrap()).unwrap();
            fs::rename(&linked, &moved).unwrap();
            fs::write(moved.join("sentinel.txt"), "keep me").unwrap();
            link(&moved, &linked);
            let before = contents(&elsewhere);
            assert!(before.iter().any(|(name, _)| name.ends_with("notes.txt")));

            let dir = w.dir.to_string_lossy().into_owned();
            write_session(&w, &[text("assistant", &format!("![shot]({dir}/a.png)"))]);
            let scope = Scope::detached();
            let session = w.session.to_string_lossy().into_owned();
            assert_eq!(facts(&dir, &scope).unwrap_err().code, "scratch_kept");
            assert_eq!(
                sweep(&dir, &[session], &scope).unwrap_err().code,
                "scratch_kept"
            );
            assert_eq!(sweep(&dir, &[], &scope).unwrap_err().code, "scratch_kept");

            assert!(
                fs::symlink_metadata(&linked)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(contents(&elsewhere), before);
            fs::remove_dir_all(&w.root).unwrap();
        }
    }

    /// A link inside the folder is removed as a link, also when a reply names a file through it: what it points at
    /// stays.
    #[test]
    fn removes_a_link_inside_the_folder_as_a_link() {
        let w = world("scratch-inner-link");
        let outside = w.root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("sentinel.txt"), "keep me").unwrap();
        fs::write(outside.join("shot.png"), "png").unwrap();
        link(&outside, &w.dir.join("checkout"));
        let before = contents(&outside);

        let dir = w.dir.to_string_lossy().into_owned();
        write_session(
            &w,
            &[text(
                "assistant",
                &format!("![a]({dir}/a.png) ![b]({dir}/checkout/shot.png)"),
            )],
        );
        let swept = sweep(
            &dir,
            &[w.session.to_string_lossy().into_owned()],
            &Scope::detached(),
        )
        .unwrap();
        assert_eq!(swept.kept, 1);
        assert!(fs::symlink_metadata(w.dir.join("checkout")).is_err());
        assert_eq!(left(&w), ["a.png"]);
        assert_eq!(contents(&outside), before);

        // The deleted session's sweep takes the folder with its link, and still nothing behind it.
        let again = world("scratch-inner-link");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("sentinel.txt"), "keep me").unwrap();
        fs::write(outside.join("shot.png"), "png").unwrap();
        link(&outside, &again.dir.join("checkout"));
        sweep(&again.dir.to_string_lossy(), &[], &Scope::detached()).unwrap();
        assert!(!again.dir.exists());
        assert_eq!(contents(&outside), before);
        fs::remove_dir_all(&again.root).unwrap();
    }
}
