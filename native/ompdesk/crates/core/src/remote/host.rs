//! The host's listener (was `RemoteHost.#listenOn`, `#closeServers`, `#accept` in `src/main/remote/host-server.ts`):
//! the first free candidate port on the address devices dial (its IPv4 tailnet address), then the same port on its
//! other addresses where they take it. Closing the listeners never waits for the links accepted on them, which stay
//! open. Each accepted socket runs the host's handshake; who may connect, the device record and the hello are main's
//! (asked through `remote.ask`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::task::{AbortHandle, JoinHandle};

use super::address;
use super::handshake::{self, Bound, GatePass, HostEnd, HostSide, Opened};
use super::identity::Identity;
use super::link::{Command, LinkOptions, Liveness, Reason, TrafficOptions};
use crate::server::{Events, Fault};

const TRAFFIC_LOG: Duration = Duration::from_secs(60);

/// One host (main's `RemoteHost`, by its number).
#[derive(Default)]
pub struct Host {
    listeners: Vec<JoinHandle<()>>,
    /// The links its handshakes became, and the handshakes running.
    links: HashSet<u64>,
    aborts: HashMap<u64, AbortHandle>,
    logged_port: Option<u32>,
}

impl Host {
    /// A link of this host ended.
    pub fn forget(&mut self, link: u64) {
        self.links.remove(&link);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenParams {
    pub host: u64,
    /// The device id of the identity it answers with (`remote.identity`).
    pub identity: String,
    pub addresses: Vec<String>,
    pub port: Option<u32>,
    /// Main's `OMP_GUI_REMOTE_PORT`, read when `port` is absent.
    pub port_setting: Option<String>,
    pub app_version: String,
    #[serde(default)]
    pub liveness: Option<Liveness>,
    /// Count each device link's traffic for the runtime log (main has a link log).
    #[serde(default)]
    pub traffic: bool,
    #[serde(default)]
    pub traffic_ms: Option<u64>,
    /// Tests: ports the system refuses, with the code (`EACCES`), as Windows' excluded ranges do.
    #[serde(default)]
    pub refuse: HashMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listening {
    pub port: Option<u32>,
    pub listening: Vec<String>,
    pub listen_error: Option<Value>,
}

/// node's code for a failed listen (`EADDRINUSE`, `EACCES`, ...).
fn listen_code(error: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match error.kind() {
        AddrInUse => "EADDRINUSE".into(),
        PermissionDenied => "EACCES".into(),
        AddrNotAvailable => "EADDRNOTAVAIL".into(),
        _ => match error.raw_os_error() {
            Some(code) => format!("E{code}"),
            None => error.to_string(),
        },
    }
}

/// The port cannot be had on this computer, so the next one is tried.
fn port_unavailable(code: &str) -> bool {
    code == "EADDRINUSE" || code == "EACCES"
}

fn log(events: &Events, host: u64, event: &str, details: Value) {
    events.send(
        "remote.log",
        &json!({"host": host, "event": event, "details": details}),
    );
}

async fn bind(params: &ListenParams, port: u32, host: &str) -> Result<TcpListener, String> {
    if let Some(code) = params.refuse.get(&port.to_string()) {
        return Err(code.clone());
    }
    let Ok(port) = u16::try_from(port) else {
        return Err("ERR_SOCKET_BAD_PORT".into());
    };
    TcpListener::bind((host, port))
        .await
        .map_err(|error| listen_code(&error))
}

/// Closes the host's listeners and listens on `addresses` (none: nowhere).
pub async fn listen(
    params: ListenParams,
    events: Events,
    identity: Arc<Identity>,
) -> Result<Listening, Fault> {
    let id = params.host;
    close_listeners(id).await;
    let mut out = Listening {
        port: None,
        listening: Vec::new(),
        listen_error: None,
    };
    let Some(dialed) = params
        .addresses
        .iter()
        .find(|host| address::is_ipv4(host))
        .or(params.addresses.first())
        .cloned()
    else {
        return Ok(out);
    };
    let candidates = address::candidates(
        params
            .port
            .unwrap_or_else(|| address::remote_port(params.port_setting.as_deref())),
    );
    let mut skipped = Vec::new();
    for candidate in &candidates {
        let first = match bind(&params, *candidate, &dialed).await {
            Ok(listener) => listener,
            Err(code) if port_unavailable(&code) => {
                skipped.push(format!("{candidate} {code}"));
                continue;
            }
            Err(code) => {
                // Not a port of its own (the address left this computer meanwhile): the next rebind tries again.
                log(&events, id, "listen-failed", json!({"code": code}));
                return Ok(out);
            }
        };
        let port = first
            .local_addr()
            .map(|a| u32::from(a.port()))
            .unwrap_or(*candidate);
        let mut listeners = vec![first];
        let mut listening = vec![dialed.clone()];
        for host in &params.addresses {
            if *host == dialed {
                continue;
            }
            match bind(&params, port, host).await {
                Ok(listener) => {
                    listeners.push(listener);
                    listening.push(host.clone());
                }
                Err(code) => log(
                    &events,
                    id,
                    "listen-skipped",
                    json!({"port": port, "family": if address::is_ipv4(host) { 4 } else { 6 }, "code": code}),
                ),
            }
        }
        let config = Arc::new(Config {
            host: id,
            app_version: params.app_version.clone(),
            liveness: params.liveness.unwrap_or_default(),
            traffic: params.traffic.then(|| {
                Duration::from_millis(params.traffic_ms.unwrap_or(TRAFFIC_LOG.as_millis() as u64))
            }),
            identity: Arc::clone(&identity),
        });
        let mut state = super::state();
        let entry = state.hosts.entry(id).or_default();
        for listener in listeners {
            let task = tokio::spawn(accept(listener, Arc::clone(&config), events.clone()));
            entry.listeners.push(task);
        }
        let log_port = *candidate != candidates[0] && entry.logged_port != Some(port);
        if log_port {
            entry.logged_port = Some(port);
        }
        drop(state);
        if log_port {
            log(
                &events,
                id,
                "port",
                json!({"port": port, "wanted": candidates[0], "skipped": skipped.join(", ")}),
            );
        }
        out.port = Some(port);
        out.listening = listening;
        return Ok(out);
    }
    log(
        &events,
        id,
        "port-unavailable",
        json!({"skipped": skipped.join(", ")}),
    );
    out.listen_error = Some(json!({"code": "port_in_use", "ports": candidates}));
    Ok(out)
}

/// Stops listening and returns once the sockets are closed (the next listen takes the same port); links accepted on
/// these listeners stay open.
pub async fn close_listeners(host: u64) {
    let listeners: Vec<JoinHandle<()>> = match super::state().hosts.get_mut(&host) {
        Some(entry) => std::mem::take(&mut entry.listeners),
        None => Vec::new(),
    };
    for listener in listeners {
        listener.abort();
        // An aborted task's future, and the listener it owns, are dropped before its handle resolves.
        let _ = listener.await;
    }
}

/// Stops listening and ends every connection of the host, in its handshake or linked.
pub async fn stop(host: u64) {
    close_listeners(host).await;
    let mut state = super::state();
    let Some(mut entry) = state.hosts.remove(&host) else {
        return;
    };
    for (_, handshake) in entry.aborts.drain() {
        handshake.abort();
    }
    for link in entry.links.drain() {
        if let Some(link) = state.links.get(&link) {
            link.command(Command::Destroy(Reason::Local));
        }
    }
}

/// What every connection of one listening pass shares.
struct Config {
    host: u64,
    app_version: String,
    liveness: Liveness,
    traffic: Option<Duration>,
    identity: Arc<Identity>,
}

async fn accept(listener: TcpListener, config: Arc<Config>, events: Events) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            // Out of descriptors and the like: try again shortly rather than spin.
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let link = super::next_id();
        // Registered before the task can run, so a stop always finds it. A handshake outlives the listener that
        // accepted it (a rebind never ends a device's connection).
        let mut state = super::state();
        let task = tokio::spawn(connection(
            stream,
            link,
            Arc::clone(&config),
            events.clone(),
        ));
        state
            .hosts
            .entry(config.host)
            .or_default()
            .aborts
            .insert(link, task.abort_handle());
    }
}

async fn connection(stream: tokio::net::TcpStream, link: u64, config: Arc<Config>, events: Events) {
    let side = Asks {
        host: config.host,
        link,
        events: events.clone(),
        opened: AtomicBool::new(false),
        queue: std::sync::Mutex::new(None),
    };
    let end = handshake::host(
        super::link::Conn::new(stream),
        Arc::clone(&config.identity),
        &config.app_version,
        &side,
    )
    .await;
    let opened = side.opened.load(Ordering::SeqCst);
    let to_close = {
        let mut state = super::state();
        if let Some(entry) = state.hosts.get_mut(&config.host) {
            entry.aborts.remove(&link);
        }
        match end {
            HostEnd::Linked { mut conn, opened } => {
                let queued = side.queue.lock().unwrap_or_else(|p| p.into_inner()).take();
                match (state.hosts.get_mut(&config.host), queued) {
                    (Some(entry), Some(queued)) => {
                        entry.links.insert(link);
                        if opened.deflate {
                            conn.deflate_sent(opened.context);
                        }
                        conn.run(
                            link,
                            events.clone(),
                            config.liveness,
                            LinkOptions {
                                listen: true,
                                traffic: config.traffic.map(|every| TrafficOptions { every }),
                            },
                            queued,
                        );
                        Ok(None)
                    }
                    // Stopped while the hello went out.
                    _ => Err(()),
                }
            }
            HostEnd::Closed(conn) => Ok(Some(conn)),
            HostEnd::Dropped => Ok(None),
        }
    };
    let ran = matches!(to_close, Ok(None))
        && side
            .queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_none()
        && opened;
    if opened && !ran {
        super::forget_link(link);
        closed(&events, link);
    }
    if let Ok(Some(conn)) = to_close {
        conn.close().await;
    }
}

/// Main took the connection as a device's (its `open` answer) and it never ran: main forgets it.
fn closed(events: &Events, link: u64) {
    events.send("remote.closed", &json!({"link": link, "reason": "closed"}));
}

/// The host's decisions, asked of main.
struct Asks {
    host: u64,
    link: u64,
    events: Events,
    opened: AtomicBool,
    /// What main sends on the link from its `open` answer on, queued until the link runs.
    queue: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Command>>>,
}

impl HostSide for Asks {
    async fn gate(&self, ip: &str) -> Result<GatePass, String> {
        let answer = super::ask(
            &self.events,
            "gate",
            json!({"host": self.host, "link": self.link, "ip": ip}),
        )
        .await;
        match answer
            .as_ref()
            .and_then(|a| a.get("code"))
            .and_then(Value::as_str)
        {
            Some(code) => Err(code.to_owned()),
            None => {
                let answer = answer.unwrap_or(Value::Null);
                Ok(GatePass {
                    visitor: answer.get("visitor").cloned().unwrap_or(Value::Null),
                    name: answer
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                })
            }
        }
    }

    async fn bind(&self, ip: &str, init: &Value, visitor: &Value) -> Result<Bound, String> {
        let answer = super::ask(
            &self.events,
            "bind",
            json!({"host": self.host, "link": self.link, "ip": ip, "init": init, "visitor": visitor}),
        )
        .await
        .unwrap_or(Value::Null);
        if let Some(code) = answer.get("code").and_then(Value::as_str) {
            return Err(code.to_owned());
        }
        match (
            answer.get("staticPub").and_then(Value::as_str),
            answer.get("name").and_then(Value::as_str),
        ) {
            (Some(static_pub), Some(name)) => Ok(Bound {
                static_pub: static_pub.to_owned(),
                name: name.to_owned(),
            }),
            _ => Err("protocol".into()),
        }
    }

    async fn open(&self, device_id: &str, hello: &Value) -> Option<Opened> {
        // Registered before main hears of the link, so what it sends as it takes the connection waits for the link.
        let (handle, queue) = super::link::channel();
        super::state().links.insert(self.link, handle);
        *self.queue.lock().unwrap_or_else(|p| p.into_inner()) = Some(queue);
        let answer = super::ask(
            &self.events,
            "open",
            json!({"host": self.host, "link": self.link, "deviceId": device_id, "hello": hello}),
        )
        .await;
        let Some(fields) = answer
            .as_ref()
            .and_then(|a| a.get("hello"))
            .and_then(Value::as_object)
            .cloned()
        else {
            super::forget_link(self.link);
            *self.queue.lock().unwrap_or_else(|p| p.into_inner()) = None;
            return None;
        };
        let answer = answer.unwrap_or(Value::Null);
        self.opened.store(true, Ordering::SeqCst);
        Some(Opened {
            hello: fields,
            deflate: answer
                .get("deflate")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            context: answer
                .get("context")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}
