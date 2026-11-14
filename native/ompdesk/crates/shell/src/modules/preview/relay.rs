//! The agent's browsing of a Preview page (AGENTS.md › Preview, `preview_core::relay_rules`): the shell plays stock omp's
//! browser relay extension for the shown page. Node dialled the relay's socket and passes its frames through
//! `preview.relayIn` / `preview.relayOut`; the rules (which CDP the agent may send, which sessions it may address) are
//! the `RelayExtension` machine's, and this file carries out the effects it returns against the page's debugger.

use std::cell::Cell;

use serde_json::{Value, json};
use shell_core::preview_core::relay_rules::{Effect, RelayExtension, RelayPage};

use super::host::{self, AgentState, HostRef, PageRef};
use super::{ctx, page};
use crate::{cdp, session, state};

/// Activity marks reach the panel at most this often.
const ACTIVITY_MS: f64 = 250.0;
/// A page that never loaded about:blank is given this long before the agent's call goes on.
const RENDERER_WAIT_MS: i64 = 10_000;

thread_local! {
    static NEXT_ERA: Cell<u64> = const { Cell::new(1) };
}

/// One agent on one page of a host.
pub(super) struct Agent {
    ext: RelayExtension,
    pub(super) page: u64,
    /// A later agent on the same host never answers an earlier one's callbacks.
    era: u64,
    hello_sent: bool,
    last_published: f64,
    latest: String,
    pending: bool,
    /// Calls waiting for the page's first document (about:blank).
    renderers: Vec<u64>,
}

impl Agent {
    fn new(ext: RelayExtension, page: u64) -> Self {
        Self {
            ext,
            page,
            era: NEXT_ERA.with(|g| g.replace(g.get() + 1)),
            hello_sent: false,
            last_published: f64::NEG_INFINITY,
            latest: String::new(),
            pending: false,
            renderers: Vec::new(),
        }
    }
}

/// The page as the relay sees it: its address, title and user agent.
fn page_info(wc_id: u64) -> (String, String, String) {
    let Some(entry) = state::wc(wc_id) else {
        return (String::new(), String::new(), session::default_user_agent());
    };
    let e = entry.borrow();
    let agent = if e.state.user_agent.is_empty() {
        session::default_user_agent()
    } else {
        e.state.user_agent.clone()
    };
    (e.state.url.clone(), e.state.title.clone(), agent)
}

fn post(host: &HostRef, frame: &Value) {
    let owner = host.borrow().owner.clone();
    ctx().emit(
        "relayOut",
        json!({ "owner": owner, "data": frame.to_string() }),
    );
}

/// `agentStart` on the shown page: its extension is made, the socket's `hello` follows with `ready`.
pub(super) fn start(host: &HostRef, tab_id: &str) {
    release(host, false);
    let page = host::active_page(host);
    let wc_id = page.borrow().wc_id;
    let (url, title, user_agent) = page_info(wc_id);
    let remote = host.borrow().remote;
    let ext = RelayExtension::new(
        RelayPage {
            id: wc_id as i64,
            url,
            title,
            user_agent,
            attached: false,
        },
        remote,
    );
    host.borrow_mut().agent = Some(Agent::new(ext, wc_id));
    let tab_id = tab_id.to_owned();
    host::publish(host, &page, move |s| {
        s.agent = Some(AgentState {
            tab_id,
            attached: false,
            last_action: String::new(),
        });
    });
}

/// The socket is open: the extension's `hello` goes out, unless the agent was stopped meanwhile.
pub(super) fn ready(host: &HostRef) {
    let Some(wc_id) = host.borrow().agent.as_ref().map(|a| a.page) else {
        return;
    };
    let (url, title, _) = page_info(wc_id);
    let hello = {
        let mut h = host.borrow_mut();
        let Some(agent) = h.agent.as_mut().filter(|a| !a.hello_sent) else {
            return;
        };
        agent.hello_sent = true;
        agent.ext.set_page_info(&url, &title);
        agent
            .ext
            .hello(&format!("ompdesk-preview-{}", host::uuid()))
    };
    post(host, &hello);
}

/// Take over, another tab, the panel closed, or the relay went away: the debugger is released and Node closes the socket.
pub(super) fn stop(host: &HostRef) {
    release(host, true);
}

/// Lets the agent go. `notify`: tell Node to close the socket (a restart's old socket is closed by Node already, and
/// the new one it holds must stay).
fn release(host: &HostRef, notify: bool) {
    let Some(mut agent) = host.borrow_mut().agent.take() else {
        return;
    };
    for effect in agent.ext.dispose() {
        if matches!(effect, Effect::Detach) {
            cdp::detach(agent.page);
        }
    }
    if notify {
        let owner = host.borrow().owner.clone();
        ctx().emit("relayEnd", json!({ "owner": owner }));
    }
    if let Some(page) = host::page(agent.page) {
        page.borrow_mut().state.agent = None;
    }
    host::send(host);
}

/// A frame from the relay.
pub(super) fn incoming(host: &HostRef, data: &str) {
    let Some((wc_id, era)) = agent_of(host) else {
        return;
    };
    let (url, title, _) = page_info(wc_id);
    let effects = with_ext(host, era, |ext| {
        ext.set_page_info(&url, &title);
        ext.handle(data)
    });
    apply(host, era, effects);
}

/// The page navigated or retitled (the agent's tab list follows).
pub(super) fn page_updated(host: &HostRef, page: &PageRef) {
    let wc_id = page.borrow().wc_id;
    let Some((agent_page, era)) = agent_of(host) else {
        return;
    };
    if agent_page != wc_id {
        return;
    }
    let (url, title, _) = page_info(wc_id);
    let effects = with_ext(host, era, |ext| {
        ext.set_page_info(&url, &title);
        ext.page_updated()
    });
    apply(host, era, effects);
}

/// A DevTools event of the debugger's session (`cdp.rs`).
pub(super) fn debugger_event(wc_id: u64, method: &str, params: &Value, session_id: Option<&str>) {
    let Some((host, era)) = of_page(wc_id) else {
        return;
    };
    let effects = with_ext(&host, era, |ext| {
        ext.on_debugger_event(method, params, session_id)
    });
    apply(&host, era, effects);
}

/// The debugger's session ended (DevTools took the page, or the page went away).
pub(super) fn debugger_detached(wc_id: u64, reason: &str) {
    let Some((host, era)) = of_page(wc_id) else {
        return;
    };
    let effects = with_ext(&host, era, |ext| ext.on_debugger_detached(reason));
    apply(&host, era, effects);
}

/// The page finished loading, failed to, or went away: calls waiting for its first document go on.
pub(super) fn loaded(host: &HostRef, wc_id: u64) {
    let waiting = {
        let mut h = host.borrow_mut();
        match h.agent.as_mut().filter(|a| a.page == wc_id) {
            Some(agent) => (agent.era, std::mem::take(&mut agent.renderers)),
            None => return,
        }
    };
    for token in waiting.1 {
        renderer_done(host, waiting.0, token);
    }
}

fn agent_of(host: &HostRef) -> Option<(u64, u64)> {
    host.borrow().agent.as_ref().map(|a| (a.page, a.era))
}

fn of_page(wc_id: u64) -> Option<(HostRef, u64)> {
    let host = host::host_of(&host::page(wc_id)?)?;
    let (page, era) = agent_of(&host)?;
    (page == wc_id).then_some((host, era))
}

fn with_ext(
    host: &HostRef,
    era: u64,
    f: impl FnOnce(&mut RelayExtension) -> Vec<Effect>,
) -> Vec<Effect> {
    match host.borrow_mut().agent.as_mut() {
        Some(agent) if agent.era == era => f(&mut agent.ext),
        _ => Vec::new(),
    }
}

/// Carries out the effects in order; what a re-entrant call returns runs before the next effect of this list.
fn apply(host: &HostRef, era: u64, effects: Vec<Effect>) {
    for effect in effects {
        let Some((wc_id, current)) = agent_of(host) else {
            return;
        };
        if current != era {
            return;
        }
        match effect {
            Effect::Post(frame) => post(host, &frame),
            Effect::Activity(method) => activity(host, era, &method),
            Effect::EnsureRenderer { token } => ensure_renderer(host, era, wc_id, token),
            Effect::Attach { token } => {
                cdp::attach(wc_id);
                let next = with_ext(host, era, |ext| ext.on_command_result(token, Ok(json!({}))));
                apply(host, era, next);
            }
            Effect::Detach => {
                cdp::detach(wc_id);
                let next = with_ext(host, era, |ext| ext.on_debugger_detached("target closed"));
                apply(host, era, next);
            }
            Effect::Send {
                token,
                method,
                params,
                session_id,
            } => {
                let key = host.borrow().key;
                cdp::send_debugger(wc_id, &method, params, session_id, move |result| {
                    command_done(key, era, token, result.map_err(|(_, message)| message));
                });
            }
        }
    }
}

fn command_done(key: i64, era: u64, token: u64, result: Result<Value, String>) {
    let Some(host) = host::host(key) else {
        return;
    };
    let next = with_ext(&host, era, |ext| ext.on_command_result(token, result));
    apply(&host, era, next);
}

fn ensure_renderer(host: &HostRef, era: u64, wc_id: u64, token: u64) {
    let has_document = state::wc(wc_id).is_some_and(|e| !e.borrow().state.url.is_empty());
    if has_document {
        return renderer_done(host, era, token);
    }
    if let Some(agent) = host.borrow_mut().agent.as_mut() {
        agent.renderers.push(token);
    }
    page::load(wc_id, "about:blank");
    let key = host.borrow().key;
    crate::ui::post_delayed(RENDERER_WAIT_MS, move || {
        if let Some(host) = host::host(key) {
            let waiting = host
                .borrow_mut()
                .agent
                .as_mut()
                .filter(|a| a.era == era)
                .is_some_and(|a| {
                    let had = a.renderers.contains(&token);
                    a.renderers.retain(|t| *t != token);
                    had
                });
            if waiting {
                renderer_done(&host, era, token);
            }
        }
    });
}

fn renderer_done(host: &HostRef, era: u64, token: u64) {
    let next = with_ext(host, era, |ext| ext.on_renderer_ready(token, Ok(())));
    apply(host, era, next);
}

/// The agent ran `method` (`""`: it let go of the debugger): the panel's mark, at most every `ACTIVITY_MS`.
fn activity(host: &HostRef, era: u64, method: &str) {
    let now = host::clock_ms();
    let wait = {
        let mut h = host.borrow_mut();
        let Some(agent) = h.agent.as_mut().filter(|a| a.era == era) else {
            return;
        };
        if !method.is_empty() {
            method.clone_into(&mut agent.latest);
        }
        if agent.pending {
            return;
        }
        ACTIVITY_MS - (now - agent.last_published)
    };
    if wait <= 0.0 {
        return flush(host, era);
    }
    if let Some(agent) = host.borrow_mut().agent.as_mut() {
        agent.pending = true;
    }
    let key = host.borrow().key;
    crate::ui::post_delayed(wait.ceil() as i64, move || {
        if let Some(host) = host::host(key) {
            flush(&host, era);
        }
    });
}

fn flush(host: &HostRef, era: u64) {
    let (wc_id, attached, latest) = {
        let mut h = host.borrow_mut();
        let Some(agent) = h.agent.as_mut().filter(|a| a.era == era) else {
            return;
        };
        agent.pending = false;
        agent.last_published = host::clock_ms();
        (agent.page, agent.ext.attached(), agent.latest.clone())
    };
    let Some(page) = host::page(wc_id) else {
        return;
    };
    if page.borrow().state.agent.is_none() {
        return;
    }
    host::publish(host, &page, move |s| {
        if let Some(agent) = s.agent.as_mut() {
            agent.attached = attached;
            if !latest.is_empty() {
                agent.last_action = latest;
            }
        }
    });
}
