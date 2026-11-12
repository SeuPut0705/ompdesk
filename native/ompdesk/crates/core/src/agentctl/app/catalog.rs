//! The `ompdesk_app` action registry (was `app-catalog.ts`): everything an agent may do to OMPdesk itself, one
//! `Action` each (id, area, description, argument schema, tier, how to run it). Which tier a call needs and whether it
//! may touch a given preference, stock setting, omp command or IPC channel is decided centrally (`guard.rs`,
//! `channels.rs`, `control.rs`); an action here only says what it wants to do through `Ctx`.
//!
//! The risk table `CHANNELS` (channels.rs) names, per IPC channel, the actions that call it.

use std::collections::HashSet;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::control::{Action, ActionResult, Ctx, Handler, Registry, Run, Undo, refusal, start};
use super::guard::Tier;
use super::ports::AppPorts;
use super::schema::{Args, no_args};
use super::settings::{Kind, Manage, SETTINGS, Setting, setting_action_id};
use super::text::{
    arg, clip, fields, finite, iso_ms, js_number, js_string, now_ms, number_text, records, shown,
    str_arg, text_of,
};
use crate::server::Fault;

const SESSIONS_LIST: &str = "sessions:list";
const SESSIONS_SEARCH: &str = "sessions:search";
const SESSIONS_RENAME: &str = "sessions:rename";
const SESSIONS_DELETE: &str = "sessions:delete";
const SESSIONS_DUMP_BUNDLE: &str = "sessions:dump-bundle";
const HOST_DESKTOP_GET: &str = "host-desktop:get";
const HOST_DESKTOP_UPDATE: &str = "host-desktop:update";
const UPDATER_GET_STATUS: &str = "updater:getStatus";
const UPDATER_CHECK: &str = "updater:check";
const UPDATER_DOWNLOAD: &str = "updater:download";
const UPDATER_APPLY: &str = "updater:apply";
const DISK_CARE_GET_STATE: &str = "disk-care:get-state";
const DISK_CARE_RUN: &str = "disk-care:run";
const APP_QUIT: &str = "app:quit";
const GITHUB_AUTH_REFRESH: &str = "github-auth:refresh";
const GITHUB_AUTH_LOGIN_START: &str = "github-auth:login-start";
const MOBILE_WEB_GET_STATE: &str = "mobile-web:get-state";
const MOBILE_WEB_COMMAND: &str = "mobile-web:command";
const WEB_DEVICES_LIST: &str = "mobile-web:devices-list";
const WEB_DEVICES_RENAME: &str = "mobile-web:devices-rename";
const WEB_BLOCKS_LIST: &str = "mobile-web:blocks-list";
const WEB_BLOCKS_REMOVE: &str = "mobile-web:blocks-remove";
const AI_MEMORY_PURGE: &str = "ai-memory:purge";
const AI_MEMORY_DELETE_PAGE: &str = "ai-memory:delete-page";
const AI_MEMORY_SWEEP: &str = "ai-memory:sweep";
const AI_MEMORY_SET_TERMINAL: &str = "ai-memory:set-terminal";
const REMOTE_WATCH_TAILNET: &str = "remote:watch-tailnet";
const REMOTE_CONNECT: &str = "remote:connect";
const REMOTE_BLOCK_PEER: &str = "remote:block-peer";
const REMOTE_GET_STATE: &str = "remote:get-state";
const REMOTE_SET_DEVICE_NAME: &str = "remote:set-device-name";
const REMOTE_RENAME_HOST: &str = "remote:rename-host";
const REMOTE_RENAME_PEER: &str = "remote:rename-peer";
const SIDEBAR_PROJECTS_COMMAND: &str = "sidebar-projects:command";

/// The side panel's views an agent may open (the renderer's `PANEL_TABS`; a test keeps them equal).
pub const PANEL_TABS: [&str; 4] = ["terminal", "diff", "preview", "files"];
/// The session views an agent may open as a sheet (the renderer's `VIEW_SHEETS`; a test keeps them equal).
pub const VIEW_SHEETS: [&str; 5] = ["jobs", "plan", "logs", "tree", "work"];
pub const SETTINGS_SECTIONS: [&str; 13] = [
    "general",
    "appearance",
    "keyboard",
    "models",
    "agent",
    "memory",
    "tools",
    "permissions",
    "workspace",
    "schedules",
    "connections",
    "updates",
    "advanced",
];

/// How long `extensions.mcp_sign_in` waits for an early answer (a refusal, a server needing no sign-in).
const MCP_SIGN_IN_EARLY: Duration = Duration::from_millis(3000);
/// What an agent is told after a change to MCP servers: no tab needs a restart.
const MCP_LIVE_NOTE: &str =
    "Every open session picks the change up (a session in a turn when its turn ends), no restart.";
/// Models one provider lists in the default answer; a longer catalog (an aggregator with an account) names how to see the rest.
const MODELS_SHORT_LIST: usize = 40;
/// Past this many matches of an `omp_settings.get` query, the rest are counted, not listed.
const OMP_SETTINGS_SHOWN_MAX: usize = 40;
const SIDEBAR_LIST_MAX: usize = 200;

impl<P> Action<P> {
    fn manage(mut self, manage: Manage) -> Action<P> {
        self.manage = Some(manage);
        self
    }

    fn full_only(mut self, reason: &'static str) -> Action<P> {
        self.full_only = Some(reason);
        self
    }

    fn describe(mut self, describe: fn(&Args) -> String) -> Action<P> {
        self.describe = Some(describe);
        self
    }
}

fn action<P>(
    id: &str,
    area: &str,
    description: &str,
    args: Value,
    tier: Tier,
    run: Handler<P>,
) -> Action<P> {
    Action {
        id: id.into(),
        area: area.into(),
        description: description.into(),
        args,
        tier,
        never_reason: None,
        manage: None,
        full_only: None,
        describe: None,
        run: Some(Run::Handler(run)),
    }
}

fn never_action<P>(id: &str, area: &str, description: &str, reason: &'static str) -> Action<P> {
    Action {
        id: id.into(),
        area: area.into(),
        description: description.into(),
        args: no_args(),
        tier: Tier::Never,
        never_reason: Some(reason),
        manage: None,
        full_only: None,
        describe: None,
        run: None,
    }
}

fn setting_action<P>(row: &'static Setting) -> Action<P> {
    let hint = match (
        row.schema.get("type").and_then(Value::as_str),
        row.schema.get("enum").and_then(Value::as_array),
    ) {
        (Some("string"), Some(options)) => {
            let listed: Vec<&str> = options.iter().filter_map(Value::as_str).collect();
            format!(" One of: {}.", listed.join(", "))
        }
        (Some("boolean"), _) => " true or false.".to_string(),
        _ => String::new(),
    };
    Action {
        id: setting_action_id(row.id),
        area: format!("settings/{}", row.area),
        description: format!("Set \"{}\".{hint}", row.en),
        args: super::schema::object_schema(vec![("value", row.schema.clone())], &["value"]),
        tier: row.tier,
        never_reason: None,
        manage: row.manage,
        full_only: None,
        describe: None,
        run: Some(Run::Setting(row)),
    }
}

/// The registry an agent meets: every action the app offers.
pub fn shipped<P: AppPorts>() -> Registry<P> {
    let mut actions: Vec<Action<P>> = vec![
        action("settings.get", "settings", r##"Read the current value of settings rows (ids as ompdesk_app_list shows after "settings."); all rows when ids is omitted. Secrets are never shown."##, json!({"type":"object","properties":{"ids":{"type":"array","items":{"type":"string","maxLength":100},"maxItems":80}},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_settings_get(ctx, args))),
        action("usage.read", "usage", r##"Provider usage and quota windows of the signed-in accounts (what the Usage view shows): each window under its own label with percent used and reset time, and the account's saved resets. refresh asks the providers now. device reads another computer's accounts."##, json!({"type":"object","properties":{"refresh":{"type":"boolean"},"device":{"type":"string","minLength":1,"maxLength":200,"description":"A paired computer by name or id as ompdesk_sessions lists it, or \"local\"; omit for the omp of your own session."}},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_usage_read(ctx, args))),
        action("models.list", "models", r##"The model role assignments, then the models of the providers that have a signed-in account (each provider's first 40). provider (id), query (words of provider/id) or all: true list whole catalogs, also of the providers without an account (an aggregator's runs to hundreds). device lists another computer's."##, json!({"type":"object","properties":{"provider":{"type":"string","minLength":1,"maxLength":100},"query":{"type":"string","minLength":1,"maxLength":100},"all":{"type":"boolean"},"device":{"type":"string","minLength":1,"maxLength":200,"description":"A paired computer by name or id as ompdesk_sessions lists it, or \"local\"; omit for the omp of your own session."}},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_models_list(ctx, args))),
        action("models.set", "models", r##"Switch this session's model."##, json!({"type":"object","properties":{"provider":{"type":"string","minLength":1,"maxLength":100},"modelId":{"type":"string","minLength":1,"maxLength":200}},"required":["provider","modelId"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_models_set(ctx, args))),
        action("models.set_role", "models", r##"Assign a model to a model role (default, slow, smol, plan, task, ...); omit modelId to clear the role. device sets it in another computer's omp."##, json!({"type":"object","properties":{"role":{"type":"string","minLength":1,"maxLength":60},"modelId":{"type":"string","minLength":1,"maxLength":200},"device":{"type":"string","minLength":1,"maxLength":200,"description":"A paired computer by name or id as ompdesk_sessions lists it, or \"local\"; omit for the omp of your own session."}},"required":["role"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_models_set_role(ctx, args))),
        action("omp_settings.get", "omp", r##"Read stock omp settings (the ones omp itself lists, e.g. retry.fallbackChains, retry.fallbackOn, compaction.thresholdTokens): paths = exact paths, query = words from a path, label or description. device reads another computer's omp. Credentials and the approval, security, memory and computer-use settings are never shown."##, json!({"type":"object","properties":{"paths":{"type":"array","items":{"type":"string","maxLength":200},"maxItems":40},"query":{"type":"string","minLength":1,"maxLength":100},"device":{"type":"string","minLength":1,"maxLength":200,"description":"A paired computer by name or id as ompdesk_sessions lists it, or \"local\"; omit for the omp of your own session."}},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_omp_settings_get(ctx, args))),
        action("omp_settings.set", "omp", r##"Write one stock omp setting by its exact path (find it with omp_settings.get query). value must fit the setting's type (true/false, number, one of its options, a list, or an object for a record such as retry.fallbackChains). device writes another computer's omp. One step back with app.undo. Credentials and the approval, security, memory and computer-use settings are refused."##, json!({"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":200},"value":{"type":"json"},"device":{"type":"string","minLength":1,"maxLength":200,"description":"A paired computer by name or id as ompdesk_sessions lists it, or \"local\"; omit for the omp of your own session."}},"required":["path","value"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_omp_settings_set(ctx, args))),
        action("ui.panel", "ui", r##"Open a side panel view (terminal, diff, preview, files), open a session view as a sheet (jobs = background tasks, plan = the plan document, logs, tree = the session tree, work = the work tree), or close the panel."##, json!({"type":"object","properties":{"tab":{"type":"string","enum":["terminal","diff","preview","files","jobs","plan","logs","tree","work","close"]}},"required":["tab"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_ui_panel(ctx, args))),
        action("ui.settings_open", "ui", r##"Open Settings at a section (for the user to look at or to finish a step only they may do)."##, json!({"type":"object","properties":{"section":{"type":"string","enum":["general","appearance","keyboard","models","agent","memory","tools","permissions","workspace","schedules","connections","updates","advanced"]},"sub":{"type":"string","maxLength":60}},"required":["section"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_ui_settings_open(ctx, args))),
        action("sessions.saved", "sessions", r##"Saved sessions on the computer this session runs on (a paired host's own when it runs there): title, folder, last change, path."##, json!({"type":"object","properties":{"scope":{"type":"string","enum":["local","global"],"description":"local: this folder's sessions; global (default): all."}},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_sessions_saved(ctx, args))),
        action("sessions.search", "sessions", r##"Search the text of saved sessions."##, json!({"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200},"scope":{"type":"string","enum":["local","global"],"description":"local: this folder's sessions; global (default): all."}},"required":["query"],"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_sessions_search(ctx, args))),
        action("sessions.rename", "sessions", r##"Rename a saved session."##, json!({"type":"object","properties":{"sessionPath":{"type":"string","minLength":1,"maxLength":4096,"description":"Session file path (.jsonl) from sessions.saved."},"name":{"type":"string","minLength":1,"maxLength":200}},"required":["sessionPath","name"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sessions_rename(ctx, args))),
        action("sessions.delete", "sessions", r##"Delete a saved session file for good."##, json!({"type":"object","properties":{"sessionPath":{"type":"string","minLength":1,"maxLength":4096,"description":"Session file path (.jsonl) from sessions.saved."}},"required":["sessionPath"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_sessions_delete(ctx, args)))
            .manage(Manage::Always { reason: r##"deleting a saved session is irreversible"##, when: None }),
        action("sessions.dump_bundle", "sessions", r##"Save a diagnostic bundle as a zip file and return its path: stock's /dump archive of an open session plus OMPdesk's own diagnostics text. Anonymized by default (message contents redacted); pass anonymized:false only when the person asked for the raw transcript. Writes to path, else the Downloads folder. Needs the session open in a tab; defaults to this session."##, json!({"type":"object","properties":{"session":{"type":"string","minLength":1,"maxLength":4096,"description":"Session file path (.jsonl) of an open session, from sessions.saved. Default: this session. A session the person hid from agents is refused."},"anonymized":{"type":"boolean","description":"Default true: stock's /dump anon. false: /dump all, the raw transcript."},"path":{"type":"string","minLength":1,"maxLength":4096,"description":"Absolute path of the zip to write (.zip is added when missing). Default: the Downloads folder."}},"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sessions_dump_bundle(ctx, args))),
        action("ui.open_system_privacy", "ui", r##"Open a macOS Privacy & Security pane in System Settings (Accessibility, Screen Recording, ...). It only opens the pane: the person toggles the switch, you cannot. macOS only."##, json!({"type":"object","properties":{"pane":{"type":"string","enum":["accessibility","screen_recording","input_monitoring","automation","full_disk_access","files_and_folders","microphone","camera"]}},"required":["pane"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_ui_open_system_privacy(ctx, args))),
        action("sidebar.projects", "sidebar", r##"The projects listed in the sidebar of the computer this session runs on (a paired host's own when it runs there): folder path, name, and whether the folder is gone; for this computer also its pin and its own name. Use the paths with the other sidebar.* actions."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_sidebar_projects(ctx, args))),
        action("sidebar.add_project", "sidebar", r##"List a folder as a project in the sidebar of the computer this session runs on (the 'Add new project' / open-folder path; a folder removed before comes back). path is absolute. A linked worktree lists its main checkout."##, json!({"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096,"description":"Absolute folder path."}},"required":["path"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sidebar_add_project(ctx, args))),
        action("sidebar.remove_project", "sidebar", r##"Remove projects from the sidebar of the computer this session runs on, as the project menu's Delete does without its 'also delete saved sessions' box ticked. No folder and no session is touched; opening the folder again in OMPdesk lists it again. path or paths must be listed by sidebar.projects: any other path is reported and left alone."##, json!({"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096,"description":"One project folder path."},"paths":{"type":"array","items":{"type":"string","maxLength":4096},"maxItems":50,"description":"Several project folder paths."}},"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sidebar_remove_project(ctx, args))),
        action("sidebar.pin_project", "sidebar", r##"Pin or unpin a project in this computer's sidebar (the project menu's Pin / Unpin; pinned projects stay on top). path must be listed by sidebar.projects."##, json!({"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096,"description":"Project folder path, as sidebar.projects lists it."},"pinned":{"type":"boolean"}},"required":["path","pinned"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sidebar_pin_project(ctx, args))),
        action("sidebar.order_projects", "sidebar", r##"Set the order of projects in this computer's sidebar (what dragging a project does): paths top first, each listed by sidebar.projects. Pinned projects stay above the rest; projects not named keep their place after these."##, json!({"type":"object","properties":{"paths":{"type":"array","items":{"type":"string","maxLength":4096},"maxItems":200}},"required":["paths"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sidebar_order_projects(ctx, args))),
        action("sidebar.rename_project", "sidebar", r##"Give a project its own name in this computer's sidebar (the project menu's Rename; the folder keeps its name). An empty name clears it. path must be listed by sidebar.projects."##, json!({"type":"object","properties":{"path":{"type":"string","minLength":1,"maxLength":4096,"description":"Project folder path, as sidebar.projects lists it."},"name":{"type":"string","minLength":0,"maxLength":120}},"required":["path","name"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sidebar_rename_project(ctx, args))),
        action("sidebar.pin_session", "sidebar", r##"Pin or unpin a saved session in this computer's sidebar (the session menu's Pin / Unpin). sessionPath from sessions.saved."##, json!({"type":"object","properties":{"sessionPath":{"type":"string","minLength":1,"maxLength":4096,"description":"Session file path (.jsonl) from sessions.saved."},"pinned":{"type":"boolean"}},"required":["sessionPath","pinned"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sidebar_pin_session(ctx, args))),
        action("sidebar.archive_sessions", "sidebar", r##"Archive or restore saved sessions in this computer's sidebar (the session menu's Archive / Restore: they leave the lists until restored; no file is touched). sessionPaths from sessions.saved."##, json!({"type":"object","properties":{"sessionPaths":{"type":"array","items":{"type":"string","maxLength":4096},"maxItems":50},"archived":{"type":"boolean"}},"required":["sessionPaths","archived"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_sidebar_archive_sessions(ctx, args))),
        action("updates.status", "updates", r##"The state of OMPdesk's own update (idle, available, downloaded, ...). host: true reads the paired host this session runs on instead of this computer."##, json!({"type":"object","properties":{"host":{"type":"boolean","description":"true: the paired host this session runs on, not this computer. Refused for a session on this computer."}},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_updates_status(ctx, args))),
        action("updates.check", "updates", r##"Check for a new OMPdesk version now (contacts the release server). host: true asks the paired host this session runs on to check its own."##, json!({"type":"object","properties":{"host":{"type":"boolean","description":"true: the paired host this session runs on, not this computer. Refused for a session on this computer."}},"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_updates_check(ctx, args)))
            .manage(Manage::Lifts(r##"only contacts the release server; nothing is downloaded into use or applied (updates.apply asks)"##)),
        action("updates.download", "updates", r##"Download the OMPdesk update that updates.status says is available, on this computer (what the Download button does). It installs nothing: updates.apply does, and always asks."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_updates_download(ctx, args)))
            .manage(Manage::Lifts(r##"only fetches the release the check found; nothing is installed or restarted (updates.apply asks)"##)),
        action("updates.apply", "updates", r##"Install the downloaded OMPdesk update and restart the app (every running turn ends). host: true asks the paired host this session runs on to install and restart its own; it refuses while work runs there."##, json!({"type":"object","properties":{"host":{"type":"boolean","description":"true: the paired host this session runs on, not this computer. Refused for a session on this computer."}},"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_updates_apply(ctx, args)))
            .manage(Manage::Always { reason: r##"installs new code and restarts, ending every running turn"##, when: None })
            .describe(describe_updates_apply),
        action("disk.status", "updates", r##"How much disk OMPdesk uses on this computer (worktrees, sessions, logs, stats, app data, session scratch files, the Bun and npm caches) and what the last disk cleanup freed."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_disk_status(ctx, args))),
        action("disk.clean", "updates", r##"Run disk care now on this computer and wait for it: drops build output and dependencies from worktrees idle 3+ days (the project makes them again) and saves then removes worktrees idle 14+ days (restorable from the Work tree view). Nothing the user could lose is deleted."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_disk_clean(ctx, args))),
        action("app.quit", "app", r##"Quit OMPdesk (every running turn ends)."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_app_quit(ctx, args)))
            .manage(Manage::Always { reason: r##"quitting ends every running turn"##, when: None }),
        action("accounts.github_status", "accounts", r##"Whether GitHub CLI is signed in and as which login."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_accounts_github_status(ctx, args))),
        action("accounts.github_sign_in", "accounts", r##"Start GitHub sign-in. Only starts the existing sign-in flow (a browser page or a code the person completes); it never reads or stores a credential."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_accounts_github_sign_in(ctx, args)))
            .manage(Manage::Always { reason: r##"signing in connects the person's account (a credential)"##, when: None }),
        action("accounts.provider_sign_in", "accounts", r##"Start sign-in for a model provider. Only starts the existing sign-in flow (a browser page or a code the person completes); it never reads or stores a credential."##, json!({"type":"object","properties":{"providerId":{"type":"string","minLength":1,"maxLength":100}},"required":["providerId"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_accounts_provider_sign_in(ctx, args)))
            .manage(Manage::Always { reason: r##"signing in connects the person's account (a credential)"##, when: None }),
        action("mobile_web.status", "mobile_web", r##"Whether the phone page is on and its state (the link is not shown)."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_mobile_web_status(ctx, args))),
        action("mobile_web.set_enabled", "mobile_web", r##"Turn the phone page on or off (it exposes this computer's sessions to the person's tailnet)."##, json!({"type":"object","properties":{"enabled":{"type":"boolean"}},"required":["enabled"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_mobile_web_set_enabled(ctx, args)))
            .manage(Manage::Always { reason: r##"turning it on exposes this computer's sessions on the network (turning it off exposes nothing)"##, when: Some(when_enabled) }),
        action("extensions.install_plugin", "extensions", r##"Install a plugin from a marketplace the person already added (it runs code in every session)."##, json!({"type":"object","properties":{"marketplace":{"type":"string","minLength":1,"maxLength":200},"plugin":{"type":"string","minLength":1,"maxLength":200}},"required":["marketplace","plugin"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_extensions_install_plugin(ctx, args)))
            .manage(Manage::Always { reason: r##"a plugin is arbitrary code that runs in every session"##, when: None }),
        action("memory.purge", "memory", r##"Erase the user's memory for good: every page, handoff and recorded session."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_memory_purge(ctx, args)))
            .manage(Manage::Always { reason: r##"erasing the memory is irreversible"##, when: None }),
        action("memory.delete_page", "memory", r##"Delete one memory page (the Memory page's Restore can bring it back)."##, json!({"type":"object","properties":{"workspace":{"type":"string","minLength":1,"maxLength":200},"project":{"type":"string","minLength":1,"maxLength":200},"path":{"type":"string","minLength":1,"maxLength":500}},"required":["workspace","project","path"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_memory_delete_page(ctx, args)))
            .manage(Manage::Always { reason: r##"deleting a memory page erases the person's data"##, when: None })
            .describe(describe_memory_delete_page),
        action("memory.sweep", "memory", r##"Run the memory retention sweep for one project (evicts pages the aging rules let go)."##, json!({"type":"object","properties":{"workspace":{"type":"string","minLength":1,"maxLength":200},"project":{"type":"string","minLength":1,"maxLength":200}},"required":["workspace","project"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_memory_sweep(ctx, args)))
            .manage(Manage::Always { reason: r##"the sweep evicts memory pages: it erases the person's data"##, when: None }),
        action("app.undo", "app", r##"Undo the last change you made with ompdesk_app, when it had a previous value."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_app_undo(ctx, args))),
        action("agent_power.set", "permissions", r##"Change what agents may do: OMPdesk control tools, full control, managing or approving for other sessions, tool approval mode, memory, engineering mode or computer use. Booleans take on; tools.approvalMode takes mode."##, json!({"type":"object","properties":{"switch":{"type":"string","enum":["agentControl","agentControlFull","agentControlManage","agentControlApprove","pstack","ecc","aiMemoryTerminal","computer.enabled","tools.approvalMode"]},"on":{"type":"boolean"},"mode":{"type":"string","enum":["yolo","write","always-ask-cached","always-ask"]}},"required":["switch"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_agent_power_set(ctx, args)))
            .manage(Manage::Always { reason: r##"these switches bound what every agent may do; only full control lets an agent change them"##, when: None })
            .full_only(r##"These switches bound the agent's own power. Only the person changes them, in Settings, unless they give agents full control of OMPdesk."##),
        never_action("cards.answer", "permissions", r##"Answer an [OMPdesk] confirmation card or a tool approval."##, r##"A card exists to ask the person. ompdesk_session_answer refuses it too."##),
        never_action("credentials.read", "accounts", r##"Read an API key, token, password, proxy credential or the sign-in state of an account."##, r##"Secrets never reach an agent. Use accounts.*_status for who is signed in."##),
        action("extensions.install_mcp", "extensions", r##"Add an MCP server (stdio: it starts a program; http/sse: it reaches a service). The user sees the exact command or url first. No env or headers: secrets are never set by an agent."##, json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":80},"transport":{"type":"string","enum":["stdio","http","sse"]},"command":{"type":"string","minLength":1,"maxLength":500},"args":{"type":"array","items":{"type":"string","maxLength":500},"maxItems":30},"url":{"type":"string","minLength":8,"maxLength":1000},"scope":{"type":"string","enum":["user","project"]}},"required":["name","transport"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_extensions_install_mcp(ctx, args)))
            .manage(Manage::Always { reason: r##"an MCP server is arbitrary code (stdio) or a network reach (http/sse) for every session"##, when: None })
            .describe(describe_extensions_install_mcp),
        action("extensions.mcp_servers", "extensions", r##"List the MCP servers this session's omp knows: connected or not, tool count, whether it needs a sign-in, and why one is off (turned off, found only in another tool's config, …)."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_extensions_mcp_servers(ctx, args))),
        action("extensions.mcp_sign_in", "extensions", r##"Start the sign-in of an MCP server that needs one (OAuth: a browser page the person completes). Once it succeeds the server connects in every open session, no restart. Only starts the existing sign-in flow (a browser page or a code the person completes); it never reads or stores a credential."##, json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":80}},"required":["name"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_extensions_mcp_sign_in(ctx, args)))
            .manage(Manage::Always { reason: r##"signing in connects the person's account (a credential)"##, when: None }),
        action("extensions.mcp_use", "extensions", r##"Use an MCP server that only another tool's user config declares (Codex, Claude Code, Cursor, …; extensions.mcp_servers says 'found in <tool>'): copies that one server's definition into omp's user mcp.json. The tool's other servers, skills and rules stay unused."##, json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":80}},"required":["name"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_extensions_mcp_use(ctx, args)))
            .manage(Manage::Always { reason: r##"an MCP server is arbitrary code (stdio) or a network reach (http/sse) for every session"##, when: None })
            .describe(describe_extensions_mcp_use),
        action("remote.list_tailnet", "connections", r##"List the computers on the person's tailnet as this one sees them (node id, name, login, whether OMPdesk shares it and lets this computer in, and whether this computer already uses it)."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_remote_list_tailnet(ctx, args))),
        action("remote.connect", "connections", r##"Connect this computer to another computer of the tailnet that shares OMPdesk (nodeId from remote.list_tailnet), so sessions can run there."##, json!({"type":"object","properties":{"nodeId":{"type":"string","minLength":1,"maxLength":128}},"required":["nodeId"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_remote_connect(ctx, args)))
            .manage(Manage::Always { reason: r##"connecting gives this computer's sessions a way onto another computer"##, when: None })
            .describe(describe_remote_connect),
        action("remote.block", "connections", r##"Keep a device that uses this computer out for good (deviceId from remote.devices): its Tailscale node is blocked and it is forgotten. Unblock with remote.unblock."##, json!({"type":"object","properties":{"deviceId":{"type":"string","minLength":1,"maxLength":64}},"required":["deviceId"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_remote_block(ctx, args)))
            .manage(Manage::Lifts(r##"it only takes access away, and remote.unblock undoes it"##))
            .describe(describe_remote_block),
        action("remote.unblock", "connections", r##"Let a blocked device (a computer or a phone) connect again while its Tailscale account is allowed, by its block id or name."##, json!({"type":"object","properties":{"block":{"type":"string","minLength":1,"maxLength":200}},"required":["block"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_remote_unblock(ctx, args)))
            .manage(Manage::Always { reason: r##"unblocking lets a device the person kept out reach this computer again"##, when: None })
            .describe(describe_remote_unblock),
        action("remote.set_allowed_users", "connections", r##"Set the Tailscale accounts allowed to use this computer, from other computers and from the phone page alike (logins; this computer's own stays allowed when the list is empty)."##, json!({"type":"object","properties":{"users":{"type":"array","items":{"type":"string","maxLength":200},"maxItems":50}},"required":["users"],"additionalProperties":false}), Tier::Sensitive, |ctx, args| Box::pin(h_remote_set_allowed_users(ctx, args)))
            .manage(Manage::Always { reason: r##"an allowed account can use this computer's sessions from any of its devices"##, when: None })
            .describe(describe_remote_set_allowed_users),
        action("remote.devices", "connections", r##"List this computer's device name, the paired computers it connects to (hosts) and the devices that use it (peers), with ids and online state."##, json!({"type":"object","properties":{},"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_remote_devices(ctx, args))),
        action("remote.rename_this_computer", "connections", r##"Change this computer's device name; every paired computer and device sees it at once."##, json!({"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":64}},"required":["name"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_remote_rename_this_computer(ctx, args))),
        action("remote.rename_host", "connections", r##"Rename a paired computer this one connects to (deviceId from remote.devices): it changes its own device name. It must be online."##, json!({"type":"object","properties":{"deviceId":{"type":"string","minLength":1,"maxLength":64},"name":{"type":"string","minLength":1,"maxLength":64}},"required":["deviceId","name"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_remote_rename_host(ctx, args))),
        action("remote.rename_device", "connections", r##"Rename a device that uses this computer (deviceId from remote.devices): it is asked to rename itself, so it must be connected."##, json!({"type":"object","properties":{"deviceId":{"type":"string","minLength":1,"maxLength":64},"name":{"type":"string","minLength":1,"maxLength":64}},"required":["deviceId","name"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_remote_rename_device(ctx, args))),
        action("mobile_web.rename_device", "mobile_web", r##"Rename a phone or tablet that uses the phone page, by its current name or id."##, json!({"type":"object","properties":{"device":{"type":"string","minLength":1,"maxLength":128},"name":{"type":"string","minLength":1,"maxLength":64}},"required":["device","name"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_mobile_web_rename_device(ctx, args))),
        action("autopilot.status", "autopilot", r##"Read an Autopilot run you started (state, cycle, branch): ompdesk_autopilot status."##, json!({"type":"object","properties":{"session":{"type":"string","minLength":1,"maxLength":200}},"required":["session"],"additionalProperties":false}), Tier::Read, |ctx, args| Box::pin(h_autopilot_status(ctx, args))),
        action("autopilot.start", "autopilot", r##"Start an Autopilot run: ompdesk_autopilot start, with its own confirmation card (commit, push or release) and its folder rules. ship defaults to the user's stored level; device runs it on a paired device (default the device your session runs on)."##, json!({"type":"object","properties":{"folder":{"type":"string","minLength":1,"maxLength":4096},"device":{"type":"string","minLength":1,"maxLength":200},"ship":{"type":"string","enum":["commit","push","release"]}},"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_autopilot_start(ctx, args))),
        action("autopilot.stop", "autopilot", r##"End an Autopilot run after the cycle in flight, or with now: true stop it at once (the turn is aborted and the run paused): ompdesk_autopilot stop."##, json!({"type":"object","properties":{"session":{"type":"string","minLength":1,"maxLength":200},"now":{"type":"boolean"}},"required":["session"],"additionalProperties":false}), Tier::Change, |ctx, args| Box::pin(h_autopilot_stop(ctx, args))),
    ];
    actions.extend(SETTINGS.iter().map(setting_action));
    Registry::new(actions)
}

fn when_enabled(args: &Args) -> bool {
    args.get("enabled") == Some(&Value::Bool(true))
}

fn describe_updates_apply(args: &Args) -> String {
    if args.get("host") == Some(&Value::Bool(true)) {
        "Install the downloaded OMPdesk update on the paired host this session runs on and restart that computer's app (its running turns end)".into()
    } else {
        "Install the downloaded OMPdesk update and restart the app (every running turn ends)."
            .into()
    }
}

fn describe_memory_delete_page(args: &Args) -> String {
    format!(
        "Delete the memory page {} of {}/{}",
        arg(args, "path"),
        arg(args, "workspace"),
        arg(args, "project")
    )
}

fn describe_extensions_install_mcp(args: &Args) -> String {
    let where_to = if args.get("transport").and_then(Value::as_str) == Some("stdio") {
        let mut words = vec![
            args.get("command")
                .map_or(String::new(), |command| js_string(Some(command))),
        ];
        if let Some(Value::Array(list)) = args.get("args") {
            words.extend(list.iter().map(|word| js_string(Some(word))));
        }
        format!("runs: {}", words.join(" "))
    } else {
        format!("connects to: {}", arg(args, "url"))
    };
    let scope = match args.get("scope") {
        None | Some(Value::Null) => "user".to_string(),
        scope => js_string(scope),
    };
    format!(
        "add the MCP server \"{}\" ({}, {scope} scope), which {where_to}",
        arg(args, "name"),
        arg(args, "transport")
    )
}

fn describe_extensions_mcp_use(args: &Args) -> String {
    format!(
        "use the MCP server \"{}\" that another tool's config declares, in every session",
        arg(args, "name")
    )
}

fn describe_remote_connect(args: &Args) -> String {
    format!("connect to the tailnet computer {}", arg(args, "nodeId"))
}

fn describe_remote_block(args: &Args) -> String {
    format!("block the device {}", arg(args, "deviceId"))
}

fn describe_remote_unblock(args: &Args) -> String {
    format!("unblock {}", arg(args, "block"))
}

fn describe_remote_set_allowed_users(args: &Args) -> String {
    let users: Vec<String> = match args.get("users") {
        Some(Value::Array(list)) => list.iter().map(|user| js_string(Some(user))).collect(),
        _ => Vec::new(),
    };
    format!("allow the Tailscale accounts {}", users.join(", "))
}

// ---- reading what the omp and the app answer ------------------------------------------------------------------

fn disk_size(bytes: f64) -> String {
    if bytes >= 1_073_741_824.0 {
        format!("{} GB", to_fixed1(bytes / 1_073_741_824.0))
    } else {
        format!("{} MB", to_fixed1(bytes / 1_048_576.0))
    }
}

/// `Number#toFixed(1)`: a tie takes the larger value, where Rust's format rounds it to even.
fn to_fixed1(number: f64) -> String {
    if !number.is_finite() {
        return if number.is_nan() {
            "NaN".into()
        } else {
            js_number(number)
        };
    }
    let exact = format!("{:.60}", number.abs());
    let Some(dot) = exact.find('.') else {
        return format!("{number:.1}");
    };
    let tail = &exact[dot + 2..];
    let tie = tail.starts_with('5') && tail[1..].bytes().all(|digit| digit == b'0');
    if !tie {
        return format!("{number:.1}");
    }
    let tenths: u128 = exact[..dot].parse::<u128>().unwrap_or(0) * 10
        + u128::from(exact.as_bytes()[dot + 1] - b'0')
        + 1;
    format!(
        "{}{}.{}",
        if number < 0.0 { "-" } else { "" },
        tenths / 10,
        tenths % 10
    )
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn number_of(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// The disk care state as one short report for the agent.
fn disk_text(state: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    match state.get("usage").filter(|usage| truthy(Some(usage))) {
        Some(usage) => {
            let parts: Vec<String> = usage
                .get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|part| {
                    format!(
                        "{} {}",
                        js_string(part.get("id")),
                        disk_size(number_of(part.get("bytes")))
                    )
                })
                .collect();
            lines.push(format!(
                "OMPdesk uses {}: {}.",
                disk_size(number_of(usage.get("total"))),
                parts.join(", ")
            ));
        }
        None => lines.push("Disk use is not measured yet.".into()),
    }
    match state.get("lastRun").filter(|run| truthy(Some(run))) {
        Some(run) => {
            let actions: Vec<String> = run
                .get("actions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|action| {
                    format!(
                        "{} {} ({})",
                        js_string(action.get("kind")),
                        js_string(action.get("count")),
                        disk_size(number_of(action.get("bytes")))
                    )
                })
                .collect();
            let listed = if actions.is_empty() {
                String::new()
            } else {
                format!(": {}", actions.join(", "))
            };
            lines.push(format!(
                "Last cleanup ({}, {}) freed {}{listed}; {} left in place, {} failed.",
                js_string(run.get("trigger")),
                iso_ms(number_of(run.get("endedAt"))),
                disk_size(number_of(run.get("freedBytes"))),
                js_string(run.get("kept")),
                js_string(run.get("failed")),
            ));
        }
        None => lines.push("No cleanup has run yet.".into()),
    }
    if truthy(state.get("running")) {
        lines.push("A cleanup is running now.".into());
    }
    lines.join(" ")
}

fn stock_value(data: &Value, path: &str) -> Option<Value> {
    data.get("values")
        .and_then(Value::as_object)?
        .get(path)
        .cloned()
}

async fn read_stock<P: AppPorts>(ctx: &Ctx<P>, path: &str) -> Result<Option<Value>, Fault> {
    let data = ctx
        .rpc(json!({"type": "get_settings", "paths": [path]}), None)
        .await?;
    Ok(stock_value(&data, path))
}

/// Writes one Settings row as its own control does, and says how to put it back.
pub async fn write_setting<P: AppPorts>(
    ctx: &Ctx<P>,
    row: &'static Setting,
    value: &Value,
) -> Result<ActionResult, Fault> {
    match row.kind {
        Kind::Stock { path } => {
            let previous = read_stock(ctx, path).await?;
            ctx.rpc(
                json!({"type": "set_setting", "path": path, "value": value}),
                None,
            )
            .await?;
            let undo = previous
                .filter(|previous| !previous.is_null())
                .map(|previous| Undo::Setting {
                    path: path.to_string(),
                    value: previous,
                    device: None,
                });
            Ok(ActionResult::changed(
                format!("{} is now {}.", row.en, shown(value)),
                row.en,
                row.ko,
                shown(value),
            )
            .with_undo(undo))
        }
        Kind::Pref { key, redact, .. } => {
            let previous = if redact {
                None
            } else {
                ctx.get_pref(key).await?
            };
            let stored = if value == &json!("") {
                Value::Null
            } else {
                value.clone()
            };
            ctx.set_pref(key, &stored).await?;
            for mirrored in row.mirror_keys() {
                ctx.set_pref(mirrored, &row.mirrored(value)).await?;
            }
            let undo = previous
                .filter(|previous| !previous.is_null())
                .map(|previous| Undo::Pref {
                    key: key.to_string(),
                    value: previous,
                });
            let shown_value = if redact {
                "…".to_string()
            } else {
                shown(value)
            };
            Ok(ActionResult::changed(
                format!(
                    "{} is now {}.",
                    row.en,
                    if redact {
                        "set".to_string()
                    } else {
                        shown(value)
                    }
                ),
                row.en,
                row.ko,
                shown_value,
            )
            .with_undo(undo))
        }
    }
}

fn iso_time(ms: f64) -> String {
    let iso = iso_ms(ms);
    format!("{}Z", &iso[..iso.len() - 5])
}

/// `1d1h`, `5h17m`, `27m`: how long from now, to the minute.
fn span(ms: f64) -> String {
    let minutes = (ms / 60_000.0).floor() as i64;
    if minutes >= 1440 {
        format!("{}d{}h", minutes / 1440, minutes % 1440 / 60)
    } else if minutes >= 60 {
        format!("{}h{}m", minutes / 60, minutes % 60)
    } else if minutes >= 1 {
        format!("{minutes}m")
    } else {
        "<1m".into()
    }
}

/// A moment the agent can use: the absolute time (UTC) and how far from now.
fn when_text(at: f64, now: f64) -> String {
    if at > now {
        format!("{} (in {})", iso_time(at), span(at - now))
    } else {
        format!("{} (passed)", iso_time(at))
    }
}

/// `a || b`: the first that is not empty.
fn first_text<'a>(candidates: &[&'a str]) -> &'a str {
    candidates
        .iter()
        .copied()
        .find(|text| !text.is_empty())
        .unwrap_or("")
}

/// One account's report: its windows each under their own label (the limit's, as `omp usage` names them), then its
/// saved resets.
fn describe_report(report: &Map<String, Value>, now: f64) -> String {
    let limits = records(report.get("limits"));
    let label_of = |limit: &Map<String, Value>| {
        first_text(&[
            text_of(limit.get("label")),
            text_of(limit.get("windowLabel")),
            text_of(limit.get("id")),
            "window",
        ])
        .to_string()
    };
    let mut sharing: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for limit in &limits {
        *sharing.entry(label_of(limit)).or_insert(0) += 1;
    }
    let mut notes: Vec<String> = Vec::new();
    if report.get("active") == Some(&Value::Bool(true)) {
        notes.push("this session's account".into());
    }
    if let Some(until) = finite(report.get("resetAt")) {
        notes.push(format!("limited until {}", when_text(until, now)));
    }
    if let Some(fetched) = finite(report.get("fetchedAt"))
        && now - fetched >= 120_000.0
    {
        notes.push(format!("read {} ago", span(now - fetched)));
    }
    let account = text_of(report.get("account"));
    let mut lines = vec![format!(
        "- {}{}{}",
        first_text(&[text_of(report.get("provider")), "?"]),
        if account.is_empty() {
            String::new()
        } else {
            format!(" ({account})")
        },
        if notes.is_empty() {
            String::new()
        } else {
            format!(" [{}]", notes.join("; "))
        },
    )];
    for limit in &limits {
        let own = label_of(limit);
        let label = if sharing.get(&own).copied().unwrap_or(0) > 1 {
            format!("{own} [{}]", text_of(limit.get("id")))
        } else {
            own
        };
        let used = match finite(limit.get("usedFraction")) {
            None => "n/a".to_string(),
            Some(fraction) => format!("{}% used", js_number((fraction * 100.0 + 0.5).floor())),
        };
        let unit = text_of(limit.get("unit"));
        let amount = if !unit.is_empty() && unit != "percent" && finite(limit.get("used")).is_some()
        {
            let cap = match limit.get("limit") {
                None | Some(Value::Null) => "?".to_string(),
                other => js_string(other),
            };
            format!(" ({}/{cap} {unit})", js_string(limit.get("used")))
        } else {
            String::new()
        };
        let resets = finite(limit.get("resetsAt")).map_or(String::new(), |at| {
            format!(", resets {}", when_text(at, now))
        });
        let status = text_of(limit.get("status"));
        let status = if !status.is_empty() && status != "ok" {
            format!(", {status}")
        } else {
            String::new()
        };
        lines.push(format!("  - {label}: {used}{amount}{resets}{status}"));
    }
    if limits.is_empty() {
        lines.push("  (no windows)".into());
    }
    if report.contains_key("resetPasses") {
        let passes = fields(report.get("resetPasses"));
        let usable = finite(passes.get("usableCount")).unwrap_or(0.0);
        let expires = finite(passes.get("expiresAt"));
        let spend = if usable > 0.0 {
            format!("{} spendable now", js_number(usable))
        } else {
            let reason = text_of(passes.get("unavailableReason"));
            format!(
                "none spendable now{}",
                if reason.is_empty() {
                    String::new()
                } else {
                    format!(": {reason}")
                }
            )
        };
        lines.push(format!(
            "  saved resets: {} ({spend}){}",
            js_number(finite(passes.get("count")).unwrap_or(usable)),
            expires.map_or(String::new(), |at| format!(
                ", soonest expires {}",
                when_text(at, now)
            ))
        ));
    }
    lines.join("\n")
}

fn describe_usage(data: &Value, now: f64) -> String {
    let reports = records(fields(Some(data)).get("reports"));
    if reports.is_empty() {
        return "No provider usage reports yet (no signed-in account reports a quota).".into();
    }
    reports
        .iter()
        .map(|report| describe_report(report, now))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One line per model role: what it really runs on, and how (a fallback, the session's own model, a model that is gone).
fn describe_roles(data: &Value) -> Vec<String> {
    records(fields(Some(data)).get("roles"))
        .iter()
        .map(|role| {
            let effective = fields(role.get("effective"));
            let model = first_text(&[
                text_of(effective.get("model")),
                text_of(role.get("model")),
                "(none)",
            ]);
            let source = text_of(effective.get("source"));
            let via = text_of(effective.get("via"));
            let how = match source {
                "fallback" => format!(
                    "fallback{}",
                    if via.is_empty() {
                        String::new()
                    } else {
                        format!(" via {via}")
                    }
                ),
                "session" => "the session's model".to_string(),
                _ => String::new(),
            };
            let notes: Vec<String> = [
                how,
                if effective.get("unavailable") == Some(&Value::Bool(true)) {
                    "not available".into()
                } else {
                    String::new()
                },
                text_of(effective.get("thinkingLevel")).to_string(),
            ]
            .into_iter()
            .filter(|note| !note.is_empty())
            .collect();
            format!(
                "- {}: {model}{}",
                text_of(role.get("id")),
                if notes.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", notes.join(", "))
                }
            )
        })
        .collect()
}

struct ListedModel {
    provider: String,
    id: String,
}

fn group_by_provider(models: &[&ListedModel]) -> Vec<(String, Vec<String>)> {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for model in models {
        match groups
            .iter_mut()
            .find(|(provider, _)| *provider == model.provider)
        {
            Some((_, rows)) => rows.push(model.id.clone()),
            None => groups.push((model.provider.clone(), vec![model.id.clone()])),
        }
    }
    groups
}

struct ModelFilter {
    provider: String,
    query: String,
    all: bool,
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// The models of `get_providers`, grouped by provider. By default only the providers that have an account (the long
/// catalogs of an aggregator are the bulk), each cut at `MODELS_SHORT_LIST`; `provider`, `query` or `all` list the
/// rest, and the closing lines say what was left out and how to ask for it.
fn describe_models(catalog: &Value, filter: &ModelFilter) -> Vec<String> {
    let data = fields(Some(catalog));
    let providers: std::collections::HashMap<String, &Map<String, Value>> =
        records(data.get("providers"))
            .into_iter()
            .map(|provider| (text_of(provider.get("id")).to_string(), provider))
            .collect();
    let models: Vec<ListedModel> = records(data.get("models"))
        .iter()
        .map(|model| ListedModel {
            provider: text_of(model.get("provider")).to_string(),
            id: text_of(model.get("id")).to_string(),
        })
        .filter(|model| !model.id.is_empty())
        .collect();
    if models.is_empty() {
        return vec!["No models available.".into()];
    }
    let words: Vec<String> = filter
        .query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let wanted = filter.provider.to_lowercase();
    let narrowed = !wanted.is_empty() || !words.is_empty();
    let signed_in = |provider: &str| {
        providers
            .get(provider)
            .is_some_and(|info| info.get("authenticated") == Some(&Value::Bool(true)))
    };
    let every_provider = narrowed || filter.all;
    let listed: Vec<&ListedModel> = models
        .iter()
        .filter(|model| {
            (wanted.is_empty() || model.provider.to_lowercase() == wanted)
                && words.iter().all(|word| {
                    format!("{}/{}", model.provider, model.id)
                        .to_lowercase()
                        .contains(word)
                })
                && (every_provider || signed_in(&model.provider))
        })
        .collect();
    let mut lines: Vec<String> = Vec::new();
    if listed.is_empty() {
        lines.push(if narrowed {
            let mut every: Vec<&str> = Vec::new();
            for model in &models {
                if !every.contains(&model.provider.as_str()) {
                    every.push(&model.provider);
                }
            }
            format!(
                "No model matches{}{}. Providers with models: {}.",
                if wanted.is_empty() {
                    String::new()
                } else {
                    format!(" provider \"{}\"", filter.provider)
                },
                if words.is_empty() {
                    String::new()
                } else {
                    format!(" query \"{}\"", filter.query)
                },
                every.join(", ")
            )
        } else {
            "No signed-in provider has models.".into()
        });
    }
    for (id, rows) in group_by_provider(&listed) {
        let info = providers.get(id.as_str());
        let name = info.map_or("", |info| text_of(info.get("name")));
        let traits: Vec<String> = [
            if !name.is_empty() && name != id {
                name.to_string()
            } else {
                String::new()
            },
            info.map_or("", |info| text_of(info.get("account")))
                .to_string(),
            if signed_in(&id) {
                String::new()
            } else {
                "no account".into()
            },
            if info.is_some_and(|info| info.get("disabled") == Some(&Value::Bool(true))) {
                "disabled".into()
            } else {
                String::new()
            },
            format!("{} model{}", rows.len(), plural(rows.len())),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
        let shown_rows = if every_provider {
            rows.len()
        } else {
            rows.len().min(MODELS_SHORT_LIST)
        };
        lines.push(format!("{id} ({}):", traits.join(", ")));
        lines.extend(
            rows[..shown_rows]
                .iter()
                .map(|model| format!("- {id}/{model}")),
        );
        if shown_rows < rows.len() {
            lines.push(format!(
                "  … {} more of {id}; ask with provider: \"{id}\" or a query.",
                rows.len() - shown_rows
            ));
        }
    }
    if !every_provider {
        let unsigned: Vec<&ListedModel> = models
            .iter()
            .filter(|model| !signed_in(&model.provider))
            .collect();
        let mut left = group_by_provider(&unsigned);
        let count: usize = left.iter().map(|(_, rows)| rows.len()).sum();
        if count > 0 {
            let providers_left = left.len();
            left.sort_by_key(|(_, rows)| std::cmp::Reverse(rows.len()));
            let biggest: Vec<String> = left
                .iter()
                .take(3)
                .map(|(id, rows)| format!("{id} {}", rows.len()))
                .collect();
            lines.push(format!(
                "{count} model{} of {providers_left} provider{} with no signed-in account left out ({}{}); ask with provider, query or all: true.",
                plural(count),
                plural(providers_left),
                biggest.join(", "),
                if providers_left > 3 { ", …" } else { "" }
            ));
        }
    }
    lines
}

fn device_of(args: &Args) -> Option<&str> {
    str_arg(args, "device")
}

/// `path: value (type or options, default) label`: what an agent needs to read a setting and write it back.
fn omp_setting_line(entry: &Map<String, Value>, value: Option<&Value>) -> String {
    let options = if entry.get("type").and_then(Value::as_str) == Some("enum") {
        entry
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .map(|option| js_string(option.get("value")))
                    .collect::<Vec<_>>()
                    .join("|")
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    let kind = if options.is_empty() {
        js_string(entry.get("type"))
    } else {
        format!("enum {options}")
    };
    let fallback = match entry.get("default") {
        None => String::new(),
        Some(default) => format!(", default {}", clip(&shown(default), 80)),
    };
    let path = text_of(entry.get("path"));
    let label = match entry.get("label").and_then(Value::as_str) {
        Some(label) if !label.is_empty() && label != path => format!(" {label}"),
        _ => String::new(),
    };
    let current = match value {
        None => "(unset)".to_string(),
        Some(value) => clip(&shown(value), 300),
    };
    format!("- {path}: {current} ({kind}{fallback}){label}")
}

fn off_reason_text(reason: &Map<String, Value>) -> String {
    let tool = js_string(reason.get("tool"));
    match text_of(reason.get("kind")) {
        "disabled" => "turned off in omp's config".into(),
        "otherTool" => format!(
            "found only in {tool}'s config, which omp does not read (extensions.mcp_use uses it)"
        ),
        "offInTool" => format!("turned off in {tool}'s config"),
        "toolOff" => format!("reading {tool}'s config is turned off in omp"),
        "projectConfigOff" => "project MCP config is turned off".into(),
        _ => "undefined".into(),
    }
}

fn needs_sign_in(server: &Map<String, Value>) -> bool {
    truthy(server.get("enabled"))
        && matches!(text_of(server.get("authState")), "required" | "expired")
}

/// One line an agent reads: state, tools, sign-in, and why a server is off. No url or command (they can hold secrets).
fn mcp_server_line(server: &Map<String, Value>) -> String {
    let mut parts = vec![format!(
        "{} ({})",
        js_string(server.get("name")),
        js_string(server.get("transport"))
    )];
    if !truthy(server.get("enabled")) {
        parts.push(
            match server
                .get("offReason")
                .and_then(Value::as_object)
                .filter(|_| truthy(server.get("offReason")))
            {
                Some(reason) => format!("off: {}", off_reason_text(reason)),
                None => "off".into(),
            },
        );
    } else {
        parts.push(js_string(server.get("status")));
        parts.push(format!("{} tools", js_string(server.get("toolCount"))));
        if needs_sign_in(server) {
            parts.push(if text_of(server.get("authState")) == "expired" {
                "sign-in expired".into()
            } else {
                "needs sign-in".into()
            });
        } else if text_of(server.get("authState")) == "authorized" {
            parts.push("signed in".into());
        }
    }
    if truthy(server.get("alsoIn")) {
        parts.push(format!(
            "taken from {}'s config",
            js_string(server.get("alsoIn"))
        ));
    }
    parts.join(", ")
}

fn mcp_sign_in_next(name: &str) -> String {
    format!(
        "It needs a sign-in: run extensions.mcp_sign_in with name \"{name}\" (the person completes it in the browser); never sign in through a terminal omp."
    )
}

fn servers_of(data: &Value) -> Vec<&Map<String, Value>> {
    records(data.get("servers"))
}

/// What `agent_power.set` can switch under full control: the switches that bound an agent's own power. A pref goes
/// through `PREFS_SET`, a stock setting through `set_setting`, and the terminal-omp wiring through ai-memory's own
/// channel (it writes the person's own omp config, which a bare pref write would not).
enum Switch {
    Pref(&'static str),
    Stock(&'static str),
    Channel(&'static str),
}

struct PowerSwitch {
    name: &'static str,
    en: &'static str,
    ko: &'static str,
    kind: Switch,
}

const POWER_SWITCHES: [PowerSwitch; 9] = [
    PowerSwitch {
        name: "agentControl",
        en: "OMPdesk control tools",
        ko: "OMPdesk 제어 도구",
        kind: Switch::Pref("agentControl"),
    },
    PowerSwitch {
        name: "agentControlFull",
        en: "Give agents full control of OMPdesk",
        ko: "에이전트에게 OMPdesk 모든 권한",
        kind: Switch::Pref("agentControlFull"),
    },
    PowerSwitch {
        name: "agentControlManage",
        en: "Let agents manage other sessions",
        ko: "에이전트가 다른 세션 관리하기",
        kind: Switch::Pref("agentControlManage"),
    },
    PowerSwitch {
        name: "agentControlApprove",
        en: "Let agents approve for other sessions",
        ko: "에이전트가 다른 세션 승인 대신하기",
        kind: Switch::Pref("agentControlApprove"),
    },
    PowerSwitch {
        name: "pstack",
        en: "Engineering mode (pstack)",
        ko: "엔지니어링 모드 (pstack)",
        kind: Switch::Pref("pstack"),
    },
    PowerSwitch {
        name: "ecc",
        en: "ECC skills",
        ko: "ECC 스킬",
        kind: Switch::Pref("ecc"),
    },
    PowerSwitch {
        name: "aiMemoryTerminal",
        en: "Memory in the terminal omp",
        ko: "터미널 omp에서도 메모리 쓰기",
        kind: Switch::Channel(AI_MEMORY_SET_TERMINAL),
    },
    PowerSwitch {
        name: "computer.enabled",
        en: "Computer use",
        ko: "컴퓨터 사용",
        kind: Switch::Stock("computer.enabled"),
    },
    PowerSwitch {
        name: "tools.approvalMode",
        en: "Tool approval",
        ko: "도구 승인",
        kind: Switch::Stock("tools.approvalMode"),
    },
];

/// The paired host a `host: true` call acts on, as the Settings › Updates host rows do; a session on this computer has none.
fn update_host<P: AppPorts>(ctx: &Ctx<P>, args: &Args) -> Result<Option<String>, Fault> {
    if args.get("host") != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    match ctx.device() {
        None => Err(refusal(
            "This session runs on this computer, not on a paired host: leave host out.",
        )),
        Some(device) => Ok(Some(device.to_string())),
    }
}

/// The caller's paired host goes into a `sessions:*` payload the way the sidebar's does; a session on this computer sends none.
fn with_caller_device<P: AppPorts>(ctx: &Ctx<P>, mut payload: Map<String, Value>) -> Value {
    if let Some(device) = ctx.device() {
        payload.insert("device".into(), json!(device));
    }
    Value::Object(payload)
}

fn scope_of(args: &Args) -> &'static str {
    if args.get("scope").and_then(Value::as_str) == Some("local") {
        "local"
    } else {
        "global"
    }
}

fn absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

/// Last segment of a path in either separator style, trailing separators ignored.
fn path_base_name(file: &str) -> &str {
    file.split(['\\', '/'])
        .rfind(|part| !part.is_empty())
        .unwrap_or(file)
}

fn base_names(paths: &[String]) -> String {
    paths
        .iter()
        .map(|path| path_base_name(path))
        .collect::<Vec<_>>()
        .join(", ")
}

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| js_string(Some(item))).collect(),
        _ => Vec::new(),
    }
}

/// The sidebar project list of the caller's computer: this one, or the paired host's own (the channel routes by `device`).
async fn send_sidebar_projects<P: AppPorts>(ctx: &Ctx<P>, request: Value) -> Result<Value, Fault> {
    let mut args = vec![request];
    if let Some(device) = ctx.device() {
        args.push(json!(device));
    }
    ctx.invoke(SIDEBAR_PROJECTS_COMMAND, args).await
}

async fn read_sidebar_projects<P: AppPorts>(ctx: &Ctx<P>) -> Result<Value, Fault> {
    send_sidebar_projects(ctx, json!({"action": "get"})).await
}

fn project_rows(state: &Value) -> Vec<&Map<String, Value>> {
    records(state.get("projects"))
}

fn project_paths(state: &Value) -> Vec<String> {
    project_rows(state)
        .iter()
        .map(|project| text_of(project.get("path")).to_string())
        .collect()
}

async fn listed_project_paths<P: AppPorts>(ctx: &Ctx<P>) -> Result<HashSet<String>, Fault> {
    Ok(project_paths(&read_sidebar_projects(ctx).await?)
        .into_iter()
        .collect())
}

fn not_listed_text(paths: &[String]) -> String {
    format!(
        "Not in the sidebar list, left alone: {}. Read sidebar.projects for the exact paths.",
        paths.join(", ")
    )
}

/// Pins, names, order and the archive are kept by the sidebar of the computer the window runs on, never a paired host's.
fn this_computer_only<P: AppPorts>(ctx: &Ctx<P>) -> Result<(), Fault> {
    if ctx.device().is_some() {
        return Err(refusal(
            "Pins, names, order and the archive belong to this computer's own sidebar; this session runs on a paired host, so the person arranges that there.",
        ));
    }
    Ok(())
}

/// A project of this computer's list, or a refusal naming the path.
async fn own_sidebar_project<P: AppPorts>(ctx: &Ctx<P>, path: &str) -> Result<(), Fault> {
    this_computer_only(ctx)?;
    if !listed_project_paths(ctx).await?.contains(path) {
        return Err(refusal(not_listed_text(&[path.to_string()])));
    }
    Ok(())
}

/// Every path is a saved session of this computer (`sessions.saved`'s list).
async fn require_saved_sessions<P: AppPorts>(ctx: &Ctx<P>, paths: &[String]) -> Result<(), Fault> {
    let saved = ctx
        .invoke(SESSIONS_LIST, vec![json!({"scope": "global"})])
        .await?;
    let known: HashSet<&str> = match &saved {
        Value::Array(rows) => rows
            .iter()
            .map(|row| row.get("path").and_then(Value::as_str).unwrap_or(""))
            .collect(),
        _ => HashSet::new(),
    };
    let unknown: Vec<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| !known.contains(path))
        .collect();
    if !unknown.is_empty() {
        return Err(refusal(format!(
            "Not a saved session of this computer: {}. Read sessions.saved for the paths.",
            unknown.join(", ")
        )));
    }
    Ok(())
}

/// The rows of a list answer as text lines, `empty` when there are none.
fn lines_of(values: &[Value], pick: impl Fn(&Map<String, Value>) -> String, empty: &str) -> String {
    let rows: Vec<&Map<String, Value>> = values.iter().filter_map(Value::as_object).collect();
    if rows.is_empty() {
        empty.to_string()
    } else {
        rows.iter()
            .map(|row| pick(row))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn answer_rows(answer: &Value, max: usize) -> &[Value] {
    match answer {
        Value::Array(rows) => &rows[..rows.len().min(max)],
        _ => &[],
    }
}

type Done = Result<ActionResult, Fault>;

// ---- the actions ----------------------------------------------------------------------------------------------

async fn h_settings_get<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let wanted: Option<HashSet<String>> = args
        .get("ids")
        .and_then(Value::as_array)
        .map(|_| string_list(args.get("ids")).into_iter().collect());
    let rows: Vec<&'static Setting> = SETTINGS
        .iter()
        .filter(|row| wanted.as_ref().is_none_or(|wanted| wanted.contains(row.id)))
        .collect();
    let stock_paths: Vec<&str> = rows
        .iter()
        .filter(|row| row.pref_key().is_none())
        .map(|row| row.id)
        .collect();
    let stock_data = if stock_paths.is_empty() {
        None
    } else {
        ctx.rpc(json!({"type": "get_settings", "paths": stock_paths}), None)
            .await
            .ok()
    };
    let mut out: Vec<String> = Vec::new();
    for row in rows {
        let display = {
            let value: Result<Option<Value>, Fault> = match row.kind {
                Kind::Stock { path } => {
                    Ok(stock_data.as_ref().and_then(|data| stock_value(data, path)))
                }
                Kind::Pref { key, .. } => ctx.get_pref(key).await,
            };
            match value {
                // A row the host holds fails to read while the host is offline; the other rows still answer.
                Err(_) => "(unreachable)".to_string(),
                Ok(value) if row.redact() => (if truthy(value.as_ref()) {
                    "(set)"
                } else {
                    "(unset)"
                })
                .to_string(),
                Ok(None) => "(default)".to_string(),
                Ok(Some(value)) => shown(&value),
            }
        };
        out.push(format!(
            "- {}: {display}{}",
            row.id,
            if row.tier == Tier::Sensitive {
                " [asks the user]"
            } else {
                ""
            }
        ));
    }
    Ok(ActionResult::text(if out.is_empty() {
        "No settings row matches.".to_string()
    } else {
        out.join("\n")
    }))
}

async fn h_usage_read<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let refresh = args.get("refresh") == Some(&Value::Bool(true));
    let data = ctx
        .rpc(
            json!({"type": "get_usage", "refresh": refresh}),
            device_of(&args),
        )
        .await?;
    Ok(ActionResult::text(describe_usage(&data, now_ms())))
}

async fn h_models_list<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let device = device_of(&args);
    let filter = ModelFilter {
        provider: str_arg(&args, "provider").unwrap_or("").to_string(),
        query: str_arg(&args, "query").unwrap_or("").to_string(),
        all: args.get("all") == Some(&Value::Bool(true)),
    };
    let mut out: Vec<String> = Vec::new();
    if filter.provider.is_empty() && filter.query.is_empty() {
        // An omp older than the role contract answers an error; the models are still worth listing.
        let roles = match ctx
            .rpc(json!({"type": "get_model_roles", "compact": true}), device)
            .await
        {
            Ok(data) => describe_roles(&data),
            Err(error) => vec![format!("(roles unavailable: {})", error.message)],
        };
        out.push("Model roles:".into());
        out.extend(roles);
        out.push(String::new());
    }
    let catalog = ctx.rpc(json!({"type": "get_providers"}), device).await?;
    out.extend(describe_models(&catalog, &filter));
    Ok(ActionResult::text(out.join("\n")))
}

async fn h_models_set<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.rpc(
        json!({"type": "set_model", "provider": arg(&args, "provider"), "modelId": arg(&args, "modelId")}),
        None,
    )
    .await?;
    let value = format!("{}/{}", arg(&args, "provider"), arg(&args, "modelId"));
    Ok(ActionResult::changed(
        format!("This session now uses {value}."),
        "Model",
        "모델",
        value,
    ))
}

async fn h_models_set_role<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let model_id = str_arg(&args, "modelId");
    let device = device_of(&args);
    let role = arg(&args, "role");
    ctx.rpc(
        json!({"type": "set_model_role", "role": role, "modelId": model_id}),
        device,
    )
    .await?;
    let on = device.map_or(String::new(), |device| format!(" on {device}"));
    let what = match model_id {
        Some(model) => format!("Role {role} now uses {model}"),
        None => format!("Role {role} cleared"),
    };
    Ok(ActionResult::changed(
        format!("{what}{on}."),
        format!("Model role {role}{on}"),
        format!(
            "모델 역할 {role}{}",
            device.map_or(String::new(), |device| format!(" ({device})"))
        ),
        model_id.unwrap_or("(cleared)"),
    ))
}

async fn h_omp_settings_get<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let device = device_of(&args);
    let paths = string_list(args.get("paths"));
    let query = str_arg(&args, "query").unwrap_or("").trim().to_string();
    if paths.is_empty() && query.is_empty() {
        let readable = ctx.omp_find("", device).await?;
        let mut groups: Vec<(String, usize)> = Vec::new();
        for read in &readable {
            let path = text_of(read.entry.get("path"));
            let group = path.split('.').next().unwrap_or(path).to_string();
            match groups.iter_mut().find(|(name, _)| *name == group) {
                Some((_, count)) => *count += 1,
                None => groups.push((group, 1)),
            }
        }
        let summary: Vec<String> = groups
            .iter()
            .map(|(group, count)| format!("{group} {count}"))
            .collect();
        return Ok(ActionResult::text(format!(
            "{} settings are readable ({}). Pass paths (exact, e.g. \"retry.fallbackOn\") or query (words from a path, label or description).",
            readable.len(),
            summary.join(", ")
        )));
    }
    let rows = if paths.is_empty() {
        Vec::new()
    } else {
        ctx.omp_read(&paths, device).await?
    };
    let mut out: Vec<String> = rows
        .iter()
        .map(|read| omp_setting_line(&read.entry, read.value.as_ref()))
        .collect();
    if !query.is_empty() {
        let found: Vec<_> = ctx
            .omp_find(&query, device)
            .await?
            .into_iter()
            .filter(|read| {
                !paths
                    .iter()
                    .any(|path| path == text_of(read.entry.get("path")))
            })
            .collect();
        out.extend(
            found
                .iter()
                .take(OMP_SETTINGS_SHOWN_MAX)
                .map(|read| omp_setting_line(&read.entry, read.value.as_ref())),
        );
        if found.len() > OMP_SETTINGS_SHOWN_MAX {
            out.push(format!(
                "({} more match: narrow the query.)",
                found.len() - OMP_SETTINGS_SHOWN_MAX
            ));
        } else if found.is_empty() && rows.is_empty() {
            out.push(format!("No readable setting matches \"{query}\"."));
        }
    }
    Ok(ActionResult::text(out.join("\n")))
}

async fn h_omp_settings_set<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let path = arg(&args, "path");
    let device = device_of(&args);
    let value = args.get("value").cloned().unwrap_or(Value::Null);
    let previous = ctx.omp_write(&path, &value, device).await?;
    let shown_value = clip(&shown(&value), 200);
    let on = device.map_or(String::new(), |device| format!(" on {device}"));
    let undo = previous
        .filter(|previous| !previous.is_null())
        .map(|previous| Undo::Setting {
            path: path.clone(),
            value: previous,
            device: device.map(str::to_string),
        });
    Ok(ActionResult::changed(
        format!("{path} is now {shown_value}{on}."),
        format!("omp setting {path}{on}"),
        format!(
            "omp 설정 {path}{}",
            device.map_or(String::new(), |device| format!(" ({device})"))
        ),
        shown_value,
    )
    .with_undo(undo))
}

async fn h_ui_panel<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let tab = arg(&args, "tab");
    ctx.ui(json!({"kind": "panel", "tab": if tab == "close" { Value::Null } else { json!(tab) }}));
    let sheet = VIEW_SHEETS.contains(&tab.as_str());
    Ok(ActionResult::text(if tab == "close" {
        "Side panel closed.".to_string()
    } else if sheet {
        format!("The {tab} sheet is open.")
    } else {
        format!("Side panel shows {tab}.")
    }))
}

async fn h_ui_settings_open<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut event = json!({"kind": "settings", "section": arg(&args, "section")});
    if let Some(sub) = str_arg(&args, "sub") {
        event["sub"] = json!(sub);
    }
    ctx.ui(event);
    Ok(ActionResult::text(format!(
        "Settings opened at {}.",
        arg(&args, "section")
    )))
}

async fn h_sessions_saved<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut payload = Map::new();
    payload.insert("scope".into(), json!(scope_of(&args)));
    let sessions = ctx
        .invoke(SESSIONS_LIST, vec![with_caller_device(&ctx, payload)])
        .await?;
    Ok(ActionResult::text(lines_of(
        answer_rows(&sessions, 50),
        |row| {
            let title = match row.get("title") {
                Some(Value::String(title)) => title.as_str(),
                _ => "(untitled)",
            };
            format!(
                "- {title} · {} · {} · {}",
                text_of(row.get("cwd")),
                text_of(row.get("modified")),
                text_of(row.get("path"))
            )
        },
        "No saved sessions.",
    )))
}

async fn h_sessions_search<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut payload = Map::new();
    payload.insert("query".into(), json!(arg(&args, "query")));
    payload.insert("scope".into(), json!(scope_of(&args)));
    let hits = ctx
        .invoke(SESSIONS_SEARCH, vec![with_caller_device(&ctx, payload)])
        .await?;
    Ok(ActionResult::text(lines_of(
        answer_rows(&hits, 30),
        |row| {
            format!(
                "- {}: {}",
                text_of(row.get("path")),
                text_of(row.get("snippet"))
            )
        },
        "No matches.",
    )))
}

async fn h_sessions_rename<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut payload = Map::new();
    payload.insert("sessionPath".into(), json!(arg(&args, "sessionPath")));
    payload.insert("name".into(), json!(arg(&args, "name")));
    ctx.invoke(SESSIONS_RENAME, vec![with_caller_device(&ctx, payload)])
        .await?;
    Ok(ActionResult::changed(
        "Renamed.",
        "Session name",
        "세션 이름",
        arg(&args, "name"),
    ))
}

async fn h_sessions_delete<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut payload = Map::new();
    payload.insert("sessionPath".into(), json!(arg(&args, "sessionPath")));
    ctx.invoke(SESSIONS_DELETE, vec![with_caller_device(&ctx, payload)])
        .await?;
    Ok(ActionResult::changed(
        "Deleted.",
        "Deleted a saved session",
        "저장된 세션 삭제",
        arg(&args, "sessionPath"),
    ))
}

async fn h_sessions_dump_bundle<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut request = Map::new();
    match str_arg(&args, "session") {
        Some(session) => {
            request.insert("sessionPath".into(), json!(session));
            if let Some(device) = ctx.device() {
                request.insert("device".into(), json!(device));
            }
        }
        None => {
            request.insert("tabId".into(), json!(ctx.caller()));
        }
    }
    request.insert(
        "anonymized".into(),
        json!(args.get("anonymized") != Some(&Value::Bool(false))),
    );
    request.insert(
        "destination".into(),
        match str_arg(&args, "path") {
            Some(path) => json!({"kind": "path", "path": path}),
            None => json!({"kind": "downloads"}),
        },
    );
    request.insert("forAgent".into(), json!(true));
    let result = ctx
        .invoke(SESSIONS_DUMP_BUNDLE, vec![Value::Object(request)])
        .await?;
    if !truthy(result.get("ok")) {
        return Err(refusal(if truthy(result.get("cancelled")) {
            "The save was cancelled.".to_string()
        } else {
            js_string(result.get("error"))
        }));
    }
    let files: Vec<String> = string_list(result.get("files"));
    let path = js_string(result.get("path"));
    Ok(ActionResult::changed(
        format!(
            "Saved the {}diagnostic bundle ({}) to {path}.",
            if truthy(result.get("anonymized")) {
                "anonymized "
            } else {
                ""
            },
            files.join(", ")
        ),
        "Saved a diagnostic bundle",
        "진단 묶음 저장",
        path,
    ))
}

async fn h_ui_open_system_privacy<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let pane = arg(&args, "pane");
    ctx.open_privacy_pane(&pane)
        .await
        .map_err(|error| refusal(error.message))?;
    Ok(ActionResult::text(format!(
        "Opened System Settings › Privacy & Security › {}. Tell the person to switch OMPdesk on there; you cannot.",
        pane.replace('_', " ")
    )))
}

async fn h_sidebar_projects<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    let state = read_sidebar_projects(&ctx).await?;
    let view = if ctx.device().is_some() {
        None
    } else {
        Some(ctx.sidebar_view())
    };
    let projects = project_rows(&state);
    let rows = &projects[..projects.len().min(SIDEBAR_LIST_MAX)];
    let more = projects.len() - rows.len();
    let listed = if rows.is_empty() {
        "No projects in the sidebar.".to_string()
    } else {
        rows.iter()
            .map(|project| {
                let path = text_of(project.get("path"));
                let alias = view
                    .as_ref()
                    .and_then(|view| view.aliases.get(path))
                    .filter(|alias| !alias.is_empty());
                format!(
                    "- {path} · {}{}{}{}",
                    path_base_name(path),
                    alias.map_or(String::new(), |alias| format!(" · named \"{alias}\"")),
                    if view.as_ref().is_some_and(|view| view
                        .pinned_projects
                        .iter()
                        .any(|pinned| pinned == path))
                    {
                        " · pinned"
                    } else {
                        ""
                    },
                    if truthy(project.get("missing")) {
                        " · folder missing"
                    } else {
                        ""
                    },
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let removed = state
        .get("removed")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let removed = if removed > 0 {
        format!("\n{removed} removed folders stay out until the person opens them again.")
    } else {
        String::new()
    };
    Ok(ActionResult::text(format!(
        "{listed}{}{removed}",
        if more > 0 {
            format!("\n… and {more} more.")
        } else {
            String::new()
        }
    )))
}

async fn h_sidebar_add_project<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let path = arg(&args, "path");
    if !absolute_path(&path) {
        return Err(refusal("path must be absolute."));
    }
    let before: HashSet<String> = project_paths(&read_sidebar_projects(&ctx).await?)
        .into_iter()
        .collect();
    send_sidebar_projects(&ctx, json!({"action": "add", "path": path})).await?;
    // A read also notices a folder that is not on disk.
    let after = read_sidebar_projects(&ctx).await?;
    let added: Vec<&Map<String, Value>> = project_rows(&after)
        .into_iter()
        .filter(|project| !before.contains(text_of(project.get("path"))))
        .collect();
    if added.is_empty() {
        return Ok(ActionResult::text(if before.contains(&path) {
            format!("{path} is already in the sidebar.")
        } else {
            format!("{path} was not added: it is the Work workspace, which is never a project.")
        }));
    }
    let missing = added.iter().any(|project| truthy(project.get("missing")));
    let paths: Vec<String> = added
        .iter()
        .map(|project| text_of(project.get("path")).to_string())
        .collect();
    Ok(ActionResult::changed(
        format!(
            "Added to the sidebar: {}{}.",
            paths.join(", "),
            if missing {
                " (the folder is not on disk, so it shows as missing)"
            } else {
                ""
            }
        ),
        "Added to the sidebar",
        "사이드바에 추가",
        base_names(&paths),
    ))
}

async fn h_sidebar_remove_project<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut asked: Vec<String> = Vec::new();
    if let Some(path) = str_arg(&args, "path") {
        asked.push(path.to_string());
    }
    asked.extend(string_list(args.get("paths")));
    let asked: Vec<String> = unique_strings(asked)
        .into_iter()
        .filter(|path| !path.is_empty())
        .collect();
    if asked.is_empty() {
        return Err(refusal("Give path or paths."));
    }
    let listed = listed_project_paths(&ctx).await?;
    let (known, unknown): (Vec<String>, Vec<String>) =
        asked.into_iter().partition(|path| listed.contains(path));
    if known.is_empty() {
        return Err(refusal(not_listed_text(&unknown)));
    }
    for path in &known {
        send_sidebar_projects(&ctx, json!({"action": "remove", "path": path})).await?;
    }
    Ok(ActionResult::changed(
        format!(
            "Removed from the sidebar: {}. No folder or session was touched; opening a folder again lists it again.{}",
            known.join(", "),
            if unknown.is_empty() {
                String::new()
            } else {
                format!(" {}", not_listed_text(&unknown))
            }
        ),
        "Removed from the sidebar",
        "사이드바에서 제거",
        base_names(&known),
    ))
}

async fn h_sidebar_pin_project<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let path = arg(&args, "path");
    let pinned = args.get("pinned") == Some(&Value::Bool(true));
    own_sidebar_project(&ctx, &path).await?;
    if ctx.sidebar_view().pinned_projects.contains(&path) == pinned {
        return Ok(ActionResult::text(format!(
            "{path} is already {}.",
            if pinned { "pinned" } else { "not pinned" }
        )));
    }
    ctx.ui(
        json!({"kind": "sidebar", "change": {"op": "pin-project", "path": path, "pinned": pinned}}),
    );
    Ok(ActionResult::changed(
        format!("{} {path}.", if pinned { "Pinned" } else { "Unpinned" }),
        if pinned {
            "Pinned a project"
        } else {
            "Unpinned a project"
        },
        if pinned {
            "프로젝트 고정"
        } else {
            "프로젝트 고정 해제"
        },
        path_base_name(&path),
    ))
}

async fn h_sidebar_order_projects<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let paths = unique_strings(string_list(args.get("paths")));
    if paths.is_empty() {
        return Err(refusal("Give at least one path."));
    }
    this_computer_only(&ctx)?;
    let listed = listed_project_paths(&ctx).await?;
    let unknown: Vec<String> = paths
        .iter()
        .filter(|path| !listed.contains(*path))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        return Err(refusal(not_listed_text(&unknown)));
    }
    ctx.ui(json!({"kind": "sidebar", "change": {"op": "order-projects", "paths": paths}}));
    Ok(ActionResult::changed(
        format!("Project order set: {}.", paths.join(", ")),
        "Project order",
        "프로젝트 순서",
        base_names(&paths),
    ))
}

async fn h_sidebar_rename_project<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let path = arg(&args, "path");
    let name = arg(&args, "name").trim().to_string();
    own_sidebar_project(&ctx, &path).await?;
    ctx.ui(json!({"kind": "sidebar", "change": {"op": "rename-project", "path": path, "name": if name.is_empty() { Value::Null } else { json!(name) }}}));
    Ok(ActionResult::changed(
        if name.is_empty() {
            format!("{path} shows its folder name again.")
        } else {
            format!("{path} is now named \"{name}\".")
        },
        "Project name",
        "프로젝트 이름",
        if name.is_empty() {
            path_base_name(&path).to_string()
        } else {
            name
        },
    ))
}

async fn h_sidebar_pin_session<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let session_path = arg(&args, "sessionPath");
    let pinned = args.get("pinned") == Some(&Value::Bool(true));
    this_computer_only(&ctx)?;
    if pinned {
        require_saved_sessions(&ctx, std::slice::from_ref(&session_path)).await?;
    }
    if ctx.sidebar_view().pinned_sessions.contains(&session_path) == pinned {
        return Ok(ActionResult::text(format!(
            "{session_path} is already {}.",
            if pinned { "pinned" } else { "not pinned" }
        )));
    }
    ctx.ui(json!({"kind": "sidebar", "change": {"op": "pin-session", "sessionPath": session_path, "pinned": pinned}}));
    Ok(ActionResult::changed(
        format!(
            "{} {session_path}.",
            if pinned { "Pinned" } else { "Unpinned" }
        ),
        if pinned {
            "Pinned a session"
        } else {
            "Unpinned a session"
        },
        if pinned {
            "세션 고정"
        } else {
            "세션 고정 해제"
        },
        path_base_name(&session_path),
    ))
}

async fn h_sidebar_archive_sessions<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let session_paths = unique_strings(string_list(args.get("sessionPaths")));
    let archived = args.get("archived") == Some(&Value::Bool(true));
    if session_paths.is_empty() {
        return Err(refusal("Give at least one session path."));
    }
    this_computer_only(&ctx)?;
    require_saved_sessions(&ctx, &session_paths).await?;
    ctx.ui(json!({"kind": "sidebar", "change": {"op": "archive-sessions", "sessionPaths": session_paths, "archived": archived}}));
    let count = session_paths.len();
    Ok(ActionResult::changed(
        format!(
            "{} {count} session{} in the sidebar; no file was touched.",
            if archived { "Archived" } else { "Restored" },
            plural(count)
        ),
        if archived {
            "Archived sessions"
        } else {
            "Restored sessions"
        },
        if archived {
            "세션 보관"
        } else {
            "세션 복원"
        },
        count.to_string(),
    ))
}

async fn h_updates_status<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let device = update_host(&ctx, &args)?;
    let answer = match &device {
        Some(device) => ctx.invoke(HOST_DESKTOP_GET, vec![json!(device)]).await?,
        None => ctx.invoke(UPDATER_GET_STATUS, vec![]).await?,
    };
    let host = device.as_ref().and_then(|_| answer.as_object());
    let status = match host {
        Some(host) => host.get("update"),
        None => Some(&answer),
    };
    let state = match status
        .and_then(Value::as_object)
        .and_then(|status| status.get("state"))
    {
        Some(state) => js_string(Some(state)),
        None => "unknown".to_string(),
    };
    let version = match status
        .and_then(Value::as_object)
        .and_then(|status| status.get("version"))
    {
        Some(version) => format!(" {}", js_string(Some(version))),
        None => String::new(),
    };
    let on_host = host.map_or(String::new(), |host| {
        let version = match host.get("version") {
            Some(Value::String(text)) => text.as_str(),
            _ => "?",
        };
        format!("The paired host runs OMPdesk {version}. ")
    });
    Ok(ActionResult::text(format!(
        "{on_host}Update state: {state}{version}."
    )))
}

async fn h_updates_check<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let device = update_host(&ctx, &args)?;
    match &device {
        Some(device) => {
            ctx.invoke(HOST_DESKTOP_UPDATE, vec![json!("check"), json!(device)])
                .await?
        }
        None => ctx.invoke(UPDATER_CHECK, vec![]).await?,
    };
    Ok(ActionResult::text(format!(
        "Update check {}; read updates.status{} for the result.",
        if device.is_some() {
            "ran on the paired host"
        } else {
            "started"
        },
        if device.is_some() {
            " with host: true"
        } else {
            ""
        }
    )))
}

async fn h_updates_download<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    ctx.invoke(UPDATER_DOWNLOAD, vec![]).await?;
    Ok(ActionResult::text(
        "Download started; read updates.status for its progress. updates.apply installs it.",
    ))
}

async fn h_updates_apply<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let device = update_host(&ctx, &args)?;
    match &device {
        Some(device) => {
            ctx.invoke(HOST_DESKTOP_UPDATE, vec![json!("install"), json!(device)])
                .await?
        }
        None => ctx.invoke(UPDATER_APPLY, vec![]).await?,
    };
    Ok(ActionResult::text(format!(
        "Applying the update; {}OMPdesk restarts.",
        if device.is_some() {
            "the paired host's "
        } else {
            ""
        }
    )))
}

async fn h_disk_status<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    Ok(ActionResult::text(disk_text(
        &ctx.invoke(DISK_CARE_GET_STATE, vec![]).await?,
    )))
}

async fn h_disk_clean<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    Ok(ActionResult::text(disk_text(
        &ctx.invoke(DISK_CARE_RUN, vec![]).await?,
    )))
}

async fn h_app_quit<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    ctx.fire(APP_QUIT, vec![])?;
    Ok(ActionResult::text("Quitting OMPdesk."))
}

async fn h_accounts_github_status<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    let state = ctx.invoke(GITHUB_AUTH_REFRESH, vec![json!(false)]).await?;
    let Some(status) = state.get("status").and_then(Value::as_object) else {
        return Ok(ActionResult::text("GitHub status is not known yet."));
    };
    Ok(ActionResult::text(if truthy(status.get("authenticated")) {
        format!(
            "Signed in to GitHub as {}.",
            match status.get("login") {
                Some(Value::String(login)) => login.as_str(),
                _ => "?",
            }
        )
    } else {
        "Not signed in to GitHub.".to_string()
    }))
}

async fn h_accounts_github_sign_in<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    ctx.invoke(GITHUB_AUTH_LOGIN_START, vec![]).await?;
    Ok(ActionResult::text(
        "GitHub sign-in started: the person finishes it in the window.",
    ))
}

async fn h_accounts_provider_sign_in<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.start_provider_login(&arg(&args, "providerId")).await?;
    Ok(ActionResult::text(format!(
        "Sign-in for {} requested: finish it in this session's Models & accounts panel.",
        arg(&args, "providerId")
    )))
}

async fn h_mobile_web_status<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    let state = ctx.invoke(MOBILE_WEB_GET_STATE, vec![]).await?;
    let phase = match state.get("phase") {
        Some(Value::String(phase)) => phase.as_str(),
        _ => "unknown",
    };
    Ok(ActionResult::text(format!(
        "Mobile web: {}, phase {phase}.",
        if truthy(state.get("enabled")) {
            "on"
        } else {
            "off"
        }
    )))
}

async fn h_mobile_web_set_enabled<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let enabled = args.get("enabled") == Some(&Value::Bool(true));
    ctx.invoke(
        MOBILE_WEB_COMMAND,
        vec![json!({"action": if enabled { "enable" } else { "disable" }})],
    )
    .await?;
    Ok(ActionResult::changed(
        format!(
            "Mobile web {}.",
            if enabled { "enabled" } else { "disabled" }
        ),
        "Mobile web",
        "모바일 웹",
        shown(&Value::Bool(enabled)),
    ))
}

async fn h_extensions_install_plugin<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.rpc(
        json!({"type": "marketplace_action", "action": "install", "marketplace": arg(&args, "marketplace"), "plugin": arg(&args, "plugin")}),
        None,
    )
    .await?;
    Ok(ActionResult::changed(
        format!("Installed {}.", arg(&args, "plugin")),
        "Installed plugin",
        "플러그인 설치",
        arg(&args, "plugin"),
    ))
}

async fn h_memory_purge<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    ctx.invoke(AI_MEMORY_PURGE, vec![]).await?;
    Ok(ActionResult::changed(
        "Memory erased.",
        "Memory",
        "메모리",
        "erased",
    ))
}

async fn h_memory_delete_page<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.invoke(
        AI_MEMORY_DELETE_PAGE,
        vec![json!({"workspace": arg(&args, "workspace"), "project": arg(&args, "project"), "path": arg(&args, "path")})],
    )
    .await?;
    Ok(ActionResult::changed(
        format!("Deleted {}.", arg(&args, "path")),
        "Memory page",
        "메모리 페이지",
        format!("deleted {}", arg(&args, "path")),
    ))
}

async fn h_memory_sweep<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let result = ctx
        .invoke(
            AI_MEMORY_SWEEP,
            vec![
                json!({"workspace": arg(&args, "workspace"), "project": arg(&args, "project")}),
                json!(false),
            ],
        )
        .await?;
    let evicted = match result.get("evicted") {
        Some(Value::Number(number)) => number_text(number),
        _ => "0".to_string(),
    };
    Ok(ActionResult::changed(
        format!("Memory sweep done: {evicted} evicted."),
        "Memory",
        "메모리",
        "swept",
    ))
}

async fn h_app_undo<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    ctx.undo_last().await
}

async fn h_agent_power_set<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let name = arg(&args, "switch");
    let Some(entry) = POWER_SWITCHES.iter().find(|entry| entry.name == name) else {
        return Err(refusal(format!("Unknown switch {name}.")));
    };
    let approval = name == "tools.approvalMode";
    let value = if approval {
        args.get("mode")
    } else {
        args.get("on")
    };
    let fits = if approval {
        value.is_some_and(Value::is_string)
    } else {
        value.is_some_and(Value::is_boolean)
    };
    let Some(value) = value.filter(|_| fits) else {
        return Err(refusal(if approval {
            "tools.approvalMode needs mode.".to_string()
        } else {
            format!("{name} needs on.")
        }));
    };
    let previous = match entry.kind {
        Switch::Stock(path) => read_stock(&ctx, path).await?,
        Switch::Pref(key) => ctx.get_pref(key).await?,
        Switch::Channel(_) => None,
    };
    match entry.kind {
        Switch::Pref(key) => ctx.set_pref(key, value).await?,
        Switch::Stock(path) => {
            ctx.rpc(
                json!({"type": "set_setting", "path": path, "value": value}),
                None,
            )
            .await?;
        }
        Switch::Channel(channel) => {
            ctx.invoke(channel, vec![value.clone()]).await?;
        }
    }
    let undo = match (&previous, &entry.kind) {
        (None | Some(Value::Null), _) | (_, Switch::Channel(_)) => None,
        (Some(previous), Switch::Pref(key)) => Some(Undo::Pref {
            key: (*key).to_string(),
            value: previous.clone(),
        }),
        (Some(previous), Switch::Stock(path)) => Some(Undo::Setting {
            path: (*path).to_string(),
            value: previous.clone(),
            device: None,
        }),
    };
    Ok(ActionResult::changed(
        format!("{} is now {}.", entry.en, shown(value)),
        entry.en,
        entry.ko,
        shown(value),
    )
    .with_undo(undo))
}

async fn h_extensions_install_mcp<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let stdio = str_arg(&args, "transport") == Some("stdio");
    if stdio && str_arg(&args, "command").is_none() {
        return Err(refusal("stdio needs command."));
    }
    let url_ok = str_arg(&args, "url")
        .is_some_and(|url| url.starts_with("http://") || url.starts_with("https://"));
    if !stdio && !url_ok {
        return Err(refusal("http and sse need an http(s) url."));
    }
    let config = if stdio {
        let mut config = json!({"transport": "stdio", "command": arg(&args, "command")});
        if let Some(list) = args.get("args").filter(|list| list.is_array()) {
            config["args"] = list.clone();
        }
        config
    } else {
        json!({"transport": arg(&args, "transport"), "url": arg(&args, "url")})
    };
    let scope = if str_arg(&args, "scope") == Some("project") {
        "project"
    } else {
        "user"
    };
    let added = ctx
        .rpc(json!({"type": "mcp_add", "name": arg(&args, "name"), "config": config, "scope": scope}), None)
        .await?;
    let server = added.get("server").and_then(Value::as_object);
    let state = match server {
        Some(server) => mcp_server_line(server),
        None => format!("{}: added", arg(&args, "name")),
    };
    let next = match server {
        Some(server) if needs_sign_in(server) => {
            format!(" {}", mcp_sign_in_next(&js_string(server.get("name"))))
        }
        _ => String::new(),
    };
    Ok(ActionResult::changed(
        format!(
            "Added MCP server {}. {state}. {MCP_LIVE_NOTE}{next}",
            arg(&args, "name")
        ),
        "Added MCP server",
        "MCP 서버 추가",
        arg(&args, "name"),
    ))
}

async fn h_extensions_mcp_servers<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    let data = ctx.rpc(json!({"type": "get_mcp_servers"}), None).await?;
    let servers = servers_of(&data);
    if servers.is_empty() {
        return Ok(ActionResult::text("No MCP server is configured."));
    }
    Ok(ActionResult::text(
        servers
            .iter()
            .map(|server| mcp_server_line(server))
            .collect::<Vec<_>>()
            .join("\n"),
    ))
}

async fn h_extensions_mcp_sign_in<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let name = arg(&args, "name");
    // The login waits on the person (up to 5 minutes); answer once it is under way, or with an early refusal.
    let login = {
        let ctx = ctx.clone();
        let name = name.clone();
        start(async move {
            ctx.rpc(json!({"type": "mcp_reauth", "name": name}), None)
                .await
        })
    };
    let mut login = login;
    let early = match tokio::time::timeout(MCP_SIGN_IN_EARLY, &mut login).await {
        Err(_) => {
            // The handle is dropped: the login runs on and nobody waits for it.
            return Ok(ActionResult::text(format!(
                "Sign-in for MCP server {name} started: the person finishes it in the browser page shown in this session. When it succeeds the server connects in every open session; check with extensions.mcp_servers."
            )));
        }
        Ok(joined) => joined.map_err(|error| Fault::new("task_failed", error.to_string()))??,
    };
    if early.get("ok") == Some(&Value::Bool(false)) {
        let error = match early.get("error") {
            None | Some(Value::Null) => "unknown error".to_string(),
            other => js_string(other),
        };
        return Err(refusal(format!(
            "Sign-in for {name} did not finish: {error}."
        )));
    }
    Ok(ActionResult::text(format!(
        "Signed in to MCP server {name}. {MCP_LIVE_NOTE}"
    )))
}

async fn h_extensions_mcp_use<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let name = arg(&args, "name");
    let adopted = ctx
        .rpc(
            json!({"type": "mcp_action", "name": name, "action": "adopt"}),
            None,
        )
        .await?;
    let listed = ctx.rpc(json!({"type": "get_mcp_servers"}), None).await?;
    let server = servers_of(&listed)
        .into_iter()
        .find(|server| server.get("name").and_then(Value::as_str) == Some(name.as_str()));
    let from = match adopted.get("from") {
        None | Some(Value::Null) => "the other tool".to_string(),
        other => js_string(other),
    };
    let line = server.map_or(String::new(), mcp_server_line);
    let next = match server {
        Some(server) if needs_sign_in(server) => format!(" {}", mcp_sign_in_next(&name)),
        _ => String::new(),
    };
    Ok(ActionResult::changed(
        format!(
            "Copied MCP server {name} from {from}'s config into omp's. {line}. {MCP_LIVE_NOTE}{next}"
        ),
        "Using MCP server",
        "MCP 서버 사용",
        name,
    ))
}

async fn h_remote_list_tailnet<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    let computers = ctx.invoke(REMOTE_WATCH_TAILNET, vec![json!(true)]).await?;
    ctx.invoke(REMOTE_WATCH_TAILNET, vec![json!(false)]).await?;
    let computers = records(Some(&computers));
    if computers.is_empty() {
        return Ok(ActionResult::text(
            "No other computer of the tailnet is online.",
        ));
    }
    Ok(ActionResult::text(
        computers
            .iter()
            .map(|computer| {
                let login = truthy(computer.get("login"));
                let refusal = truthy(computer.get("refusal"));
                format!(
                    "node {}: {}{}, {}{}{}",
                    js_string(computer.get("nodeId")),
                    js_string(computer.get("name")),
                    if login {
                        format!(" ({})", js_string(computer.get("login")))
                    } else {
                        String::new()
                    },
                    js_string(computer.get("state")),
                    if refusal {
                        format!(" ({})", js_string(computer.get("refusal")))
                    } else {
                        String::new()
                    },
                    if truthy(computer.get("connected")) {
                        ", connected"
                    } else {
                        ""
                    },
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
    ))
}

async fn h_remote_connect<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let host = ctx
        .invoke(REMOTE_CONNECT, vec![json!(arg(&args, "nodeId"))])
        .await?;
    Ok(ActionResult::changed(
        format!(
            "Connected to {} ({}).",
            js_string(host.get("name")),
            js_string(host.get("deviceId"))
        ),
        "Connected computer",
        "연결한 컴퓨터",
        js_string(host.get("name")),
    ))
}

async fn h_remote_block<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.invoke(REMOTE_BLOCK_PEER, vec![json!(arg(&args, "deviceId"))])
        .await?;
    Ok(ActionResult::changed(
        "Blocked.",
        "Blocked device",
        "차단한 기기",
        arg(&args, "deviceId"),
    ))
}

async fn h_remote_unblock<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let blocks = ctx.invoke(WEB_BLOCKS_LIST, vec![]).await?;
    let blocks = records(Some(&blocks));
    let wanted = arg(&args, "block");
    let entry = blocks
        .iter()
        .find(|block| block.get("id").and_then(Value::as_str) == Some(wanted.as_str()))
        .or_else(|| {
            blocks
                .iter()
                .find(|block| block.get("name").and_then(Value::as_str) == Some(wanted.as_str()))
        });
    let Some(entry) = entry else {
        return Err(refusal(format!("No block named {wanted}.")));
    };
    ctx.invoke(
        WEB_BLOCKS_REMOVE,
        vec![entry.get("id").cloned().unwrap_or(Value::Null)],
    )
    .await?;
    Ok(ActionResult::changed(
        "Unblocked.",
        "Unblocked device",
        "차단 해제",
        js_string(entry.get("name")),
    ))
}

async fn h_remote_set_allowed_users<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let users = string_list(args.get("users"));
    ctx.invoke(
        MOBILE_WEB_COMMAND,
        vec![json!({"action": "set-allowed-users", "users": users})],
    )
    .await?;
    Ok(ActionResult::changed(
        "Allowed accounts saved.",
        "Allowed accounts",
        "허용 계정",
        users.join(", "),
    ))
}

async fn h_remote_devices<P: AppPorts>(ctx: Ctx<P>, _args: Args) -> Done {
    let state = ctx.invoke(REMOTE_GET_STATE, vec![]).await?;
    let mut lines = vec![format!(
        "This computer: {}",
        js_string(state.get("host").and_then(|host| host.get("name")))
    )];
    lines.extend(records(state.get("hosts")).iter().map(|host| {
        format!(
            "host {}: {} ({})",
            js_string(host.get("deviceId")),
            js_string(host.get("name")),
            js_string(host.get("state"))
        )
    }));
    lines.extend(
        records(state.get("host").and_then(|host| host.get("peers")))
            .iter()
            .map(|peer| {
                format!(
                    "device {}: {} ({})",
                    js_string(peer.get("deviceId")),
                    js_string(peer.get("name")),
                    if truthy(peer.get("online")) {
                        "online"
                    } else {
                        "offline"
                    }
                )
            }),
    );
    Ok(ActionResult::text(lines.join("\n")))
}

async fn h_remote_rename_this_computer<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.invoke(REMOTE_SET_DEVICE_NAME, vec![json!(arg(&args, "name"))])
        .await?;
    Ok(ActionResult::changed(
        "Renamed.",
        "Device name",
        "기기 이름",
        arg(&args, "name"),
    ))
}

async fn h_remote_rename_host<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.invoke(
        REMOTE_RENAME_HOST,
        vec![json!({"deviceId": arg(&args, "deviceId"), "name": arg(&args, "name")})],
    )
    .await?;
    Ok(ActionResult::changed(
        "Renamed.",
        "Computer name",
        "컴퓨터 이름",
        arg(&args, "name"),
    ))
}

async fn h_remote_rename_device<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    ctx.invoke(
        REMOTE_RENAME_PEER,
        vec![json!({"deviceId": arg(&args, "deviceId"), "name": arg(&args, "name")})],
    )
    .await?;
    Ok(ActionResult::changed(
        "Renamed.",
        "Device name",
        "기기 이름",
        arg(&args, "name"),
    ))
}

async fn h_mobile_web_rename_device<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let devices = ctx.invoke(WEB_DEVICES_LIST, vec![]).await?;
    let devices = records(Some(&devices));
    let wanted = arg(&args, "device");
    let device = devices
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(wanted.as_str()))
        .or_else(|| {
            devices
                .iter()
                .find(|entry| entry.get("name").and_then(Value::as_str) == Some(wanted.as_str()))
        });
    let Some(device) = device else {
        return Err(refusal(format!("No phone-page device named {wanted}.")));
    };
    ctx.invoke(
        WEB_DEVICES_RENAME,
        vec![
            device.get("id").cloned().unwrap_or(Value::Null),
            json!(arg(&args, "name")),
        ],
    )
    .await?;
    Ok(ActionResult::changed(
        "Renamed.",
        "Device name",
        "기기 이름",
        arg(&args, "name"),
    ))
}

async fn h_autopilot_status<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    Ok(ActionResult::text(
        ctx.autopilot(json!({"action": "status", "session": args.get("session")}))
            .await?,
    ))
}

async fn h_autopilot_start<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut request = json!({"action": "start"});
    for key in ["folder", "device", "ship"] {
        if let Some(value) = args.get(key) {
            request[key] = value.clone();
        }
    }
    Ok(ActionResult::text(ctx.autopilot(request).await?))
}

async fn h_autopilot_stop<P: AppPorts>(ctx: Ctx<P>, args: Args) -> Done {
    let mut request = json!({"action": "stop", "session": args.get("session")});
    if let Some(now) = args.get("now") {
        request["now"] = now.clone();
    }
    Ok(ActionResult::text(ctx.autopilot(request).await?))
}
