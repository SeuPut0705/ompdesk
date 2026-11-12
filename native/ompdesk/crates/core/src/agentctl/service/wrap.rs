//! The pieces of `src/shared/agent-control.ts`, `agent-control-contracts.ts`, `subagent-title-contracts.ts` and
//! `src/shared/schedules.ts` the service's texts read: how an agent's message is wrapped and read back, the task title
//! of a session an agent opened, the markers a message carries, and a schedule's frequency in words. The core has no
//! regex engine, so each pattern is read by hand.

use super::js::{self, len16, slice16, trim, trim_start};
use super::types::{ScheduleEvent, ScheduleFrequency};

pub const AGENT_MESSAGE_TAG: &str = "ompdesk-agent-message";
/// A card OMPdesk raises itself starts with this; a card with it is never answerable by an agent.
pub const AGENT_CARD_PREFIX: &str = "[OMPdesk] ";
/// Schedules an agent creates start with this.
pub const AGENT_SCHEDULE_PREFIX: &str = "[agent] ";

fn attribute_of(value: &str) -> String {
    js::collapse_spaces(value)
        .trim_matches(js::is_space)
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unescape_attribute(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The text a session receives: `body` from the session titled `from` (empty when it has no title yet), whose saved
/// id is `session` (absent while it has no saved file). A body cannot carry its own wrapper.
pub fn wrap_agent_message(body: &str, from: &str, session: Option<&str>) -> String {
    let safe = body
        .replace(
            &format!("<{AGENT_MESSAGE_TAG}"),
            &format!("<\u{200b}{AGENT_MESSAGE_TAG}"),
        )
        .replace(
            &format!("</{AGENT_MESSAGE_TAG}"),
            &format!("</\u{200b}{AGENT_MESSAGE_TAG}"),
        );
    let id = match session {
        Some(session) if !session.is_empty() => format!(" session=\"{}\"", attribute_of(session)),
        _ => String::new(),
    };
    format!(
        "<{AGENT_MESSAGE_TAG} from=\"{}\"{id}>\n{safe}\n</{AGENT_MESSAGE_TAG}>",
        attribute_of(from)
    )
}

#[derive(Clone, Debug, PartialEq)]
pub struct WrappedMessage {
    /// The sending session's title; "" when it had none.
    pub from: String,
    /// The sending session's saved id; absent in a message written before it was carried.
    pub session: Option<String>,
    pub body: String,
}

/// `OPENING` at the start of `text`: the sender, the saved id (when written) and what follows the `>\n`.
fn opening(text: &str) -> Option<(String, Option<String>, &str)> {
    let rest = text.strip_prefix(&format!("<{AGENT_MESSAGE_TAG} from=\""))?;
    let (from, rest) = rest.split_once('"')?;
    let (session, rest) = match rest.strip_prefix(" session=\"") {
        Some(after) => {
            let (id, rest) = after.split_once('"')?;
            (Some(id), rest)
        }
        None => (None, rest),
    };
    let rest = rest.strip_prefix(">\n")?;
    Some((
        unescape_attribute(from),
        session.map(unescape_attribute),
        rest,
    ))
}

/// The parts of a wrapped message, either form; None for anything else (a person's own prompt).
pub fn parse_agent_message(text: &str) -> Option<WrappedMessage> {
    let (from, session, rest) = opening(text)?;
    let body = rest.strip_suffix(&format!("\n</{AGENT_MESSAGE_TAG}>"))?;
    Some(WrappedMessage {
        from,
        session: session.filter(|session| !session.is_empty()),
        body: body.to_owned(),
    })
}

const TITLE_MAX_CHARS: usize = 120;
const TASK_TITLE_MAX: usize = 120;

fn is_blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// `assignmentTitle`: the assignment's own `Title:` line (`/^\s*Title:[ \t]*(\S[^\n]*?)[ \t]*(?:\n|$)/`).
fn assignment_title(text: &str) -> Option<String> {
    let rest = trim_start(text).strip_prefix("Title:")?;
    let rest = rest.trim_start_matches(is_blank);
    if rest.chars().next().is_none_or(js::is_space) {
        return None;
    }
    let line = rest.split('\n').next().unwrap_or("");
    let title = line.trim_end_matches(is_blank);
    (len16(title) <= TITLE_MAX_CHARS).then(|| title.to_owned())
}

/// `stripTitlePrefix`: `text` without a leading `Title:` label (any case).
fn strip_title_prefix(text: &str) -> &str {
    let rest = trim_start(text);
    match rest.get(..6) {
        Some(label) if label.eq_ignore_ascii_case("title:") => {
            rest[6..].trim_start_matches(is_blank)
        }
        _ => text,
    }
}

/// `assignmentHeadline`: what a task message is about: its `Title:` line, else its first non-empty line.
fn assignment_headline(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if let Some(title) = assignment_title(text) {
        return Some(title);
    }
    text.split('\n')
        .map(|line| trim(strip_title_prefix(line)))
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

/// What a session another session's agent opened is about, from the message it was opened with; None for a person's
/// own prompt.
pub fn agent_task_title(prompt: &str) -> Option<String> {
    let text = trim(prompt);
    let (_, _, rest) = opening(text)?;
    let body = rest
        .strip_suffix(&format!("\n</{AGENT_MESSAGE_TAG}>"))
        .unwrap_or(rest);
    let line = assignment_headline(body)?;
    Some(if len16(&line) > TASK_TITLE_MAX {
        format!("{}…", slice16(&line, 0, TASK_TITLE_MAX - 1))
    } else {
        line
    })
}

/// The marker of a message with a dispatch id (`[ompdesk dispatch <id>:`).
pub fn dispatch_mark(dispatch: &str) -> String {
    format!("[ompdesk dispatch {dispatch}:")
}

/// The marker of a message sent with a request id.
pub fn request_mark(id: &str) -> String {
    format!("[ompdesk request {id}]")
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// When a schedule starts, in English for agents and logs.
pub fn describe_frequency(frequency: &ScheduleFrequency) -> String {
    match frequency {
        ScheduleFrequency::Interval { minutes } => format!("every {} min", js::number(*minutes)),
        ScheduleFrequency::Daily { time, days } => {
            let names: Vec<String> = days
                .iter()
                .map(|day| {
                    WEEKDAYS
                        .get(usize::from(*day))
                        .map_or_else(|| day.to_string(), |name| (*name).to_owned())
                })
                .collect();
            format!(
                "{} at {time}",
                if names.is_empty() {
                    "daily".to_owned()
                } else {
                    names.join(", ")
                }
            )
        }
        ScheduleFrequency::Once { at } => format!("once at {at}"),
        ScheduleFrequency::Event { event } => match event {
            ScheduleEvent::Webhook { .. } => "on a webhook call".to_owned(),
            ScheduleEvent::Github { repo, events } => {
                format!("on GitHub {} in {repo}", events.join("/"))
            }
            ScheduleEvent::Files { path } => format!("when files change under {path}"),
            ScheduleEvent::Git { repo, branch } => {
                format!("on new commits to {branch} in {repo}")
            }
            ScheduleEvent::Session { events, folder } => {
                let kinds: Vec<&str> = events
                    .iter()
                    .map(|kind| match kind.as_str() {
                        "waiting" => "waits for the owner",
                        "done" => "finishes a turn",
                        _ => "fails a turn",
                    })
                    .collect();
                let folder = folder
                    .as_ref()
                    .filter(|folder| !folder.is_empty())
                    .map_or_else(String::new, |folder| {
                        format!(" in a folder containing {folder}")
                    });
                format!("when a session {}{folder}", kinds.join(" or "))
            }
            ScheduleEvent::Email {
                account,
                from,
                subject,
                to,
            } => {
                let filters: Vec<String> = [
                    from.as_ref()
                        .filter(|text| !text.is_empty())
                        .map(|text| format!("from {text}")),
                    to.as_ref()
                        .filter(|text| !text.is_empty())
                        .map(|text| format!("to {text}")),
                    subject
                        .as_ref()
                        .filter(|text| !text.is_empty())
                        .map(|text| format!("with \"{text}\" in the subject")),
                ]
                .into_iter()
                .flatten()
                .collect();
                let filters = if filters.is_empty() {
                    String::new()
                } else {
                    format!(" {}", filters.join(", "))
                };
                format!("on new mail in {account}{filters}")
            }
        },
    }
}
