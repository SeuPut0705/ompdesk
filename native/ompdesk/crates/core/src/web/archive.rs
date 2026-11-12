//! The previous builds' hashed `/assets/` files, served for a while after this computer updated OMPdesk, so a paired
//! page loaded before the update still finds the chunks it asks for (unit 8b; was `src/main/web/asset-archive.ts`).
//!
//! Why: a phone keeps its page open for hours, and its service worker boots the cached shell of the build it was
//! installed with; the new build's renderer folder no longer has that build's lazy chunks (the side panel's views, a
//! language, Settings, a dialog), so a lazy import failed ("Importing a module script failed.", v0.38.1) and the page
//! crashed. Every `/assets/` name carries its content hash, so serving an older build's file by name can only ever
//! serve exactly that file.
//!
//! How: at each start the server's build (`build_id`, the hash of its `web.html`) is copied once into
//! `<userData>/web-assets/<build>/assets/` (a rename of a `.partial` folder; about 15 MB). The builds that stopped
//! being current are kept for `RETAIN_MS` after they were replaced, `MAX_PREVIOUS` at most, newest first, and `roots`
//! lists them for the edge (`assets::Assets::previous_builds`).
//!
//! Each file is read and written, never copied by a platform call: in a packaged app the renderer folder is inside
//! `app.asar`, and Electron serves a copy, open or spawn of a file there by first copying it out to a temp file of its
//! own that it never removes (a `copyFile` per asset left all 218 of a build's assets, 15.6 MB, in the owner's temp
//! folder at every update). The core never reads through Electron's asar layer, but the files it is handed are the
//! ones main resolved, and a read-and-write copy is what the TypeScript guaranteed.
//!
//! One archive per `userData` per core process (`open`). Methods (`register`): `web.assets.retain` `{userData,
//! staticRoot, now}` -> `{roots}`, `web.assets.buildId` `{staticRoot}` -> `{build}`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::{Number, Value, json};
use sha2::{Digest, Sha256};

use crate::disk::tree::write_atomic_if;
use crate::server::{Call, Fault, Registry, Reply};

/// How long a replaced build's assets stay served.
pub const RETAIN_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;
/// How many replaced builds are kept at most.
pub const MAX_PREVIOUS: usize = 2;

const INDEX_FILE: &str = "builds.json";
const FOLDER: &str = "web-assets";

/// The build a renderer folder holds: the hash of its `web.html` (it names that build's entry chunks); None without one.
pub fn build_id(static_root: &Path) -> Option<String> {
    let page = fs::read(static_root.join(super::assets::PAGE_FILE)).ok()?;
    Some(super::hex(&Sha256::digest(page))[..12].to_owned())
}

fn is_build(name: &str) -> bool {
    name.len() == 12
        && name
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A build in `builds.json`: `replaced_at` is null for the current one.
#[derive(Debug, Clone, PartialEq)]
struct Archived {
    build: String,
    replaced_at: Option<Number>,
}

/// `Index.safeParse(readJson(file))`: the builds of a well-formed index, none for anything else.
fn read_index(file: &Path) -> Vec<Archived> {
    let parse = || -> Option<Vec<Archived>> {
        let value: Value = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
        if value.get("v")?.as_f64()? != 1.0 {
            return None;
        }
        value
            .get("builds")?
            .as_array()?
            .iter()
            .map(|entry| {
                let build = entry.get("build")?.as_str().filter(|name| is_build(name))?;
                let replaced_at = match entry.get("replacedAt")? {
                    Value::Null => None,
                    Value::Number(number) => Some(number.clone()),
                    _ => return None,
                };
                Some(Archived {
                    build: build.to_owned(),
                    replaced_at,
                })
            })
            .collect()
    };
    parse().unwrap_or_default()
}

/// `JSON.stringify({ v: 1, builds }, null, "\t") + "\n"`.
fn index_text(builds: &[Archived]) -> String {
    use serde::Serialize as _;
    let value = json!({
        "v": 1,
        "builds": builds
            .iter()
            .map(|entry| json!({ "build": entry.build, "replacedAt": entry.replaced_at }))
            .collect::<Vec<_>>(),
    });
    let mut out = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(
        &mut out,
        serde_json::ser::PrettyFormatter::with_indent(b"\t"),
    );
    if value.serialize(&mut serializer).is_err() {
        return String::new();
    }
    out.push(b'\n');
    String::from_utf8(out).unwrap_or_default()
}

fn exists(path: &Path) -> bool {
    fs::metadata(path).is_ok()
}

/// This build's assets, copied once; false when they could not be (the build is then not kept).
fn copy(dir: &Path, static_root: &Path, build: &str) -> bool {
    let target = dir.join(build);
    if exists(&target.join("assets")) {
        return true;
    }
    let partial = {
        let mut name = target.as_os_str().to_owned();
        name.push(".partial");
        PathBuf::from(name)
    };
    let copied = (|| -> io::Result<()> {
        let _ = fs::remove_dir_all(&partial);
        fs::create_dir_all(partial.join("assets"))?;
        let source = static_root.join("assets");
        for entry in fs::read_dir(&source)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                fs::write(
                    partial.join("assets").join(entry.file_name()),
                    fs::read(entry.path())?,
                )?;
            }
        }
        fs::rename(&partial, &target)
    })();
    if copied.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    copied.is_ok()
}

fn remove(path: &Path) -> io::Result<()> {
    let removed = match fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) => Err(error),
    };
    match removed {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Keeps the build in `static_root`, marks the others replaced and drops what is past the window or the count;
/// the folders of the builds still served, newest first. None without a built renderer (a dev run has none).
fn retain_build(dir: &Path, static_root: &Path, now: i64) -> io::Result<Option<Vec<PathBuf>>> {
    let Some(current) = build_id(static_root) else {
        return Ok(None);
    };
    let now_number = Number::from(now);
    let mut previous: Vec<(String, Number)> = read_index(&dir.join(INDEX_FILE))
        .into_iter()
        .filter(|entry| entry.build != current)
        .map(|entry| {
            (
                entry.build,
                entry.replaced_at.unwrap_or_else(|| now_number.clone()),
            )
        })
        .filter(|(_, replaced_at)| {
            now as f64 - replaced_at.as_f64().unwrap_or(f64::NAN) < RETAIN_MS
        })
        .collect();
    previous.sort_by(|a, b| {
        let (a, b) = (a.1.as_f64().unwrap_or(0.0), b.1.as_f64().unwrap_or(0.0));
        b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal)
    });
    previous.truncate(MAX_PREVIOUS);
    let kept: Vec<Archived> = previous
        .into_iter()
        .filter(|(build, _)| exists(&dir.join(build).join("assets")))
        .map(|(build, replaced_at)| Archived {
            build,
            replaced_at: Some(replaced_at),
        })
        .collect();
    let copied = copy(dir, static_root, &current);
    let mut builds = kept.clone();
    if copied {
        builds.push(Archived {
            build: current.clone(),
            replaced_at: None,
        });
    }
    write_atomic_if(
        &dir.join(INDEX_FILE),
        index_text(&builds).as_bytes(),
        Some(0o600),
        0o777,
        &|| true,
    )
    .map_err(|fault| io::Error::other(fault.message))?;
    let keep: HashSet<&str> = [INDEX_FILE, current.as_str()]
        .into_iter()
        .chain(kept.iter().map(|entry| entry.build.as_str()))
        .collect();
    if let Ok(names) = fs::read_dir(dir) {
        for name in names.filter_map(Result::ok) {
            if !keep.contains(name.file_name().to_string_lossy().as_ref()) {
                remove(&name.path())?;
            }
        }
    }
    Ok(Some(
        kept.iter().map(|entry| dir.join(&entry.build)).collect(),
    ))
}

pub struct AssetArchive {
    dir: PathBuf,
    roots: Mutex<Vec<PathBuf>>,
    /// Calls run one after another: a second call's copy is never swept away by the first call's cleanup.
    queue: tokio::sync::Mutex<()>,
}

static ARCHIVES: LazyLock<Mutex<HashMap<PathBuf, Arc<AssetArchive>>>> =
    LazyLock::new(Mutex::default);

/// The one archive of this `userData` in the process.
pub fn open(user_data: &Path) -> Arc<AssetArchive> {
    let mut archives = ARCHIVES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(archives.entry(user_data.to_path_buf()).or_insert_with(|| {
        Arc::new(AssetArchive {
            dir: user_data.join(FOLDER),
            roots: Mutex::default(),
            queue: tokio::sync::Mutex::new(()),
        })
    }))
}

impl AssetArchive {
    fn roots_guard(&self) -> MutexGuard<'_, Vec<PathBuf>> {
        self.roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Folders holding a replaced build's `assets/`, newest first: where a missing `/assets/` file is looked for.
    pub fn roots(&self) -> Vec<PathBuf> {
        self.roots_guard().clone()
    }

    /// Keep the build in `static_root` for later (copied once), mark the others replaced, drop what is past the window
    /// or the count, and serve the rest. Never fails for a missing renderer folder (a dev run has none).
    pub async fn retain(&self, static_root: &Path, now: i64) -> io::Result<Vec<PathBuf>> {
        let _turn = self.queue.lock().await;
        let (dir, root) = (self.dir.clone(), static_root.to_path_buf());
        let kept = tokio::task::spawn_blocking(move || retain_build(&dir, &root, now))
            .await
            .map_err(io::Error::other)??;
        if let Some(kept) = kept {
            *self.roots_guard() = kept;
        }
        Ok(self.roots())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(default)]
    user_data: PathBuf,
    static_root: PathBuf,
    #[serde(default)]
    now: i64,
}

async fn retain(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let roots = open(&params.user_data)
        .retain(&params.static_root, params.now)
        .await
        .map_err(|error| Fault::new("io", error.to_string()))?;
    let roots: Vec<String> = roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    Reply::json(&json!({ "roots": roots }))
}

async fn build(call: Call) -> Result<Reply, Fault> {
    let params: Params = call.params()?;
    let found = tokio::task::spawn_blocking(move || build_id(&params.static_root))
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?;
    Reply::json(&json!({ "build": found }))
}

pub fn register(registry: &mut Registry) {
    registry.add("web.assets.retain", |call| Box::pin(retain(call)));
    registry.add("web.assets.buildId", |call| Box::pin(build(call)));
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static COUNT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "ompdesk-core-archive-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn renderer(&self, folder: &str) -> PathBuf {
            self.0.join(folder)
        }

        fn archive(&self) -> PathBuf {
            self.0.join(FOLDER)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Put build `name` in `folder`: its own web.html and one hashed chunk named after it.
    fn build(folder: &Path, name: &str) {
        let _ = fs::remove_dir_all(folder);
        fs::create_dir_all(folder.join("assets")).unwrap();
        fs::write(
            folder.join("web.html"),
            format!("<!doctype html><script src=\"./assets/web-{name}.js\"></script>"),
        )
        .unwrap();
        fs::write(
            folder.join("assets").join(format!("chunk-{name}.js")),
            format!("chunk {name}"),
        )
        .unwrap();
    }

    fn served(archive: &AssetArchive, file: &str) -> Vec<String> {
        archive
            .roots()
            .iter()
            .map(|root| root.join("assets").join(file))
            .filter_map(|path| fs::read_to_string(path).ok())
            .collect()
    }

    fn fresh(scratch: &Scratch) -> AssetArchive {
        AssetArchive {
            dir: scratch.archive(),
            roots: Mutex::default(),
            queue: tokio::sync::Mutex::new(()),
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    const CLOCK: i64 = 1_000_000;

    #[tokio::test]
    async fn each_build_is_kept_once_and_only_the_replaced_ones_are_served() {
        let scratch = Scratch::new();
        let archive = fresh(&scratch);
        let renderer = scratch.renderer("renderer");
        build(&renderer, "a");
        archive.retain(&renderer, CLOCK).await.unwrap();
        assert!(
            archive.roots().is_empty(),
            "the current build is the renderer folder's own"
        );
        build(&renderer, "b");
        archive.retain(&renderer, CLOCK + 1000).await.unwrap();
        assert_eq!(served(&archive, "chunk-a.js"), ["chunk a"]);
        assert!(served(&archive, "chunk-b.js").is_empty());
        let before = names(&scratch.archive());
        archive.retain(&renderer, CLOCK + 2000).await.unwrap();
        assert_eq!(
            names(&scratch.archive()),
            before,
            "a relaunch on the same build copies nothing again"
        );
        assert_eq!(served(&archive, "chunk-a.js"), ["chunk a"]);
    }

    #[tokio::test]
    async fn a_build_replaced_longer_than_the_window_ago_goes_and_the_newest_two_stay() {
        let scratch = Scratch::new();
        let archive = fresh(&scratch);
        let renderer = scratch.renderer("renderer");
        let mut clock = CLOCK;
        for name in ["a", "b", "c", "d"] {
            build(&renderer, name);
            archive.retain(&renderer, clock).await.unwrap();
            clock += 1000;
        }
        assert_eq!(MAX_PREVIOUS, 2);
        assert_eq!(served(&archive, "chunk-c.js"), ["chunk c"]);
        assert_eq!(served(&archive, "chunk-b.js"), ["chunk b"]);
        assert!(served(&archive, "chunk-a.js").is_empty());
        assert_eq!(archive.roots().len(), 2);
        assert!(
            archive.roots()[0].ends_with(build_id_of_chunk(&scratch, "c")),
            "newest first"
        );
        clock += RETAIN_MS as i64;
        archive.retain(&renderer, clock).await.unwrap();
        assert!(archive.roots().is_empty());
        let current = build_id(&renderer).unwrap();
        let mut expected = vec![INDEX_FILE.to_owned(), current];
        expected.sort();
        assert_eq!(names(&scratch.archive()), expected);
    }

    /// The build id of a renderer that holds `name`'s page.
    fn build_id_of_chunk(scratch: &Scratch, name: &str) -> String {
        let folder = scratch.renderer("probe");
        build(&folder, name);
        build_id(&folder).unwrap()
    }

    #[tokio::test]
    async fn nothing_happens_without_a_built_renderer_and_a_corrupt_index_is_replaced() {
        let scratch = Scratch::new();
        let archive = fresh(&scratch);
        let renderer = scratch.renderer("renderer");
        archive.retain(&renderer, CLOCK).await.unwrap();
        assert!(!scratch.archive().exists());
        build(&renderer, "a");
        fs::create_dir_all(scratch.archive()).unwrap();
        fs::write(scratch.archive().join(INDEX_FILE), "{not json").unwrap();
        archive.retain(&renderer, CLOCK).await.unwrap();
        assert!(archive.roots().is_empty());
        let index: Value =
            serde_json::from_slice(&fs::read(scratch.archive().join(INDEX_FILE)).unwrap()).unwrap();
        assert_eq!(index["builds"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_index_is_tab_indented_owner_only_json_and_names_what_replaced_what() {
        let scratch = Scratch::new();
        let archive = fresh(&scratch);
        let renderer = scratch.renderer("renderer");
        build(&renderer, "a");
        archive.retain(&renderer, CLOCK).await.unwrap();
        let first = build_id(&renderer).unwrap();
        build(&renderer, "b");
        archive.retain(&renderer, CLOCK + 5).await.unwrap();
        let second = build_id(&renderer).unwrap();
        let text = fs::read_to_string(scratch.archive().join(INDEX_FILE)).unwrap();
        assert_eq!(
            text,
            format!(
                "{{\n\t\"v\": 1,\n\t\"builds\": [\n\t\t{{\n\t\t\t\"build\": \"{first}\",\n\t\t\t\"replacedAt\": {}\n\t\t}},\n\t\t{{\n\t\t\t\"build\": \"{second}\",\n\t\t\t\"replacedAt\": null\n\t\t}}\n\t]\n}}\n",
                CLOCK + 5
            )
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(scratch.archive().join(INDEX_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(read_index(&scratch.archive().join(INDEX_FILE)).len(), 2);
        assert!(read_index(&scratch.archive().join("missing.json")).is_empty());
    }

    #[test]
    fn an_index_that_is_not_the_expected_shape_reads_as_empty() {
        let scratch = Scratch::new();
        let file = scratch.0.join("i.json");
        for bad in [
            r#"{"v":2,"builds":[]}"#,
            r#"{"v":1}"#,
            r#"{"v":1,"builds":[{"build":"nothex","replacedAt":null}]}"#,
            r#"{"v":1,"builds":[{"build":"0123456789ab"}]}"#,
            r#"{"v":1,"builds":[{"build":"0123456789ab","replacedAt":"x"}]}"#,
            "[]",
        ] {
            fs::write(&file, bad).unwrap();
            assert!(read_index(&file).is_empty(), "{bad}");
        }
        fs::write(
            &file,
            r#"{"v":1,"extra":true,"builds":[{"build":"0123456789ab","replacedAt":12.5,"x":1}]}"#,
        )
        .unwrap();
        assert_eq!(read_index(&file).len(), 1);
    }

    #[tokio::test]
    async fn a_second_call_waits_for_the_first_so_its_cleanup_never_sweeps_the_second_calls_copy() {
        let scratch = Scratch::new();
        let archive = Arc::new(fresh(&scratch));
        let (first, second) = (scratch.renderer("first"), scratch.renderer("second"));
        build(&first, "a");
        build(&second, "b");
        // The first call is held while the turn is taken: nothing of the second runs until it ends.
        let turn = archive.queue.lock().await;
        let pending = tokio::spawn({
            let (archive, second) = (Arc::clone(&archive), second.clone());
            async move { archive.retain(&second, CLOCK).await }
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!pending.is_finished());
        assert!(!scratch.archive().exists());
        drop(turn);
        pending.await.unwrap().unwrap();
        assert!(
            scratch
                .archive()
                .join(build_id(&second).unwrap())
                .join("assets/chunk-b.js")
                .exists()
        );
        let (a, b) = tokio::join!(
            archive.retain(&first, CLOCK + 1),
            archive.retain(&second, CLOCK + 2)
        );
        a.unwrap();
        b.unwrap();
        assert!(
            scratch
                .archive()
                .join(build_id(&second).unwrap())
                .join("assets/chunk-b.js")
                .exists()
        );
    }

    #[tokio::test]
    async fn a_copy_that_fails_leaves_no_partial_and_the_build_is_not_kept() {
        let scratch = Scratch::new();
        let archive = fresh(&scratch);
        let renderer = scratch.renderer("renderer");
        build(&renderer, "a");
        fs::remove_dir_all(renderer.join("assets")).unwrap();
        archive.retain(&renderer, CLOCK).await.unwrap();
        assert_eq!(names(&scratch.archive()), [INDEX_FILE]);
        assert!(read_index(&scratch.archive().join(INDEX_FILE)).is_empty());
    }

    #[test]
    fn the_build_is_the_first_12_hex_digits_of_the_pages_sha256() {
        let scratch = Scratch::new();
        let folder = scratch.renderer("r");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("web.html"), "abc").unwrap();
        assert_eq!(build_id(&folder).as_deref(), Some("ba7816bf8f01"));
        assert_eq!(build_id(&scratch.renderer("none")), None);
    }
}
