//! The Preview's side of stock omp's browser relay, as pure rules (port of `src/main/preview/agent-relay.ts`).
//!
//! Stock's relay server drives "tabs" through a companion Chrome extension; the preview plays that extension for its
//! one page. This file holds what decides what the agent may do (`refused_command`) and the extension's wire logic
//! (`RelayExtension`), with no CEF, no clock and no async: every step the TypeScript `await`ed is an [`Effect`] the glue
//! carries out and whose completion it feeds back by a method call. A frame the relay sends goes to `handle`; the
//! page's own DevTools events, detach and the renderer coming up go to the `on_*` methods.
//!
//! Safety rules kept from the TypeScript (AGENTS.md › Preview): only an allowlist of the page's own CDP domains is
//! forwarded, only to sessions the page's own debugger announced, and navigation off http(s), downloads, file pickers
//! and other targets are refused before the page sees them.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use super::js::{is_line_end, is_space};
use super::urls::{is_loopback_url, preview_url};

/// Stock's `DISCARDED_TABS_PROTOCOL_VERSION`: required for the relay to list our tab.
const DISCARDED_TABS_PROTOCOL: u32 = 1;

/// CDP domains the agent may drive on the page: what stock's browser tool (puppeteer) uses against one page. Everything
/// else is refused, so a new or browser-wide domain stays off until it is listed here. `Browser`, `SystemInfo`,
/// `Tethering`, `Tracing` and `Memory` are deliberately absent; `Target` has its own two-method list below.
const ALLOWED_DOMAINS: &[&str] = &[
    "Accessibility",
    "Animation",
    "Audits",
    "CSS",
    "Console",
    "DOM",
    "DOMDebugger",
    "DOMSnapshot",
    "DOMStorage",
    "Debugger",
    "Emulation",
    "Fetch",
    "HeapProfiler",
    "IO",
    "Input",
    "Inspector",
    "Log",
    "Media",
    "Network",
    "Overlay",
    "Page",
    "Performance",
    "PerformanceTimeline",
    "Profiler",
    "Runtime",
    "Security",
    "ServiceWorker",
    "Storage",
];

/// The only `Target.` methods forwarded: the page arms auto-attach over its own frames and workers, and drops one of
/// those sessions again. Every other Target method can reach beyond the page, so it stays refused.
const ALLOWED_TARGET_METHODS: &[&str] = &["Target.setAutoAttach", "Target.detachFromTarget"];

/// Inside an allowed domain, methods that still reach beyond the page: its tab, files, downloads, TLS.
const REFUSED_METHODS: &[&str] = &[
    "DOM.setFileInputFiles",
    "Input.setInterceptDrags",
    "Page.close",
    "Page.crash",
    "Page.setDownloadBehavior",
    "Page.setInterceptFileChooserDialog",
    "Security.handleCertificateError",
    "Security.setIgnoreCertificateErrors",
    "Security.setOverrideCertificateErrors",
];

/// Why a domain is refused with its own text instead of the generic one, so the agent's tool error says why.
const TRACING_REASON: &str = "OMPdesk's preview does not allow Tracing (tab.traceStart): a trace is browser-wide and would record the app's other windows. Use Performance or Profiler on this page instead";

/// Announced targets that are not children of this page (a session onto them is never relayed).
const FOREIGN_TARGET_TYPES: &[&str] = &["page", "tab", "browser"];

const LOOPBACK_REASON: &str =
    "OMPdesk's preview does not open this computer's own addresses for a paired computer's agent";

/// Why the preview may not show `url`, or None: `about:blank` or an http(s) page (the rule every navigation shares), and
/// for a paired host's agent never this computer's own addresses. `url` is None when the value is absent; anything that
/// is not a string is refused like a non-http(s) address.
fn navigation_refusal(url: Option<&Value>, block_loopback: bool) -> Option<&'static str> {
    if url.and_then(Value::as_str) == Some("about:blank") {
        return None;
    }
    let Some(safe) = url.and_then(Value::as_str).and_then(preview_url) else {
        return Some("OMPdesk's preview only opens http(s) pages");
    };
    (block_loopback && is_loopback_url(&safe)).then_some(LOOPBACK_REASON)
}

/// `/^\s*file:/im.test(text)`: some line of `text` starts, after any whitespace, with `file:` in any letter case.
fn names_file_url(text: &str) -> bool {
    let starts = std::iter::once(0).chain(
        text.char_indices()
            .filter(|&(_, c)| is_line_end(c))
            .map(|(i, c)| i + c.len_utf8()),
    );
    starts.into_iter().any(|start| {
        let rest = text[start..].trim_start_matches(is_space).as_bytes();
        rest.len() >= 5 && rest[..5].eq_ignore_ascii_case(b"file:")
    })
}

/// `Input.DragData` that hands the page files: `files` paths, or an item naming a `file:` URL.
fn drag_carries_files(data: &Value) -> bool {
    let Some(data) = data.as_object() else {
        return false;
    };
    if let Some(files) = data.get("files")
        && !files.as_array().is_some_and(Vec::is_empty)
    {
        return true;
    }
    let Some(items) = data.get("items").and_then(Value::as_array) else {
        return false;
    };
    let names_file = |value: &Value| value.as_str().is_some_and(names_file_url);
    items.iter().any(|item| match item {
        Value::Object(fields) => fields.values().any(names_file),
        Value::Array(elements) => elements.iter().any(names_file),
        _ => false,
    })
}

/// `Number.isInteger`.
fn is_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0)
}

/// Why the preview refuses `method` with `params`, or None to forward it. Navigation is checked here because a CDP
/// `Page.navigate` is browser-initiated and skips the preview's own navigation guard. Which session a command addresses
/// is checked by `RelayExtension`, which sees the page's events. `params` that is not an object (the TypeScript's
/// `undefined`, null, a string, an array) names nothing, as an empty object.
pub fn refused_command(method: &str, params: &Value, block_loopback: bool) -> Option<String> {
    // `method.slice(0, Math.max(method.indexOf("."), 0))`: no dot leaves an empty domain, which is never allowed.
    let domain = method.split_once('.').map_or("", |(domain, _)| domain);
    let allowed = if domain == "Target" {
        ALLOWED_TARGET_METHODS.contains(&method)
    } else {
        ALLOWED_DOMAINS.contains(&domain)
    };
    if !allowed || REFUSED_METHODS.contains(&method) {
        return Some(if domain == "Tracing" {
            TRACING_REASON.to_owned()
        } else {
            format!("OMPdesk's preview does not allow {method}")
        });
    }
    let named = params.as_object();
    let field = |key: &str| named.and_then(|fields| fields.get(key));
    if method == "Page.navigate"
        && let Some(refusal) = navigation_refusal(field("url"), block_loopback)
    {
        return Some(refusal.to_owned());
    }
    // The DevTools resource loader bypasses page navigation and CORS. Keep its direct URL under the same local-address
    // rule as Page.navigate, not just the scheme check, or a paired agent can read this computer's loopback services.
    if method == "Network.loadNetworkResource" {
        let Some(url) = field("url").and_then(Value::as_str).and_then(preview_url) else {
            return Some("OMPdesk's preview only loads http(s) resources".to_owned());
        };
        if block_loopback && is_loopback_url(&url) {
            return Some(LOOPBACK_REASON.to_owned());
        }
    }
    // The target URL is read from the page's own history before the command goes out (see `Step::History`).
    if method == "Page.navigateToHistoryEntry" && !field("entryId").is_some_and(is_integer) {
        return Some("OMPdesk's preview needs a history entry id to navigate".to_owned());
    }
    if method == "Input.dispatchDragEvent" && field("data").is_some_and(drag_carries_files) {
        return Some("OMPdesk's preview does not allow dropping files onto the page".to_owned());
    }
    None
}

/// What the glue carries out for the machine. Order matters: run the effects of one call in order, and run what a
/// re-entrant call (`on_debugger_detached` after `Detach`) returns before the next effect of the outer list.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// A frame to send to the relay over its socket.
    Post(Value),
    /// The agent's activity: a CDP method it just ran, `"attach"`, or `""` once it has released the page.
    Activity(String),
    /// Give a never-loaded page a renderer (about:blank): page-domain commands wait forever without one. Answer with
    /// `on_renderer_ready(token, ..)`.
    EnsureRenderer { token: u64 },
    /// Attach the page's debugger (protocol version 1.3). Answer with `on_command_result(token, ..)`: `Ok` with any
    /// value, or `Err(message)` when attaching failed.
    Attach { token: u64 },
    /// Detach the page's debugger. The glue answers with `on_debugger_detached(reason)`, from the same call.
    Detach,
    /// Run one CDP command on the page (on `session_id`'s session when given). Answer with `on_command_result(token, ..)`.
    Send {
        token: u64,
        method: String,
        params: Option<Value>,
        session_id: Option<String>,
    },
}

/// A relay → extension RPC (stock `RelayToExtMessage` with `t: "rpc"`), as stock's schema accepts it.
struct Rpc {
    id: Value,
    op: String,
    tab_id: Option<f64>,
    session_id: Option<String>,
    method: Option<String>,
    params: Option<Value>,
}

impl Rpc {
    /// None for anything the TypeScript's zod schema refuses (`pong`, unknown frames, a field of the wrong type; null
    /// is not "absent" to it).
    fn parse(frame: &Value) -> Option<Rpc> {
        let fields = frame.as_object()?;
        if fields.get("t")?.as_str()? != "rpc" {
            return None;
        }
        let id = fields.get("id").filter(|id| id.is_number())?.clone();
        let op = fields.get("op")?.as_str()?.to_owned();
        let optional = |key: &str| fields.get(key);
        let tab_id = match optional("tabId") {
            None => None,
            Some(value) => Some(value.as_f64().filter(|_| value.is_number())?),
        };
        let text = |key: &str| -> Option<Option<String>> {
            match optional(key) {
                None => Some(None),
                Some(value) => value.as_str().map(|text| Some(text.to_owned())),
            }
        };
        let params = match optional("params") {
            None => None,
            Some(value) if value.is_object() => Some(value.clone()),
            Some(_) => return None,
        };
        Some(Rpc {
            id,
            op,
            tab_id,
            session_id: text("sessionId")?,
            method: text("method")?,
            params,
        })
    }
}

/// Where one in-flight RPC waits for the glue.
enum Step {
    /// `attach`, waiting for `on_renderer_ready`.
    Renderer,
    /// `attach`, waiting for the debugger's attach result.
    Attach,
    /// `Page.navigateToHistoryEntry`, waiting for `Page.getNavigationHistory`: its entry's URL decides the command.
    History {
        method: String,
        params: Option<Value>,
        session_id: Option<String>,
        entry_id: f64,
    },
    /// A forwarded command, waiting for its result.
    Send,
}

struct Pending {
    id: Value,
    step: Step,
}

/// The preview page as the relay sees it: the inputs the machine is given.
#[derive(Debug, Clone, PartialEq)]
pub struct RelayPage {
    /// Stable numeric tab id (the preview browser's id).
    pub id: i64,
    pub url: String,
    pub title: String,
    pub user_agent: String,
    /// Whether the page's debugger is already attached when the machine starts.
    pub attached: bool,
}

/// Plays stock's relay extension for one preview page. The machine is the one owner of "is the debugger ours":
/// `Attach` sets it, `on_debugger_detached` and a failed attach clear it.
pub struct RelayExtension {
    page: RelayPage,
    block_loopback: bool,
    relay_detaching: bool,
    disposed: bool,
    /// Sessions this page's own debugger announced (its frames and workers); nothing else is addressable.
    sessions: HashSet<String>,
    pending: HashMap<u64, Pending>,
    next_token: u64,
}

fn post_result(id: &Value, result: Value) -> Effect {
    Effect::Post(json!({ "t": "rpcResult", "id": id, "ok": true, "result": result }))
}

fn post_error(id: &Value, message: impl Into<String>) -> Effect {
    Effect::Post(json!({ "t": "rpcResult", "id": id, "ok": false, "error": message.into() }))
}

/// `String(number)`: the digits JavaScript prints for a finite number.
fn js_number(n: f64) -> String {
    if n == 0.0 {
        return "0".to_owned();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    // `{:e}` is the shortest round-trip digits, as "d.ddde<exp>"; ECMAScript's Number::toString lays them out.
    let scientific = format!("{:e}", n.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let point = exponent.parse::<i32>().unwrap_or(0) + 1;
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let exp = point - 1;
        let sign_exp = if exp < 0 { '-' } else { '+' };
        let head = &digits[..1];
        let tail = &digits[1..];
        let fraction = if tail.is_empty() {
            String::new()
        } else {
            format!(".{tail}")
        };
        format!("{head}{fraction}e{sign_exp}{}", exp.abs())
    };
    format!("{sign}{body}")
}

impl RelayExtension {
    /// `block_loopback`: the agent is a paired host's, so this computer's own addresses (localhost) are not its to
    /// open (the Preview's rule for a host's tab).
    pub fn new(page: RelayPage, block_loopback: bool) -> Self {
        RelayExtension {
            page,
            block_loopback,
            relay_detaching: false,
            disposed: false,
            sessions: HashSet::new(),
            pending: HashMap::new(),
            next_token: 1,
        }
    }

    /// True while the agent holds the page's debugger.
    pub fn attached(&self) -> bool {
        !self.disposed && self.page.attached
    }

    /// The page navigated or retitled: its new address and title. Follow with `page_updated`.
    pub fn set_page_info(&mut self, url: &str, title: &str) {
        url.clone_into(&mut self.page.url);
        title.clone_into(&mut self.page.title);
    }

    /// Stock's `TabSnapshot` of the one tab.
    fn snapshot(&self) -> Value {
        json!({
            "tabId": self.page.id,
            "url": self.page.url,
            "title": self.page.title,
            "active": true,
            "discarded": false,
            "windowId": 1,
            "pinned": false,
            "groupId": -1,
        })
    }

    /// The extension's first frame: our single tab, and whether a debugger is already ours. The glue posts it.
    pub fn hello(&self, instance_id: &str) -> Value {
        let user_agent = self.page.user_agent.as_str();
        // `/Chrome\/[\d.]+/`: the first "Chrome/" that is followed by a digit or a dot.
        let version = user_agent
            .match_indices("Chrome/")
            .find_map(|(start, name)| {
                let after = start + name.len();
                let run = user_agent[after..]
                    .bytes()
                    .take_while(|b| b.is_ascii_digit() || *b == b'.')
                    .count();
                (run > 0).then(|| &user_agent[start..after + run])
            });
        json!({
            "t": "hello",
            "instanceId": instance_id,
            "userAgent": user_agent,
            "browserVersion": version.unwrap_or("Chrome/unknown"),
            "discardedTabsProtocol": DISCARDED_TABS_PROTOCOL,
            "tabs": [self.snapshot()],
            "attachedTabIds": if self.attached() { vec![self.page.id] } else { Vec::new() },
        })
    }

    /// The page navigated or retitled.
    pub fn page_updated(&self) -> Vec<Effect> {
        vec![Effect::Post(
            json!({ "t": "tabUpdated", "tab": self.snapshot() }),
        )]
    }

    fn token(&mut self, id: &Value, step: Step) -> u64 {
        let token = self.next_token;
        self.next_token += 1;
        self.pending.insert(
            token,
            Pending {
                id: id.clone(),
                step,
            },
        );
        token
    }

    /// Remember the sessions the page's debugger announces and drops: only a child of this page is addressable.
    fn track_sessions(&mut self, method: &str, params: &Value) {
        if method != "Target.attachedToTarget" && method != "Target.detachedFromTarget" {
            return;
        }
        let Some(session) = params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        if method == "Target.detachedFromTarget" {
            self.sessions.remove(session);
            return;
        }
        let kind = params
            .get("targetInfo")
            .and_then(|info| info.get("type"))
            .and_then(Value::as_str);
        if kind.is_some_and(|kind| !FOREIGN_TARGET_TYPES.contains(&kind)) {
            self.sessions.insert(session.to_owned());
        }
    }

    /// Why the preview refuses to address `session_id` (and the session `params` name), or None.
    fn refused_session(
        &self,
        method: &str,
        params: Option<&Value>,
        session_id: Option<&str>,
    ) -> Option<&'static str> {
        if session_id.is_some_and(|session| !self.sessions.contains(session)) {
            return Some("OMPdesk's preview only reaches this page's own frames and workers");
        }
        if method == "Target.detachFromTarget" {
            let named = params
                .and_then(|params| params.get("sessionId"))
                .and_then(Value::as_str);
            if !named.is_some_and(|session| self.sessions.contains(session)) {
                return Some("OMPdesk's preview only detaches this page's own frames and workers");
            }
        }
        None
    }

    /// One DevTools event of the page, relayed with its session. Announced and dropped sessions are tracked first.
    pub fn on_debugger_event(
        &mut self,
        method: &str,
        params: &Value,
        session_id: Option<&str>,
    ) -> Vec<Effect> {
        if self.disposed {
            return Vec::new();
        }
        self.track_sessions(method, params);
        let mut frame = Map::new();
        frame.insert("t".into(), json!("cdpEvent"));
        frame.insert("tabId".into(), json!(self.page.id));
        if let Some(session) = session_id.filter(|session| !session.is_empty()) {
            frame.insert("sessionId".into(), json!(session));
        }
        frame.insert("method".into(), json!(method));
        // An event with no params leaves the key out, as `JSON.stringify` does for `undefined`.
        if !params.is_null() {
            frame.insert("params".into(), params.clone());
        }
        vec![Effect::Post(Value::Object(frame))]
    }

    /// The page's debugger detached (the page went away, DevTools opened, or our own `Detach`).
    pub fn on_debugger_detached(&mut self, reason: &str) -> Vec<Effect> {
        if self.disposed {
            return Vec::new();
        }
        let relay_initiated = std::mem::take(&mut self.relay_detaching);
        self.page.attached = false;
        self.sessions.clear();
        vec![
            Effect::Post(
                json!({ "t": "detached", "tabId": self.page.id, "reason": reason, "relayInitiated": relay_initiated }),
            ),
            Effect::Activity(String::new()),
        ]
    }

    /// One relay → extension frame. A frame that is not valid JSON or not an RPC (`pong`, unknown) does nothing.
    pub fn handle(&mut self, raw_frame: &str) -> Vec<Effect> {
        let Ok(parsed) = serde_json::from_str::<Value>(raw_frame) else {
            return Vec::new();
        };
        let Some(rpc) = Rpc::parse(&parsed) else {
            return Vec::new();
        };
        self.run(rpc)
    }

    fn run(&mut self, rpc: Rpc) -> Vec<Effect> {
        let id = &rpc.id;
        if self.disposed {
            return vec![post_error(id, "The preview stopped sharing this page")];
        }
        if let Some(tab) = rpc.tab_id
            && tab != self.page.id as f64
            && rpc.op != "group"
            && rpc.op != "ungroup"
        {
            return vec![post_error(id, format!("No preview tab {}", js_number(tab)))];
        }
        match rpc.op.as_str() {
            "attach" => vec![Effect::EnsureRenderer {
                token: self.token(id, Step::Renderer),
            }],
            "detach" => {
                let mut effects = Vec::new();
                if self.page.attached {
                    self.relay_detaching = true;
                    effects.push(Effect::Detach);
                }
                effects.push(post_result(id, json!({})));
                effects
            }
            "send" => {
                let method = rpc.method.clone().unwrap_or_default();
                let null = Value::Null;
                let params = rpc.params.as_ref().unwrap_or(&null);
                let refused = refused_command(&method, params, self.block_loopback).or_else(|| {
                    self.refused_session(&method, rpc.params.as_ref(), rpc.session_id.as_deref())
                        .map(str::to_owned)
                });
                if let Some(message) = refused {
                    return vec![post_error(id, message)];
                }
                if method == "Page.navigateToHistoryEntry" {
                    // `refused_command` has checked the entry id is an integer.
                    let entry_id = params
                        .get("entryId")
                        .and_then(Value::as_f64)
                        .unwrap_or(f64::NAN);
                    let session_id = rpc.session_id.clone();
                    let token = self.token(
                        id,
                        Step::History {
                            method,
                            params: rpc.params,
                            session_id: session_id.clone(),
                            entry_id,
                        },
                    );
                    return vec![Effect::Send {
                        token,
                        method: "Page.getNavigationHistory".into(),
                        params: None,
                        session_id,
                    }];
                }
                let token = self.token(id, Step::Send);
                vec![
                    Effect::Activity(method.clone()),
                    Effect::Send {
                        token,
                        method,
                        params: rpc.params,
                        session_id: rpc.session_id,
                    },
                ]
            }
            "activateTab" | "ungroup" => vec![post_result(id, json!({}))],
            // Chrome tab groups have no preview counterpart; nothing is grouped.
            "group" => vec![post_result(id, json!({ "grouped": {} }))],
            "createTab" => vec![post_error(
                id,
                "OMPdesk's preview is a single page: navigate it instead of opening a tab",
            )],
            "removeTab" => vec![post_error(
                id,
                "OMPdesk's preview stays open; the user closes it",
            )],
            other => vec![post_error(id, format!("Unknown relay operation {other}"))],
        }
    }

    /// The renderer an `EnsureRenderer` asked for is there (`Err(message)`: it could not be made).
    pub fn on_renderer_ready(&mut self, token: u64, ready: Result<(), String>) -> Vec<Effect> {
        let Some(Pending {
            id,
            step: Step::Renderer,
        }) = self.pending.remove(&token)
        else {
            return Vec::new();
        };
        if let Err(message) = ready {
            return vec![post_error(&id, message)];
        }
        // The TypeScript attached anyway when the relay went away while the renderer started, leaving a debugger nobody
        // listens to; here a disposed machine answers the RPC and attaches nothing.
        if self.disposed {
            return vec![post_error(&id, "The preview stopped sharing this page")];
        }
        if self.page.attached {
            return vec![
                Effect::Activity("attach".into()),
                post_result(&id, json!({})),
            ];
        }
        // Set now, so a second `attach` whose renderer comes up before this result does not attach twice.
        self.page.attached = true;
        self.pending.insert(
            token,
            Pending {
                id,
                step: Step::Attach,
            },
        );
        vec![Effect::Attach { token }]
    }

    /// The result of an `Attach` or `Send` effect (`Err(message)`: the debugger refused or failed).
    pub fn on_command_result(&mut self, token: u64, result: Result<Value, String>) -> Vec<Effect> {
        let Some(Pending { id, step }) = self.pending.remove(&token) else {
            return Vec::new();
        };
        match step {
            Step::Renderer => {
                self.pending.insert(
                    token,
                    Pending {
                        id,
                        step: Step::Renderer,
                    },
                );
                Vec::new()
            }
            Step::Attach => match result {
                Ok(_) => vec![
                    Effect::Activity("attach".into()),
                    post_result(&id, json!({})),
                ],
                Err(message) => {
                    self.page.attached = false;
                    vec![post_error(&id, message)]
                }
            },
            Step::Send => match result {
                // `result && typeof result === "object" ? result : {}`: an array passes, as in JavaScript.
                Ok(value @ (Value::Object(_) | Value::Array(_))) => vec![post_result(&id, value)],
                Ok(_) => vec![post_result(&id, json!({}))],
                Err(message) => vec![post_error(&id, message)],
            },
            Step::History {
                method,
                params,
                session_id,
                entry_id,
            } => {
                let history = match result {
                    Ok(history) => history,
                    Err(message) => return vec![post_error(&id, message)],
                };
                // Stock's `tab.back()` / `tab.forward()` jump to an entry id, so its URL is looked up and held to the
                // rule every other navigation follows.
                let entry = history
                    .get("entries")
                    .and_then(Value::as_array)
                    .and_then(|entries| {
                        entries
                            .iter()
                            .find(|entry| entry.get("id").and_then(Value::as_f64) == Some(entry_id))
                    });
                if let Some(refusal) = navigation_refusal(
                    entry.and_then(|entry| entry.get("url")),
                    self.block_loopback,
                ) {
                    return vec![post_error(&id, refusal)];
                }
                self.pending.insert(
                    token,
                    Pending {
                        id,
                        step: Step::Send,
                    },
                );
                vec![
                    Effect::Activity(method.clone()),
                    Effect::Send {
                        token,
                        method,
                        params,
                        session_id,
                    },
                ]
            }
        }
    }

    /// Release the debugger and stop forwarding (take over, stop, or the relay went away). Later events and detaches
    /// are ignored; RPCs still in flight finish and are answered.
    pub fn dispose(&mut self) -> Vec<Effect> {
        if self.disposed {
            return Vec::new();
        }
        self.disposed = true;
        if std::mem::replace(&mut self.page.attached, false) {
            vec![Effect::Detach]
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The fake per-page debugger and relay socket of the TypeScript test, driving the machine's effects.
    struct Harness {
        ext: RelayExtension,
        attached: bool,
        rendered: bool,
        history: Vec<Value>,
        sent: Vec<(String, Option<Value>, Option<String>)>,
        posted: Vec<Value>,
        activity: Vec<String>,
    }

    const USER_AGENT: &str = "Mozilla/5.0 Chrome/138.0.7204.0 Electron/36.9.5";

    fn page() -> RelayPage {
        RelayPage {
            id: 7,
            url: "https://example.com/".into(),
            title: "Example".into(),
            user_agent: USER_AGENT.into(),
            attached: false,
        }
    }

    impl Harness {
        fn new() -> Self {
            Self::with(false)
        }

        fn with(block_loopback: bool) -> Self {
            Harness {
                ext: RelayExtension::new(page(), block_loopback),
                attached: false,
                rendered: false,
                history: Vec::new(),
                sent: Vec::new(),
                posted: Vec::new(),
                activity: Vec::new(),
            }
        }

        fn run(&mut self, effects: Vec<Effect>) {
            for effect in effects {
                let more = match effect {
                    Effect::Post(frame) => {
                        self.posted.push(frame);
                        Vec::new()
                    }
                    Effect::Activity(method) => {
                        self.activity.push(method);
                        Vec::new()
                    }
                    Effect::EnsureRenderer { token } => {
                        self.rendered = true;
                        self.ext.on_renderer_ready(token, Ok(()))
                    }
                    Effect::Attach { token } => {
                        let result = if self.attached {
                            Err("already attached".to_owned())
                        } else {
                            self.attached = true;
                            Ok(Value::Null)
                        };
                        self.ext.on_command_result(token, result)
                    }
                    Effect::Detach => {
                        self.attached = false;
                        self.ext.on_debugger_detached("target closed")
                    }
                    Effect::Send {
                        token,
                        method,
                        params,
                        session_id,
                    } => {
                        let result = match method.as_str() {
                            "Page.getNavigationHistory" => {
                                json!({ "currentIndex": self.history.len() as i64 - 1, "entries": self.history })
                            }
                            "Runtime.evaluate" => {
                                json!({ "result": { "type": "string", "value": "Example" } })
                            }
                            _ => Value::Null,
                        };
                        self.sent.push((method, params, session_id));
                        self.ext.on_command_result(token, Ok(result))
                    }
                };
                self.run(more);
            }
        }

        fn rpc(&mut self, id: i64, body: Value) -> Option<Value> {
            let mut frame = json!({ "t": "rpc", "id": id });
            frame
                .as_object_mut()
                .unwrap()
                .extend(body.as_object().unwrap().clone());
            let effects = self.ext.handle(&frame.to_string());
            self.run(effects);
            self.posted
                .iter()
                .find(|m| m["t"] == "rpcResult" && m["id"] == id)
                .cloned()
        }

        fn ok(&mut self, id: i64, body: Value) -> bool {
            self.rpc(id, body)
                .is_some_and(|result| result["ok"] == true)
        }

        fn failed(&mut self, id: i64, body: Value) -> bool {
            self.rpc(id, body)
                .is_some_and(|result| result["ok"] == false)
        }

        fn emit(&mut self, method: &str, params: Value, session: Option<&str>) {
            let effects = self.ext.on_debugger_event(method, &params, session);
            self.run(effects);
        }

        fn sent_methods(&self) -> Vec<&str> {
            self.sent
                .iter()
                .map(|(method, ..)| method.as_str())
                .collect()
        }

        fn attach(&mut self) {
            assert!(self.ok(1, json!({ "op": "attach", "tabId": 7 })));
        }
    }

    #[test]
    fn matches_the_typescript_table() {
        let rows = super::super::captured("relay-commands").as_array().unwrap();
        assert!(rows.len() >= 171);
        for row in rows {
            let got = refused_command(
                row["method"].as_str().unwrap(),
                &row["params"],
                row["block"].as_bool().unwrap(),
            );
            assert_eq!(json!(got), row["out"], "{row}");
        }
    }

    #[test]
    fn says_hello_with_the_one_preview_tab_in_stocks_discarded_tabs_protocol() {
        let harness = Harness::new();
        assert_eq!(
            harness.ext.hello("ompdesk-preview-x"),
            json!({
                "t": "hello",
                "instanceId": "ompdesk-preview-x",
                "userAgent": USER_AGENT,
                "browserVersion": "Chrome/138.0.7204.0",
                "discardedTabsProtocol": 1,
                "tabs": [{
                    "tabId": 7,
                    "url": "https://example.com/",
                    "title": "Example",
                    "active": true,
                    "discarded": false,
                    "windowId": 1,
                    "pinned": false,
                    "groupId": -1,
                }],
                "attachedTabIds": [],
            })
        );
    }

    #[test]
    fn says_hello_with_an_attached_debugger_and_no_chrome_version() {
        let mut attached = page();
        attached.attached = true;
        attached.user_agent = "Chrome/ Chrome/9.1 x".into();
        let hello = RelayExtension::new(attached, false).hello("x");
        assert_eq!(hello["attachedTabIds"], json!([7]));
        assert_eq!(hello["browserVersion"], "Chrome/9.1");
        let mut bare = page();
        bare.user_agent = "Mozilla/5.0".into();
        assert_eq!(
            RelayExtension::new(bare, false).hello("x")["browserVersion"],
            "Chrome/unknown"
        );
    }

    #[test]
    fn announces_a_navigated_page() {
        let mut harness = Harness::new();
        harness.ext.set_page_info("https://b.test/", "B");
        let effects = harness.ext.page_updated();
        assert_eq!(
            effects,
            vec![Effect::Post(json!({ "t": "tabUpdated", "tab": {
                "tabId": 7, "url": "https://b.test/", "title": "B", "active": true,
                "discarded": false, "windowId": 1, "pinned": false, "groupId": -1,
            }}))]
        );
    }

    #[test]
    fn attaches_forwards_commands_and_events_with_session_ids_and_reports_activity() {
        let mut harness = Harness::new();
        assert_eq!(
            harness.rpc(1, json!({ "op": "attach", "tabId": 7 })),
            Some(json!({ "t": "rpcResult", "id": 1, "ok": true, "result": {} }))
        );
        assert!(harness.attached);
        assert!(harness.rendered);
        assert_eq!(
            harness.rpc(2, json!({ "op": "send", "tabId": 7, "method": "Runtime.evaluate", "params": { "expression": "document.title" } })),
            Some(json!({ "t": "rpcResult", "id": 2, "ok": true, "result": { "result": { "type": "string", "value": "Example" } } }))
        );
        harness.emit(
            "Target.attachedToTarget",
            json!({ "sessionId": "child-1", "targetInfo": { "type": "iframe", "targetId": "frame-1" }, "waitingForDebugger": false }),
            None,
        );
        harness.rpc(
            3,
            json!({ "op": "send", "tabId": 7, "sessionId": "child-1", "method": "Runtime.enable" }),
        );
        assert_eq!(
            harness
                .sent
                .iter()
                .map(|(method, _, session)| (method.as_str(), session.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("Runtime.evaluate", None),
                ("Runtime.enable", Some("child-1"))
            ]
        );
        harness.emit(
            "Page.loadEventFired",
            json!({ "timestamp": 1 }),
            Some("child-1"),
        );
        assert_eq!(
            harness.posted.last(),
            Some(
                &json!({ "t": "cdpEvent", "tabId": 7, "sessionId": "child-1", "method": "Page.loadEventFired", "params": { "timestamp": 1 } })
            )
        );
        assert_eq!(
            harness.activity,
            ["attach", "Runtime.evaluate", "Runtime.enable"]
        );
    }

    #[test]
    fn leaves_an_empty_session_and_missing_params_out_of_an_event() {
        let mut harness = Harness::new();
        harness.emit("Page.frameStoppedLoading", Value::Null, Some(""));
        assert_eq!(
            harness.posted,
            [json!({ "t": "cdpEvent", "tabId": 7, "method": "Page.frameStoppedLoading" })]
        );
    }

    #[test]
    fn refuses_navigation_off_http_browser_wide_commands_and_new_or_closed_tabs() {
        let mut harness = Harness::new();
        harness.attach();
        let bodies = [
            json!({ "op": "send", "tabId": 7, "method": "Page.navigate", "params": { "url": "file:///etc/passwd" } }),
            json!({ "op": "send", "tabId": 7, "method": "Page.setDownloadBehavior", "params": { "behavior": "allow" } }),
            json!({ "op": "send", "tabId": 7, "method": "Browser.setDownloadBehavior", "params": {} }),
            json!({ "op": "createTab", "url": "https://example.org/" }),
            json!({ "op": "removeTab", "tabId": 7 }),
            json!({ "op": "send", "tabId": 99, "method": "Runtime.enable" }),
        ];
        for (index, body) in bodies.into_iter().enumerate() {
            assert!(harness.failed(2 + index as i64, body.clone()), "{body}");
        }
        assert!(harness.sent.is_empty());
        assert!(harness.ok(8, json!({ "op": "send", "tabId": 7, "method": "Page.navigate", "params": { "url": "https://a.test/" } })));
        let grouped = harness.rpc(
            9,
            json!({ "op": "group", "tabIds": [7], "title": "omp", "color": "cyan" }),
        );
        assert_eq!(grouped.unwrap()["result"], json!({ "grouped": {} }));
    }

    #[test]
    fn answers_each_refusal_and_unknown_operation_with_its_text() {
        let mut harness = Harness::new();
        let text = |harness: &mut Harness, id, body| {
            harness.rpc(id, body).unwrap()["error"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(
            text(&mut harness, 1, json!({ "op": "createTab" })),
            "OMPdesk's preview is a single page: navigate it instead of opening a tab"
        );
        assert_eq!(
            text(&mut harness, 2, json!({ "op": "removeTab" })),
            "OMPdesk's preview stays open; the user closes it"
        );
        assert_eq!(
            text(&mut harness, 3, json!({ "op": "frobnicate" })),
            "Unknown relay operation frobnicate"
        );
        assert_eq!(
            text(&mut harness, 4, json!({ "op": "send", "tabId": 99 })),
            "No preview tab 99"
        );
        assert_eq!(
            text(&mut harness, 5, json!({ "op": "send", "tabId": 1.5 })),
            "No preview tab 1.5"
        );
        assert_eq!(
            text(&mut harness, 6, json!({ "op": "send", "tabId": 7 })),
            "OMPdesk's preview does not allow "
        );
        // A group or ungroup for another tab is answered, not refused.
        assert!(harness.ok(7, json!({ "op": "group", "tabId": 99 })));
        assert!(harness.ok(8, json!({ "op": "ungroup", "tabId": 99 })));
        assert!(harness.ok(9, json!({ "op": "activateTab", "tabId": 7 })));
    }

    #[test]
    fn ignores_frames_that_are_not_rpcs_in_stocks_schema() {
        let mut harness = Harness::new();
        for raw in [
            "not json",
            "null",
            "[]",
            r#"{"t":"pong"}"#,
            r#"{"t":"rpc","id":1}"#,
            r#"{"t":"rpc","id":"1","op":"attach"}"#,
            r#"{"t":"rpc","id":1,"op":"attach","tabId":null}"#,
            r#"{"t":"rpc","id":1,"op":"send","params":[]}"#,
            r#"{"t":"rpc","id":1,"op":"send","params":null}"#,
            r#"{"t":"rpc","id":1,"op":"send","method":5}"#,
            r#"{"t":"rpc","id":1,"op":"send","sessionId":null}"#,
        ] {
            assert_eq!(harness.ext.handle(raw), Vec::new(), "{raw}");
        }
    }

    #[test]
    fn refuses_every_method_outside_the_pages_own_domains_and_the_dangerous_ones_inside_them() {
        let mut harness = Harness::new();
        harness.attach();
        let refused = [
            "Target.getTargets",
            "Target.setDiscoverTargets",
            "Target.attachToTarget",
            "Target.attachToBrowserTarget",
            "Target.sendMessageToTarget",
            "Target.activateTarget",
            "Target.getTargetInfo",
            "Target.createTarget",
            "Target.closeTarget",
            "Target.createBrowserContext",
            "Target.disposeBrowserContext",
            "Target.exposeDevToolsProtocol",
            "DOM.setFileInputFiles",
            "Page.setInterceptFileChooserDialog",
            "Input.setInterceptDrags",
            "Page.close",
            "Page.crash",
            "Page.navigateToHistoryEntry",
            "Page.setDownloadBehavior",
            "Security.setIgnoreCertificateErrors",
            "Security.setOverrideCertificateErrors",
            "Security.handleCertificateError",
            "Browser.close",
            "Browser.getVersion",
            "SystemInfo.getInfo",
            "Tethering.bind",
            "Tracing.start",
            "Memory.getDOMCounters",
            "constructor",
            "toString",
            "__proto__.x",
            "",
        ];
        for (index, method) in refused.into_iter().enumerate() {
            let body = json!({ "op": "send", "tabId": 7, "method": method, "params": {} });
            assert!(harness.failed(10 + index as i64, body), "{method}");
            assert!(
                refused_command(method, &json!({}), false).is_some(),
                "{method}"
            );
        }
        assert!(harness.sent.is_empty());
    }

    #[test]
    fn forwards_the_commands_stocks_browser_tool_needs() {
        let mut harness = Harness::new();
        harness.attach();
        let allowed = [
            "Runtime.enable",
            "Runtime.callFunctionOn",
            "Page.enable",
            "Page.captureScreenshot",
            "Page.stopLoading",
            "Page.setWebLifecycleState",
            "Page.handleJavaScriptDialog",
            "DOM.getDocument",
            "Input.dispatchMouseEvent",
            "Network.enable",
            "Fetch.disable",
            "Emulation.setUserAgentOverride",
            "Inspector.enable",
            "Profiler.start",
            "Target.setAutoAttach",
        ];
        for (index, method) in allowed.into_iter().enumerate() {
            assert!(
                harness.ok(
                    100 + index as i64,
                    json!({ "op": "send", "tabId": 7, "method": method, "params": {} })
                ),
                "{method}"
            );
        }
        assert_eq!(harness.sent_methods(), allowed);
    }

    #[test]
    fn lets_stocks_back_and_forward_through_after_reading_the_entrys_url() {
        let mut harness = Harness::new();
        harness.attach();
        harness.history = vec![
            json!({ "id": 1, "url": "about:blank" }),
            json!({ "id": 2, "url": "https://a.test/" }),
            json!({ "id": 3, "url": "file:///etc/passwd" }),
            json!({ "id": 4, "url": "chrome://gpu" }),
        ];
        let go = |harness: &mut Harness, id: i64, entry_id: Option<Value>| {
            let params =
                entry_id.map_or_else(|| json!({}), |entry_id| json!({ "entryId": entry_id }));
            harness.rpc(id, json!({ "op": "send", "tabId": 7, "method": "Page.navigateToHistoryEntry", "params": params }))
        };
        assert_eq!(go(&mut harness, 2, Some(json!(1))).unwrap()["ok"], true);
        assert_eq!(go(&mut harness, 3, Some(json!(2))).unwrap()["ok"], true);
        for (id, entry_id) in [
            (4, Some(json!(3))),
            (5, Some(json!(4))),
            (6, Some(json!(99))),
            (7, Some(json!("2"))),
            (8, None),
        ] {
            let result = go(&mut harness, id, entry_id.clone()).unwrap();
            assert_eq!(result["ok"], false, "{entry_id:?}");
        }
        assert_eq!(
            harness.sent_methods(),
            [
                "Page.getNavigationHistory",
                "Page.navigateToHistoryEntry",
                "Page.getNavigationHistory",
                "Page.navigateToHistoryEntry",
                "Page.getNavigationHistory",
                "Page.getNavigationHistory",
                "Page.getNavigationHistory",
            ]
        );
        let navigations: Vec<_> = harness
            .sent
            .iter()
            .filter(|(method, ..)| method == "Page.navigateToHistoryEntry")
            .map(|(_, params, _)| params.clone())
            .collect();
        assert_eq!(
            navigations,
            [Some(json!({ "entryId": 1 })), Some(json!({ "entryId": 2 }))]
        );
        // Only the real command counts as the agent's activity, not the history lookup.
        assert_eq!(
            harness.activity,
            [
                "attach",
                "Page.navigateToHistoryEntry",
                "Page.navigateToHistoryEntry"
            ]
        );
    }

    #[test]
    fn holds_a_history_entry_to_the_paired_hosts_loopback_rule_and_reports_a_failed_lookup() {
        let mut harness = Harness::with(true);
        harness.attach();
        harness.history = vec![
            json!({ "id": 1, "url": "http://localhost:3000/" }),
            json!({ "id": 2, "url": "https://a.test/" }),
        ];
        let go = |harness: &mut Harness, id: i64, entry_id: i64| {
            harness.rpc(id, json!({ "op": "send", "tabId": 7, "method": "Page.navigateToHistoryEntry", "params": { "entryId": entry_id } }))
        };
        let refused = go(&mut harness, 2, 1).unwrap();
        assert_eq!(
            refused["error"],
            "OMPdesk's preview does not open this computer's own addresses for a paired computer's agent"
        );
        assert_eq!(go(&mut harness, 3, 2).unwrap()["ok"], true);
        // A failing lookup is the RPC's error, and the command never goes out.
        let effects = harness.ext.handle(&json!({ "t": "rpc", "id": 4, "op": "send", "method": "Page.navigateToHistoryEntry", "params": { "entryId": 2 } }).to_string());
        let [Effect::Send { token, method, .. }] = effects.as_slice() else {
            panic!("{effects:?}")
        };
        assert_eq!(method, "Page.getNavigationHistory");
        let failed = harness
            .ext
            .on_command_result(*token, Err("No frame".into()));
        assert_eq!(
            failed,
            vec![Effect::Post(
                json!({ "t": "rpcResult", "id": 4, "ok": false, "error": "No frame" })
            )]
        );
    }

    #[test]
    fn answers_tracing_with_a_reason_the_agents_tool_error_can_show() {
        let mut harness = Harness::new();
        harness.attach();
        let result = harness
            .rpc(
                2,
                json!({ "op": "send", "tabId": 7, "method": "Tracing.start", "params": {} }),
            )
            .unwrap();
        assert_eq!(result["ok"], false);
        let error = result["error"].as_str().unwrap();
        assert!(
            error.contains("Tracing")
                && error.contains("traceStart")
                && error.contains("browser-wide"),
            "{error}"
        );
        assert!(harness.sent.is_empty());
    }

    #[test]
    fn refuses_a_drag_that_carries_files_or_file_paths_and_forwards_one_that_carries_text() {
        let mut harness = Harness::new();
        harness.attach();
        let drag = |harness: &mut Harness, id: i64, data: Value| {
            harness.rpc(id, json!({ "op": "send", "tabId": 7, "method": "Input.dispatchDragEvent", "params": { "type": "drop", "x": 1, "y": 1, "data": data } }))
        };
        for (id, data) in [
            (2, json!({ "items": [], "files": ["/etc/hosts"] })),
            (3, json!({ "items": [], "files": "/etc/hosts" })),
            (
                4,
                json!({ "items": [{ "mimeType": "text/uri-list", "data": "file:///etc/hosts" }] }),
            ),
        ] {
            let result = drag(&mut harness, id, data.clone()).unwrap();
            assert_eq!(result["ok"], false, "{data}");
            assert!(result["error"].as_str().unwrap().contains("files"));
        }
        assert!(harness.sent.is_empty());
        assert_eq!(
            drag(
                &mut harness,
                5,
                json!({ "items": [{ "mimeType": "text/plain", "data": "hello" }], "files": [] })
            )
            .unwrap()["ok"],
            true
        );
        assert_eq!(
            drag(
                &mut harness,
                6,
                json!({ "items": [{ "mimeType": "text/plain", "data": "hello" }] })
            )
            .unwrap()["ok"],
            true
        );
        assert_eq!(
            harness.sent_methods(),
            ["Input.dispatchDragEvent", "Input.dispatchDragEvent"]
        );
    }

    #[test]
    fn finds_a_file_url_at_the_start_of_any_line_in_any_case() {
        for hit in [
            "file:///x",
            "  FILE:///x",
            "a\nfile:///x",
            "a\r\n\t File:x",
            "a\u{2028}file:",
            "\u{feff}file:",
        ] {
            assert!(names_file_url(hit), "{hit:?}");
        }
        for miss in [
            "",
            "xfile:///x",
            "a file:///x",
            "fil:",
            "ſile:",
            "http://a/file:",
        ] {
            assert!(!names_file_url(miss), "{miss:?}");
        }
    }

    #[test]
    fn loads_a_network_resource_for_the_page_only_from_an_http_url() {
        let mut harness = Harness::new();
        harness.attach();
        let load = |harness: &mut Harness, id: i64, url: Option<&str>| {
            let mut params = json!({ "frameId": "f", "options": { "disableCache": true, "includeCredentials": false } });
            if let Some(url) = url {
                params["url"] = json!(url);
            }
            harness.rpc(id, json!({ "op": "send", "tabId": 7, "method": "Network.loadNetworkResource", "params": params }))
        };
        for (id, url) in [
            (2, Some("file:///etc/hosts")),
            (3, Some("FILE:///etc/hosts")),
            (4, Some("chrome://version")),
            (5, Some("data:text/plain,x")),
            (6, None),
        ] {
            let result = load(&mut harness, id, url).unwrap();
            assert_eq!(result["ok"], false, "{url:?}");
            assert!(result["error"].as_str().unwrap().contains("http(s)"));
        }
        assert!(harness.sent.is_empty());
        assert_eq!(
            load(&mut harness, 7, Some("https://example.com/app.js.map")).unwrap()["ok"],
            true
        );
        assert_eq!(harness.sent_methods(), ["Network.loadNetworkResource"]);
    }

    #[test]
    fn a_paired_agent_cannot_read_local_services_through_the_resource_loader() {
        let mut remote = Harness::with(true);
        remote.attach();
        let mut local = Harness::new();
        local.attach();
        for (id, url) in [
            (2, "http://127.0.0.1:47831/"),
            (3, "http://localhost:9333/json"),
            (4, "http://[::1]:8000/private"),
            (5, "http://2130706433:8000/private"),
        ] {
            let rpc = json!({
                "op": "send", "tabId": 7, "method": "Network.loadNetworkResource",
                "params": { "frameId": "f", "url": url, "options": { "includeCredentials": true } }
            });
            let refused = remote.rpc(id, rpc.clone()).unwrap();
            assert_eq!(refused["ok"], false, "{url}");
            assert!(
                refused["error"]
                    .as_str()
                    .unwrap()
                    .contains("paired computer")
            );
            assert_eq!(local.rpc(id, rpc).unwrap()["ok"], true, "{url}");
        }
        assert!(remote.sent.is_empty());
        assert_eq!(
            remote
                .rpc(
                    6,
                    json!({
                        "op": "send", "tabId": 7, "method": "Network.loadNetworkResource",
                        "params": { "frameId": "f", "url": "https://example.com/app.js.map" }
                    })
                )
                .unwrap()["ok"],
            true
        );
    }

    #[test]
    fn only_reaches_sessions_this_pages_own_debugger_announced() {
        let mut harness = Harness::new();
        harness.attach();
        let send =
            |harness: &mut Harness, id: i64, session: Option<&str>, method: &str, params: Value| {
                let mut body =
                    json!({ "op": "send", "tabId": 7, "method": method, "params": params });
                if let Some(session) = session {
                    body["sessionId"] = json!(session);
                }
                harness.ok(id, body)
            };
        // Never announced: for example a session the agent opened onto the app window.
        assert!(!send(
            &mut harness,
            2,
            Some("app-window"),
            "Runtime.evaluate",
            json!({})
        ));
        assert!(!send(
            &mut harness,
            3,
            Some(""),
            "Runtime.evaluate",
            json!({})
        ));
        assert!(harness.sent.is_empty());
        // A child of this page (an out-of-process frame) is announced and reachable until it detaches.
        harness.emit(
            "Target.attachedToTarget",
            json!({ "sessionId": "frame-session", "targetInfo": { "type": "iframe", "targetId": "frame-1" }, "waitingForDebugger": false }),
            None,
        );
        assert!(send(
            &mut harness,
            4,
            Some("frame-session"),
            "Runtime.enable",
            json!({})
        ));
        let auto_attach =
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true });
        assert!(send(
            &mut harness,
            5,
            Some("frame-session"),
            "Target.setAutoAttach",
            auto_attach
        ));
        // A session announced for another page-like target is not this page's child.
        harness.emit("Target.attachedToTarget", json!({ "sessionId": "other-page", "targetInfo": { "type": "page", "targetId": "page-2" } }), None);
        assert!(!send(
            &mut harness,
            6,
            Some("other-page"),
            "Runtime.evaluate",
            json!({})
        ));
        // Detaching a session needs a session that was announced.
        assert!(!send(
            &mut harness,
            7,
            None,
            "Target.detachFromTarget",
            json!({ "sessionId": "app-window" })
        ));
        assert!(send(
            &mut harness,
            8,
            None,
            "Target.detachFromTarget",
            json!({ "sessionId": "frame-session" })
        ));
        harness.emit(
            "Target.detachedFromTarget",
            json!({ "sessionId": "frame-session" }),
            None,
        );
        assert!(!send(
            &mut harness,
            9,
            Some("frame-session"),
            "Runtime.enable",
            json!({})
        ));
        // Announced sessions end with the debugger attachment.
        harness.emit("Target.attachedToTarget", json!({ "sessionId": "worker-session", "targetInfo": { "type": "worker", "targetId": "worker-1" } }), None);
        harness.rpc(10, json!({ "op": "detach", "tabId": 7 }));
        harness.rpc(11, json!({ "op": "attach", "tabId": 7 }));
        assert!(!send(
            &mut harness,
            12,
            Some("worker-session"),
            "Runtime.enable",
            json!({})
        ));
    }

    #[test]
    fn marks_a_relay_requested_detach_and_releases_the_debugger_on_dispose() {
        let mut harness = Harness::new();
        harness.attach();
        harness.rpc(2, json!({ "op": "detach", "tabId": 7 }));
        let detached = harness.posted.iter().find(|m| m["t"] == "detached");
        assert_eq!(
            detached,
            Some(
                &json!({ "t": "detached", "tabId": 7, "reason": "target closed", "relayInitiated": true })
            )
        );
        // The detached frame precedes the RPC's answer and the agent's release is announced.
        let order: Vec<_> = harness
            .posted
            .iter()
            .map(|m| m["t"].as_str().unwrap())
            .collect();
        assert_eq!(order, ["rpcResult", "detached", "rpcResult"]);
        assert_eq!(harness.activity, ["attach", ""]);
        harness.rpc(3, json!({ "op": "attach", "tabId": 7 }));
        let effects = harness.ext.dispose();
        harness.run(effects);
        assert!(!harness.attached);
        // The page's events and its detach are not forwarded any more.
        let before = harness.posted.len();
        harness.emit("Page.loadEventFired", json!({}), None);
        assert_eq!(harness.ext.on_debugger_detached("x"), Vec::new());
        assert_eq!(harness.posted.len(), before);
        assert!(harness.failed(4, json!({ "op": "attach", "tabId": 7 })));
        assert_eq!(harness.ext.dispose(), Vec::new());
    }

    #[test]
    fn marks_a_detach_the_page_made_itself_as_not_relay_initiated() {
        let mut harness = Harness::new();
        harness.attach();
        harness.attached = false;
        let effects = harness.ext.on_debugger_detached("replaced_with_devtools");
        assert_eq!(
            effects,
            vec![
                Effect::Post(
                    json!({ "t": "detached", "tabId": 7, "reason": "replaced_with_devtools", "relayInitiated": false })
                ),
                Effect::Activity(String::new()),
            ]
        );
        assert!(!harness.ext.attached());
        // A relay detach while nothing is attached is answered and detaches nothing.
        let effects = harness.ext.handle(r#"{"t":"rpc","id":5,"op":"detach"}"#);
        assert_eq!(
            effects,
            vec![Effect::Post(
                json!({ "t": "rpcResult", "id": 5, "ok": true, "result": {} })
            )]
        );
    }

    #[test]
    fn does_not_attach_twice_or_after_dispose_and_reports_a_failed_attach() {
        let mut harness = Harness::new();
        // Two attaches in flight at once attach the debugger once.
        let first = harness.ext.handle(r#"{"t":"rpc","id":1,"op":"attach"}"#);
        let second = harness.ext.handle(r#"{"t":"rpc","id":2,"op":"attach"}"#);
        let [Effect::EnsureRenderer { token: a }] = first.as_slice() else {
            panic!("{first:?}")
        };
        let [Effect::EnsureRenderer { token: b }] = second.as_slice() else {
            panic!("{second:?}")
        };
        let attach = harness.ext.on_renderer_ready(*a, Ok(()));
        assert!(matches!(attach.as_slice(), [Effect::Attach { .. }]));
        assert_eq!(
            harness.ext.on_renderer_ready(*b, Ok(())),
            vec![
                Effect::Activity("attach".into()),
                post_result(&json!(2), json!({}))
            ]
        );
        let [Effect::Attach { token }] = attach.as_slice() else {
            unreachable!()
        };
        assert_eq!(
            harness.ext.on_command_result(*token, Ok(Value::Null)),
            vec![
                Effect::Activity("attach".into()),
                post_result(&json!(1), json!({}))
            ]
        );
        // A failed attach is the RPC's error and leaves the page unattached.
        let mut harness = Harness::new();
        let effects = harness.ext.handle(r#"{"t":"rpc","id":3,"op":"attach"}"#);
        let [Effect::EnsureRenderer { token }] = effects.as_slice() else {
            panic!("{effects:?}")
        };
        let effects = harness.ext.on_renderer_ready(*token, Ok(()));
        let [Effect::Attach { token }] = effects.as_slice() else {
            panic!("{effects:?}")
        };
        assert_eq!(
            harness
                .ext
                .on_command_result(*token, Err("Another debugger".into())),
            vec![post_error(&json!(3), "Another debugger")]
        );
        assert!(!harness.ext.attached());
        // A renderer that fails to start is the RPC's error.
        let effects = harness.ext.handle(r#"{"t":"rpc","id":4,"op":"attach"}"#);
        let [Effect::EnsureRenderer { token }] = effects.as_slice() else {
            panic!("{effects:?}")
        };
        assert_eq!(
            harness.ext.on_renderer_ready(*token, Err("gone".into())),
            vec![post_error(&json!(4), "gone")]
        );
        // A dispose while the renderer starts leaves nothing attached.
        let effects = harness.ext.handle(r#"{"t":"rpc","id":5,"op":"attach"}"#);
        let [Effect::EnsureRenderer { token }] = effects.as_slice() else {
            panic!("{effects:?}")
        };
        assert_eq!(harness.ext.dispose(), Vec::new());
        assert_eq!(
            harness.ext.on_renderer_ready(*token, Ok(())),
            vec![post_error(
                &json!(5),
                "The preview stopped sharing this page"
            )]
        );
    }

    #[test]
    fn answers_a_forwarded_command_with_an_object_or_an_empty_one_and_its_error_text() {
        let mut harness = Harness::new();
        for (id, result, want) in [
            (
                1,
                Ok(json!({ "a": 1 })),
                json!({ "t": "rpcResult", "id": 1, "ok": true, "result": { "a": 1 } }),
            ),
            (
                2,
                Ok(Value::Null),
                json!({ "t": "rpcResult", "id": 2, "ok": true, "result": {} }),
            ),
            (
                3,
                Ok(json!("text")),
                json!({ "t": "rpcResult", "id": 3, "ok": true, "result": {} }),
            ),
            (
                4,
                Ok(json!(5)),
                json!({ "t": "rpcResult", "id": 4, "ok": true, "result": {} }),
            ),
            (
                5,
                Err("Debugger is not attached".to_owned()),
                json!({ "t": "rpcResult", "id": 5, "ok": false, "error": "Debugger is not attached" }),
            ),
        ] {
            let effects = harness.ext.handle(
                &json!({ "t": "rpc", "id": id, "op": "send", "method": "Runtime.enable" })
                    .to_string(),
            );
            let [Effect::Activity(method), Effect::Send { token, .. }] = effects.as_slice() else {
                panic!("{effects:?}")
            };
            assert_eq!(method, "Runtime.enable");
            assert_eq!(
                harness.ext.on_command_result(*token, result),
                vec![Effect::Post(want)]
            );
        }
        // A token nobody waits on does nothing.
        assert_eq!(
            harness.ext.on_command_result(99, Ok(Value::Null)),
            Vec::new()
        );
        assert_eq!(harness.ext.on_renderer_ready(99, Ok(())), Vec::new());
    }

    #[test]
    fn checks_commands() {
        let none = |method: &str, params: Value| refused_command(method, &params, false);
        assert_eq!(none("Page.navigate", json!({ "url": "about:blank" })), None);
        assert!(none("Page.navigate", json!({ "url": "javascript:alert(1)" })).is_some());
        assert_eq!(none("Input.dispatchMouseEvent", json!({})), None);
        assert!(none("SystemInfo.getInfo", json!({})).is_some());
    }

    #[test]
    fn keeps_a_paired_hosts_agent_off_this_computers_own_addresses_and_leaves_a_local_agents_alone()
    {
        for url in [
            "http://localhost:3000/",
            "http://127.0.0.1:47831/",
            "http://[::1]:8080/",
        ] {
            let params = json!({ "url": url });
            assert_eq!(
                refused_command("Page.navigate", &params, false),
                None,
                "{url}"
            );
            assert!(
                refused_command("Page.navigate", &params, true)
                    .unwrap()
                    .contains("own addresses"),
                "{url}"
            );
        }
        assert_eq!(
            refused_command(
                "Page.navigate",
                &json!({ "url": "https://example.com/" }),
                true
            ),
            None
        );
        assert_eq!(
            refused_command("Page.navigate", &json!({ "url": "about:blank" }), true),
            None
        );
        assert!(
            refused_command(
                "Page.navigate",
                &json!({ "url": "file:///etc/passwd" }),
                true
            )
            .unwrap()
            .contains("http(s)")
        );
    }

    #[test]
    fn prints_numbers_as_javascript_does() {
        for (n, want) in [
            (99.0, "99"),
            (-3.0, "-3"),
            (0.0, "0"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (1.25e21, "1.25e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e300, "1e+300"),
        ] {
            assert_eq!(js_number(n), want, "{n}");
        }
    }
}
