//! The control socket's requests, answered for one outside caller (was `src/main/control-socket/router.ts`). Waits
//! live here, not in the CLI. The rules are Herdr's, re-implemented: hear a tab's activity before reading the session
//! so a fast turn is never missed, `agent_blocked` before sending to a session that waits on the person, and
//! `agent_prompt_stalled` when a sent prompt never starts a turn. What a request means beyond that is main's: a tool
//! call and a session's name go to the agent-control service through `super::link`.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::time::Instant;

use super::events::Sink;
use super::frame::{self, Frame, Kind};
use super::js;
use super::link::{Link, Look, StepKind, Watching};
use super::{Caller, SessionState, View};

/// A request's refusal: one of the wire's error codes and its message.
#[derive(Debug, PartialEq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

fn failure(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
}

/// What a connection gives its requests: who calls, and where a subscription's events go.
#[derive(Clone)]
pub struct Connection {
    pub caller: Arc<Caller>,
    /// The connection's number: its subscriptions end with it.
    pub number: u64,
    pub sink: Arc<dyn Sink>,
}

/// node's longest timer.
const MAX_TIMER_MS: f64 = 2_147_483_647.0;
const DELIVERIES: [&str; 2] = ["follow_up", "steer"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Until {
    Idle,
    Blocked,
    Done,
    Any,
}

impl Until {
    const ALL: [(&'static str, Until); 4] = [
        ("idle", Until::Idle),
        ("blocked", Until::Blocked),
        ("done", Until::Done),
        ("any", Until::Any),
    ];

    fn name(self) -> &'static str {
        Until::ALL
            .iter()
            .find(|(_, until)| *until == self)
            .map_or("", |(name, _)| name)
    }
}

fn until_of(raw: Option<&str>) -> Result<Option<Until>, Failure> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    frame::text_of(raw)
        .and_then(|text| Until::ALL.iter().find(|(name, _)| *name == text))
        .map(|(_, until)| Some(*until))
        .ok_or_else(|| {
            failure(
                "bad_request",
                "until must be one of idle, blocked, done, any",
            )
        })
}

fn positive_ms(raw: Option<&str>, what: &str) -> Result<Option<f64>, Failure> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    match frame::number_of(raw) {
        Some(value) if value.is_finite() && value > 0.0 => Ok(Some(value.min(MAX_TIMER_MS))),
        _ => Err(failure(
            "bad_request",
            format!("{what} must be a positive number of milliseconds"),
        )),
    }
}

/// When a timer of `ms` set now fires (node's shortest timer is 1 ms).
fn after(ms: f64) -> Instant {
    Instant::now() + Duration::from_secs_f64(ms.max(1.0) / 1000.0)
}

fn session_name(request: &Frame) -> Result<Box<RawValue>, Failure> {
    match request.value("session") {
        Some(name) if request.has_text("session") => Ok(name.to_owned()),
        _ => Err(failure("bad_request", "session must be a name")),
    }
}

#[derive(Serialize)]
struct Status<'a> {
    session: &'a str,
    title: &'a str,
    state: SessionState,
}

#[derive(Serialize)]
struct Waited<'a> {
    session: &'a str,
    title: &'a str,
    state: SessionState,
    matched: &'static str,
    #[serde(rename = "stopReason", skip_serializing_if = "Option::is_none")]
    stop_reason: Option<&'a str>,
}

/// The send tool's outcome as main answers it.
#[derive(Deserialize)]
struct Outcome {
    text: String,
    #[serde(rename = "isError")]
    is_error: bool,
}

fn json<T: Serialize>(value: &T) -> Result<String, Failure> {
    serde_json::to_string(value).map_err(|error| failure("unavailable", error.to_string()))
}

/// Answers one request: its result as JSON, or why not.
pub async fn handle(
    link: Arc<Link>,
    connection: Connection,
    id: String,
    request: Frame,
) -> Result<String, Failure> {
    let method = request.text("method").unwrap_or_default();
    match method.as_str() {
        "tool" => tool(&link, &connection, &request).await,
        "state" => {
            let (view, _) = resolve(&link, &connection.caller, session_name(&request)?).await?;
            json(&Status {
                session: &view.session,
                title: &view.title,
                state: view.state,
            })
        }
        "wait" => wait(&link, &connection, &request).await,
        "send" => send(&link, &connection, &request).await,
        "subscribe" => {
            link.subscribe(
                connection.number,
                &connection.caller.id,
                &id,
                connection.sink,
            );
            Ok(format!("{{\"sub\":{id}}}"))
        }
        other => Err(failure("unknown_method", format!("unknown method {other}"))),
    }
}

async fn tool(link: &Link, connection: &Connection, request: &Frame) -> Result<String, Failure> {
    let Some(tool) = request.value("tool").filter(|_| request.has_text("tool")) else {
        return Err(failure("bad_request", "tool must be a tool name"));
    };
    let answer = link
        .run(
            &connection.caller,
            tool.to_owned(),
            request.value("args").map(ToOwned::to_owned),
        )
        .await;
    match answer.result {
        Ok(outcome) => Ok(outcome.get().to_owned()),
        Err(message) => Err(failure("unavailable", message)),
    }
}

/// The open session `name` names, and the number of the push that said so.
async fn resolve(
    link: &Link,
    caller: &Arc<Caller>,
    name: Box<RawValue>,
) -> Result<(View, u64), Failure> {
    let answer = link.resolve(caller, name).await;
    let view = match answer.result {
        Ok(view) => serde_json::from_str(view.get())
            .map_err(|error| failure("unavailable", error.to_string()))?,
        Err(message) => return Err(failure("session_not_found", message)),
    };
    Ok((view, answer.at))
}

fn gone(tab: &str) -> Failure {
    failure("session_gone", format!("Session {tab} is gone"))
}

/// What a wait settles on, looked at now and after everything main tells. `done` and `any` are edges: a turn end (for
/// `any`, any step) after `mark` satisfies them even when it was heard during a send's activity gate. `idle`,
/// `blocked` and settled are states: only the session as it is now satisfies them, so a turn that ended before another
/// one started does not end the wait.
fn evaluate(
    look: &Look,
    tab: &str,
    until: Option<Until>,
    mark: u64,
    start: SessionState,
    hold: bool,
) -> Result<Option<String>, Failure> {
    let Some(view) = look.view() else {
        return Err(gone(tab));
    };
    if look.since(mark).any(|step| step.kind == StepKind::Released) {
        return Err(gone(tab));
    }
    let matched = until.map_or("settled", Until::name);
    let edge = match until {
        Some(Until::Done) => look.since(mark).find(|step| step.kind == StepKind::Ended),
        Some(Until::Any) => look.since(mark).next(),
        _ => None,
    };
    if let Some(step) = edge {
        let state = match step.kind {
            StepKind::Working => SessionState::Working,
            StepKind::Blocked => SessionState::Blocked,
            StepKind::Ended | StepKind::Released => SessionState::Idle,
        };
        return Ok(Some(json(&Waited {
            session: &view.session,
            title: &view.title,
            state,
            matched,
            stop_reason: step.stop_reason.as_deref(),
        })?));
    }
    if hold {
        return Ok(None);
    }
    let settled = match until {
        // A stopped omp moves on only when someone restarts it: a settled wait reports it rather than hang.
        None => matches!(
            view.state,
            SessionState::Idle | SessionState::Blocked | SessionState::Stopped
        ),
        Some(Until::Idle) => view.state == SessionState::Idle,
        Some(Until::Blocked) => view.state == SessionState::Blocked,
        Some(Until::Any) => view.state != start,
        Some(Until::Done) => false,
    };
    if !settled {
        return Ok(None);
    }
    let last_end = look.since(mark).rfind(|step| step.kind == StepKind::Ended);
    Ok(Some(json(&Waited {
        session: &view.session,
        title: &view.title,
        state: view.state,
        matched,
        stop_reason: last_end.and_then(|step| step.stop_reason.as_deref()),
    })?))
}

/// `flow`, failed with `late()` once `deadline` passes. The deadline is looked at first: of a timeout and an answer
/// that come at the same moment the timeout counts, as the TypeScript's earlier timer did.
async fn bounded<T>(
    deadline: Option<Instant>,
    flow: impl Future<Output = Result<T, Failure>>,
    late: impl FnOnce() -> Failure,
) -> Result<T, Failure> {
    let Some(deadline) = deadline else {
        return flow.await;
    };
    tokio::select! {
        biased;
        () = tokio::time::sleep_until(deadline) => Err(late()),
        out = flow => out,
    }
}

async fn wait(
    link: &Arc<Link>,
    connection: &Connection,
    request: &Frame,
) -> Result<String, Failure> {
    let name = session_name(request)?;
    let until = until_of(request.raw("until"))?;
    let timeout = positive_ms(request.raw("timeoutMs"), "timeoutMs")?;
    let deadline = timeout.map(after);
    let watching = link.watch();
    let flow = async {
        let (view, _) = resolve(link, &connection.caller, name).await?;
        watching.bind(&view.session);
        // From the request's start: a turn that ended while the name was resolved counts for `done`.
        link.until(&watching, |look| {
            evaluate(look, &view.session, until, watching.born, view.state, false)
        })
        .await
    };
    bounded(deadline, flow, || {
        failure(
            "timeout",
            format!(
                "Wait timed out after {} ms",
                js::number(timeout.unwrap_or_default())
            ),
        )
    })
    .await
}

async fn send(
    link: &Arc<Link>,
    connection: &Connection,
    request: &Frame,
) -> Result<String, Failure> {
    let name = session_name(request)?;
    let Some(message) = request
        .raw("message")
        .filter(|_| request.has_text("message"))
    else {
        return Err(failure("bad_request", "message must be text"));
    };
    let delivery = request.raw("delivery");
    if let Some(delivery) = delivery
        && !frame::text_of(delivery).is_some_and(|text| DELIVERIES.contains(&text.as_str()))
    {
        return Err(failure(
            "bad_request",
            "delivery must be one of follow_up, steer",
        ));
    }
    let request_id = request.raw("requestId");
    if request_id.is_some_and(|raw| frame::kind(raw) != Kind::Text) {
        return Err(failure("bad_request", "requestId must be text"));
    }
    let wait = match request.raw("wait") {
        None => None,
        Some(raw) => Some(
            Frame::member(raw).ok_or_else(|| failure("bad_request", "wait must be an object"))?,
        ),
    };
    let until = until_of(wait.as_ref().and_then(|wait| wait.raw("until")))?;
    let timeout = positive_ms(
        wait.as_ref().and_then(|wait| wait.raw("timeoutMs")),
        "wait.timeoutMs",
    )?;
    let force = request.raw("force") == Some("true");
    let deadline = timeout.map(after);
    let watching = link.watch();
    let flow = sent(
        link,
        connection,
        &watching,
        Sending {
            name,
            message,
            delivery,
            request_id,
            force,
            wait: wait.is_some(),
            until,
        },
    );
    // Herdr's prompt --wait: one timeout covers the send, the gate and the wait.
    bounded(deadline, flow, || {
        failure(
            "timeout",
            format!(
                "Send timed out after {} ms",
                js::number(timeout.unwrap_or_default())
            ),
        )
    })
    .await
}

struct Sending<'a> {
    name: Box<RawValue>,
    message: &'a str,
    delivery: Option<&'a str>,
    request_id: Option<&'a str>,
    force: bool,
    wait: bool,
    until: Option<Until>,
}

async fn sent(
    link: &Arc<Link>,
    connection: &Connection,
    watching: &Watching,
    sending: Sending<'_>,
) -> Result<String, Failure> {
    let (view, resolved) = resolve(link, &connection.caller, sending.name).await?;
    let tab = view.session.as_str();
    watching.bind(tab);
    if view.state == SessionState::Blocked && !sending.force {
        return Err(failure(
            "agent_blocked",
            format!(
                "Session {tab} waits on the person (a question, an approval or a plan). Answer there, or send anyway with --force."
            ),
        ));
    }
    let was_working = view.state == SessionState::Working;
    let mut args = format!(
        "{{\"session\":{},\"message\":{}",
        json(&tab)?,
        sending.message
    );
    if let Some(delivery) = sending.delivery {
        args.push_str(&format!(",\"delivery\":{delivery}"));
    }
    if let Some(request_id) = sending.request_id {
        args.push_str(&format!(",\"request_id\":{request_id}"));
    }
    args.push('}');
    let raw = |text: String| {
        RawValue::from_string(text).map_err(|error| failure("unavailable", error.to_string()))
    };
    let answer = link
        .run(
            &connection.caller,
            raw("\"ompdesk_session_send\"".into())?,
            Some(raw(args)?),
        )
        .await;
    let receipt = answer.at;
    // Herdr's prompt --wait: the gate and the final wait both read what happened after main started on the send.
    let pre_send = answer.began.unwrap_or(resolved);
    let outcome: Outcome = match answer.result {
        Ok(outcome) => serde_json::from_str(outcome.get())
            .map_err(|error| failure("unavailable", error.to_string()))?,
        Err(message) => return Err(failure("unavailable", message)),
    };
    if outcome.is_error {
        return Err(failure("tool_failed", outcome.text));
    }
    if !sending.wait {
        return Ok(format!("{{\"receipt\":{}}}", json(&outcome.text)?));
    }
    // The activity gate: the session was working already, or after the send it was seen working, blocked or ending a
    // turn (a step, or the state now: a plan proposal raises no step). Within the start wait, or less when the total
    // timeout is nearer; else agent_prompt_stalled.
    let start_wait = link.tuning.start_wait_ms;
    let gate = link.until(watching, |look| {
        let Some(now) = look.view() else {
            return Err(gone(tab));
        };
        if look
            .since(pre_send)
            .any(|step| step.kind == StepKind::Released)
        {
            return Err(gone(tab));
        }
        let started = was_working
            || look.since(pre_send).next().is_some()
            || matches!(now.state, SessionState::Working | SessionState::Blocked);
        Ok(started.then_some(()))
    });
    bounded(Some(after(start_wait as f64)), gate, || {
        failure(
            "agent_prompt_stalled",
            format!(
                "Session {tab} produced no observed working or blocked state within {start_wait} ms of the message"
            ),
        )
    })
    .await?;
    // A session that was working when the message went may have ended that turn while the send was in flight (a
    // follow-up queued after omp looked at its queue starts a turn of its own next): that end is not the message's,
    // so the wait counts from the receipt, and an idle seen right after such an end is held for the start wait
    // unless a new step comes (the follow-up folded into the ended turn starts none).
    let ended_in_flight = was_working
        && link.look(watching, |look| {
            look.since(pre_send)
                .any(|step| step.seq <= receipt && step.kind == StepKind::Ended)
        });
    let grace = ended_in_flight.then(|| after(start_wait as f64));
    let mark = if was_working { receipt } else { pre_send };
    let waited = link
        .until(watching, |look| {
            let hold =
                grace.is_some_and(|until| look.at < until) && look.since(receipt).next().is_none();
            evaluate(look, tab, sending.until, mark, view.state, hold)
        })
        .await?;
    Ok(format!(
        "{{\"receipt\":{},\"waited\":{waited}}}",
        json(&outcome.text)?
    ))
}
