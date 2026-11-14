//! A run's commands and its start (was `handleCommand`, `status`, `#action`, `#start`, `#adopt` and what they read of git in
//! `src/main/autopilot.ts`): what a window or a paired device asks of a tab, and the run that becomes of a start.

use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::audit;
use super::branches::{self, Choice, Entry, Mode};
use super::coordinator::{CommandParams, Contracts, Coordinator, Source, locked};
use super::run::{Run, RunState, Settings, Title};
use super::util::{Oops, R, flag, oops, text};
use crate::fs::order::js_trim;
use crate::git::read::resolve;
use crate::git::run::Git;
use crate::run::Opts;

const GIT_MS: u64 = 30_000;
const WORKTREE_MS: u64 = 960_000;
/// Start's guide is at most one model request (the bridge gives it 20 s, plus reading the repo and gh): longer than the
/// default 8 s RPC wait.
const GUIDE_MS: u64 = 45_000;

/// The message a "Release" button press sends as the user's own words (the bridge's `ship` checks a real user message).
pub const RELEASE_NOW_MESSAGE: &str = "Release now: finish the item in progress, start nothing new, then run this repository's release procedure.";
/// What the next cycle's `begin` hands the agent when the person chooses "ship, then stop" (English, like every note).
pub const STOP_AFTER_SHIP_NOTE: &str = "The person chose to ship, then stop: finish this cycle's item and commit it (a green cycle lands as usual). Then call autopilot propose_release; if a release is due, run the release procedure in this cycle. End the cycle with `end` as usual: the run stops after it.";

/// The title the run's session gets from a cycle's item (`runSessionTitle`).
const TITLE_ITEM_MAX: usize = 40;

/// The run's session title: the repository's folder name from the moment the run starts, then the item of the cycle at work,
/// renamed as each cycle picks its own. No "Autopilot" word: the row's rocket mark and the title bar's say it is a run (the
/// user's call, 23 Oct 2026).
pub fn run_session_title(what: &str) -> String {
    let squeezed = what
        .split(crate::fs::order::is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let units: Vec<u16> = squeezed.encode_utf16().collect();
    if units.len() > TITLE_ITEM_MAX {
        let cut = String::from_utf16_lossy(&units[..TITLE_ITEM_MAX - 1]);
        format!("{}…", cut.trim_end_matches(crate::fs::order::is_js_space))
    } else {
        squeezed
    }
}

/// Whether a run this process adopts (a relaunch) may go on naming its session: the name is one the run gave it (its
/// folder, a cycle's item, an earlier build's "Autopilot · …") or none. A name the person typed is theirs: never this.
pub fn run_owns_title(name: &str, folders: &[String], items: &[String]) -> bool {
    let shown = js_trim(name);
    if shown.is_empty() || shown.starts_with("Autopilot · ") || shown.starts_with("오토파일럿 · ")
    {
        return true;
    }
    folders
        .iter()
        .chain(items)
        .any(|what| !js_trim(what).is_empty() && run_session_title(what) == shown)
}

fn basename(path: &str) -> String {
    std::path::Path::new(path.trim_end_matches(['/', '\\']))
        .file_name()
        .map_or_else(
            || path.to_owned(),
            |name| name.to_string_lossy().into_owned(),
        )
}

fn slow() -> Opts<'static> {
    Opts {
        timeout_ms: Some(GIT_MS),
        ..Opts::default()
    }
}

/// git's stdout trimmed when it exited 0, else nothing (a git that cannot answer is no answer).
pub async fn git_text(git: &Git, cwd: &str, args: &[&str]) -> String {
    match git.run(cwd, args, slow()).await {
        Ok(output) if output.code == 0 => js_trim(&output.text()).to_owned(),
        _ => String::new(),
    }
}

impl RunState {
    /// A run that has just begun.
    pub fn begin(info: NewRun) -> RunState {
        RunState {
            run: info.run,
            root: info.root,
            branch: info.branch,
            base_branch: info.base_branch,
            checkout_root: info.checkout_root,
            target: info.target,
            settings: info.settings,
            status: None,
            snapshot: None,
            expected_refs: Vec::new(),
            checkout_may_move: false,
            config_may_change: false,
            release_requested: false,
            release_procedure: info.release_procedure,
            release_blocked: info.release_blocked,
            land_to: info.land_to,
            landing: None,
            landed_count: 0,
            end_after_ship: None,
            ship_stop_waits_release: false,
            release_owed: false,
            children: Vec::new(),
            child_branches: BTreeSet::new(),
            stopping: false,
            next_nudge_at: 0,
            nudge_later: false,
            quota_wake: None,
            stalls: Vec::new(),
            quota_retries: 0,
            refreshing: false,
            refresh_again: false,
            title: None,
            stop_polling: None,
            release_item: None,
            starting: false,
        }
    }
}

pub struct NewRun {
    pub run: String,
    pub root: String,
    pub branch: String,
    pub base_branch: String,
    pub checkout_root: String,
    pub target: Option<String>,
    pub land_to: Option<String>,
    pub settings: Settings,
    pub release_procedure: Option<Value>,
    pub release_blocked: Option<String>,
}

/// What a start's options and the defaults make of a run's settings. Nothing is stored between runs: shipping nobody
/// chose is decided per repository at the start, notifications are the stops a person must know of.
pub fn start_settings(contracts: &Contracts, options: &Value) -> Value {
    let ship_options = options.get("ship").cloned().unwrap_or(Value::Null);
    let remote = text(&ship_options, "remote").unwrap_or("origin").to_owned();
    let preset = text(options, "preset")
        .and_then(|name| contracts.presets.get(name))
        .unwrap_or(&contracts.default_ship_policy);
    let auto_push = ship_options
        .get("autoPush")
        .and_then(Value::as_bool)
        .or_else(|| preset.get("autoPush").and_then(Value::as_bool))
        .unwrap_or(false);
    let auto_release = ship_options
        .get("autoRelease")
        .filter(|release| !release.is_null())
        .or_else(|| preset.get("autoRelease"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut limits = contracts.no_limits.clone();
    if let (Some(base), Some(over)) = (
        limits.as_object_mut(),
        options.get("limits").and_then(Value::as_object),
    ) {
        for (name, value) in over {
            base.insert(name.clone(), value.clone());
        }
    }
    json!({
        "focus": options.get("focus").cloned().unwrap_or_else(|| json!([])),
        "ship": {"autoPush": auto_push, "autoRelease": auto_release, "remote": remote},
        "limits": limits,
    })
}

/// What a command answers: the status as the bridge keeps it, and whether main lays its overlay (the ship queue, the
/// children, what only main knows) and the recent-cycles cut over it.
fn status_answer(status: Value, overlay: bool) -> Value {
    json!({"ok": true, "status": status, "overlay": overlay})
}

impl Coordinator {
    /// The two commands the coordinator answers (`get_autopilot`, `set_autopilot`).
    pub async fn command(self: &Arc<Self>, params: &CommandParams) -> R<Value> {
        match text(&params.command, "type") {
            Some("get_autopilot") => self.status(&params.source, &params.tab).await,
            _ => self.action(params).await,
        }
    }

    /// `get_autopilot`: a run's status, or for any other tab what the start sheet needs.
    async fn status(self: &Arc<Self>, source: &Source, tab: &str) -> R<Value> {
        let run = match self.runs_get(tab) {
            Some(run) => Some(run),
            None => self.adopt(tab).await,
        };
        if let Some(run) = run {
            return Ok(status_answer(self.fetch_status(&run).await?, true));
        }
        let status = self
            .bridge(tab, &self.contracts.bridge.status, json!({}), None)
            .await
            .ok();
        if let Some(status) = status.filter(|status| flag(status, "active")) {
            return Ok(status_answer(status, false));
        }
        Ok(status_answer(self.idle_status(source).await, false))
    }

    async fn action(self: &Arc<Self>, params: &CommandParams) -> R<Value> {
        let command = &params.command;
        let tab = params.tab.as_str();
        let action = text(command, "action").unwrap_or_default().to_owned();
        if action == "start" {
            return self.start(params).await;
        }
        let run = match self.runs_get(tab) {
            Some(run) => Some(run),
            None => self.adopt(tab).await,
        };
        let Some(run) = run else {
            return Err(oops(
                "autopilot_no_run",
                self.text("autopilot.err.noRun", json!({})).await,
            ));
        };
        match action.as_str() {
            "stop" => {
                if run.lock().starting {
                    // The start is still waiting for the tab's omp: nothing is armed to stop yet, the start ends.
                    let wait = locked(&self.start_waits).remove(tab);
                    if let Some(end) = wait {
                        let _ = end.send("Autopilot's start was stopped.".to_owned());
                        return Ok(status_answer(self.idle_status(&params.source).await, false));
                    }
                }
                self.begin_stop(&run, "user").await;
            }
            "stop_after_ship" => {
                self.stop_after_ship(&run, flag(command, "enabled"), params.now)
                    .await?;
            }
            "abort" => {
                self.port.note_stopped(tab);
                self.port.turn_stop(tab, "stop-now", None);
                let _ = self.stock(tab, json!({"type": "abort"})).await;
                self.aborted(tab).await;
            }
            "pause" => {
                self.stock(tab, json!({"type": "set_goal", "action": "pause"}))
                    .await?;
                self.set_state(&run, json!({"state": "paused", "reason": "user_pause"}))
                    .await?;
            }
            "resume" => self.resume(&run).await?,
            "configure" => {
                let mut changes = command.clone();
                if let Some(object) = changes.as_object_mut() {
                    object.remove("type");
                    object.remove("action");
                }
                self.configure(&run, changes).await?;
            }
            "note" => {
                let note = text(command, "text").unwrap_or_default();
                self.bridge(
                    tab,
                    &self.contracts.bridge.note,
                    json!({"text": note}),
                    None,
                )
                .await?;
            }
            "followup_dismiss" => {
                let note = text(command, "text").unwrap_or_default();
                self.bridge(
                    tab,
                    &self.contracts.bridge.dismiss,
                    json!({"text": note}),
                    None,
                )
                .await?;
            }
            "ship" => self.ship_action(&run, command).await?,
            "cancel_ship" => {
                run.ship.cancel(text(command, "id").unwrap_or_default());
            }
            _ => {}
        }
        Ok(status_answer(self.fetch_status(&run).await?, true))
    }

    // ---- start ----------------------------------------------------------------------------------------------

    /// The remote a run ships to when nothing says: `origin`, else the only (first) remote, else `origin` anyway.
    async fn detect_remote(&self, git: &Git, cwd: &str) -> String {
        let names = git_text(git, cwd, &["remote"]).await;
        let names: Vec<&str> = names.split('\n').filter(|name| !name.is_empty()).collect();
        if names.contains(&"origin") {
            "origin".to_owned()
        } else {
            names.first().copied().unwrap_or("origin").to_owned()
        }
    }

    /// Throws the reason a run cannot take `choice` (git's own state, read at the start).
    async fn refuse_branch(&self, choice: &Choice, entries: &[Entry]) -> R<()> {
        let Some(problem) = branches::branch_problem(choice, entries) else {
            return Ok(());
        };
        let branch = choice.name();
        let (key, code) = match problem {
            branches::Problem::Exists => ("autopilot.err.branchExists", "autopilot_branch_exists"),
            branches::Problem::InvalidName => {
                ("autopilot.err.branchInvalid", "autopilot_branch_invalid")
            }
            branches::Problem::Missing => {
                ("autopilot.err.branchMissing", "autopilot_branch_missing")
            }
        };
        Err(oops(code, self.text(key, json!({"branch": branch})).await))
    }

    /// What the start sheet needs of a session that is no run: ship defaults, release facts, the branches.
    async fn idle_status(&self, source: &Source) -> Value {
        let (procedure, blocked) = self.release_for(&source.cwd).await;
        let git = self.git().await.ok();
        let (remote, branches) = match &git {
            Some(git) => {
                // git prints `C:/x` on Windows; the sheet's key and the folders the picker names are native paths.
                let top = git_text(git, &source.cwd, &["rev-parse", "--show-toplevel"]).await;
                let toplevel = if top.is_empty() {
                    top
                } else {
                    resolve("/", &top)
                };
                let remote = self.detect_remote(git, &source.cwd).await;
                let info = if toplevel.is_empty() {
                    None
                } else {
                    Some(branches::read_info(git, &source.cwd, &toplevel, &remote).await)
                };
                (remote, info)
            }
            None => ("origin".to_owned(), None),
        };
        let mut policy = self.contracts.default_ship_policy.clone();
        policy["remote"] = json!(remote);
        let mut ship = json!({"policy": policy, "queue": []});
        if let Some(procedure) = procedure {
            ship["releaseProcedure"] = procedure;
        }
        if let Some(blocked) = blocked {
            ship["releaseBlocked"] = json!(blocked);
        }
        let mut status = json!({"active": false, "ship": ship});
        if let Some(info) = branches {
            status["branches"] = info;
        }
        status
    }

    /// Start's guide from the bridge; none when the bridge cannot build one.
    pub async fn guide_to_commit(
        self: &Arc<Self>,
        tab: String,
        root: String,
        procedure: Option<Value>,
        guide_text: Option<String>,
    ) -> Option<Value> {
        let mut params = json!({"root": root, "procedure": procedure});
        if let Some(given) = guide_text.filter(|given| !js_trim(given).is_empty()) {
            params["text"] = json!(given);
        }
        let guide = self
            .bridge(&tab, &self.contracts.bridge.guide, params, Some(GUIDE_MS))
            .await
            .ok()?;
        text(&guide, "text")
            .is_some_and(|body| !js_trim(body).is_empty())
            .then_some(guide)
    }

    /// Writes Start's guide into the new worktree and commits it as the autopilot branch's first commit; nothing happens
    /// when the worktree's own guide already says the same. Hooks are skipped (a docs-only commit must not be able to stop
    /// the start) and so is signing. The user's own branch is never written.
    async fn commit_guide(&self, git: &Git, root: &str, guide: &str) -> R<()> {
        let body = format!("{}\n", js_trim(guide));
        if body.len() > self.contracts.guide_commit_max_bytes {
            return Err(oops(
                "autopilot_guide_large",
                self.text("autopilot.err.guideTooLarge", json!({})).await,
            ));
        }
        let file = std::path::Path::new(root).join(&self.contracts.guide_file);
        let current = std::fs::read_to_string(&file).ok();
        if current
            .as_deref()
            .is_some_and(|current| format!("{}\n", js_trim(current)) == body)
        {
            return Ok(());
        }
        std::fs::write(&file, &body).map_err(|error| Oops::from(error.to_string()))?;
        let message = if current.is_none() {
            "docs: add AUTOPILOT.md guide"
        } else {
            "docs: update AUTOPILOT.md guide"
        };
        let name = self.contracts.guide_file.as_str();
        let steps: [Vec<&str>; 2] = [
            vec!["add", "--", name],
            vec![
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--no-verify",
                "-m",
                message,
                "--",
                name,
            ],
        ];
        for args in &steps {
            let result = git.run(root, args, slow()).await.ok();
            if result.as_ref().is_none_or(|result| result.code != 0) {
                let why = result
                    .map(|result| js_trim(&result.stderr).to_owned())
                    .filter(|why| !why.is_empty())
                    .unwrap_or_else(|| "git failed".to_owned());
                let lead = self.text("autopilot.err.guideCommit", json!({})).await;
                return Err(oops("autopilot_guide_commit", format!("{lead} {why}")));
            }
        }
        Ok(())
    }

    /// Waits for the tab's omp: no deadline. It ends only when the tab's omp reads `ready`, fails or exits, when the pool
    /// releases the tab, or when the user's Stop arrives while the run is still `starting`.
    async fn ready(&self, tab: &str) -> R<()> {
        let (end, ended) = oneshot::channel::<String>();
        locked(&self.start_waits).insert(tab.to_owned(), end);
        let asked = self.port.ready(tab);
        let outcome = tokio::select! {
            result = asked => result.map(|_| ()).map_err(Oops::from),
            message = ended => {
                self.port.ready_cancel(tab);
                Err(Oops::from(message.unwrap_or_else(|_| "The Autopilot tab is gone.".to_owned())))
            }
        };
        locked(&self.start_waits).remove(tab);
        outcome
    }

    async fn start(self: &Arc<Self>, params: &CommandParams) -> R<Value> {
        let options = &params.command;
        let (tab, source) = (params.tab.as_str(), &params.source);
        let t = |key: &'static str| self.text(key, json!({}));
        if source.device {
            return Err(oops("autopilot_device", t("autopilot.err.device").await));
        }
        let existing = match self.runs_get(tab) {
            Some(run) => Some(run),
            None => self.adopt(tab).await,
        };
        if existing.is_some() {
            return Err(oops("autopilot_running", t("autopilot.err.running").await));
        }
        let cwd = source.cwd.as_str();
        let git = self.git().await?;
        let toplevel = git_text(&git, cwd, &["rev-parse", "--show-toplevel"]).await;
        if toplevel.is_empty()
            || git_text(&git, cwd, &["rev-parse", "--verify", "-q", "HEAD"])
                .await
                .is_empty()
        {
            return Err(oops("autopilot_not_repo", t("autopilot.err.notRepo").await));
        }
        let checkout_branch = git_text(&git, cwd, &["symbolic-ref", "--short", "-q", "HEAD"]).await;
        if checkout_branch.is_empty() {
            return Err(oops(
                "autopilot_detached",
                t("autopilot.err.detached").await,
            ));
        }
        let ship_options = options.get("ship").cloned().unwrap_or(Value::Null);
        let remote_chosen = match text(&ship_options, "remote") {
            Some(remote) => remote.to_owned(),
            None => self.detect_remote(&git, cwd).await,
        };
        let ship_undecided = options.get("preset").is_none_or(Value::is_null)
            && ship_options.get("autoPush").is_none_or(Value::is_null)
            && ship_options.get("autoRelease").is_none_or(Value::is_null);
        let mut with_remote = options.clone();
        with_remote["ship"] = {
            let mut ship = ship_options.clone();
            if !ship.is_object() {
                ship = json!({});
            }
            ship["remote"] = json!(remote_chosen);
            ship
        };
        let mut settings = start_settings(&self.contracts, &with_remote);
        let (checkout_procedure, _) = self.release_for(&toplevel).await;
        let wants_release =
            Settings(settings.clone()).auto_release() || text(options, "preset") == Some("release");
        if wants_release && checkout_procedure.is_none() {
            return Err(oops(
                "autopilot_no_release",
                t("autopilot.err.noRelease").await,
            ));
        }
        // The app owns the guide: the repo's own (an agent's text first), a Release section added from the project's facts
        // when it has none, or a whole one built from them. Built while the worktree is made; committed into it below.
        let guide_work = {
            let this = self.clone();
            let (tab, top, procedure) =
                (tab.to_owned(), toplevel.clone(), checkout_procedure.clone());
            let given = text(options, "guide").map(str::to_owned);
            tokio::spawn(async move { this.guide_to_commit(tab, top, procedure, given).await })
        };

        // The branch is checked now, from git's own state: the sheet's list may be old.
        let date = params.today.as_str();
        let choice = match options.get("branch").filter(|branch| !branch.is_null()) {
            None => Choice::New { name: None },
            Some(branch) => match branches::parse_choice(branch) {
                Some(choice) => choice,
                None => {
                    let message = self
                        .text("autopilot.err.branchInvalid", json!({"branch": ""}))
                        .await;
                    return Err(oops("autopilot_branch_invalid", message));
                }
            },
        };
        let remote = Settings(settings.clone()).remote();
        let (entries, default_branch) = branches::read_entries(&git, cwd, &remote).await;
        self.refuse_branch(&choice, &entries).await?;
        let target = branches::via_work_branch(&choice, &entries);
        // Nobody chose a level: land every green cycle with a commit on the project's default branch (ShipRunner's
        // fast-forward push, never the agent's, never forced; a protected branch gets one pull request instead) when the
        // repository has a remote. Without a known default branch the run's own branch is pushed; without a remote, nothing.
        // Releasing is decided below, from the procedure.
        let has_remote = ship_undecided && !git_text(&git, cwd, &["remote"]).await.is_empty();
        if ship_undecided {
            let land = has_remote && default_branch.is_some();
            let ship = &mut settings["ship"];
            ship["automatic"] = json!(true);
            ship["autoPush"] = json!(has_remote && !land);
            if land {
                ship["land"] = json!(true);
            }
        }
        let mode = branches::worktree_mode_for(&choice, &entries);
        let taken: HashSet<String> = entries.iter().map(|entry| entry.name.clone()).collect();
        // A target another worktree holds (main in the user's folder): work on a branch of our own cut from it.
        let branch_source: Option<Value> = if let Some(target) = &target {
            let local = entries
                .iter()
                .find(|entry| &entry.name == target)
                .is_some_and(|entry| entry.local);
            Some(json!({
                "name": branches::suggest_branch_name(date, &taken),
                "mode": "new",
                "from": if local { target.clone() } else { format!("{remote}/{target}") },
            }))
        } else if let Choice::Existing { name } = &choice {
            let mut value = json!({"name": name, "mode": mode.as_str()});
            if mode == Mode::Remote {
                value["remote"] = json!(remote);
            }
            Some(value)
        } else if !choice.name().is_empty() {
            Some(json!({"name": choice.name(), "mode": mode.as_str()}))
        } else {
            None
        };
        let mut create = json!({
            "type": "worktree_create",
            "name": match &branch_source {
                Some(source) => branches::branch_slug(text(source, "name").unwrap_or_default(), date),
                None => date.to_owned(),
            },
            "baseCwd": cwd,
            "baseRef": "HEAD",
            "branchPrefix": "autopilot/",
        });
        if let Some(source) = branch_source {
            create["branch"] = source;
        }
        let created = self
            .port
            .dispatch(
                params.call,
                params.native_owner.as_ref(),
                tab,
                create,
                WORKTREE_MS,
            )
            .await?;
        if !flag(&created, "success") {
            let message = text(&created, "error").unwrap_or("Creating the worktree failed.");
            return Err(oops("autopilot_failed", message));
        }
        let made = created.get("data").cloned().unwrap_or(Value::Null);
        let (made_path, made_branch, made_base) = (
            text(&made, "path").unwrap_or_default().to_owned(),
            text(&made, "branch").unwrap_or_default().to_owned(),
            text(&made, "baseCwd").unwrap_or_default().to_owned(),
        );
        let guide = guide_work.await.ok().flatten();
        if let Some(guide) = &guide {
            self.commit_guide(&git, &made_path, text(guide, "text").unwrap_or_default())
                .await?;
        }
        // The run's own checkout holds the guide now, so its Release section counts when no rules file names a procedure.
        let (procedure, blocked) = self.release_for(&made_path).await;
        // Nobody chose a level and a procedure says the project releases: the agent releases by it, when it judges the
        // changes worth one (cadence `agent`). No remote: nothing to release to.
        if ship_undecided && has_remote && procedure.is_some() {
            settings["ship"]["autoRelease"]["on"] = json!(true);
        }
        let shown = Settings(settings.clone());
        self.log(&format!(
            "autopilot: guide {}; ship {}, release {}{}",
            match &guide {
                Some(guide) => format!(
                    "{}, release {}, releases {}",
                    text(guide, "source").unwrap_or_default(),
                    text(guide, "release").unwrap_or_default(),
                    guide
                        .get("releases")
                        .map_or("undefined".to_owned(), |value| value.to_string()),
                ),
                None => "unavailable".to_owned(),
            },
            if shown.land() {
                format!("land on {}", default_branch.clone().unwrap_or_default())
            } else {
                format!("push {}", shown.auto_push())
            },
            shown.auto_release(),
            procedure
                .as_ref()
                .and_then(|procedure| text(procedure, "file"))
                .map_or(String::new(), |file| format!(" ({file})")),
        ));
        // The run's own base: the folder's branch, or, on the default branch itself, that branch (a release pushes it).
        let named = target.clone().unwrap_or_else(|| made_branch.clone());
        let base_branch = if Some(&named) == default_branch.as_ref() {
            named
        } else {
            checkout_branch.clone()
        };
        let run_id = branches::run_id_for(&made_branch, date);
        let spawned = self.port.spawn_tab(
            params.call,
            params.native_owner.as_ref(),
            json!({
                "cwd": made_path,
                "worktree": {"name": run_id, "branch": made_branch, "baseCwd": made_base, "path": made_path},
            }),
        ).await?;
        let Some(new_tab) = text(&spawned, "tabId").map(str::to_owned) else {
            return Err(oops(
                "autopilot_failed",
                "The Autopilot tab could not be opened.",
            ));
        };
        let run = self.new_run(
            &new_tab,
            RunState::begin(NewRun {
                run: run_id.clone(),
                root: made_path.clone(),
                branch: made_branch.clone(),
                base_branch: base_branch.clone(),
                checkout_root: made_base.clone(),
                target: target.clone(),
                land_to: shown.land().then(|| default_branch.clone()).flatten(),
                settings: shown.clone(),
                release_procedure: procedure.clone(),
                release_blocked: blocked.clone(),
            }),
        );
        run.lock().starting = true;
        let armed = self
            .arm_new_run(
                &run,
                &new_tab,
                &toplevel,
                &made_path,
                &made_branch,
                &made_base,
                &run_id,
                &base_branch,
                target.as_deref(),
                &settings,
                procedure,
                blocked,
            )
            .await;
        run.lock().starting = false;
        if let Err(error) = armed {
            // The tab stays (its worktree has nothing in it yet); the run does not.
            let _ = self
                .bridge(&new_tab, &self.contracts.bridge.disarm, json!({}), None)
                .await;
            locked(&self.runs).remove(&new_tab);
            self.port.mirror(json!({"tab": new_tab, "gone": true}));
            return Err(error);
        }
        let status = self.fetch_status(&run).await?;
        let mut answer = status_answer(status, true);
        answer["tabId"] = json!(new_tab);
        Ok(answer)
    }

    #[allow(clippy::too_many_arguments)]
    async fn arm_new_run(
        self: &Arc<Self>,
        run: &Arc<Run>,
        new_tab: &str,
        toplevel: &str,
        made_path: &str,
        made_branch: &str,
        made_base: &str,
        run_id: &str,
        base_branch: &str,
        target: Option<&str>,
        settings: &Value,
        procedure: Option<Value>,
        blocked: Option<String>,
    ) -> R<()> {
        self.ready(new_tab).await?;
        self.retitle(run, &basename(toplevel)).await;
        let mut arm = json!({
            "role": "parent",
            "root": made_path,
            "run": run_id,
            "branch": made_branch,
            "baseBranch": base_branch,
            "settings": settings,
        });
        if let Some(target) = target {
            arm["target"] = json!(target);
        }
        if let Some(procedure) = procedure {
            arm["releaseProcedure"] = procedure;
        }
        if let Some(blocked) = blocked {
            arm["releaseBlocked"] = json!(blocked);
        }
        let status = self
            .bridge(new_tab, &self.contracts.bridge.arm, arm, None)
            .await?;
        run.lock().status = Some(status);
        let snapshot = self.snapshot(made_path, made_base).await;
        run.lock().snapshot = snapshot;
        let mut goal = json!({"type": "set_goal", "objective": self.contracts.objective});
        if let Some(tokens) = Settings(settings.clone()).tokens_limit() {
            goal["tokenBudget"] = json!(tokens);
        }
        let response = self.stock_response(new_tab, goal).await?;
        if !flag(&response, "success") {
            let message = text(&response, "error").unwrap_or("The goal could not be created.");
            return Err(Oops::from(message));
        }
        Ok(())
    }

    /// A run the journal knows but this process does not (relaunch, a tab opened from the sidebar).
    pub async fn adopt(self: &Arc<Self>, tab: &str) -> Option<Arc<Run>> {
        if let Some(existing) = self.runs_get(tab) {
            return Some(existing);
        }
        let sidecar = self.sidecar(tab).await?;
        if sidecar.device || sidecar.status != "ready" || locked(&self.child_runs).contains_key(tab)
        {
            return None;
        }
        let status = self
            .bridge(tab, &self.contracts.bridge.status, json!({}), None)
            .await
            .ok()?;
        if !flag(&status, "active") || text(&status, "role") == Some("child") {
            return None;
        }
        let (root, branch) = (
            text(&status, "root")?.to_owned(),
            text(&status, "branch")?.to_owned(),
        );
        let settings = status
            .get("settings")
            .filter(|settings| settings.is_object())?
            .clone();
        if text(&status, "state") == Some("ended") {
            return None;
        }
        if let Some(raced) = self.runs_get(tab) {
            return Some(raced);
        }
        let git = self.git().await.ok()?;
        let checkout_root = self
            .common_checkout(&git, &root)
            .await
            .unwrap_or_else(|| root.clone());
        let (procedure, blocked) = self.release_for(&root).await;
        let shown = Settings(settings);
        let land_to = if shown.land() {
            branches::read_entries(&git, &root, &shown.remote()).await.1
        } else {
            None
        };
        let run = self.new_run(
            tab,
            RunState::begin(NewRun {
                run: text(&status, "run").map_or_else(|| branch.clone(), str::to_owned),
                root: root.clone(),
                branch,
                base_branch: text(&status, "baseBranch").unwrap_or("main").to_owned(),
                checkout_root: checkout_root.clone(),
                target: text(&status, "target").map(str::to_owned),
                land_to,
                settings: shown,
                release_procedure: procedure,
                release_blocked: blocked,
            }),
        );
        run.lock().status = Some(status.clone());
        self.adopt_title(&run, &status, &[checkout_root.clone(), root.clone()])
            .await;
        let snapshot = audit::take_snapshot(&git, &root, Some(&checkout_root))
            .await
            .ok();
        run.lock().snapshot = snapshot;
        let release = status.get("ship").and_then(|ship| ship.get("release"));
        if let Some(release) = release
            && text(release, "state") == Some("pending")
            && let (Some(version), Some(url)) = (text(release, "version"), text(release, "runUrl"))
        {
            self.poll_release(&run, version.to_owned(), url.to_owned());
        }
        Some(run)
    }

    /// The checkout the worktree was cut from: the first entry of `git worktree list` (the primary one).
    async fn common_checkout(&self, git: &Git, root: &str) -> Option<String> {
        let list = git_text(git, root, &["worktree", "list", "--porcelain"]).await;
        list.lines()
            .find_map(|line| line.strip_prefix("worktree "))
            .map(str::to_owned)
    }

    /// A relaunch's run takes over naming its session, from the next cycle, while the name is still the run's own.
    async fn adopt_title(&self, run: &Arc<Run>, status: &Value, folders: &[String]) {
        let Ok(state) = self.stock(&run.tab, json!({"type": "get_state"})).await else {
            return;
        };
        let name = text(&state, "sessionName").unwrap_or_default().to_owned();
        let mut items: Vec<String> = status
            .get("cycles")
            .and_then(Value::as_array)
            .map(|cycles| {
                cycles
                    .iter()
                    .map(|cycle| text(cycle, "title").unwrap_or_default().to_owned())
                    .collect()
            })
            .unwrap_or_default();
        items.push(
            status
                .get("now")
                .and_then(|now| text(now, "title"))
                .unwrap_or_default()
                .to_owned(),
        );
        let names: Vec<String> = folders.iter().map(|folder| basename(folder)).collect();
        if run_owns_title(&name, &names, &items) {
            run.lock().title = Some(Title { name, item: None });
        }
    }

    /// Names the run's session (`run_session_title`); a later rename only replaces the run's own title, never the user's.
    pub async fn retitle(&self, run: &Arc<Run>, what: &str) {
        let name = run_session_title(what);
        let result: R<()> = async {
            let own = run.lock().title.clone();
            if let Some(own) = &own {
                let state = self.stock(&run.tab, json!({"type": "get_state"})).await?;
                if text(&state, "sessionName").unwrap_or_default() != own.name {
                    return Ok(());
                }
            }
            self.stock(&run.tab, json!({"type": "set_session_name", "name": name}))
                .await?;
            run.lock().title = Some(Title {
                name: name.clone(),
                item: own.and_then(|own| own.item),
            });
            Ok(())
        }
        .await;
        if let Err(error) = result {
            self.log(&format!(
                "naming the run's session failed: {}",
                error.message
            ));
        }
    }

    /// The run's title follows the cycle at work: its `pick`, else (a cycle that picked nothing) its record's title.
    pub fn title_by_item(self: &Arc<Self>, run: &Arc<Run>, item: Option<&str>) {
        let Some(item) = item.filter(|item| !js_trim(item).is_empty()) else {
            return;
        };
        {
            let mut state = run.lock();
            let Some(title) = state.title.as_mut() else {
                return;
            };
            if title.item.as_deref() == Some(item) {
                return;
            }
            title.item = Some(item.to_owned());
        }
        let (this, run, item) = (self.clone(), run.clone(), item.to_owned());
        self.track(async move {
            let _turn = run.titling.lock().await;
            this.retitle(&run, &item).await;
        });
    }

    /// The bridge's status frame as main's overlay saw it: what only a frame says reaches the run's copy.
    pub fn status_seen(self: &Arc<Self>, tab: &str, status: &Value) {
        let Some(run) = self.runs_get(tab) else {
            return;
        };
        if !flag(status, "active") {
            return;
        }
        self.remember_status(&run, status);
        let item = status
            .get("now")
            .and_then(|now| text(now, "title"))
            .map(str::to_owned);
        self.title_by_item(&run, item.as_deref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Value {
        serde_json::from_str(include_str!("captured-run.json")).unwrap()
    }

    fn contracts() -> Contracts {
        let constants = &captured()["constants"];
        let mut all = json!({
            "bridge": constants["bridge"],
            "objective": "o",
            "guideFile": "AUTOPILOT.md",
            "guideCommitMaxBytes": 262144,
            "childTag": "autopilot-child",
            "defaultShipPolicy": constants["defaultShipPolicy"],
            "noLimits": constants["noLimits"],
            "presets": constants["presets"],
        });
        all["bridge"]["guide"] = constants["bridge"]["guide"].clone();
        serde_json::from_value(all).expect("the captured contracts read as the core's")
    }

    #[test]
    fn settings_layer_defaults_a_preset_and_the_explicit_values_as_the_typescript_did() {
        let contracts = contracts();
        for case in captured()["settings"].as_array().unwrap() {
            assert_eq!(
                start_settings(&contracts, &case["input"]),
                case["out"],
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn session_titles_and_their_owners_match_the_typescript() {
        let all = captured();
        for case in all["titles"].as_array().unwrap() {
            assert_eq!(
                run_session_title(case["input"].as_str().unwrap()),
                case["out"].as_str().unwrap(),
                "{case}"
            );
        }
        for case in all["owns"].as_array().unwrap() {
            let list = |key: &str| -> Vec<String> {
                case[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| item.as_str().unwrap().to_owned())
                    .collect()
            };
            let out = run_owns_title(
                case["name"].as_str().unwrap(),
                &list("folders"),
                &list("items"),
            );
            assert_eq!(json!(out), case["out"], "{case}");
        }
    }
}
