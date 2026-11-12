//! `ompdesk_schedule` (`#schedule`, `#frequencyOf`) and `ompdesk_autopilot` (`#autopilot`, `#runStatus`,
//! `#autopilotStart`, `#autopilotFrom`).

use serde_json::Value;

use super::super::AgentControl;
use super::super::fail::{Fail, R, fail};
use super::super::host::HostState;
use super::super::js::len16;
use super::super::resolve::OpenOptions;
use super::super::sessions::CloseHow;
use super::super::text::{
    SESSION_PREFIX_MIN, describe_run, label, schedule_runs_text, schedule_state, start_options,
    trim_separators, webhook_line,
};
use super::super::types::{
    AutopilotArgs, AutopilotBranch, AutopilotStart, ControlDevice, ControlTab, RunStatus,
    ScheduleArgs, ScheduleDraft, ScheduleEvent, ScheduleFrequency, ScheduleOn, SpawnRequest,
};
use super::super::wrap::{AGENT_SCHEDULE_PREFIX, describe_frequency};

/// `path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)`.
fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes.get(2).is_some_and(|c| matches!(c, b'\\' | b'/')))
}

fn absolute(path: &str, what: &str) -> R<String> {
    if !is_absolute(path) {
        return fail(format!("{what} must be an absolute path."));
    }
    Ok(path.to_owned())
}

impl AgentControl {
    /// `ompdesk_schedule`: create, list, change or cancel the runs an agent put on the Schedules service of a device
    /// (a timer, once, or an event), test one now and read its run history. Only agent-made ones can be changed.
    pub(crate) async fn schedule(&self, caller: &ControlTab, args: ScheduleArgs) -> R<String> {
        // Default: the device the caller's own session runs on, so its folder is a path there.
        let mut device: Option<ControlDevice>;
        if args.target.as_deref() == Some("self") {
            if let Some(own) = &caller.device {
                return fail(format!(
                    "This session runs on {}: a session wakes itself only on the computer it runs on, and only from that computer's own app.",
                    caller.device_name.as_deref().unwrap_or(own)
                ));
            }
            device = None;
        } else if let Some(wanted) = &args.device {
            device = self.device(wanted)?;
        } else if let Some(own) = &caller.device {
            let found = self.host.state().device(own).cloned();
            match found {
                Some(found) => device = Some(found),
                None => {
                    return fail(format!(
                        "{} is no longer a paired device.",
                        caller.device_name.as_deref().unwrap_or(own)
                    ));
                }
            }
        } else {
            device = None;
        }
        if let Some(named) = device.take() {
            device = Some(self.reach(named).await?);
        }
        let where_ = match &device {
            Some(device) => format!("on {}", device.name),
            None => "on this computer".to_owned(),
        };
        let device_id = device.as_ref().map(|device| device.id.as_str());
        let Some(source) = self.schedule_source(device_id) else {
            return fail(format!("Scheduled runs are not available {where_}."));
        };
        let rows = source.list().await?;
        if args.action == "list" {
            if rows.is_empty() {
                return Ok(format!("No scheduled runs {where_}."));
            }
            let mut lines = vec![format!("Scheduled runs {where_}:")];
            for row in &rows {
                lines.push(format!(
                    "- {} “{}” {}{}; {}{}{}{}",
                    row.id,
                    row.name,
                    describe_frequency(&row.frequency),
                    if row.wakes {
                        String::new()
                    } else {
                        format!(" in {}", row.cwd)
                    },
                    schedule_state(row),
                    match row.last_status.as_deref() {
                        Some(status) if !status.is_empty() => format!("; last run {status}"),
                        _ => String::new(),
                    },
                    if row.wakes { "; wakes a session" } else { "" },
                    if row.name.starts_with(AGENT_SCHEDULE_PREFIX) {
                        " [made by an agent: you can change it]"
                    } else {
                        " [the user's own: leave it]"
                    }
                ));
            }
            return Ok(lines.join("\n"));
        }
        let device_arg = match &device {
            Some(device) => format!(
                ",\"device\":{}",
                serde_json::to_string(&device.name).unwrap_or_default()
            ),
            None => String::new(),
        };
        if args.action != "create" {
            let id = args.id.clone().unwrap_or_default();
            let row = rows
                .iter()
                .find(|entry| entry.id == id)
                .or_else(|| {
                    rows.iter()
                        .find(|entry| len16(&id) >= SESSION_PREFIX_MIN && entry.id.starts_with(&id))
                })
                .cloned();
            let Some(row) = row else {
                return fail(format!(
                    "No scheduled run \"{id}\" {where_}. ompdesk_schedule {{\"action\":\"list\"{device_arg}}} shows them."
                ));
            };
            if args.action == "runs" {
                return Ok(schedule_runs_text(&row, &source.runs(&row.id).await?));
            }
            if !row.name.starts_with(AGENT_SCHEDULE_PREFIX) {
                return fail(format!(
                    "“{}” is the user's own schedule; only the user changes it (Settings › Schedules).",
                    row.name
                ));
            }
            match args.action.as_str() {
                "cancel" => {
                    source.remove(&row.id).await?;
                    return Ok(format!("Cancelled “{}” {where_}.", row.name));
                }
                "pause" | "resume" => {
                    let resume = args.action == "resume";
                    let changed = source.set_enabled(&row.id, resume).await?;
                    return Ok(format!(
                        "{} “{}” {where_}; {}.",
                        if resume { "Resumed" } else { "Paused" },
                        changed.name,
                        schedule_state(&changed)
                    ));
                }
                "run" => {
                    source.run_now(&row.id).await?;
                    return Ok(format!(
                        "Started a test run of “{}” {where_}. ompdesk_schedule {{\"action\":\"runs\",\"id\":\"{}\"{device_arg}}} shows how it ends.",
                        row.name, row.id
                    ));
                }
                "update" => {
                    let frequency = self.frequency_of(caller, &args, device.as_ref())?;
                    let name = args.name.clone().filter(|name| !name.is_empty());
                    let prompt = args.prompt.clone().filter(|prompt| !prompt.is_empty());
                    let model = args.model.clone().filter(|model| !model.is_empty());
                    let changed = source
                        .update(&row.id, move |mut draft: ScheduleDraft| {
                            if let Some(name) = name {
                                draft.name = format!("{AGENT_SCHEDULE_PREFIX}{name}");
                            }
                            if let Some(prompt) = prompt {
                                draft.prompt = prompt;
                            }
                            if let Some(model) = model {
                                draft.model = Some(model);
                            }
                            if let Some(frequency) = frequency {
                                draft.frequency = frequency;
                                draft.enabled = true;
                            }
                            draft
                        })
                        .await?;
                    return Ok(format!(
                        "Updated “{}” {where_}: {}; {}.{}",
                        changed.name,
                        describe_frequency(&changed.frequency),
                        schedule_state(&changed),
                        webhook_line(&changed)
                    ));
                }
                _ => {}
            }
        }
        let frequency = self.frequency_of(caller, &args, device.as_ref())?;
        let Some(frequency) = frequency else {
            return fail(
                "create needs exactly one of every_minutes, daily_at, at, in_minutes or on.",
            );
        };
        // The caller's folder is a path on its own device; another device needs its folder named.
        if args.folder.as_deref().is_none_or(str::is_empty) && device_id != caller.device.as_deref()
        {
            return fail(format!(
                "folder is required: name an absolute folder {where_}."
            ));
        }
        let cwd = args.folder.clone().unwrap_or_else(|| caller.cwd.clone());
        if !is_absolute(&cwd) {
            return fail("folder must be an absolute path.");
        }
        // A wake-up goes to the caller's own session file, which is a path on this computer only.
        let mut wake_session: Option<String> = None;
        if args.target.as_deref() == Some("self") {
            match caller
                .session_path
                .as_deref()
                .filter(|path| !path.is_empty())
            {
                Some(path) => wake_session = Some(path.to_owned()),
                None => {
                    return fail(
                        "This session has no saved file yet, so it cannot wake itself. Try again after its first message.",
                    );
                }
            }
        }
        let name = format!(
            "{AGENT_SCHEDULE_PREFIX}{}",
            args.name.as_deref().unwrap_or("")
        );
        if !self.host.state().manage_enabled {
            let state = self.host.state();
            let folder = match &device {
                Some(device) => format!("{cwd} ({})", device.name),
                None => cwd.clone(),
            };
            let caller_name = if caller.title.is_empty() {
                "—"
            } else {
                caller.title.as_str()
            };
            let when = describe_frequency(&frequency);
            let approved = self
                .host
                .confirm(
                    &caller.tab_id,
                    &state.text("scheduleTitle", &[]),
                    &state.text(
                        "scheduleMessage",
                        &[
                            ("caller", caller_name),
                            ("name", args.name.as_deref().unwrap_or("")),
                            ("when", &when),
                            ("folder", &folder),
                        ],
                    ),
                )
                .await?;
            if !approved {
                return Ok(
                    "The user declined the schedule. Do not ask again unless they tell you to."
                        .to_owned(),
                );
            }
        }
        let row = source
            .save(&ScheduleDraft {
                name,
                prompt: args.prompt.clone().unwrap_or_default(),
                cwd: cwd.clone(),
                frequency: frequency.clone(),
                model: args.model.clone(),
                auto_approve: false,
                enabled: true,
                wake_session: wake_session.clone(),
            })
            .await?;
        let when = describe_frequency(&row.frequency);
        let start = |word: &str| {
            if matches!(row.frequency, ScheduleFrequency::Event { .. }) {
                "it waits for its event".to_owned()
            } else {
                format!("next {word} {}", row.next_run.as_deref().unwrap_or("—"))
            }
        };
        if wake_session.is_some() {
            return Ok(format!(
                "Scheduled “{}” {when}: it wakes this session with the prompt, opening it in the background if no tab holds it; id {}; {}. It runs only while OMPdesk is open on this computer; the owner sees it in Settings › Schedules with its runs. {}{}",
                row.name,
                row.id,
                start("wake"),
                if matches!(frequency, ScheduleFrequency::Once { .. }) {
                    "It is deleted once its run succeeds (a failed one stays a day).".to_owned()
                } else {
                    format!(
                        "Cancel it when you no longer need it with ompdesk_schedule {{\"action\":\"cancel\",\"id\":\"{}\"}}.",
                        row.id
                    )
                },
                webhook_line(&row)
            ));
        }
        Ok(format!(
            "Scheduled “{}” {when} in {cwd} {where_}; id {}; {}. It runs only while OMPdesk is open {where_}, never with auto-approve; cancel it with ompdesk_schedule {{\"action\":\"cancel\",\"id\":\"{}\"{device_arg}}}.{}",
            row.name,
            row.id,
            start("run"),
            row.id,
            webhook_line(&row)
        ))
    }

    /// `#frequencyOf`: the one start `args` names, or None when it names none (an update that keeps the timing).
    fn frequency_of(
        &self,
        caller: &ControlTab,
        args: &ScheduleArgs,
        device: Option<&ControlDevice>,
    ) -> R<Option<ScheduleFrequency>> {
        if let Some(minutes) = args.every_minutes {
            return Ok(Some(ScheduleFrequency::Interval { minutes }));
        }
        if let Some(time) = &args.daily_at {
            let mut days = args.days.clone().unwrap_or_default();
            days.sort_unstable();
            days.dedup();
            return Ok(Some(ScheduleFrequency::Daily {
                time: time.clone(),
                days,
            }));
        }
        if let Some(at) = &args.at {
            let Some(ms) = crate::schedules::rules::date_parse(at, &crate::schedules::rules::Local) else {
                return Err(Fail::other("Invalid time value"));
            };
            return Ok(Some(ScheduleFrequency::Once {
                at: crate::schedules::rules::iso(ms),
            }));
        }
        if let Some(minutes) = args.in_minutes {
            return Ok(Some(ScheduleFrequency::Once {
                at: crate::schedules::rules::iso((self.now() + minutes * 60_000.0) as i64),
            }));
        }
        let Some(on) = &args.on else {
            return Ok(None);
        };
        let event = match on {
            // The service makes the key.
            ScheduleOn::Webhook => ScheduleEvent::Webhook { key: String::new() },
            ScheduleOn::Github { repo, events } => ScheduleEvent::Github {
                repo: repo.clone(),
                events: events.clone(),
            },
            ScheduleOn::Files { path } => ScheduleEvent::Files {
                path: absolute(path, "on.path")?,
            },
            ScheduleOn::Git { repo, branch } => {
                // The caller's folder is a path on its own device only.
                let named = repo.as_deref().filter(|repo| !repo.is_empty());
                if named.is_none()
                    && device.map(|device| device.id.as_str()) != caller.device.as_deref()
                {
                    return fail("on.repo is required on another device.");
                }
                let repo = repo.clone().unwrap_or_else(|| caller.cwd.clone());
                ScheduleEvent::Git {
                    repo: absolute(&repo, "on.repo")?,
                    branch: branch.clone(),
                }
            }
            ScheduleOn::Session { events, folder } => ScheduleEvent::Session {
                events: events.clone(),
                folder: folder.clone().filter(|folder| !folder.is_empty()),
            },
            ScheduleOn::Email {
                account,
                from,
                subject,
                to,
            } => ScheduleEvent::Email {
                account: account.clone(),
                from: from.clone().filter(|text| !text.is_empty()),
                subject: subject.clone().filter(|text| !text.is_empty()),
                to: to.clone().filter(|text| !text.is_empty()),
            },
        };
        Ok(Some(ScheduleFrequency::Event { event }))
    }

    /// `ompdesk_autopilot`: start, read or stop an Autopilot run through the coordinator the Autopilot screen uses.
    pub(crate) async fn autopilot(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        args: AutopilotArgs,
    ) -> R<String> {
        if !self.host.caps().autopilot {
            return fail("Autopilot is not available here.");
        }
        let (session, stop, now) = match &args {
            AutopilotArgs::Start(start) => {
                return self.autopilot_start(caller, tabs, &args, start).await;
            }
            AutopilotArgs::Status { session } => (session, false, false),
            AutopilotArgs::Stop { session, now } => (session, true, *now == Some(true)),
        };
        let target = self
            .open(
                tabs,
                session,
                caller,
                if stop { "stop" } else { "read" },
                OpenOptions::default(),
            )
            .await?;
        self.refuse_hidden(&target, caller)?;
        let own = self
            .opened_by(&self.host.state(), &caller.tab_id, tabs)
            .contains(&target.tab_id);
        if !stop {
            if !own && !self.host.state().manage_enabled {
                return fail(format!(
                    "{} is not an Autopilot run you started. Reading other runs needs the user's \"Let agents manage other sessions\" setting.",
                    label(&target)
                ));
            }
            let status = self.run_status(&target).await?;
            return Ok(describe_run(&target.tab_id, &target.title, &status));
        }
        let before = self.run_status(&target).await?;
        if before.state.as_deref() == Some("ended") {
            return Ok(format!(
                "{}\nIt has ended already.",
                describe_run(&target.tab_id, &target.title, &before)
            ));
        }
        if !own && !self.host.state().manage_enabled {
            let caller_name = if caller.title.is_empty() {
                "—"
            } else {
                caller.title.as_str()
            };
            let target_name = if target.title.is_empty() {
                target.tab_id.as_str()
            } else {
                target.title.as_str()
            };
            let params = [("caller", caller_name), ("target", target_name)];
            let state = self.host.state();
            let approved = self
                .host
                .confirm(
                    &caller.tab_id,
                    &state.text("stopTitle", &params),
                    &state.text("stopMessage", &params),
                )
                .await?;
            if !approved {
                return Ok(format!(
                    "The user declined: {} keeps running. Do not ask again unless they tell you to.",
                    label(&target)
                ));
            }
        }
        if before.state.as_deref() == Some("stopping") && !now {
            return Ok(format!(
                "{}\nIt is ending already.",
                describe_run(&target.tab_id, &target.title, &before)
            ));
        }
        self.mem().closing.insert(target.tab_id.clone());
        let stopped = self.host.autopilot_stop(&target.tab_id, now).await;
        self.mem().closing.remove(&target.tab_id);
        let after = stopped?;
        Ok(format!(
            "{}\n{}",
            describe_run(&target.tab_id, &target.title, &after),
            if now {
                "Stopped now: the turn in flight was aborted and the run is paused (the user can resume it on the Autopilot screen)."
            } else {
                "Ending: it finishes the cycle in flight, then closes its children and stops. It will not continue by itself."
            }
        ))
    }

    /// `#runStatus`.
    async fn run_status(&self, target: &ControlTab) -> R<RunStatus> {
        let status = self.host.autopilot_status(&target.tab_id).await?;
        if status.active != Some(true) || status.role.as_deref() == Some("child") {
            return fail(format!("{} is not an Autopilot run.", label(target)));
        }
        Ok(status)
    }

    /// `#autopilotStart`.
    async fn autopilot_start(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        args: &AutopilotArgs,
        start: &AutopilotStart,
    ) -> R<String> {
        if self.stopping(&caller.tab_id) {
            return fail("Autopilot is ending: start nothing new.");
        }
        let folder = trim_separators(start.folder.as_deref().unwrap_or(&caller.cwd));
        if !is_absolute(&folder) {
            return fail("folder must be an absolute path.");
        }
        let mut device = caller.device.clone();
        let mut device_name = caller.device_name.clone();
        if let Some(wanted) = &start.device {
            let found = self.device(wanted)?;
            if let Some(found) = &found {
                self.reach(found.clone()).await?;
            }
            device = found.as_ref().map(|found| found.id.clone());
            device_name = found.map(|found| found.name);
        }
        let candidates: Vec<&ControlTab> = std::iter::once(caller)
            .chain(tabs)
            .filter(|tab| {
                tab.device == device && !tab.hidden && trim_separators(&tab.cwd) == folder
            })
            .collect();
        let mut source_tab = candidates
            .iter()
            .find(|tab| tab.status == super::super::types::TabStatus::Ready)
            .or_else(|| candidates.first())
            .map(|tab| (*tab).clone());
        if source_tab.is_none() && device.is_none() {
            return fail(format!(
                "{folder} is not open in a session of this window on this computer. Autopilot starts from a folder one of those sessions has open: open one there first (ompdesk_session_open with folder), or use your own folder."
            ));
        }
        // On a paired host nothing has the folder open: a session there to start from, closed again once the run
        // started.
        let mut source_opened: Option<String> = None;
        let run = async {
            if source_tab.is_none() {
                let request = SpawnRequest {
                    folder: Some(folder.clone()),
                    device: Some(device.clone()),
                    ..SpawnRequest::default()
                };
                let opened = self.host.spawn(&caller.tab_id, &request).await?.tab_id;
                source_opened = Some(opened.clone());
                self.when_ready(&opened, &caller.tab_id, None).await?;
                source_tab = self
                    .host
                    .state()
                    .tabs(&caller.tab_id)
                    .and_then(|tabs| tabs.into_iter().find(|tab| tab.tab_id == opened));
                if source_tab.is_none() {
                    return fail(format!(
                        "The session opened on {} to start from is gone.",
                        device_name
                            .as_deref()
                            .or(device.as_deref())
                            .unwrap_or("undefined")
                    ));
                }
            }
            let source = source_tab
                .clone()
                .expect("a source tab was found or opened");
            self.autopilot_from(
                caller,
                tabs,
                args,
                start,
                &source,
                &folder,
                device_name.as_deref(),
            )
            .await
        }
        .await;
        let result = match run {
            Ok(text) => Ok(text),
            Err(error) if error.is_tool() => Err(error),
            Err(error) => fail(format!("Autopilot did not start: {}", error.message())),
        };
        // Best effort, no note: a web page's tab is released in main, a desktop window closes its own.
        if let Some(opened) = source_opened {
            let control = self.clone();
            let caller_tab_id = caller.tab_id.clone();
            tokio::spawn(async move {
                let wait_ms = control.tuning.close_wait_ms;
                let _ = control
                    .close_tab(
                        &caller_tab_id,
                        &opened,
                        CloseHow {
                            auto: false,
                            wait_ms,
                            cleared: false,
                        },
                    )
                    .await;
            });
        }
        result
    }

    /// `#autopilotFrom`: the card, then the coordinator's start from `source_tab` (on whichever computer runs it).
    #[allow(clippy::too_many_arguments)]
    async fn autopilot_from(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        args: &AutopilotArgs,
        start: &AutopilotStart,
        source_tab: &ControlTab,
        folder: &str,
        device_name: Option<&str>,
    ) -> R<String> {
        let where_ = match device_name {
            Some(name) => format!("{folder} on {name}"),
            None => folder.to_owned(),
        };
        let default_branch = self.host.autopilot_plan(&source_tab.tab_id).await?;
        // A start always names its level: the card says what it will do, and an omitted one commits only.
        let ship = start.ship.as_deref().unwrap_or("commit");
        if start
            .advanced
            .as_ref()
            .is_some_and(|advanced| advanced.cadence.is_some())
            && ship != "release"
        {
            return fail("advanced.cadence goes with ship release (it is the release rhythm).");
        }
        let on_default_branch = matches!(
            &start.branch,
            Some(AutopilotBranch::Existing { name })
                if Some(name.as_str()) == default_branch.as_deref() || name == "main" || name == "master"
        );
        // `#openedBy` also prunes and fills what the caller opened; the run's tab is added to it below.
        let _ = self.opened_by(&self.host.state(), &caller.tab_id, tabs);
        let state: std::sync::Arc<HostState> = self.host.state();
        if !state.full_enabled && (!state.manage_enabled || ship == "release" || on_default_branch)
        {
            let branch = match &start.branch {
                Some(AutopilotBranch::Existing { name }) => {
                    if on_default_branch {
                        state.text("autopilotBranchDefault", &[("name", name)])
                    } else {
                        name.clone()
                    }
                }
                Some(AutopilotBranch::New { name: Some(name) }) => name.clone(),
                _ => state.text("autopilotBranchNew", &[]),
            };
            let ship_text = state.text(
                match ship {
                    "release" => "autopilotShipRelease",
                    "push" => "autopilotShipPush",
                    _ => "autopilotShipCommit",
                },
                &[],
            );
            let caller_name = if caller.title.is_empty() {
                "—"
            } else {
                caller.title.as_str()
            };
            let approved = self
                .host
                .confirm(
                    &caller.tab_id,
                    &state.text("autopilotTitle", &[]),
                    &state.text(
                        "autopilotMessage",
                        &[
                            ("caller", caller_name),
                            ("folder", &where_),
                            ("ship", &ship_text),
                            ("branch", &branch),
                        ],
                    ),
                )
                .await?;
            if !approved {
                return Ok(
                    "The user declined Autopilot. Do not ask again unless they tell you to."
                        .to_owned(),
                );
            }
        }
        let options = Value::Object(start_options(args, ship));
        let started = self
            .host
            .autopilot_start(&caller.tab_id, &source_tab.tab_id, &options)
            .await?;
        let started_tab = started.tab_id.clone().unwrap_or_default();
        {
            let mut mem = self.mem();
            let opened = mem.opened.entry(caller.tab_id.clone()).or_default();
            if !opened.contains(&started_tab) {
                opened.push(started_tab.clone());
            }
        }
        Ok([
            format!(
                "Started Autopilot in session {started_tab}{}.",
                match device_name {
                    Some(name) => format!(" (it runs on {name}, in {folder})"),
                    None => String::new(),
                }
            ),
            describe_run(&started_tab, "", &started),
            format!(
                "It works by itself: read it with ompdesk_autopilot {{\"action\":\"status\",\"session\":\"{started_tab}\"}}, end it with {{\"action\":\"stop\",\"session\":\"{started_tab}\"}}. Do not send it messages."
            ),
        ]
        .join("\n"))
    }
}
