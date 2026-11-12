//! The module-level functions of `service.ts` and `branches.ts` (`mergeProblem`, `boundDiff`): every text an agent
//! reads, the ids and names a session is told by, and the rules over transcripts. Pure; each is replayed against
//! tables captured from the TypeScript (`captured.json`, `tests.rs`). Cuts count UTF-16 units as JavaScript did (`js`).

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::fail::{Fail, R, fail};
use super::js::{self, cut, head, len16, number, one_line, slice16, tail16, trim, trim_end};
use super::types::{
    AgentMessage, AutopilotArgs, AutopilotStart, Block, BranchFacts, ClosedChild, Content,
    ControlAsk, ControlTab, MergePrediction, MessagesPage, OpenElsewhere, RunStatus, ScheduleRow,
    ScheduleRun, StoredSession, StoredWork, TabStatus, Tool, UiRequest, WorktreeRef,
    WorktreeSetupReport,
};
use super::wrap::{
    AGENT_CARD_PREFIX, AGENT_SCHEDULE_PREFIX, agent_task_title, dispatch_mark, parse_agent_message,
    request_mark, wrap_agent_message,
};
use crate::agentctl::journal::call_journal::{CallIntent, ScheduleIntent};
use crate::agentctl::journal::pending_cleanups::{CleanupAction, PendingCleanup};

pub const SUMMARY_CHARS: usize = 200;
pub const SESSION_PREFIX_MIN: usize = 4;
pub const TITLE_PREFIX_MIN: usize = 3;
pub const TOOL_RESULT_CHARS: usize = 300;
pub const MESSAGE_CHARS: usize = 1_500;
pub const LIST_DEFAULT_ROWS: usize = 30;
/// `READ_MAX_CHARS` of `tools.ts`: a read returns at most this many characters per page.
pub const READ_MAX_CHARS: usize = 16_000;
const CHECK_TAIL_CHARS: usize = 1_200;
/// Reports after which a session waits for, or no longer expects, its receiver's next message in the same turn.
pub const WAITS_AFTER_REPORT: [&str; 4] = ["done", "review", "question", "blocked"];
/// Stock's label for the custom-answer row of a choice card.
pub const OTHER_OPTION: &str = "Other (type your own)";

/// Where a session open in no tab of this app is open: on `computer`, in a tab it runs for `holder` or its own.
pub fn open_in_text(computer: &str, holder: Option<&str>) -> String {
    match holder.filter(|holder| !holder.is_empty()) {
        Some(holder) => format!("open in a tab {computer} runs for {holder}"),
        None => format!("open in a tab on {computer}"),
    }
}

/// Where a saved session no tab of this app holds is open and what it does there; "" when nowhere. `step` is its
/// running tool call.
pub fn open_elsewhere_text(row: &StoredSession, step: Option<&str>) -> String {
    let Some(open) = &row.elsewhere else {
        return String::new();
    };
    let computer = match &row.device {
        Some(device) => row.device_name.as_deref().unwrap_or(device),
        None => "this computer",
    };
    let where_ = open_in_text(computer, open.holder.as_deref());
    let Some(work) = open.work else {
        return where_;
    };
    let work = match work {
        StoredWork::Turn => match step.filter(|step| !step.is_empty()) {
            Some(step) => format!("running, {step}"),
            None => "running".to_owned(),
        },
        StoredWork::Background => "running (background work still going)".to_owned(),
        StoredWork::Waiting => "waiting for the user's answer there".to_owned(),
        StoredWork::Idle => "idle".to_owned(),
    };
    format!("{where_}: {work}")
}

/// The task text with the dispatch id its report names (a report for an older dispatch is ignored).
pub fn with_dispatch(message: &str, dispatch: Option<&str>, request_id: Option<&str>) -> String {
    let mut marks = Vec::new();
    if let Some(dispatch) = dispatch.filter(|dispatch| !dispatch.is_empty()) {
        marks.push(format!(
            "{} report with ompdesk_report, dispatch \"{dispatch}\"]",
            dispatch_mark(dispatch)
        ));
    }
    if let Some(id) = request_id.filter(|id| !id.is_empty()) {
        marks.push(request_mark(id));
    }
    if marks.is_empty() {
        message.to_owned()
    } else {
        format!("{message}\n\n{}", marks.join("\n"))
    }
}

/// The dispatch number and request ids a session's journal holds (the markers its opener's messages carried).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct JournalMarks {
    pub dispatch: u64,
    pub requests: HashSet<String>,
}

/// `journalMarks`: `/\[ompdesk dispatch d(\d+):/g` and `/\[ompdesk request ([^\]]+)\]/g` over the user messages.
pub fn journal_marks(messages: &[AgentMessage]) -> JournalMarks {
    const DISPATCH: &str = "[ompdesk dispatch d";
    const REQUEST: &str = "[ompdesk request ";
    let mut marks = JournalMarks::default();
    for message in messages {
        if message.role != "user" {
            continue;
        }
        let text = content_text(message.content.as_ref());
        let mut from = 0;
        while let Some(at) = text[from..].find(DISPATCH) {
            let start = from + at + DISPATCH.len();
            let digits = text[start..].bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 && text[start + digits..].starts_with(':') {
                let number = text[start..start + digits].parse().unwrap_or(u64::MAX);
                marks.dispatch = marks.dispatch.max(number);
                from = start + digits + 1;
            } else {
                from += at + 1;
            }
        }
        let mut from = 0;
        while let Some(at) = text[from..].find(REQUEST) {
            let start = from + at + REQUEST.len();
            match text[start..].find(']') {
                Some(end) if end > 0 => {
                    marks.requests.insert(text[start..start + end].to_owned());
                    from = start + end + 1;
                }
                _ => from += at + 1,
            }
        }
    }
    marks
}

/// Why a tab that is `exited` or `error` cannot work, with the reason its omp gave.
pub fn start_failure(tab: &ControlTab) -> String {
    let what = if tab.status == TabStatus::Exited {
        "its omp process exited"
    } else {
        "its omp failed to start"
    };
    let reason = match tab
        .failure
        .as_deref()
        .map(trim)
        .filter(|text| !text.is_empty())
    {
        Some(_) => format!(" ({})", one_line(tab.failure.as_deref().unwrap_or(""), 600)),
        None => ", and it gave no reason".to_owned(),
    };
    format!("The session could not start: {what}{reason}.")
}

/// `<script> failed (exit 3)` or `<script> failed (timed out after 120s)`, for a hook's failure text.
pub fn hook_failure(hook: &WorktreeSetupReport) -> String {
    let how = if hook.timed_out {
        format!(
            "timed out after {}s",
            number((hook.duration_ms / 1000.0).round())
        )
    } else {
        format!(
            "exit {}",
            hook.exit_code.map_or_else(|| "null".to_owned(), number)
        )
    };
    format!("{} failed ({how})", hook.script)
}

/// How long a turn has run, for a session's state line (`running, <step>, for 12 min`).
pub fn elapsed_text(ms: f64) -> String {
    let x = ms / 1000.0;
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    let seconds = rounded.max(0.0) as u64;
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let rest = minutes % 60;
    if rest == 0 {
        format!("{} h", minutes / 60)
    } else {
        format!("{} h {rest} min", minutes / 60)
    }
}

/// The id a session path carries: stock names a session file `<time>_<session id>.jsonl`.
pub fn saved_id_of_path(path: Option<&str>) -> Option<String> {
    let stem = path?.strip_suffix(".jsonl")?;
    let at = stem.rfind(['_', '/', '\\'])?;
    (stem.as_bytes()[at] == b'_' && at + 1 < stem.len()).then(|| stem[at + 1..].to_owned())
}

fn is_quote(c: char) -> bool {
    matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’')
}

/// A name as an agent typed it, without the quotes it may have wrapped around the id.
pub fn unquoted(session: &str) -> String {
    trim(
        session
            .trim_start_matches(is_quote)
            .trim_end_matches(is_quote),
    )
    .to_owned()
}

/// Every id that names an open session: its tab id, the ids it had before relaunches and its saved id.
pub fn ids_of(tab: &ControlTab) -> Vec<String> {
    let mut ids = vec![tab.tab_id.clone()];
    ids.extend(tab.former_ids.iter().cloned());
    ids.extend(saved_id_of_path(tab.session_path.as_deref()));
    ids
}

/// `todos 2/5 done (now: ...)`, or None when the session has no todos.
pub fn todo_progress(phases: &[super::types::TodoPhase]) -> Option<String> {
    let tasks: Vec<_> = phases.iter().flat_map(|phase| &phase.tasks).collect();
    if tasks.is_empty() {
        return None;
    }
    let done = tasks
        .iter()
        .filter(|task| task.status == "completed" || task.status == "abandoned")
        .count();
    let current = tasks.iter().find(|task| task.status == "in_progress");
    Some(format!(
        "todos {done}/{} done{}",
        tasks.len(),
        current.map_or_else(String::new, |task| format!(
            " (now: {})",
            one_line(&task.content, 80)
        ))
    ))
}

/// The session waits on someone: an open ask or approval, or a plan proposal awaiting approval.
pub fn waits(tab: &ControlTab) -> bool {
    !tab.asks.is_empty() || tab.plan.is_some()
}

/// A saved session's name: its title, else the task an agent opened it for, else its first message.
pub fn stored_title(row: &StoredSession) -> String {
    if !row.title.is_empty() {
        return row.title.clone();
    }
    if let Some(task) = agent_task_title(&row.first_message).filter(|task| !task.is_empty()) {
        return task;
    }
    if !row.first_message.is_empty() {
        return row.first_message.clone();
    }
    "(untitled)".to_owned()
}

/// Calls whose effect a second run would repeat: recorded. Reads and a notification are not.
pub fn mutates(tool: Tool, args: &Value) -> bool {
    let action = args.get("action").and_then(Value::as_str);
    match tool {
        Tool::Open | Tool::Send | Tool::Answer | Tool::Stop | Tool::Merge | Tool::App => true,
        Tool::Schedule => action != Some("list"),
        Tool::Autopilot => action != Some("status"),
        _ => false,
    }
}

/// What a recorded call sets out to do, so its effect can be found after a relaunch.
pub fn call_intent(tool: Tool, args: &Value, caller: &ControlTab) -> Option<CallIntent> {
    let fields = args.as_object()?;
    if tool == Tool::Open {
        let items: Vec<&Value> = match fields.get("sessions") {
            Some(Value::Array(sessions)) => sessions.iter().collect(),
            _ => vec![args],
        };
        let open = items
            .into_iter()
            .filter_map(|item| {
                let item = item.as_object()?;
                let message = item
                    .get("message")
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty())?;
                // `!reopen`: a reopen is no new session.
                let reopen = item.get("reopen");
                let reopens = match reopen {
                    None | Some(Value::Null) | Some(Value::Bool(false)) => false,
                    Some(Value::String(text)) => !text.is_empty(),
                    Some(Value::Number(number)) => number.as_f64() != Some(0.0),
                    Some(_) => true,
                };
                (!reopens).then(|| {
                    // One entry per new session; "" when the brief names no task.
                    agent_task_title(&wrap_agent_message(message, &caller.title, None))
                        .unwrap_or_default()
                })
            })
            .collect();
        return Some(CallIntent {
            open: Some(open),
            ..CallIntent::default()
        });
    }
    if tool == Tool::Schedule && fields.get("action").and_then(Value::as_str) == Some("create") {
        let name = fields.get("name").and_then(Value::as_str).unwrap_or("");
        return Some(CallIntent {
            schedule: Some(ScheduleIntent {
                name: format!("{AGENT_SCHEDULE_PREFIX}{name}"),
                device: fields
                    .get("device")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }),
            ..CallIntent::default()
        });
    }
    None
}

/// The last path segment of a folder (`cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd`).
fn folder_name(cwd: &str) -> &str {
    cwd.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(cwd)
}

/// How a line names a session: its title, or `(untitled, in <folder>)`.
pub fn label(tab: &ControlTab) -> String {
    if tab.hidden {
        return format!("{} (hidden from agents)", tab.tab_id);
    }
    if tab.title.is_empty() {
        format!("(untitled, in {})", folder_name(&tab.cwd))
    } else {
        format!("\"{}\"", one_line(&tab.title, 80))
    }
}

/// A session as a line names the one it is: its title, then its saved id and the computer it runs on.
pub fn named(tab: &ControlTab) -> String {
    let saved = if tab.hidden {
        None
    } else {
        saved_id_of_path(tab.session_path.as_deref())
    };
    let mut facts = Vec::new();
    if let Some(saved) = saved {
        facts.push(format!("saved id {saved}"));
    }
    if let Some(name) = tab.device_name.as_deref().filter(|name| !name.is_empty()) {
        facts.push(format!("on {name}"));
    }
    if facts.is_empty() {
        label(tab)
    } else {
        format!("{} ({})", label(tab), facts.join(", "))
    }
}

/// How a fate names a close or delete the caller made with `ompdesk_session_stop`.
pub fn by_caller(caller: &ControlTab) -> String {
    let who = if caller.title.is_empty() {
        "an agent's session".to_owned()
    } else {
        format!("the session \"{}\"", one_line(&caller.title, 60))
    };
    format!("{who} (ompdesk_session_stop)")
}

/// Who a refused cleanup is kept for: the caller's session file and computer, else its tab id.
pub fn cleanup_caller(caller: &ControlTab) -> String {
    match &caller.session_path {
        Some(path) => format!("{}\n{path}", caller.device.as_deref().unwrap_or("")),
        None => caller.tab_id.clone(),
    }
}

/// What `close` and `delete` ask of a stop.
#[derive(Clone, Copy, Debug, Default)]
pub struct StopFlags {
    pub close: bool,
    pub delete: bool,
}

/// A stop, close or delete of `target` as `caller` asked for it, at `at` (epoch ms).
pub fn cleanup_of(
    caller: &ControlTab,
    target: &ControlTab,
    flags: StopFlags,
    at: f64,
) -> PendingCleanup {
    PendingCleanup {
        caller: cleanup_caller(caller),
        path: target.session_path.clone(),
        device: target.device.clone(),
        tab_id: target.tab_id.clone(),
        title: if target.hidden {
            String::new()
        } else if !target.title.is_empty() {
            target.title.clone()
        } else {
            target.task.clone().unwrap_or_default()
        },
        action: if flags.delete {
            CleanupAction::Delete
        } else if flags.close {
            CleanupAction::Close
        } else {
            CleanupAction::Stop
        },
        at,
    }
}

/// Why a session is not stopped, closed or deleted in this turn (`needsPersonTurn`).
pub fn in_use_refusal(tab: &ControlTab, flags: StopFlags) -> String {
    let outcome = if flags.delete {
        "it was not deleted"
    } else if flags.close {
        "it stays open"
    } else {
        "it keeps running"
    };
    let why = if tab.user_touched {
        "the user typed into it"
    } else {
        "it is in the user's view and you did not open it"
    };
    format!(
        "{}: {why}, and your current turn was not started by the user's own message (another agent's message, a report, a schedule or Autopilot started it): {outcome}. Only a turn the user's own message starts may stop, close or delete it; ask the user.",
        label(tab)
    )
}

/// A folder as two spellings of it compare: either slash, no trailing one, and a Windows drive path in any case.
pub fn folder_key(folder: &str) -> String {
    let plain = trim(folder).replace('\\', "/");
    let plain = plain.trim_end_matches('/');
    let bytes = plain.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/' {
        plain.to_lowercase()
    } else {
        plain.to_owned()
    }
}

/// "next 2026-…" ("next —" while every schedule is paused), "off", "done" (a once that ran), "waits for its event".
pub fn schedule_state(row: &ScheduleRow) -> String {
    use super::types::ScheduleFrequency as Frequency;
    if !row.enabled {
        let once_ran = matches!(row.frequency, Frequency::Once { .. })
            && row
                .last_status
                .as_deref()
                .is_some_and(|status| !status.is_empty());
        return if once_ran { "done" } else { "off" }.to_owned();
    }
    if matches!(row.frequency, Frequency::Event { .. }) {
        return "waits for its event".to_owned();
    }
    format!("next {}", row.next_run.as_deref().unwrap_or("—"))
}

/// How to call a webhook trigger: the path and the key it answers to.
pub fn webhook_line(row: &ScheduleRow) -> String {
    use super::types::{ScheduleEvent, ScheduleFrequency as Frequency};
    let Frequency::Event {
        event: ScheduleEvent::Webhook { key },
    } = &row.frequency
    else {
        return String::new();
    };
    format!(
        " Webhook: POST /hooks/{} on that computer's OMPdesk web server (on while Mobile web is on: http://127.0.0.1:<its port> there, or its Mobile web link from the tailnet) with the header \"Authorization: Bearer {key}\"; the request body is passed to the run.",
        row.id
    )
}

/// `ompdesk_schedule {"action":"runs"}`: the kept runs, newest first, with what fired them and why one failed.
pub fn schedule_runs_text(row: &ScheduleRow, runs: &[ScheduleRun]) -> String {
    if runs.is_empty() {
        return format!("“{}” has not run yet; {}.", row.name, schedule_state(row));
    }
    let mut lines = vec![format!(
        "Runs of “{}” ({}, newest first; {}):",
        row.name,
        runs.len(),
        schedule_state(row)
    )];
    for run in runs {
        let trigger = match run.trigger.as_str() {
            "manual" => "test",
            "event" => "event",
            _ => "timer",
        };
        let detail = run
            .detail
            .as_deref()
            .filter(|detail| !detail.is_empty())
            .map_or_else(String::new, |detail| {
                format!(" — fired by: {}", one_line(detail, 300))
            });
        let error = run
            .error
            .as_deref()
            .filter(|error| !error.is_empty())
            .map_or_else(String::new, |error| {
                format!(
                    " — {}: {}",
                    if run.status == "skipped" {
                        "why"
                    } else {
                        "reason"
                    },
                    one_line(error, 300)
                )
            });
        let ended = run
            .ended_at
            .as_deref()
            .filter(|ended| !ended.is_empty())
            .map_or_else(String::new, |ended| format!(" ended {ended}"));
        lines.push(format!(
            "- {} {} ({trigger}){ended}{error}{detail}",
            run.started_at, run.status
        ));
    }
    lines.join("\n")
}

/// A path without trailing separators (a root stays as it is).
pub fn trim_separators(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let drive = trimmed.len() == 2
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
        && trimmed.as_bytes()[1] == b':';
    if trimmed.is_empty() || drive {
        path.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `ompdesk_autopilot`'s ship levels as the start sheet's presets.
fn ship_preset(ship: &str) -> &'static str {
    match ship {
        "push" => "push",
        "release" => "release",
        _ => "local",
    }
}

/// `ompdesk_autopilot start` arguments as the start sheet's options, with the level always named (never Automatic).
pub fn start_options(args: &AutopilotArgs, ship: &str) -> Map<String, Value> {
    let AutopilotArgs::Start(start) = args else {
        return Map::new();
    };
    let AutopilotStart {
        guide,
        branch,
        advanced,
        ..
    } = &**start;
    let advanced = advanced.clone().unwrap_or_default();
    let mut policy = Map::new();
    if let Some(remote) = advanced.remote.as_ref().filter(|remote| !remote.is_empty()) {
        policy.insert("remote".into(), json!(remote));
    }
    if let Some(cadence) = advanced.cadence {
        policy.insert(
            "autoRelease".into(),
            json!({ "on": true, "cadence": { "kind": "every", "n": cadence } }),
        );
    }
    let mut options = Map::new();
    options.insert("preset".into(), json!(ship_preset(ship)));
    if !policy.is_empty() {
        options.insert("ship".into(), Value::Object(policy));
    }
    if let Some(guide) = guide.as_ref().filter(|guide| !guide.is_empty()) {
        options.insert("guide".into(), json!(guide));
    }
    if let Some(branch) = branch {
        options.insert(
            "branch".into(),
            match branch {
                super::types::AutopilotBranch::New { name } => match name {
                    Some(name) => json!({ "kind": "new", "name": name }),
                    None => json!({ "kind": "new" }),
                },
                super::types::AutopilotBranch::Existing { name } => {
                    json!({ "kind": "existing", "name": name })
                }
            },
        );
    }
    if let Some(focus) = &advanced.focus {
        options.insert("focus".into(), json!(focus));
    }
    if let Some(limits) = &advanced.limits {
        let mut map = Map::new();
        for (key, value) in [
            ("tokens", limits.tokens),
            ("minutes", limits.minutes),
            ("cycles", limits.cycles),
            ("usd", limits.usd),
        ] {
            if let Some(value) = value {
                map.insert(key.into(), json!(value));
            }
        }
        options.insert("limits".into(), Value::Object(map));
    }
    options
}

fn verify_text(verify: &Value) -> String {
    match verify {
        Value::String(text) => text.clone(),
        Value::Null => "undefined".to_owned(),
        other => other.to_string(),
    }
}

/// A run's state as a short report for the agent.
pub fn describe_run(tab_id: &str, title: &str, status: &RunStatus) -> String {
    let reason = match status.reason.as_deref().filter(|reason| !reason.is_empty()) {
        Some(reason) => format!(
            " ({reason}{})",
            status
                .detail
                .as_deref()
                .filter(|detail| !detail.is_empty())
                .map_or_else(String::new, |detail| format!(": {}", one_line(detail, 160)))
        ),
        None => String::new(),
    };
    let title_part = if title.is_empty() {
        String::new()
    } else {
        format!(" \"{}\"", one_line(title, 80))
    };
    let mut lines = vec![format!(
        "Autopilot run {tab_id}{title_part}: {}{reason}; cycle {}.",
        status.state.as_deref().unwrap_or("unknown"),
        number(status.cycle.unwrap_or(0.0))
    )];
    if let Some(branch) = status.branch.as_deref().filter(|branch| !branch.is_empty()) {
        let target = status
            .target
            .as_deref()
            .filter(|target| !target.is_empty())
            .map_or_else(String::new, |target| format!(", pushes to {target}"));
        lines.push(format!(
            "branch {branch}, base {}{target}, worktree {}",
            status.base_branch.as_deref().unwrap_or("?"),
            status.root.as_deref().unwrap_or("?")
        ));
    }
    let policy = status
        .ship
        .as_ref()
        .and_then(|ship| ship.policy.as_ref())
        .or_else(|| {
            status
                .settings
                .as_ref()
                .and_then(|settings| settings.ship.as_ref())
        });
    if let Some(policy) = policy {
        let level = if policy.auto_release.on {
            "release"
        } else if policy.auto_push {
            "push"
        } else {
            "commit"
        };
        lines.push(format!("ship level {level}, remote {}", policy.remote));
    }
    lines.push(match &status.now {
        Some(now) => format!(
            "now: cycle {}{}{}",
            number(now.n),
            now.area
                .as_deref()
                .filter(|area| !area.is_empty())
                .map_or_else(String::new, |area| format!(" [{area}]")),
            now.title
                .as_deref()
                .filter(|title| !title.is_empty())
                .map_or_else(String::new, |title| format!(
                    " \"{}\"",
                    one_line(title, 100)
                ))
        ),
        None => "now: between cycles".to_owned(),
    });
    lines.push(format!(
        "red streak {}",
        number(status.red_streak.unwrap_or(0.0))
    ));
    let commit = status.cycles.iter().rev().find(|cycle| {
        cycle
            .commit
            .as_deref()
            .is_some_and(|commit| !commit.is_empty())
            && !cycle.reverted
    });
    lines.push(match commit {
        Some(cycle) => format!(
            "last commit {} (cycle {}, \"{}\", verify {})",
            slice16(cycle.commit.as_deref().unwrap_or(""), 0, 9),
            number(cycle.n),
            one_line(&cycle.title, 80),
            verify_text(&cycle.verify)
        ),
        None => "last commit: none yet".to_owned(),
    });
    let push = status
        .ship
        .as_ref()
        .and_then(|ship| ship.queue.iter().rev().find(|item| item.kind == "push"));
    lines.push(match push {
        Some(item) => format!(
            "last push {}{}{}",
            item.state,
            item.sha
                .as_deref()
                .filter(|sha| !sha.is_empty())
                .map_or_else(String::new, |sha| format!(" {}", slice16(sha, 0, 9))),
            item.detail
                .as_deref()
                .filter(|detail| !detail.is_empty())
                .map_or_else(String::new, |detail| format!(
                    " ({})",
                    one_line(detail, 100)
                ))
        ),
        None => "last push: none yet".to_owned(),
    });
    lines.push(
        match status.ship.as_ref().and_then(|ship| ship.release.as_ref()) {
            Some(release) => format!(
                "last release {} {}{}",
                release.version,
                release.state,
                release
                    .run_url
                    .as_deref()
                    .filter(|url| !url.is_empty())
                    .map_or_else(String::new, |url| format!(" {url}"))
            ),
            None => "last release: none yet".to_owned(),
        },
    );
    let children = status
        .children
        .iter()
        .filter(|child| child.status == "running")
        .count();
    if children > 0 {
        lines.push(format!("{children} child session(s) running"));
    }
    if status.state.as_deref() == Some("paused") {
        lines.push(
            "It does not continue by itself: the user resumes it on the Autopilot screen.".into(),
        );
    }
    if status.state.as_deref() == Some("waiting_quota") {
        let at = status
            .quota_reset_at
            .filter(|at| *at != 0.0)
            .map_or_else(String::new, |at| {
                format!(" at {}", crate::aimemory::value::iso(at.max(0.0) as u64))
            });
        lines.push(format!(
            "It waits for the account's usage limit and goes on by itself{at}."
        ));
    }
    lines.join("\n")
}

/// `contentText`: a message's text blocks, one per line.
pub fn content_text(content: Option<&Content>) -> String {
    match content {
        None => String::new(),
        Some(Content::Text(text)) => text.clone(),
        Some(Content::Blocks(blocks)) => blocks
            .iter()
            .filter_map(|block| match block {
                Block::Text(text) if !text.is_empty() => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// One transcript message as a line for another agent; None for the rows an agent has no use for.
pub fn render_message(message: &AgentMessage) -> Option<String> {
    match message.role.as_str() {
        "user" => {
            let text = content_text(message.content.as_ref());
            let text = trim(&text);
            if text.is_empty() {
                return None;
            }
            let wrapped = parse_agent_message(text);
            // The saved id names the sender for an answer; titles repeat, and a message before it carried none.
            let sender = wrapped.as_ref().map_or_else(String::new, |wrapped| {
                let mut parts = Vec::new();
                if !wrapped.from.is_empty() {
                    parts.push(one_line(&wrapped.from, 60));
                }
                if let Some(session) = &wrapped.session {
                    parts.push(format!("saved id {session}"));
                }
                parts.join(", ")
            });
            let head = if wrapped.is_some() {
                if sender.is_empty() {
                    "[user, sent by an agent]".to_owned()
                } else {
                    format!("[user, sent by an agent ({sender})]")
                }
            } else {
                "[user]".to_owned()
            };
            let body = wrapped
                .as_ref()
                .map_or(text, |wrapped| wrapped.body.as_str());
            Some(format!("{head} {}", cut(body, MESSAGE_CHARS)))
        }
        "assistant" => {
            let mut parts = Vec::new();
            let text = content_text(message.content.as_ref());
            let text = trim(&text);
            if !text.is_empty() {
                parts.push(format!("[assistant] {}", cut(text, MESSAGE_CHARS)));
            }
            if let Some(Content::Blocks(blocks)) = &message.content {
                for block in blocks {
                    if let Block::ToolCall { name, intent, .. } = block {
                        let intent = intent
                            .as_deref()
                            .filter(|intent| !intent.is_empty())
                            .map_or_else(String::new, |intent| {
                                format!(": {}", one_line(intent, 120))
                            });
                        parts.push(format!("[tool call] {name}{intent}"));
                    }
                }
            }
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        "toolResult" => {
            let text = one_line(&content_text(message.content.as_ref()), TOOL_RESULT_CHARS);
            let line = format!(
                "[tool result{}] {} {text}",
                if message.is_error { " (error)" } else { "" },
                message.tool_name.as_deref().unwrap_or("")
            );
            Some(trim_end(&line).to_owned())
        }
        "bashExecution" => Some(format!(
            "[bash] {} → exit {}",
            one_line(message.command.as_deref().unwrap_or(""), 160),
            message
                .exit_code
                .as_ref()
                .map_or_else(|| "?".to_owned(), ToString::to_string)
        )),
        _ => None,
    }
}

/// A check a session ran: the command, whether it passed, and the end of its output.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct CheckRun {
    pub command: String,
    pub passed: bool,
    /// The last `CHECK_TAIL_CHARS` of its output (where runners print their summary and first failures).
    pub tail: String,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `CHECK_COMMAND`: a command line that checks the work (tests, types, lint, build), as a compare reports it.
pub fn is_check_command(command: &str) -> bool {
    const WORDS: [&str; 26] = [
        "test",
        "tests",
        "vitest",
        "jest",
        "pytest",
        "mocha",
        "playwright",
        "tsc",
        "typecheck",
        "check",
        "lint",
        "biome",
        "eslint",
        "ruff",
        "mypy",
        "clippy",
        "build",
        "cargo test",
        "cargo check",
        "cargo build",
        "go test",
        "go vet",
        "go build",
        "gradle",
        "mvn",
        "make",
    ];
    let mut previous: Option<char> = None;
    for (at, c) in command.char_indices() {
        let boundary = previous.is_none_or(|before| !is_word(before)) && is_word(c);
        previous = Some(c);
        if !boundary {
            continue;
        }
        let rest = &command.as_bytes()[at..];
        for word in WORDS {
            if rest.len() >= word.len()
                && rest[..word.len()].eq_ignore_ascii_case(word.as_bytes())
                && command[at + word.len()..]
                    .chars()
                    .next()
                    .is_none_or(|next| !is_word(next))
            {
                return true;
            }
        }
    }
    false
}

/// `/exit(?:ed with)? (?:code )?(\d+)/i`: the first exit code a text names.
fn exit_code_in(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("exit") {
        let start = from + at + 4;
        for prefix in ["ed with ", " "] {
            let Some(rest) = lower[start..].strip_prefix(prefix) else {
                continue;
            };
            let rest_at = lower.len() - rest.len();
            for skip in ["code ", ""] {
                let Some(digits) = lower[rest_at..].strip_prefix(skip) else {
                    continue;
                };
                let digits_at = lower.len() - digits.len();
                let count = digits.bytes().take_while(u8::is_ascii_digit).count();
                if count > 0 {
                    return Some(lower[digits_at..digits_at + count].to_owned());
                }
            }
        }
        from += at + 1;
    }
    None
}

/// The end of a check's output, where runners print their summary and the failures.
pub fn output_tail(text: &str) -> String {
    let trimmed = trim_end(text);
    if len16(trimmed) > CHECK_TAIL_CHARS {
        format!("…{}", tail16(trimmed, CHECK_TAIL_CHARS))
    } else {
        trimmed.to_owned()
    }
}

/// The checks a transcript ran, newest last: the command, whether it passed (exit 0 / no error), its output's end.
pub fn checks_run(messages: &[AgentMessage]) -> Vec<CheckRun> {
    let mut calls: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut checks = Vec::new();
    for message in messages {
        if message.role == "assistant" && matches!(message.content, Some(Content::Blocks(_))) {
            let Some(Content::Blocks(blocks)) = &message.content else {
                continue;
            };
            for block in blocks {
                if let Block::ToolCall {
                    id,
                    name,
                    arguments,
                    ..
                } = block
                    && name == "bash"
                    && let Some(command) = arguments.get("command").and_then(Value::as_str)
                    && is_check_command(command)
                {
                    calls.insert(id.clone(), command.to_owned());
                }
            }
        } else if message.role == "toolResult" {
            let Some(command) = message.tool_call_id.as_ref().and_then(|id| calls.get(id)) else {
                continue;
            };
            let text = content_text(message.content.as_ref());
            let passed = !message.is_error && exit_code_in(&text).is_none_or(|code| code == "0");
            checks.push(CheckRun {
                command: command.clone(),
                passed,
                tail: output_tail(&text),
            });
        } else if message.role == "bashExecution"
            && is_check_command(message.command.as_deref().unwrap_or(""))
        {
            checks.push(CheckRun {
                command: message.command.clone().unwrap_or_default(),
                passed: message
                    .exit_code
                    .as_ref()
                    .and_then(serde_json::Number::as_f64)
                    == Some(0.0),
                tail: output_tail(message.output.as_deref().unwrap_or("")),
            });
        }
    }
    checks
}

/// How a child's transcript ends: what `autoClose` reads where this launch saw nothing of its turns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptEnding {
    /// The final answer: the text of the last assistant message; None when that message has none.
    pub last: Option<String>,
    /// How the last assistant message ended (stock's `stopReason`).
    pub stop_reason: Option<String>,
    /// An `ompdesk_report` of kind `done` to its opener since the last prompt it was given, not refused.
    pub reported_done: bool,
    /// A prompt the person typed (neither an agent's wrapped message nor stock's synthetic one).
    pub person_prompted: bool,
}

/// `ompdesk_report {kind: "done"}` to the opener: as the tool itself, or written to its device.
pub fn is_done_report(name: &str, args: &Value) -> bool {
    let mut report = args.clone();
    if name == "write"
        && args.get("path").and_then(Value::as_str) == Some("xd://ompdesk_report")
        && let Some(content) = args.get("content").and_then(Value::as_str)
    {
        match serde_json::from_str(content) {
            Ok(parsed) => report = parsed,
            Err(_) => return false,
        }
    } else if name != Tool::Report.name() {
        return false;
    }
    // A report to a sibling (`to`) is a note, not the end of the work it was given.
    report.as_object().is_some_and(|fields| {
        fields.get("kind").and_then(Value::as_str) == Some("done") && !fields.contains_key("to")
    })
}

pub fn transcript_ending(messages: &[AgentMessage]) -> TranscriptEnding {
    let mut last = None;
    let mut stop_reason = None;
    let mut person_prompted = false;
    let mut reports: Vec<String> = Vec::new();
    let mut refused: HashSet<&str> = HashSet::new();
    for message in messages {
        match message.role.as_str() {
            "user" => {
                if message.synthetic == Some(true)
                    || message.attribution.as_deref() == Some("agent")
                {
                    continue;
                }
                let text = content_text(message.content.as_ref());
                let text = trim(&text);
                if text.is_empty() {
                    continue;
                }
                // New work: a done report before it no longer speaks for what the session does now.
                reports.clear();
                if parse_agent_message(text).is_none() {
                    person_prompted = true;
                }
            }
            "assistant" => {
                let text = content_text(message.content.as_ref());
                let text = trim(&text);
                last = (!text.is_empty()).then(|| text.to_owned());
                stop_reason = message.stop_reason.clone();
                if let Some(Content::Blocks(blocks)) = &message.content {
                    for block in blocks {
                        if let Block::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } = block
                            && is_done_report(name, arguments)
                        {
                            reports.push(id.clone());
                        }
                    }
                }
            }
            "toolResult" if message.is_error => {
                if let Some(id) = message.tool_call_id.as_deref().filter(|id| !id.is_empty()) {
                    refused.insert(id);
                }
            }
            _ => {}
        }
    }
    TranscriptEnding {
        last,
        stop_reason: stop_reason.filter(|reason| !reason.is_empty()),
        reported_done: reports.iter().any(|id| !refused.contains(id.as_str())),
        person_prompted,
    }
}

/// What `git merge-tree` predicts merging a child's branch into the parent's HEAD would do.
pub fn prediction_line(prediction: &MergePrediction, base: Option<&str>) -> String {
    match prediction {
        MergePrediction::Clean => format!(
            "merge: no conflict with {}",
            base.unwrap_or("the parent's HEAD")
        ),
        MergePrediction::Conflict { files } => format!(
            "merge: would conflict in {} (predicted by git merge-tree; nothing was touched)",
            files.join(", ")
        ),
        MergePrediction::Unknown { reason } => {
            format!("merge: not predicted ({})", one_line(reason, 200))
        }
    }
}

/// What the bridge's `agent_control.judge` answers; an older bridge sends only text, model, usd.
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeReply {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// The role whose chain served it (`advisor`, else `slow`).
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub main_family: Option<String>,
    /// Whether the judge's family differs from the caller's model; None when either is unknown.
    #[serde(default)]
    pub cross_family: Option<bool>,
    #[serde(default)]
    pub usd: Option<f64>,
}

/// " by <model> (<role> role, <family> family; …)": which model judged and whether it is another family than the caller's.
pub fn judge_label(reply: Option<&JudgeReply>) -> String {
    let Some(reply) = reply else {
        return String::new();
    };
    let Some(model) = reply.model.as_deref().filter(|model| !model.is_empty()) else {
        return String::new();
    };
    let Some(role) = reply.role.as_deref().filter(|role| !role.is_empty()) else {
        return format!(" by {model}");
    };
    let family = reply
        .family
        .as_deref()
        .filter(|family| !family.is_empty())
        .map_or_else(String::new, |family| format!(", {family} family"));
    let relation = match reply.cross_family {
        Some(true) => format!(
            "; your model is {}",
            reply.main_family.as_deref().unwrap_or("undefined")
        ),
        Some(false) => {
            "; same family as your model: no model of another family had credentials".to_owned()
        }
        None => String::new(),
    };
    format!(" by {model} ({role} role{family}{relation})")
}

/// What a session is doing right now, from the tail of its transcript: a tool call without a result yet.
pub fn current_step(messages: &[AgentMessage]) -> Option<String> {
    let answered: HashSet<&str> = messages
        .iter()
        .filter(|message| message.role == "toolResult")
        .filter_map(|message| message.tool_call_id.as_deref())
        .collect();
    for message in messages.iter().rev() {
        let (true, Some(Content::Blocks(blocks))) = (message.role == "assistant", &message.content)
        else {
            continue;
        };
        let pending = blocks.iter().rev().find(
            |block| matches!(block, Block::ToolCall { id, .. } if !answered.contains(id.as_str())),
        );
        return match pending {
            Some(Block::ToolCall { name, intent, .. }) => Some(format!(
                "running {name}{}",
                intent
                    .as_deref()
                    .filter(|intent| !intent.is_empty())
                    .map_or_else(String::new, |intent| format!(" ({})", one_line(intent, 80)))
            )),
            _ => None,
        };
    }
    None
}

/// What a page opens with when its `before` cursor named no page of the session as it is now, and the newest came instead.
pub fn stale_cursor_note(cursor: Option<&str>) -> String {
    format!(
        "The cursor \"{}\" names no page of this session as it is now (it wrote more since that page, or the cursor came from its saved copy or its open tab): this is its newest page instead; page back from the cursor below.",
        cursor.unwrap_or("undefined")
    )
}

/// One transcript page for the agent: the newest messages that fit `READ_MAX_CHARS`, and the cursor to page back.
pub fn render_page(
    title: &str,
    session: &str,
    messages: &[AgentMessage],
    total_messages: usize,
    prev_cursor: Option<&str>,
    note: Option<&str>,
) -> String {
    let lines: Vec<String> = messages.iter().filter_map(render_message).collect();
    let mut total = 0;
    let mut kept: Vec<&String> = Vec::new();
    for line in lines.iter().rev() {
        let size = len16(line);
        if total + size > READ_MAX_CHARS && !kept.is_empty() {
            break;
        }
        total += size;
        kept.push(line);
    }
    kept.reverse();
    let omitted = lines.len() - kept.len();
    let head = format!(
        "{title}: {} message(s) of {total_messages}{}.",
        messages.len(),
        if omitted > 0 {
            format!(" ({omitted} older ones of this page left out; use a smaller limit)")
        } else {
            String::new()
        }
    );
    let more = match prev_cursor.filter(|cursor| !cursor.is_empty()) {
        Some(cursor) => format!(
            "\nEarlier messages: ompdesk_session_read {{\"session\":\"{session}\",\"before\":\"{cursor}\"}}."
        ),
        None => String::new(),
    };
    let body = if kept.is_empty() {
        "(nothing to show)".to_owned()
    } else {
        kept.iter()
            .map(|line| line.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "{}{head}\n{body}{more}",
        note.filter(|note| !note.is_empty())
            .map_or_else(String::new, |note| format!("{note}\n"))
    )
}

/// A `get_transcript_page` payload with its messages, or None for anything else.
pub fn transcript_page(data: &Value) -> Option<MessagesPage> {
    data.get("messages")?.as_array()?;
    serde_json::from_value(data.clone()).ok()
}

/// The title of a stock request as its card shows it.
pub fn ask_title(request: &UiRequest) -> String {
    if request.method == "ask" {
        return request
            .questions
            .first()
            .map(|question| question.question.clone())
            .unwrap_or_default();
    }
    request.title.clone().unwrap_or_default()
}

/// What a question card asks and which `ompdesk_session_answer` field answers it, for its opener's mail.
pub fn card_text(request: &UiRequest) -> String {
    let title = request.title.as_deref().unwrap_or("undefined");
    match request.method.as_str() {
        "select" => format!(
            "{title}\noptions: {}\nanswer with: choice (one option exactly as written)",
            request
                .options
                .iter()
                .map(|option| format!("\"{option}\""))
                .collect::<Vec<_>>()
                .join(" | ")
        ),
        "confirm" => format!(
            "{title}{}\nanswer with: approve (true or false)",
            request
                .message
                .as_deref()
                .filter(|message| !message.is_empty())
                .map_or_else(String::new, |message| format!("\n{message}"))
        ),
        "input" | "editor" => format!("{title}\nanswer with: text"),
        "ask" => {
            let mut lines: Vec<String> = request
                .questions
                .iter()
                .map(|question| {
                    format!(
                        "[{}] {}\noptions: {}{}",
                        question.id,
                        question.question,
                        question
                            .options
                            .iter()
                            .map(|option| format!("\"{}\"", option.label))
                            .collect::<Vec<_>>()
                            .join(" | "),
                        if question.multi {
                            " (several allowed)"
                        } else {
                            ""
                        }
                    )
                })
                .collect();
            lines.push("answer with: answers ([{\"id\": <question id>, \"selected\": [<option>]}], or \"text\" for an answer of your own)".to_owned());
            lines.join("\n")
        }
        _ => ask_title(request),
    }
}

/// The option named `wanted` (case-insensitive, or a unique prefix), or a readable failure listing the options.
pub fn pick_option(options: &[String], wanted: &str) -> R<String> {
    let lowered = trim(wanted).to_lowercase();
    if let Some(exact) = options
        .iter()
        .find(|option| option.to_lowercase() == lowered)
    {
        return Ok(exact.clone());
    }
    let near: Vec<&String> = options
        .iter()
        .filter(|option| option.to_lowercase().starts_with(&lowered))
        .collect();
    if near.len() == 1 {
        return Ok(near[0].clone());
    }
    fail(format!(
        "\"{wanted}\" is not one of: {}.",
        options.join(" | ")
    ))
}

/// The tail of a "no such session" failure naming the devices whose saved sessions could not be searched.
pub fn unreached_text(devices: &[String]) -> String {
    if devices.is_empty() {
        String::new()
    } else {
        format!(
            " ({} could not be searched: not online; call again once it is, or name the device)",
            devices.join(", ")
        )
    }
}

/// `ControlAsk` of a card OMPdesk raised itself: never answerable by an agent.
pub fn is_agent_card(ask: &ControlAsk) -> bool {
    ask_title(&ask.request).starts_with(AGENT_CARD_PREFIX)
}

// ---- the judge's verdict ------------------------------------------------------------------------------------------

/// One criterion of a ranked session.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Criterion {
    pub criterion: String,
    /// `yes`, `partly`, `no` or `unknown`.
    pub met: String,
    pub why: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Ranked {
    pub session: String,
    pub score: f64,
    pub criteria: Vec<Criterion>,
    pub reasons: String,
}

/// The judge's verdict (`Verdict`).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Verdict {
    pub ranking: Vec<Ranked>,
    pub winner: Option<String>,
    pub why: String,
}

fn string_or(value: Option<&Value>, default: &str) -> Option<String> {
    match value {
        None => Some(default.to_owned()),
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => None,
    }
}

fn verdict_of(value: &Value) -> Option<Verdict> {
    let top = value.as_object()?;
    let mut ranking = Vec::new();
    for item in top.get("ranking")?.as_array()? {
        let item = item.as_object()?;
        let score = item.get("score")?.as_f64()?;
        if !(0.0..=100.0).contains(&score) {
            return None;
        }
        let mut criteria = Vec::new();
        match item.get("criteria") {
            None => {}
            Some(Value::Array(rows)) => {
                for row in rows {
                    let row = row.as_object()?;
                    let met = row.get("met")?.as_str()?;
                    if !["yes", "partly", "no", "unknown"].contains(&met) {
                        return None;
                    }
                    criteria.push(Criterion {
                        criterion: row.get("criterion")?.as_str()?.to_owned(),
                        met: met.to_owned(),
                        why: string_or(row.get("why"), "")?,
                    });
                }
            }
            Some(_) => return None,
        }
        ranking.push(Ranked {
            session: item.get("session")?.as_str()?.to_owned(),
            score,
            criteria,
            reasons: string_or(item.get("reasons"), "")?,
        });
    }
    let winner = match top.get("winner") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => return None,
    };
    Some(Verdict {
        ranking,
        winner,
        why: string_or(top.get("why"), "")?,
    })
}

/// The judge's JSON, also when a model wraps it in a fence or a sentence; None when there is none.
pub fn parse_verdict(text: &str) -> Option<Verdict> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    verdict_of(&serde_json::from_str(&text[start..=end]).ok()?)
}

// ---- branches.ts --------------------------------------------------------------------------------------------------

/// Why a merge of this branch cannot go ahead (what it would lose or tangle), or None.
pub fn merge_problem(worktree: &WorktreeRef, facts: &BranchFacts) -> Option<String> {
    let Some(base) = facts.base_branch.as_deref().filter(|base| !base.is_empty()) else {
        return Some(format!(
            "The parent checkout ({}) is on a detached HEAD; check out a branch there first.",
            worktree.base_cwd
        ));
    };
    if facts.uncommitted > 0.0 {
        return Some(format!(
            "{} has {} uncommitted file(s) in {}; ask that session to commit them first (ompdesk_session_send).",
            worktree.branch,
            number(facts.uncommitted),
            worktree.path
        ));
    }
    if facts.base_uncommitted > 0.0 {
        return Some(format!(
            "{} has {} uncommitted file(s); commit or stash them first so the merge cannot mix with them.",
            worktree.base_cwd,
            number(facts.base_uncommitted)
        ));
    }
    if facts.merged || facts.commits_ahead == 0.0 {
        return Some(format!(
            "{} has nothing to merge into {base}.",
            worktree.branch
        ));
    }
    None
}

/// The `diff --git` header's path; the header itself when it is quoted or odd.
fn section_path(section: &str) -> String {
    let header = match section.find('\n') {
        Some(at) if at > 0 => &section[..at],
        _ => section,
    };
    if let Some(both) = header.strip_prefix("diff --git a/") {
        let count = both.chars().count();
        if count >= 5 && (count - 3) % 2 == 0 {
            let half = (count - 3) / 2;
            let middle = both
                .char_indices()
                .nth(half)
                .map_or(both.len(), |(at, _)| at);
            let (first, rest) = both.split_at(middle);
            if let Some(second) = rest.strip_prefix(" b/")
                && first == second
                && !first.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
            {
                return first.to_owned();
            }
        }
    }
    header
        .strip_prefix("diff --git ")
        .unwrap_or(header)
        .to_owned()
}

/// Where JavaScript's multiline `^` matches: the start, and after a line terminator.
fn line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(text.char_indices().filter_map(|(at, c)| {
        matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}').then_some(at + c.len_utf8())
    }))
}

/// `diff.split(/^(?=diff --git )/m)`.
fn diff_sections(diff: &str) -> Vec<&str> {
    let mut cuts: Vec<usize> = line_starts(diff)
        .filter(|at| *at > 0 && diff[*at..].starts_with("diff --git "))
        .collect();
    cuts.dedup();
    let mut sections = Vec::new();
    let mut from = 0;
    for at in cuts {
        sections.push(&diff[from..at]);
        from = at;
    }
    sections.push(&diff[from..]);
    sections
}

/// `section.match(/[^\n]*\n|[^\n]+$/g)`: its lines, each with its newline.
fn section_lines(section: &str) -> Vec<&str> {
    section.split_inclusive('\n').collect()
}

/// Cut a unified diff to about `chars` characters, fairly across files: each file gets an equal share, and what a
/// small file does not use goes to the larger ones. A cut file ends at a line boundary with one line saying how many
/// lines went. `omitted` counts the characters of the diff left out.
pub fn bound_diff(diff: &str, chars: usize) -> (String, usize) {
    if chars == 0 {
        return (String::new(), len16(diff));
    }
    if len16(diff) <= chars {
        return (diff.to_owned(), 0);
    }
    let sections = diff_sections(diff);
    let mut order: Vec<(usize, usize)> = sections
        .iter()
        .enumerate()
        .map(|(index, section)| (index, len16(section)))
        .collect();
    order.sort_by_key(|(_, size)| *size);
    let mut shares = vec![0usize; sections.len()];
    let mut remaining = chars;
    for (rank, (index, size)) in order.iter().enumerate() {
        let share = remaining / (order.len() - rank);
        shares[*index] = (*size).min(share);
        remaining -= shares[*index];
    }
    let mut out = String::new();
    let mut omitted = 0;
    for (index, section) in sections.iter().enumerate() {
        let share = shares[index];
        if len16(section) <= share {
            out.push_str(section);
            continue;
        }
        let lines = section_lines(section);
        let path = section_path(section);
        let marker = |left: usize| {
            format!(
                "… {left} more line{} of {path} left out\n",
                if left == 1 { "" } else { "s" }
            )
        };
        // Reserve the longest the marker can be (every line left out) so the cut file stays within its share.
        let mut budget = share as i64 - len16(&marker(lines.len())) as i64;
        let mut kept = 0;
        while kept < lines.len() && (len16(lines[kept]) as i64) <= budget {
            budget -= len16(lines[kept]) as i64;
            out.push_str(lines[kept]);
            kept += 1;
        }
        omitted += lines[kept..].iter().map(|line| len16(line)).sum::<usize>();
        out.push_str(&marker(lines.len() - kept));
    }
    (out, omitted)
}

/// `response.data` of a successful command, else the refusal as the agent reads it (`responseData`).
pub fn response_data(response: &super::types::RpcResponse, what: &str) -> R<Value> {
    if !response.success {
        return fail(format!(
            "{what} failed: {}",
            response.error.as_deref().unwrap_or("unknown error")
        ));
    }
    Ok(response.data.clone().unwrap_or(Value::Null))
}

/// `error instanceof Error ? error.message : String(error)`.
pub fn error_text(error: &Fail) -> String {
    error.message()
}

/// `ClosedChild` that names `path` on `device` (the closed-children list's lookups).
pub fn closed_child_of<'a>(
    children: &'a [ClosedChild],
    path: &str,
    device: Option<&str>,
) -> Option<&'a ClosedChild> {
    children
        .iter()
        .rev()
        .find(|child| child.path == path && child.device.as_deref() == device)
}

/// The `OpenElsewhere` of a summary's holder is built by the list; kept here so every reader names it one way.
pub fn elsewhere(holder: Option<String>, work: Option<StoredWork>) -> OpenElsewhere {
    OpenElsewhere { holder, work }
}

#[allow(unused_imports)]
use head as _;
/// Re-export so the cut helper reads the same everywhere a family needs it.
pub use js::head as head_text;
