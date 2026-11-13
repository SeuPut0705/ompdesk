//! The updater's work (was `src/main/updater.ts`'s network, files and installers, `nsis-updater.ts` and electron-
//! updater's NSIS flow): one check at a time, the downloads with resume and SHA-512, the macOS staging and swap
//! helper, the Windows installer. Node mirrors the state from `updater.status` and keeps the scheduler, the confirm,
//! the quit and the windows (PROTOCOL.md §15.8).
//!
//! Every request runs on a thread of its own; the state sits behind one lock that is never held across the network,
//! a file transfer or a process.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha512};
use shell_core::labels;
use shell_core::updater_core::release::{self, FeedError, Platform, PlatformRelease};
use shell_core::updater_core::rules::{self, DOWNLOAD_IDLE_TIMEOUT_MS};
use shell_core::updater_core::semver;
use shell_core::updater_core::status::{Access, Mode, Status};

use super::fetch::{self, Fail, Redirect};
use super::platform::{self, StageError};
use super::token;
use crate::modules::Ctx;

/// A release reaches users within one interval; one GitHub API call per check is 12 an hour, under the 60/h
/// anonymous limit.
const CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);
const FIRST_CHECK: Duration = Duration::from_secs(3);
/// How long the release lookup may go unanswered, its body included (a stalled connection never fails by itself).
const RELEASE_LOOKUP_TIMEOUT: Duration = Duration::from_secs(15);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const IDLE: Duration = Duration::from_millis(DOWNLOAD_IDLE_TIMEOUT_MS);
/// electron-updater's cache folder (`updaterCacheDirName`), kept so a download it left is found.
const WINDOWS_CACHE: &str = "ompdesk-updater";

/// Why a step failed: the module's own words (a `MAIN_TEXT` key and a suffix), or a raw text.
pub enum Failure {
    Own {
        key: &'static str,
        suffix: Option<String>,
    },
    Raw(String),
}

impl Failure {
    fn own(key: &'static str) -> Failure {
        Failure::Own { key, suffix: None }
    }

    fn own_with(key: &'static str, suffix: impl ToString) -> Failure {
        Failure::Own {
            key,
            suffix: Some(suffix.to_string()),
        }
    }

    /// `failureStatus`: an own failure is its own headline; anything else is `fallback` with the raw text as detail.
    fn status(&self, fallback: &str, banner: bool) -> Status {
        match self {
            Failure::Own { key, suffix } => Status::Error {
                key: (*key).to_string(),
                suffix: suffix.clone(),
                detail: None,
                show_in_banner: Some(banner),
            },
            Failure::Raw(text) => Status::Error {
                key: fallback.to_string(),
                suffix: None,
                detail: Some(text.clone()),
                show_in_banner: Some(banner),
            },
        }
    }

    /// The text the log carries: the UI language's words of an own failure, as the TypeScript's message was.
    fn text(&self) -> String {
        match self {
            Failure::Own { key, suffix } => {
                let words = labels::label(key, &[]).unwrap_or_else(|| (*key).to_string());
                match suffix {
                    Some(suffix) => format!("{words} ({suffix})"),
                    None => words,
                }
            }
            Failure::Raw(text) => text.clone(),
        }
    }
}

fn stalled() -> Failure {
    Failure::Raw(format!("No data received for {} s", IDLE.as_secs()))
}

fn net(fail: Fail) -> Failure {
    match fail {
        Fail::Net(text) => Failure::Raw(text),
        Fail::Timeout => stalled(),
    }
}

/// A check's failure: electron-updater's or the feed's code, and its text.
struct CheckError {
    code: Option<String>,
    message: String,
}

impl From<FeedError> for CheckError {
    fn from(error: FeedError) -> Self {
        CheckError {
            code: Some(error.code.to_string()),
            message: error.message,
        }
    }
}

/// One waiter list (`Promise` of a run under way).
struct Gate {
    done: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn new() -> Arc<Gate> {
        Arc::new(Gate {
            done: Mutex::new(false),
            cv: Condvar::new(),
        })
    }

    fn wait(&self) {
        let mut done = self.done.lock().unwrap();
        while !*done {
            done = self.cv.wait(done).unwrap();
        }
    }

    fn open(&self) {
        *self.done.lock().unwrap() = true;
        self.cv.notify_all();
    }
}

#[derive(Clone)]
struct Asset {
    name: String,
    url: String,
    sha512: String,
    size: u64,
}

/// Where the app lives (from `hello`'s facts).
struct Places {
    user_data: PathBuf,
    downloads: PathBuf,
    exe: String,
    argv: Vec<String>,
    packaged: bool,
}

struct State {
    version: String,
    mode: Mode,
    status: Status,
    own_bundle: Option<PathBuf>,
    /// The verified new bundle (relaunch mode) and the version it must report once it starts.
    staged_app: Option<(PathBuf, String)>,
    active_version: Option<String>,
    asset: Option<Asset>,
    /// The manual DMG in Downloads, or the Windows installer in the updater cache.
    installer: Option<PathBuf>,
    relaunch_after_swap: bool,
    swap_launched: bool,
    install_started: bool,
    dev_dry_install: bool,
    token: Option<String>,
    check: Option<Arc<Gate>>,
    check_asked: bool,
    transfer: bool,
    helpers: Vec<JoinHandle<()>>,
}

pub struct LoginEnv {
    pub token: Option<String>,
    pub path: String,
}

pub struct Service {
    ctx: Ctx,
    places: Places,
    api: String,
    state: Mutex<State>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn sha512_base64(file: &Path) -> std::io::Result<String> {
    let mut hash = Sha512::new();
    let mut reader = File::open(file)?;
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = std::io::Read::read(&mut reader, &mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(STANDARD.encode(hash.finalize()))
}

fn file_size(file: &Path) -> u64 {
    std::fs::metadata(file).map(|m| m.len()).unwrap_or(0)
}

impl Service {
    pub fn new(ctx: Ctx) -> Service {
        let facts = crate::state::FACTS.get().cloned().unwrap_or(Value::Null);
        let path = |name: &str| PathBuf::from(facts["paths"][name].as_str().unwrap_or_default());
        let places = Places {
            user_data: path("userData"),
            downloads: path("downloads"),
            exe: facts["exe"].as_str().unwrap_or_default().to_string(),
            argv: facts["argv"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            packaged: facts["isPackaged"].as_bool().unwrap_or(false),
        };
        // Test seam (unpackaged only): a local stand-in for the release repository's API.
        let api = env("OMP_DEV_UPDATE_API")
            .filter(|_| !places.packaged)
            .unwrap_or_else(|| rules::GITHUB_API_REPO.to_string());
        Service {
            ctx,
            places,
            api,
            state: Mutex::new(State {
                version: String::new(),
                mode: Mode::Automatic,
                status: Status::Idle,
                own_bundle: None,
                staged_app: None,
                active_version: None,
                asset: None,
                installer: None,
                relaunch_after_swap: false,
                swap_launched: false,
                install_started: false,
                dev_dry_install: false,
                token: None,
                check: None,
                check_asked: false,
                transfer: false,
                helpers: Vec::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    pub fn user_data(&self) -> &Path {
        &self.places.user_data
    }

    pub fn api(&self) -> &str {
        &self.api
    }

    fn updates_dir(&self) -> PathBuf {
        self.places.user_data.join("updates")
    }

    fn installable_of(s: &State) -> bool {
        match (&s.status, s.mode) {
            (Status::Downloaded { .. }, Mode::Relaunch) => {
                s.staged_app.is_some() && s.own_bundle.is_some()
            }
            (Status::Downloaded { .. }, Mode::Automatic) => true,
            _ => false,
        }
    }

    fn state_json(s: &State) -> Value {
        json!({ "status": s.status.to_json(), "installable": Self::installable_of(s), "mode": s.mode.as_str() })
    }

    pub fn state(&self) -> Value {
        Self::state_json(&self.lock())
    }

    fn broadcast(&self, status: Status) {
        let state = {
            let mut s = self.lock();
            s.status = status;
            Self::state_json(&s)
        };
        self.ctx.emit("status", state);
    }

    fn status(&self) -> Status {
        self.lock().status.clone()
    }

    /// One decision line of `gui-runtime.jsonl` (source `app-update`, info level), written by Node (`log.runtime`,
    /// PROTOCOL.md §15.4 rule 1); Node's relay scrubs every `reason` of URLs and secrets the redactor knows.
    fn log(&self, message: &str, details: Value) {
        let mut details = details;
        if let Some(object) = details.as_object_mut() {
            object.insert("level".into(), json!("info"));
        }
        self.ctx.runtime_log(
            json!({ "source": "app-update", "message": message, "details": details }),
            None,
        );
    }

    /// A plain line of the same log, without decision details.
    pub fn log_line(&self, message: &str) {
        self.ctx
            .runtime_log(json!({ "source": "app-update", "message": message }), None);
    }

    /// `GH_TOKEN`/`GITHUB_TOKEN` and the `PATH` for `gh`, from Node (its launch environment and the login shell's).
    pub fn login_env(&self) -> LoginEnv {
        let (tx, rx) = std::sync::mpsc::channel();
        self.ctx.ask("loginEnv", json!({}), None, move |answer, _| {
            let _ = tx.send(answer);
        });
        let fallback = || LoginEnv {
            token: None,
            path: std::env::var("PATH").unwrap_or_default(),
        };
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(value)) => LoginEnv {
                token: value["token"]
                    .as_str()
                    .map(String::from)
                    .filter(|t| !t.is_empty()),
                path: value["path"]
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| fallback().path),
            },
            _ => fallback(),
        }
    }

    // ---------------------------------------------------------------- start

    /// `updater.start`: the mode, the dev seams, the startup sweep and the background check. Once.
    pub fn start(self: &Arc<Self>, version: &str) -> Value {
        let mode = self.detect_mode();
        {
            let mut s = self.lock();
            s.version = version.to_string();
            s.mode = mode;
        }
        // Dev/test seam (unpackaged only): pretend this staged bundle was downloaded and verified. On Windows the
        // update is a pretend installer whose install only quits: every decision before it runs as shipped.
        let dev_staged = env("OMP_DEV_UPDATE_STAGED").filter(|_| !self.places.packaged);
        let dev_version =
            env("OMP_DEV_UPDATE_STAGED_VERSION").unwrap_or_else(|| "0.0.0-dev".into());
        if let Some(staged) = dev_staged {
            let relaunch_ready = mode == Mode::Relaunch && self.lock().own_bundle.is_some();
            if relaunch_ready {
                self.lock().staged_app = Some((PathBuf::from(staged), dev_version.clone()));
                self.broadcast(Status::Downloaded {
                    version: dev_version,
                    mode: Mode::Relaunch,
                });
            } else if mode == Mode::Automatic {
                self.lock().dev_dry_install = true;
                self.broadcast(Status::Downloaded {
                    version: dev_version,
                    mode: Mode::Automatic,
                });
            }
        }
        if cfg!(target_os = "macos") {
            // Installs interrupted by older builds keyed the partial by process id: the only debris a startup sweep can
            // identify for sure.
            let downloads = self.places.downloads.clone();
            std::thread::spawn(move || sweep_partials(&downloads, None));
        }
        let service = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                // A downloaded or in-flight update is never replaced by a background re-check.
                if !matches!(
                    service.status(),
                    Status::Downloading { .. } | Status::Downloaded { .. }
                ) {
                    service.run_check(false);
                }
                std::thread::sleep(CHECK_INTERVAL);
            }
        });
        self.state()
    }

    fn detect_mode(&self) -> Mode {
        if !cfg!(target_os = "macos") {
            return Mode::Automatic;
        }
        let set_own = |own: Option<PathBuf>| {
            let found = own.is_some();
            self.lock().own_bundle = own;
            if found { Mode::Relaunch } else { Mode::Manual }
        };
        // Test seams for unpackaged builds; never override a release bundle.
        if !self.places.packaged {
            match env("OMP_DEV_UPDATE_MODE").as_deref() {
                Some("relaunch") => {
                    return set_own(platform::swappable_bundle(
                        env("OMP_DEV_UPDATE_BUNDLE").as_deref(),
                    ));
                }
                Some("manual") => return Mode::Manual,
                _ => {}
            }
        }
        // Ad-hoc or certificate-signed alike: the release ships a DMG, not the ZIP Squirrel needs.
        let bundle = self
            .places
            .packaged
            .then(|| rules::mac_bundle_path(&self.places.exe))
            .flatten();
        set_own(platform::swappable_bundle(bundle.as_deref()))
    }

    // ---------------------------------------------------------------- check

    /// `updater.check`: a person's check. A downloaded update or a transfer under way is the answer as it is.
    pub fn check(&self) -> Value {
        let busy = {
            let s = self.lock();
            s.transfer || matches!(s.status, Status::Downloaded { .. })
        };
        if !busy {
            self.broadcast(Status::Checking);
            self.run_check(true);
        }
        self.state()
    }

    /// One check at a time. A check someone asked for surfaces its failures in the banner; asked during a background
    /// check, the background check is the check and settles as asked.
    fn run_check(&self, manual: bool) {
        let (gate, mine) = {
            let mut s = self.lock();
            if manual {
                s.check_asked = true;
            }
            match &s.check {
                Some(gate) => (gate.clone(), false),
                None => {
                    let gate = Gate::new();
                    s.check = Some(gate.clone());
                    (gate, true)
                }
            }
        };
        if !mine {
            return gate.wait();
        }
        self.check_once();
        {
            let mut s = self.lock();
            s.check = None;
            s.check_asked = false;
        }
        gate.open();
    }

    fn check_once(&self) {
        let mut token = token::resolve(self).map(|(token, _)| token);
        let configured = token.clone();
        let mut rejected = false;
        self.lock().token = token.clone();
        let mut failure = self.attempt_check(token.as_deref());
        // GitHub answers 401 to a bad token even for public data (an expired GH_TOKEN, a stale `gh` login). The repo
        // is public, so ask again without it instead of blocking updates on the stale credential.
        if failure.is_some()
            && token.is_some()
            && token::repo_access(self, token.as_deref()) == Access::Invalid
        {
            rejected = true;
            token = None;
            self.lock().token = None;
            failure = self.attempt_check(None);
        }
        let (asked, current, version) = {
            let s = self.lock();
            (s.check_asked, s.status.clone(), s.version.clone())
        };
        let Some(error) = failure else {
            let settled = rules::settle_incomplete_check(&current, asked, "updates.noResult");
            if settled != current {
                self.log(
                    "check",
                    json!({ "event": "error", "kind": "no-result", "manual": asked }),
                );
                self.broadcast(settled);
            }
            return;
        };
        let mut access = token::repo_access(self, token.as_deref());
        // An anonymous request GitHub answers "not found" means the repo is private again: a token is needed (or the
        // one tried was rejected).
        if access == Access::Denied && token.is_none() {
            access = if rejected {
                Access::Invalid
            } else {
                Access::Missing
            };
        }
        let code = error.code.as_deref();
        let key = match code {
            Some(release::METADATA_ERROR) => "updates.releaseInvalid",
            Some(release::PLATFORM_ERROR) => "updates.installerMissing",
            _ => "updates.checkFailed",
        };
        let settled =
            rules::settle_failed_check(access, code, key, &version, asked, Some(&error.message));
        match &settled {
            // A repo with no release yet is the same answer as "no update".
            Status::NotAvailable { .. } => self.log(
                "check",
                json!({ "event": "no-update", "current": version, "manual": asked, "note": "no release published" }),
            ),
            Status::AuthRequired { reason } => self.log(
                "check",
                json!({ "event": "error", "kind": format!("auth-required:{}", reason.as_str()), "manual": asked,
                        "reason": rules::cut_secrets(&error.message, &[configured.as_deref()]) }),
            ),
            _ => self.log(
                "check",
                json!({ "event": "error", "kind": code.unwrap_or("check-failed"), "manual": asked,
                        "reason": rules::cut_secrets(&error.message, &[configured.as_deref()]) }),
            ),
        }
        self.broadcast(settled);
    }

    /// One release lookup with `token` (none = anonymous), and its outcome: electron-updater's `checkForUpdates` over
    /// the release-notes provider. An unpackaged app checks only with `OMP_DEV_UPDATE_CHECK=1`.
    fn attempt_check(&self, token: Option<&str>) -> Option<CheckError> {
        if !self.places.packaged && env("OMP_DEV_UPDATE_CHECK").as_deref() != Some("1") {
            return None;
        }
        self.broadcast(Status::Checking);
        let release = match self.fetch_release(token) {
            Ok(release) => release,
            Err(error) => return Some(error),
        };
        let current = self.lock().version.clone();
        match semver::is_newer(&release.version, &current) {
            None => Some(CheckError {
                code: Some(release::INVALID_VERSION_ERROR.into()),
                message: format!(
                    "This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: \"{}\"",
                    release.version
                ),
            }),
            Some(false) => {
                self.log("check", json!({ "event": "no-update", "current": current }));
                self.broadcast(Status::NotAvailable { version: current });
                None
            }
            Some(true) => {
                self.found(release);
                None
            }
        }
    }

    fn fetch_release(&self, token: Option<&str>) -> Result<PlatformRelease, CheckError> {
        // A pre-release only exists for the updater test harness; never in a release bundle.
        let prerelease =
            !self.places.packaged && env("OMP_DEV_UPDATE_PRERELEASE").as_deref() == Some("1");
        // GitHub lists newest first; one page reaches any pre-release worth testing.
        let url = if prerelease {
            format!("{}/releases?per_page=30", self.api)
        } else {
            format!("{}/releases/latest", self.api)
        };
        let late = || CheckError {
            code: Some(release::LOOKUP_ERROR.into()),
            message: format!(
                "GitHub did not answer within {} s ({url})",
                RELEASE_LOOKUP_TIMEOUT.as_secs()
            ),
        };
        let deadline = Instant::now() + RELEASE_LOOKUP_TIMEOUT;
        let headers = rules::github_api_headers(token, None);
        let mut response = match fetch::get(
            &url,
            &headers,
            Redirect::Follow,
            false,
            RELEASE_LOOKUP_TIMEOUT,
        ) {
            Ok(response) => response,
            Err(Fail::Timeout) => return Err(late()),
            Err(Fail::Net(text)) => {
                return Err(CheckError {
                    code: None,
                    message: text,
                });
            }
        };
        // 404 is also what a token without access sees; the check asks the repo endpoint before trusting "no release".
        if response.status == 404 {
            return Err(FeedError {
                code: release::NO_RELEASE_ERROR,
                message: format!("No published release ({url})"),
            }
            .into());
        }
        if !(200..300).contains(&response.status) {
            return Err(FeedError {
                code: release::LOOKUP_ERROR,
                message: format!("GitHub answered {} ({url})", response.status),
            }
            .into());
        }
        let body = match response.body(deadline) {
            Ok(body) => body,
            Err(Fail::Timeout) => return Err(late()),
            Err(Fail::Net(text)) => {
                return Err(CheckError {
                    code: None,
                    message: text,
                });
            }
        };
        let payload: Value = serde_json::from_slice(&body).map_err(|e| CheckError {
            code: None,
            message: e.to_string(),
        })?;
        let picked = release::pick_release(&payload, prerelease)?;
        Ok(release::resolve_platform_release(
            &picked,
            Platform::current(),
        )?)
    }

    /// electron-updater's `update-available`: what to fetch, and the background download where it is automatic.
    fn found(&self, release: PlatformRelease) {
        let (current, mode) = {
            let s = self.lock();
            (s.version.clone(), s.mode)
        };
        let version = release.version.clone();
        self.log("check", json!({ "event": "found", "version": version, "current": current, "mode": mode.as_str() }));
        {
            let mut s = self.lock();
            // The transfer in flight keeps its asset and version.
            if s.transfer {
                return;
            }
            s.active_version = Some(version.clone());
            // A re-check of the release already staged does not fetch it again.
            let staged_here = s
                .staged_app
                .as_ref()
                .is_some_and(|(_, staged)| *staged == version);
            if mode == Mode::Relaunch && staged_here {
                drop(s);
                return self.broadcast(Status::Downloaded {
                    version,
                    mode: Mode::Relaunch,
                });
            }
            s.asset = None;
            s.installer = None;
            s.staged_app = None;
        }
        let name = match mode {
            Mode::Automatic => release.file.name.clone(),
            Mode::Manual | Mode::Relaunch => {
                // Only Apple Silicon builds ship; an Intel Mac has no installer to fetch.
                if !cfg!(target_arch = "aarch64") {
                    return self.broadcast(Status::Error {
                        key: "updates.unsupportedArchitecture".into(),
                        suffix: None,
                        detail: None,
                        show_in_banner: None,
                    });
                }
                rules::mac_download_name(&version)
            }
        };
        self.lock().asset = Some(Asset {
            name,
            url: release.asset_url.clone(),
            sha512: release.file.sha512.clone(),
            size: release.file.size,
        });
        self.broadcast(Status::Available {
            version: version.clone(),
            notes: Some(rules::notes_excerpt(&release.notes)),
            mode,
        });
        // Downloads start at once in the background (the only prompt is "Restart & install"); the manual DMG waits for
        // a click. Failures stay out of the banner like any passive check.
        let service = super::service();
        match mode {
            Mode::Automatic => {
                std::thread::spawn(move || {
                    if let Err(failure) = service.windows_download(&version) {
                        service.broadcast(failure.status("updates.failed", false));
                    }
                });
            }
            Mode::Relaunch => {
                std::thread::spawn(move || {
                    if let Err(failure) = service.mac_download(&version, Mode::Relaunch) {
                        service.broadcast(failure.status("updates.downloadFailed", false));
                    }
                });
            }
            Mode::Manual => {}
        }
    }

    // ---------------------------------------------------------------- download

    /// `updater.download`: the update an `available` status names.
    pub fn download(&self) -> Value {
        let (go, mode, version) = {
            let s = self.lock();
            let version = match &s.status {
                Status::Available { version, .. } => {
                    Some(s.active_version.clone().unwrap_or_else(|| version.clone()))
                }
                _ => None,
            };
            (
                version.is_some() && !s.transfer,
                s.mode,
                version.unwrap_or_default(),
            )
        };
        if go {
            let outcome = match mode {
                Mode::Automatic => self.windows_download(&version),
                Mode::Manual | Mode::Relaunch => {
                    if self.lock().asset.is_none() {
                        Err(Failure::own("updates.installerMissing"))
                    } else {
                        self.mac_download(&version, mode)
                    }
                }
            };
            if let Err(failure) = outcome {
                self.broadcast(failure.status("updates.downloadFailed", true));
            }
        }
        self.state()
    }

    /// Takes the one transfer slot: a second one would append to the same `.partial`.
    fn take_transfer(&self) -> bool {
        let mut s = self.lock();
        !std::mem::replace(&mut s.transfer, true)
    }

    fn end_transfer(&self) {
        self.lock().transfer = false;
    }

    fn mac_download(&self, version: &str, mode: Mode) -> Result<(), Failure> {
        if !self.take_transfer() {
            return Ok(());
        }
        let asset = self.lock().asset.clone();
        let outcome = (|| {
            let asset = asset
                .clone()
                .ok_or(Failure::own("updates.installerMissing"))?;
            self.broadcast(Status::Downloading {
                version: version.into(),
                mode,
                percent: 0,
            });
            let started = Instant::now();
            self.log("download", json!({ "event": "started", "version": version, "mode": mode.as_str(), "bytes": asset.size }));
            match self.mac_transfer(version, mode, &asset) {
                Ok(()) => {
                    // The SHA-512 matched and, for the relaunch mode, the bundle is staged and verified.
                    self.log("download", json!({ "event": "verified", "version": version, "mode": mode.as_str(),
                                                 "bytes": asset.size, "ms": started.elapsed().as_millis() as u64 }));
                    Ok(())
                }
                Err(failure) => {
                    self.log(
                        "download",
                        json!({ "event": "failed", "version": version, "mode": mode.as_str(),
                                                 "reason": self.scrub(&failure.text()) }),
                    );
                    Err(failure)
                }
            }
        })();
        self.end_transfer();
        outcome
    }

    fn scrub(&self, text: &str) -> String {
        let token = self.lock().token.clone();
        rules::cut_secrets(text, &[token.as_deref()])
    }

    fn mac_transfer(&self, version: &str, mode: Mode, asset: &Asset) -> Result<(), Failure> {
        let io = |e: std::io::Error| Failure::Raw(e.to_string());
        let updates = self.updates_dir();
        // Manual installers land in Downloads for Finder; relaunch DMGs are private staging.
        if mode == Mode::Relaunch {
            std::fs::create_dir_all(&updates).map_err(io)?;
        }
        let destination = if mode == Mode::Manual {
            available_download_path(&self.places.downloads, &asset.name)
        } else {
            updates.join(&asset.name)
        };
        let partial = PathBuf::from(rules::partial_path(&destination.to_string_lossy()));
        let url = self.signed_asset_url(&asset.url)?;
        // Partials of releases this one superseded can never be continued.
        if mode == Mode::Manual {
            if let Some(dir) = partial.parent() {
                sweep_partials(dir, partial.file_name().and_then(|n| n.to_str()));
            }
        } else {
            sweep_dir(
                &updates,
                &[&asset.name, &rules::partial_path(&asset.name), "swap.log"],
            );
        }
        self.transfer_to(&url, &partial, asset, version, mode)?;
        std::fs::rename(&partial, &destination).map_err(io)?;
        if mode == Mode::Relaunch {
            let own = self
                .lock()
                .own_bundle
                .clone()
                .ok_or(Failure::own("updates.installerMissing"))?;
            let staged = platform::stage_bundle(
                &destination,
                &updates.join(version),
                &std::env::temp_dir(),
                version,
                &own,
            )
            .map_err(|error| match error {
                StageError::Missing => Failure::own("updates.installerMissing"),
                StageError::Verify => Failure::own("updates.hashMismatch"),
                StageError::Mount => Failure::own_with("updates.downloadFailed", "mount"),
                StageError::Copy => Failure::own_with("updates.downloadFailed", "copy"),
                StageError::Io(text) => Failure::Raw(text),
            })?;
            let _ = std::fs::remove_file(&destination);
            self.lock().staged_app = Some((staged, version.to_string()));
            self.broadcast(Status::Downloaded {
                version: version.into(),
                mode,
            });
            return Ok(());
        }
        self.lock().installer = Some(destination.clone());
        // e2e and headless runs verify the download but never put Finder on screen.
        if env("OMP_GUI_HEADLESS").as_deref() != Some("1") {
            platform::open_installer(&destination)
                .map_err(|_| Failure::own("updates.openInstallerFailed"))?;
        }
        self.broadcast(Status::Downloaded {
            version: version.into(),
            mode,
        });
        Ok(())
    }

    fn windows_download(&self, version: &str) -> Result<(), Failure> {
        if !self.take_transfer() {
            return Ok(());
        }
        let asset = self.lock().asset.clone();
        let started = Instant::now();
        self.log(
            "download",
            json!({ "event": "started", "version": version, "mode": "nsis" }),
        );
        let outcome = asset
            .ok_or(Failure::own("updates.installerMissing"))
            .and_then(|asset| {
                self.windows_transfer(version, &asset)
                    .map(|installer| (installer, asset.size))
            });
        self.end_transfer();
        match outcome {
            Ok((installer, bytes)) => {
                self.lock().installer = Some(installer);
                self.log("download", json!({ "event": "verified", "version": version, "mode": "nsis",
                                             "bytes": bytes, "ms": started.elapsed().as_millis() as u64 }));
                self.broadcast(Status::Downloaded {
                    version: version.into(),
                    mode: Mode::Automatic,
                });
                Ok(())
            }
            Err(failure) => {
                self.log("download", json!({ "event": "failed", "mode": "nsis", "reason": self.scrub(&failure.text()) }));
                Err(failure)
            }
        }
    }

    /// The Windows installer in electron-updater's cache (`<LOCALAPPDATA>/ompdesk-updater/pending/`): one whose SHA-512
    /// matches is used as it is, else it is downloaded (resuming a partial) and `update-info.json` is written.
    fn windows_transfer(&self, version: &str, asset: &Asset) -> Result<PathBuf, Failure> {
        let io = |e: std::io::Error| Failure::Raw(e.to_string());
        let local = env("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                env("USERPROFILE").map(|home| PathBuf::from(home).join("AppData").join("Local"))
            })
            .ok_or_else(|| Failure::Raw("no LOCALAPPDATA".into()))?;
        let pending = local.join(WINDOWS_CACHE).join("pending");
        std::fs::create_dir_all(&pending).map_err(io)?;
        let installer = pending.join(&asset.name);
        let info = pending.join("update-info.json");
        let cached = std::fs::read(&info)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| value["sha512"] == asset.sha512);
        if cached && sha512_base64(&installer).is_ok_and(|hash| hash == asset.sha512) {
            return Ok(installer);
        }
        let partial_name = rules::partial_path(&asset.name);
        sweep_dir(&pending, &[&asset.name, &partial_name]);
        let _ = std::fs::remove_file(&installer);
        let url = self.signed_asset_url(&asset.url)?;
        let partial = pending.join(&partial_name);
        self.transfer_to(&url, &partial, asset, version, Mode::Automatic)?;
        std::fs::rename(&partial, &installer).map_err(io)?;
        let record = json!({ "fileName": asset.name, "sha512": asset.sha512, "isAdminRightsRequired": false });
        std::fs::write(&info, record.to_string()).map_err(io)?;
        Ok(installer)
    }

    /// The signed CDN URL of a release asset: the API asset endpoint answers `application/octet-stream` with a redirect
    /// to a short-lived signed URL (a private repo 404s on `releases/download/...`, so this one path serves both). The
    /// redirect is taken by hand, so an Authorization header never reaches the CDN, which rejects a second mechanism.
    fn signed_asset_url(&self, api_url: &str) -> Result<String, Failure> {
        let token = self.lock().token.clone();
        let headers = rules::github_api_headers(token.as_deref(), Some("application/octet-stream"));
        let response = fetch::get(api_url, &headers, Redirect::Manual, true, IDLE).map_err(net)?;
        match response.header("location") {
            Some(location) if (300..400).contains(&response.status) => Ok(location.to_string()),
            _ => Err(Failure::own_with("updates.downloadFailed", response.status)),
        }
    }

    /// Streams `url` into `partial`, continuing what is there when the server honours the range, then checks its
    /// SHA-512. Every step gets the idle timeout: a stalled transfer fails as retryable and keeps its bytes.
    fn transfer_to(
        &self,
        url: &str,
        partial: &Path,
        asset: &Asset,
        version: &str,
        mode: Mode,
    ) -> Result<(), Failure> {
        let io = |e: std::io::Error| Failure::Raw(e.to_string());
        let mut existing = file_size(partial);
        if existing > asset.size {
            let _ = std::fs::remove_file(partial);
            existing = 0;
        }
        let mut headers = Vec::new();
        if existing > 0 {
            headers.push(("range".to_string(), format!("bytes={existing}-")));
        }
        // `no-store`: a 100 MB installer in Chromium's disk cache is dead weight.
        let mut response = fetch::get(url, &headers, Redirect::Follow, true, IDLE).map_err(net)?;
        let plan =
            rules::plan_transfer(existing, response.status, response.header("content-range"));
        if !(200..300).contains(&response.status) {
            // A 416 means the offset is past the release's bytes: the partial could never complete.
            if response.status == 416 {
                let _ = std::fs::remove_file(partial);
            }
            return Err(Failure::own_with("updates.downloadFailed", response.status));
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(plan.append)
            .truncate(!plan.append)
            .open(partial)
            .map_err(io)?;
        let total = asset.size;
        let mut transferred = plan.offset;
        let mut last_progress: Option<Instant> = None;
        while let Some(chunk) = response.next(IDLE).map_err(net)? {
            file.write_all(&chunk).map_err(io)?;
            transferred += chunk.len() as u64;
            let due = last_progress.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL);
            if due || (total > 0 && transferred == total) {
                let percent = if total > 0 {
                    ((transferred as f64 / total as f64) * 100.0)
                        .round()
                        .min(100.0) as u32
                } else {
                    0
                };
                self.broadcast(Status::Downloading {
                    version: version.into(),
                    mode,
                    percent,
                });
                last_progress = Some(Instant::now());
            }
        }
        file.sync_all().map_err(io)?;
        drop(file);
        if sha512_base64(partial).map_err(io)? != asset.sha512 {
            let _ = std::fs::remove_file(partial);
            return Err(Failure::own("updates.hashMismatch"));
        }
        Ok(())
    }

    // ---------------------------------------------------------------- install

    /// `updater.install`: Node began the install and shows it; this starts what the mode needs and says how Node quits.
    pub fn install(&self, trigger: &str, presence: Option<&str>) -> Value {
        let none = json!({ "then": "none" });
        let (mode, installer, ready, dry) = {
            let s = self.lock();
            if !matches!(s.status, Status::Downloaded { .. }) || s.install_started {
                return none;
            }
            (
                s.mode,
                s.installer.clone(),
                s.staged_app.is_some() && s.own_bundle.is_some(),
                s.dev_dry_install,
            )
        };
        let missing =
            || Failure::own("updates.installerMissing").status("updates.installerMissing", true);
        match mode {
            Mode::Manual => {
                match installer {
                    None => self.broadcast(missing()),
                    Some(file) => {
                        if platform::open_installer(&file).is_err() {
                            self.broadcast(
                                Failure::own("updates.openInstallerFailed")
                                    .status("updates.openInstallerFailed", true),
                            );
                        }
                    }
                }
                none
            }
            Mode::Relaunch => {
                if !ready {
                    self.broadcast(missing());
                    return none;
                }
                let mut s = self.lock();
                s.relaunch_after_swap = true;
                s.install_started = true;
                json!({ "then": "quit" })
            }
            Mode::Automatic if dry => {
                self.lock().install_started = true;
                json!({ "then": "quit" })
            }
            Mode::Automatic => {
                let Some(installer) = installer else {
                    self.broadcast(
                        Failure::Raw("No update filepath provided, can't quit and install".into())
                            .status("updates.failed", false),
                    );
                    return none;
                };
                self.lock().install_started = true;
                self.note_helper("nsis", trigger, presence, Map::new());
                // Started off the reader thread (Defender scans a fresh unsigned setup inside `CreateProcess`); the quit
                // follows once the attempt ended, started or not.
                if let Err(error) =
                    platform::start_installer(&installer, &["--updated", "--force-run"])
                {
                    self.broadcast(Failure::Raw(error.to_string()).status("updates.failed", false));
                }
                json!({ "then": "quit-for-update" })
            }
        }
    }

    /// `updater.quit`: an approved quit with an update downloaded installs it, though nothing asked.
    pub fn quit(&self, trigger: &str, presence: Option<&str>) {
        let mut s = self.lock();
        match s.mode {
            Mode::Relaunch => {
                let (Some((staged, expected)), Some(own)) =
                    (s.staged_app.clone(), s.own_bundle.clone())
                else {
                    return;
                };
                if s.swap_launched {
                    return;
                }
                s.swap_launched = true;
                let relaunch = s.relaunch_after_swap;
                drop(s);
                let mut extra = Map::new();
                extra.insert("relaunch".into(), json!(relaunch));
                self.note_helper("relaunch", trigger, presence, extra);
                // What the reopened app is launched with: the shell's own arguments.
                let args: Vec<String> = self.places.argv.iter().skip(1).cloned().collect();
                let log = self.updates_dir().join("swap.log");
                let _ = std::fs::create_dir_all(self.updates_dir());
                // The start mark the helper waits for after it reopened the new app (Node writes it, `noteAppStarted`).
                let mark = self.places.user_data.join("app-started.json");
                if let Err(error) =
                    platform::launch_swap(&staged, &own, relaunch, &log, &mark, &expected, &args)
                {
                    self.log("swap", json!({ "event": "failed", "mode": "relaunch", "reason": error.to_string() }));
                }
            }
            Mode::Automatic => {
                if s.install_started || !matches!(s.status, Status::Downloaded { .. }) {
                    return;
                }
                s.install_started = true;
                let installer = (!s.dev_dry_install).then(|| s.installer.clone()).flatten();
                drop(s);
                self.note_helper("nsis", trigger, presence, Map::new());
                if let Some(installer) = installer {
                    // The install at quit runs silently and must start before the shell is gone: `shutdown` joins it.
                    let handle = std::thread::spawn(move || {
                        let _ = platform::start_installer(&installer, &["--updated", "/S"]);
                    });
                    self.lock().helpers.push(handle);
                }
            }
            Mode::Manual => {}
        }
    }

    /// The install's helper starts: one line, and the marker the next launch reports from.
    fn note_helper(
        &self,
        mode: &str,
        trigger: &str,
        presence: Option<&str>,
        extra: Map<String, Value>,
    ) {
        let (from, to) = {
            let s = self.lock();
            let to = match &s.status {
                Status::Downloaded { version, .. } => version.clone(),
                _ => "unknown".into(),
            };
            (s.version.clone(), to)
        };
        let mut pending =
            json!({ "from": from, "to": to, "mode": mode, "trigger": trigger, "at": now_ms() });
        let mut line =
            json!({ "event": "helper", "mode": mode, "from": from, "to": to, "trigger": trigger });
        if let Some(presence) = presence {
            pending["presence"] = json!(presence);
            line["presence"] = json!(presence);
        }
        for (key, value) in extra {
            line[key] = value;
        }
        let _ = std::fs::write(
            self.places.user_data.join("update-install.json"),
            pending.to_string(),
        );
        self.log("swap", line);
    }

    /// The app exits: the installer started at quit must exist before the shell is gone.
    pub fn shutdown(&self) {
        let helpers = std::mem::take(&mut self.lock().helpers);
        for helper in helpers {
            let _ = helper.join();
        }
    }
}

/// A free name in Downloads: `name`, then `stem (2).ext`, …
fn available_download_path(downloads: &Path, name: &str) -> PathBuf {
    let (stem, extension) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut candidate = downloads.join(name);
    let mut suffix = 2;
    while candidate.exists() {
        candidate = downloads.join(format!("{stem} ({suffix}){extension}"));
        suffix += 1;
    }
    candidate
}

/// Installer debris in Downloads (`rules::sweeps`); everything else there is the person's.
fn sweep_partials(directory: &Path, active: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if rules::sweeps(&name, active) {
            // Still open by a racing transfer: the next launch retries.
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Drops what a private folder holds but `keep`: one stubborn leftover never blocks the download replacing it.
fn sweep_dir(directory: &Path, keep: &[&str]) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}
