use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::mpsc;

use super::{Services, Sink, Stop};
use crate::routines::text::clip;
use crate::server::Scope;

#[derive(Clone, Debug)]
pub struct SessionTab {
    pub tab_id: String,
    pub session_file: Option<String>,
    pub cwd: String,
    pub title: String,
    pub device: Option<String>,
    pub opened_by: Option<String>,
    pub opened_by_session: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Outcome {
    pub stop_reason: String,
    pub error_message: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Activity {
    Busy {
        tab_id: String,
    },
    Idle {
        tab_id: String,
        outcome: Option<Outcome>,
    },
    Ask {
        tab_id: String,
        request_id: String,
        text: String,
    },
    Released {
        tab_id: String,
    },
}

/// The canonical pool captures its authoritative tab facts with each activity edge. No sidecar-state surrogate.
pub struct SessionNotice {
    pub activity: Activity,
    pub tabs: Vec<SessionTab>,
}

pub struct SessionSubscription {
    pub events: mpsc::UnboundedReceiver<SessionNotice>,
    stop: Option<Stop>,
}

impl SessionSubscription {
    pub fn new(events: mpsc::UnboundedReceiver<SessionNotice>, stop: Stop) -> Self {
        Self {
            events,
            stop: Some(stop),
        }
    }
}

impl Drop for SessionSubscription {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            stop();
        }
    }
}

pub(super) struct Options {
    pub events: Vec<String>,
    pub folder: Option<String>,
    pub wake_session: Option<String>,
}

pub(super) async fn run<S: Services, C: Sink>(
    services: Arc<S>,
    options: Options,
    sink: C,
    scope: &Scope,
) {
    let mut subscription = match services.sessions() {
        Ok(subscription) => subscription,
        Err(error) => {
            sink.failure("sessions", Some(&error.message));
            return;
        }
    };
    let mut told = HashMap::<String, String>::new();
    loop {
        let event = tokio::select! { biased; _ = scope.on_cancel() => return, event = subscription.events.recv() => event };
        let Some(notice) = event else {
            if sink.current() {
                sink.failure("sessions", Some("the native session subscription closed"));
            }
            return;
        };
        if !sink.current() {
            return;
        }
        let (tab_id, kind, key) = match &notice.activity {
            Activity::Busy { tab_id } | Activity::Released { tab_id } => {
                told.remove(tab_id);
                continue;
            }
            Activity::Ask {
                tab_id, request_id, ..
            } => (tab_id, "waiting", format!("ask:{request_id}")),
            Activity::Idle {
                tab_id,
                outcome: Some(outcome),
            } if outcome.stop_reason != "aborted" => {
                let kind = if outcome.stop_reason == "error" {
                    "failed"
                } else {
                    "done"
                };
                (tab_id, kind, kind.to_owned())
            }
            _ => continue,
        };
        if !options.events.iter().any(|event| event == kind) || told.get(tab_id) == Some(&key) {
            continue;
        }
        let Some(tab) = notice.tabs.iter().find(|tab| &tab.tab_id == tab_id) else {
            continue;
        };
        if tab.session_file.is_none() || tab.device.is_some() {
            continue;
        }
        if options
            .folder
            .as_deref()
            .is_some_and(|folder| !folder_holds(&tab.cwd, folder))
        {
            continue;
        }
        if excluded(tab, &notice.tabs, options.wake_session.as_deref()) {
            continue;
        }
        told.insert(tab_id.clone(), key);
        sink.publish(None, &[describe(kind, tab, &notice.activity)]);
    }
}

fn describe(kind: &str, tab: &SessionTab, activity: &Activity) -> String {
    let title = clip(&tab.title, 120);
    let title = if title.is_empty() { "Untitled" } else { &title };
    let named = format!("Session \"{title}\" in {}", tab.cwd);
    match (kind, activity) {
        ("waiting", Activity::Ask { text, .. }) => {
            let text = clip(text, 200);
            format!(
                "{named} is waiting for an answer{}",
                if text.is_empty() {
                    String::new()
                } else {
                    format!(": {text}")
                }
            )
        }
        ("failed", Activity::Idle { outcome, .. }) => {
            let error = clip(
                outcome
                    .as_ref()
                    .and_then(|outcome| outcome.error_message.as_deref())
                    .unwrap_or_default(),
                200,
            );
            format!(
                "{named} failed its turn{}",
                if error.is_empty() {
                    String::new()
                } else {
                    format!(": {error}")
                }
            )
        }
        _ => format!("{named} finished its turn"),
    }
}

fn folder_holds(cwd: &str, folder: &str) -> bool {
    let normalized = |path: &str| path.replace('\\', "/").trim_matches('/').to_lowercase();
    let folder = normalized(folder);
    !folder.is_empty() && format!("/{}/", normalized(cwd)).contains(&format!("/{folder}/"))
}

// The renderer's `openerOfSessions` cannot be imported by native code; this keeps its live-tab-only rule from
// routines/sessions.ts, including a remembered opener file whose tab is no longer open.
fn excluded(tab: &SessionTab, tabs: &[SessionTab], wake: Option<&str>) -> bool {
    let Some(file) = tab.session_file.as_deref() else {
        return true;
    };
    let Some(wake) = wake else {
        return false;
    };
    if file == wake {
        return true;
    }
    let local: Vec<&SessionTab> = tabs
        .iter()
        .filter(|tab| tab.session_file.is_some() && tab.device.is_none())
        .collect();
    let mut known: HashSet<&str> = local
        .iter()
        .filter_map(|tab| tab.session_file.as_deref())
        .collect();
    known.insert(wake);
    let mut direct = HashMap::<&str, &str>::new();
    for tab in &local {
        let child = tab.session_file.as_deref().unwrap_or_default();
        let opener = tab
            .opened_by
            .as_deref()
            .and_then(|id| local.iter().find(|tab| tab.tab_id == id).copied())
            .or_else(|| {
                tab.opened_by_session.as_deref().and_then(|file| {
                    local
                        .iter()
                        .find(|tab| tab.session_file.as_deref() == Some(file))
                        .copied()
                })
            });
        let parent = opener
            .filter(|opener| opener.tab_id != tab.tab_id)
            .and_then(|opener| opener.session_file.as_deref())
            .or_else(|| {
                tab.opened_by_session
                    .as_deref()
                    .filter(|file| known.contains(file))
            });
        if let Some(parent) = parent.filter(|parent| *parent != child) {
            direct.insert(child, parent);
        }
    }
    let mut seen = HashSet::from([file]);
    let mut root = direct.get(file).copied();
    while let Some(parent) =
        root.filter(|parent| direct.contains_key(parent) && !seen.contains(parent))
    {
        seen.insert(parent);
        root = direct.get(parent).copied();
    }
    root.is_some_and(|root| root == wake && !seen.contains(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tab(id: &str) -> SessionTab {
        SessionTab {
            tab_id: id.into(),
            session_file: Some(format!("/s/{id}.jsonl")),
            cwd: "/x/y".into(),
            title: "Refactor".into(),
            device: None,
            opened_by: None,
            opened_by_session: None,
        }
    }
    #[test]
    fn keeps_the_typescript_live_family_and_folder_contract() {
        let owner = tab("owner");
        let mut child = tab("child");
        child.opened_by = Some("owner".into());
        let mut nested = tab("nested");
        nested.opened_by_session = child.session_file.clone();
        let tabs = [owner, child.clone(), nested.clone()];
        assert!(excluded(&child, &tabs, Some("/s/owner.jsonl")));
        assert!(excluded(&nested, &tabs, Some("/s/owner.jsonl")));
        assert!(!excluded(&nested, &tabs, None));
        assert!(folder_holds("C:\\Work\\App\\src", "work/app"));
        assert!(!folder_holds("/x/yard", "x/y"));
        assert!(!folder_holds("/x/y", "/"));
    }
}
