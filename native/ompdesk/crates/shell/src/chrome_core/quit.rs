//! The quit's rules (was `src/main/app-quit.ts`, `quit-watchdog.ts` and the rules of `quit-guard.ts`): when a quit asks
//! first, what the two confirmations say, what a Dock click does, and the exit watchdog's countdown. Close-to-tray and
//! the last window's close are the window area's (`chrome_core::window`). No CEF and no clock in here.

use serde_json::{Value, json};

/// The "sessions are still working" inventory Node answers `chrome.quitFacts` with (`assessQuitRisk`).
#[derive(Debug, PartialEq, Eq, Clone, Copy, Default)]
pub struct QuitRisk {
    pub working_tabs: u64,
    pub total_tabs: u64,
    /// Windows holding at least one working tab: the dialog names the count.
    pub working_windows: u64,
}

/// `chrome.quitFacts`' answer: the risk, and whether Settings › General › Continue interrupted work is on (a quit then
/// leaves its running turns to the next launch).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct QuitFacts {
    pub risk: QuitRisk,
    pub resumes: bool,
}

impl QuitFacts {
    pub fn from_json(value: &Value) -> Option<Self> {
        let count = |key: &str| value.get(key).and_then(Value::as_u64);
        Some(Self {
            risk: QuitRisk {
                working_tabs: count("workingTabs")?,
                total_tabs: count("totalTabs")?,
                working_windows: count("workingWindows")?,
            },
            resumes: value.get("resumes").and_then(Value::as_bool)?,
        })
    }
}

/// Idle tabs die quietly. Live agent runs ask first only when quitting stops them: with Continue interrupted work on,
/// a quit, an update restart or a crash leaves their markers and the next launch continues them.
pub fn quit_needs_confirmation(risk: &QuitRisk, resumes: bool) -> bool {
    risk.working_tabs > 0 && !resumes
}

/// What a user-initiated update restart asks first.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum UpdateConfirmation {
    RunningWork,
    BackgroundWork,
}

/// Setting off: the quit confirm for running turns. Setting on: running turns continue after the relaunch and ask
/// nothing, but background subagents and jobs start over, so a restart over them is named first. `has_background_work`
/// is Node's `hasBackgroundWork` (read only when `resumes` is on: `needs_background_work`).
pub fn update_restart_confirmation(
    risk: &QuitRisk,
    resumes: bool,
    has_background_work: bool,
) -> Option<UpdateConfirmation> {
    if !resumes {
        return quit_needs_confirmation(risk, resumes).then_some(UpdateConfirmation::RunningWork);
    }
    has_background_work.then_some(UpdateConfirmation::BackgroundWork)
}

/// Whether the update restart's confirmation reads the background work at all.
pub fn needs_background_work(resumes: bool) -> bool {
    resumes
}

/// `chrome.backgroundWork`'s answer: whether work would start over, and the sentence naming it in the UI language.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct BackgroundWork {
    pub has: bool,
    pub sentence: String,
}

impl BackgroundWork {
    pub fn from_json(value: &Value) -> Option<Self> {
        Some(Self {
            has: value.get("has")?.as_bool()?,
            sentence: value.get("sentence")?.as_str()?.to_string(),
        })
    }
}

/// The text of a label key with its `{name}` placeholders filled (`shell_core::labels::label`).
pub type Say<'a> = &'a dyn Fn(&str, &[(&str, &str)]) -> String;

/// A native warning box, as `dialog.messageBox`'s `options` (the first button confirms; the second is the default and
/// the way out).
fn warning(
    say: Say,
    buttons: [&str; 2],
    title: &str,
    body: &str,
    params: &[(&str, &str)],
) -> Value {
    json!({
        "type": "warning",
        "buttons": [say(buttons[0], &[]), say(buttons[1], &[])],
        "defaultId": 1,
        "cancelId": 1,
        "message": say(title, &[]),
        "detail": say(body, params),
    })
}

/// The quit confirmation.
pub fn quit_options(risk: &QuitRisk, say: Say) -> Value {
    warning(
        say,
        ["quit.quitAnyway", "quit.keepWorking"],
        "quit.workingTitle",
        "quit.workingBody",
        &[
            ("working", &risk.working_tabs.to_string()),
            ("total", &risk.total_tabs.to_string()),
            ("windows", &risk.working_windows.to_string()),
        ],
    )
}

/// The update restart's background-work confirmation, naming `sentence`.
pub fn background_work_options(sentence: &str, say: Say) -> Value {
    warning(
        say,
        ["updates.restartWork.restart", "updates.restartWork.cancel"],
        "updates.restartWork.title",
        "updates.restartWork.body",
        &[("work", sentence)],
    )
}

/// What a confirmation does next.
#[derive(Debug, PartialEq, Clone)]
pub enum Confirmation {
    Proceed,
    /// Ask with these `dialog.messageBox` options: the first button proceeds.
    Ask(Value),
}

/// `confirmQuit`.
pub fn confirm_quit(facts: &QuitFacts, say: Say) -> Confirmation {
    if quit_needs_confirmation(&facts.risk, facts.resumes) {
        Confirmation::Ask(quit_options(&facts.risk, say))
    } else {
        Confirmation::Proceed
    }
}

/// `confirmUpdateRestart`; `work` is what `chrome.backgroundWork` answered, asked only when `needs_background_work`.
pub fn confirm_update_restart(
    facts: &QuitFacts,
    work: Option<&BackgroundWork>,
    say: Say,
) -> Confirmation {
    let has = work.is_some_and(|work| work.has);
    match update_restart_confirmation(&facts.risk, facts.resumes, has) {
        None => Confirmation::Proceed,
        Some(UpdateConfirmation::RunningWork) => Confirmation::Ask(quit_options(&facts.risk, say)),
        Some(UpdateConfirmation::BackgroundWork) => {
            let sentence = work.map(|work| work.sentence.as_str()).unwrap_or_default();
            Confirmation::Ask(background_work_options(sentence, say))
        }
    }
}

/// What a Dock click (macOS `activate`) does.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ActivateAction {
    Spawn,
    Show,
    Ignore,
}

/// A Dock click opens a window when none is left and brings a hidden one back. Once a quit is approved it does
/// neither: the services are torn down (or going down), and a window restored on them cannot open a paired host's tab.
pub fn activate_action(
    quit_approved: bool,
    window_count: usize,
    any_visible: bool,
) -> ActivateAction {
    if quit_approved {
        ActivateAction::Ignore
    } else if window_count == 0 {
        ActivateAction::Spawn
    } else if any_visible {
        ActivateAction::Ignore
    } else {
        ActivateAction::Show
    }
}

/// Long enough for a healthy teardown (sidecars get their SIGTERM grace), short enough that an update is not stranded.
pub const QUIT_EXIT_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Reason {
    Quit,
    Update,
}

impl Reason {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "quit" => Some(Self::Quit),
            "update" => Some(Self::Update),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quit => "quit",
            Self::Update => "update",
        }
    }
}

/// The force-exit countdown behind a committed quit or update install. The caller owns the clock: `arm` says when a
/// timer must call `expire`, and a timer that was disarmed meanwhile finds nothing to do.
#[derive(Debug, Default)]
pub struct Watchdog {
    armed: Option<(u64, Reason)>,
    next: u64,
}

impl Watchdog {
    pub const fn new() -> Self {
        Self {
            armed: None,
            next: 0,
        }
    }

    pub fn is_armed(&self) -> bool {
        self.armed.is_some()
    }

    /// Starts the countdown: the generation its timer must hand to `expire`. A second call keeps the first countdown,
    /// so repeated `before-quit` events never extend it.
    pub fn arm(&mut self, reason: Reason) -> Option<u64> {
        if self.armed.is_some() {
            return None;
        }
        self.next += 1;
        self.armed = Some((self.next, reason));
        Some(self.next)
    }

    /// The quit was cancelled (an install that failed before the app closed keeps the session running). With `reason`,
    /// only a countdown armed for that reason stops.
    pub fn disarm(&mut self, reason: Option<Reason>) {
        if let Some((_, armed_for)) = self.armed
            && reason.is_none_or(|reason| reason == armed_for)
        {
            self.armed = None;
        }
    }

    /// A timer's deadline came: the reason when its countdown is still the armed one (then it is spent).
    pub fn expire(&mut self, generation: u64) -> Option<Reason> {
        match self.armed {
            Some((armed, reason)) if armed == generation => {
                self.armed = None;
                Some(reason)
            }
            _ => None,
        }
    }
}

/// The runtime-log line a fired watchdog writes (`QuitWatchdogReport`).
pub fn watchdog_report(reason: Reason, timeout_ms: u64) -> Value {
    json!({
        "source": "background-task",
        "message": format!(
            "Shutdown did not finish within {timeout_ms}ms of committing the {}; forcing exit",
            reason.as_str()
        ),
        "details": { "watchdog": "quit", "reason": reason.as_str(), "timeoutMs": timeout_ms },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chrome_core::captured::{of, steps};
    use crate::labels::fill;

    fn risk(value: &Value) -> QuitRisk {
        QuitRisk {
            working_tabs: value["workingTabs"].as_u64().unwrap(),
            total_tabs: value["totalTabs"].as_u64().unwrap(),
            working_windows: value["workingWindows"].as_u64().unwrap(),
        }
    }

    fn working(count: u64) -> QuitRisk {
        QuitRisk {
            working_tabs: count,
            total_tabs: count + 1,
            working_windows: count.min(1),
        }
    }

    // The cases of `quit-guard.test.ts` that are rules of the shell now.
    #[test]
    fn asks_only_while_work_is_in_flight_and_quitting_would_stop_it() {
        assert!(!quit_needs_confirmation(&QuitRisk::default(), false));
        assert!(!quit_needs_confirmation(&working(0), false));
        assert!(quit_needs_confirmation(&working(1), false));
        assert!(!quit_needs_confirmation(&working(1), true));
        assert!(!quit_needs_confirmation(&QuitRisk::default(), true));
    }

    #[test]
    fn an_update_restart_with_continue_on_asks_only_for_background_work() {
        assert_eq!(update_restart_confirmation(&working(1), true, false), None);
        assert_eq!(
            update_restart_confirmation(&QuitRisk::default(), true, false),
            None
        );
        assert_eq!(
            update_restart_confirmation(&working(1), true, true),
            Some(UpdateConfirmation::BackgroundWork)
        );
    }

    #[test]
    fn an_update_restart_with_it_off_keeps_the_quit_confirm() {
        assert_eq!(
            update_restart_confirmation(&working(1), false, true),
            Some(UpdateConfirmation::RunningWork)
        );
        assert_eq!(
            update_restart_confirmation(&working(1), false, false),
            Some(UpdateConfirmation::RunningWork)
        );
        assert_eq!(
            update_restart_confirmation(&QuitRisk::default(), false, false),
            None
        );
    }

    #[test]
    fn a_dock_click_never_rebuilds_a_window_once_a_quit_is_approved() {
        assert_eq!(activate_action(false, 0, false), ActivateAction::Spawn);
        assert_eq!(activate_action(false, 2, false), ActivateAction::Show);
        assert_eq!(activate_action(false, 2, true), ActivateAction::Ignore);
        assert_eq!(activate_action(true, 0, false), ActivateAction::Ignore);
        assert_eq!(activate_action(true, 2, false), ActivateAction::Ignore);
    }

    #[test]
    fn replays_the_captured_rules() {
        for step in of("quit", "src/main/quit-guard.ts#quitNeedsConfirmation") {
            let got = quit_needs_confirmation(
                &risk(&step.input["risk"]),
                step.input["resumes"].as_bool().unwrap(),
            );
            assert_eq!(json!(got), step.output, "{:?}", step.input);
        }
        for step in of("quit", "src/main/quit-guard.ts#updateRestartConfirmation") {
            let got = update_restart_confirmation(
                &risk(&step.input["risk"]),
                step.input["resumes"].as_bool().unwrap(),
                step.input["has"].as_bool().unwrap(),
            )
            .map(|c| match c {
                UpdateConfirmation::RunningWork => "running work",
                UpdateConfirmation::BackgroundWork => "background work",
            });
            assert_eq!(json!(got), step.output, "{:?}", step.input);
        }
        for step in of("quit", "src/main/quit-guard.ts#activateAction") {
            let got = activate_action(
                step.input["quitApproved"].as_bool().unwrap(),
                step.input["windowCount"].as_u64().unwrap() as usize,
                step.input["anyVisible"].as_bool().unwrap(),
            );
            let want = match step.output.as_str().unwrap() {
                "spawn" => ActivateAction::Spawn,
                "show" => ActivateAction::Show,
                _ => ActivateAction::Ignore,
            };
            assert_eq!(got, want, "{:?}", step.input);
        }
    }

    /// The label table of one language, from what the capture recorded of `MAIN_TEXT`.
    fn table(language: &str) -> Value {
        of("quit", "src/main/i18n-text.ts#MAIN_TEXT")[0].output[language].clone()
    }

    fn say_in(table: &Value) -> impl Fn(&str, &[(&str, &str)]) -> String + '_ {
        move |key, params| fill(table[key].as_str().unwrap(), params)
    }

    fn facts(step: &crate::chrome_core::captured::Step) -> QuitFacts {
        QuitFacts {
            risk: risk(&step.input["risk"]),
            resumes: step.input["resumes"].as_bool().unwrap(),
        }
    }

    fn dialogs(plan: &Confirmation) -> Value {
        match plan {
            Confirmation::Proceed => json!([]),
            Confirmation::Ask(options) => json!([options]),
        }
    }

    #[test]
    fn replays_the_confirm_quit_dialogs() {
        for step in of("quit", "src/main/app-quit.ts#confirmQuit") {
            let table = table(step.input["language"].as_str().unwrap());
            let plan = confirm_quit(&facts(&step), &say_in(&table));
            assert_eq!(dialogs(&plan), step.output["dialogs"], "{:?}", step.input);
            // The first button proceeds; a box that never opened proceeds by itself.
            let result = match plan {
                Confirmation::Proceed => true,
                Confirmation::Ask(_) => step.input["response"].as_u64() == Some(0),
            };
            assert_eq!(json!(result), step.output["result"], "{:?}", step.input);
        }
    }

    #[test]
    fn replays_the_update_restart_dialogs() {
        for step in of("quit", "src/main/app-quit.ts#confirmUpdateRestart") {
            let table = table(step.input["language"].as_str().unwrap());
            let facts = facts(&step);
            let work = BackgroundWork {
                has: step.input["has"].as_bool().unwrap(),
                sentence: step.input["sentence"].as_str().unwrap().to_string(),
            };
            let reads = needs_background_work(facts.resumes);
            let plan = confirm_update_restart(&facts, reads.then_some(&work), &say_in(&table));
            assert_eq!(
                json!(u64::from(reads)),
                step.output["workRead"],
                "{:?}",
                step.input
            );
            assert_eq!(dialogs(&plan), step.output["dialogs"], "{:?}", step.input);
            let result = match plan {
                Confirmation::Proceed => true,
                Confirmation::Ask(_) => step.input["response"].as_u64() == Some(0),
            };
            assert_eq!(json!(result), step.output["result"], "{:?}", step.input);
        }
    }

    #[test]
    fn replays_the_watchdog_sequences() {
        for step in of("quit", "src/main/quit-watchdog.ts#QuitWatchdog") {
            let timeout = step.input["timeoutMs"].as_u64().unwrap();
            let mut dog = Watchdog::new();
            let mut now = 0u64;
            // The timers a real run would have: (deadline, generation).
            let mut timers: Vec<(u64, u64)> = Vec::new();
            let mut exits = 0;
            let ops = step.input["ops"].as_array().unwrap();
            let outputs = step.output.as_array().unwrap();
            for (op, want) in ops.iter().zip(outputs) {
                let mut logs: Vec<Value> = Vec::new();
                match op["op"].as_str().unwrap() {
                    "arm" => {
                        let reason = Reason::parse(op["reason"].as_str().unwrap()).unwrap();
                        if let Some(generation) = dog.arm(reason) {
                            timers.push((now + timeout, generation));
                        }
                    }
                    "disarm" => dog.disarm(op["reason"].as_str().and_then(Reason::parse)),
                    _ => {
                        now += op["ms"].as_u64().unwrap();
                        for (_, generation) in timers
                            .iter()
                            .filter(|(at, _)| *at <= now)
                            .copied()
                            .collect::<Vec<_>>()
                        {
                            if let Some(reason) = dog.expire(generation) {
                                logs.push(watchdog_report(reason, timeout));
                                exits += 1;
                            }
                        }
                        timers.retain(|(at, _)| *at > now);
                    }
                }
                let got = json!({ "armed": dog.is_armed(), "logs": logs, "exits": exits });
                assert_eq!(&got, want, "{} after {op}", step.input["name"]);
            }
        }
    }

    #[test]
    fn every_captured_step_has_a_replay() {
        let known = [
            "src/main/quit-guard.ts#quitNeedsConfirmation",
            "src/main/quit-guard.ts#updateRestartConfirmation",
            "src/main/quit-guard.ts#activateAction",
            "src/main/i18n-text.ts#MAIN_TEXT",
            "src/main/app-quit.ts#confirmQuit",
            "src/main/app-quit.ts#confirmUpdateRestart",
            "src/main/quit-watchdog.ts#QuitWatchdog",
        ];
        for step in steps("quit") {
            assert!(
                known.contains(&step.function.as_str()),
                "no replay for {}",
                step.function
            );
        }
    }
}
