//! A known host's link, kept up (was `RemoteClient`'s reconnect loop in `src/main/remote/client.ts`): rounds of the
//! host's addresses with a 1 s → 30 s backoff between them, a host that refuses every dial (its app restarting) tried
//! every second for a minute, `wake` (check a live link, retry a dead one now) and the `peer` wake that ends a dial
//! stuck on a restarting host. Main holds each link it brings up by its number (`remote.client.state` carries it) and
//! carries every request and event on it; the transitions it logs go to main as `remote.client.log`.

use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::super::dial;
use super::super::handshake::{self, Expected, Failure};
use super::super::identity::Identity;
use super::super::link::{Command, Conn, LinkOptions, Liveness, Reason};
use super::super::store::Store;
use crate::clock;
use crate::server::{Events, Scope};

pub const RECONNECT_MIN_MS: u64 = 1_000;
pub const RECONNECT_MAX_MS: u64 = 30_000;
/// A refused dial (nothing listens: the host's app is restarting) is retried every `RECONNECT_MIN_MS` this long after
/// the link was lost, then backs off like any other failure.
pub const REFUSED_RETRY_WINDOW_MS: u64 = 60_000;
/// An address step older than this when the host's computer connects here is stuck, not slow.
const STALE_STEP_MS: u64 = 1_000;
/// How long a wake's check waits for any frame before the link is dropped (`WAKE_CHECK_MS`, wire.ts).
pub const WAKE_CHECK_MS: u64 = 3_000;
/// Backoff retries past this one (30 s apart by then) are not logged: an absent host would fill the log.
const LOGGED_BACKOFF_ATTEMPTS: u32 = 6;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Connecting,
    Online,
    Offline,
}

impl LinkState {
    fn as_str(self) -> &'static str {
        match self {
            LinkState::Connecting => "connecting",
            LinkState::Online => "online",
            LinkState::Offline => "offline",
        }
    }
}

/// Where a client finds its host's addresses on each attempt.
pub trait Addresses: Send + Sync {
    fn resolve(
        &self,
        host: Map<String, Value>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Vec<String>> + Send>>;
}

/// The record's stored addresses (a client outside a devices instance: the transport tests).
pub struct Stored;

impl Addresses for Stored {
    fn resolve(
        &self,
        host: Map<String, Value>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Vec<String>> + Send>> {
        let addresses = strings(host.get("addresses"));
        Box::pin(async move { addresses })
    }
}

pub fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn text(record: &Map<String, Value>, key: &str) -> String {
    record
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// One stretch without a link: from the drop (or the first attempt of a launch) until it is online again.
struct Outage {
    since: u64,
    attempts: u32,
    down_logged: bool,
    /// Whether the last failed attempt of this stretch was refused on every address; None before one failed.
    refused: Option<bool>,
}

struct Inner {
    host: Map<String, Value>,
    name: String,
    state: LinkState,
    hello: Option<Value>,
    error: Option<String>,
    link: Option<u64>,
    running: bool,
    attempting: bool,
    cancel: Option<Scope>,
    rerun: Option<String>,
    step: u64,
    step_at: u64,
    stale: Option<clock::Timer>,
    retry: Option<clock::Timer>,
    backoff: u64,
    online_at: Option<u64>,
    outage: Option<Outage>,
}

pub struct Client {
    pub id: u64,
    pub device_id: String,
    events: Events,
    identity: Arc<Identity>,
    app_version: String,
    capabilities: Map<String, Value>,
    liveness: Liveness,
    /// The pinned record's file (`remote-hosts.json`): read on every attempt, told the working address and name.
    store: Option<Arc<Mutex<Store>>>,
    addresses: Box<dyn Addresses>,
    inner: Mutex<Inner>,
    me: Weak<Client>,
}

pub struct ClientOptions {
    pub events: Events,
    pub identity: Arc<Identity>,
    pub host: Map<String, Value>,
    pub name: String,
    pub app_version: String,
    pub capabilities: Map<String, Value>,
    pub liveness: Liveness,
    pub store: Option<Arc<Mutex<Store>>>,
    pub addresses: Box<dyn Addresses>,
}

impl Client {
    pub fn new(options: ClientOptions) -> Arc<Client> {
        let id = super::super::next_id();
        let device_id = text(&options.host, "deviceId");
        Arc::new_cyclic(|me| Client {
            id,
            device_id,
            events: options.events,
            identity: options.identity,
            app_version: options.app_version,
            capabilities: options.capabilities,
            liveness: options.liveness,
            store: options.store,
            addresses: options.addresses,
            inner: Mutex::new(Inner {
                host: options.host,
                name: options.name,
                state: LinkState::Offline,
                hello: None,
                error: None,
                link: None,
                running: false,
                attempting: false,
                cancel: None,
                rerun: None,
                step: 0,
                step_at: 0,
                stale: None,
                retry: None,
                backoff: RECONNECT_MIN_MS,
                online_at: None,
                outage: None,
            }),
            me: me.clone(),
        })
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn this(&self) -> Arc<Client> {
        self.me.upgrade().expect("a client is held while it runs")
    }

    fn log(&self, event: &str, details: Value) {
        self.events.send(
            "remote.client.log",
            &json!({"client": self.id, "event": event, "details": details}),
        );
    }

    /// What main mirrors: the state, why the last attempt failed, the last hello, the record, and the link it holds.
    fn tell(&self, inner: &Inner) {
        self.events.send(
            "remote.client.state",
            &json!({
                "client": self.id,
                "state": inner.state.as_str(),
                "error": inner.error,
                "hello": inner.hello,
                "host": inner.host,
                "link": if inner.state == LinkState::Online { inner.link.map(Value::from) } else { None },
            }),
        );
    }

    fn set_state(&self, inner: &mut Inner, state: LinkState) {
        if inner.state == state {
            return;
        }
        inner.state = state;
        self.tell(inner);
    }

    pub fn state(&self) -> LinkState {
        self.inner().state
    }

    /// The device name the next hello carries.
    pub fn set_name(&self, name: &str) {
        self.inner().name = name.to_owned();
    }

    /// The host announced a new name (`host.name`): show and remember it.
    pub fn host_renamed(&self, name: &str) {
        let mut inner = self.inner();
        inner.host.insert("name".into(), name.into());
        if let Some(Value::Object(hello)) = inner.hello.as_mut() {
            hello.insert("name".into(), name.into());
        }
        self.remember(None, Some(name));
        self.tell(&inner);
    }

    /// Writes the working address (first) and the host's name into its record, as the store's own rules say.
    fn remember(&self, address: Option<&str>, name: Option<&str>) {
        let Some(store) = &self.store else {
            return;
        };
        let mut store = store.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(address) = address {
            let _ = store.remember_address(&self.device_id, address);
        }
        if let Some(name) = name
            && store
                .get(&self.device_id)
                .is_some_and(|record| record.get("name").and_then(Value::as_str) != Some(name))
        {
            let _ = store.update(
                &self.device_id,
                vec![("name".into(), Some(Value::from(name)))],
            );
        }
    }

    /// Start (or keep) the link; while waiting out a backoff, retry now.
    pub fn connect(&self) {
        let mut inner = self.inner();
        inner.running = true;
        if inner.link.is_some() || inner.attempting {
            return;
        }
        let trigger = if inner.retry.is_some() {
            "connect"
        } else {
            "start"
        };
        clear(&mut inner.retry);
        self.spawn_attempt(&mut inner, trigger, 0);
    }

    /// The network or the computer may have changed under the link: check a live one, retry a dead one now.
    pub fn wake(&self, trigger: &str) {
        let mut inner = self.inner();
        if !inner.running {
            return;
        }
        if inner.attempting {
            if trigger == "peer" {
                let step = inner.step;
                self.cancel_stale(&mut inner, step);
            }
            return;
        }
        let Some(link) = inner.link else {
            self.retry_now(&mut inner, trigger);
            return;
        };
        drop(inner);
        let (reply, alive) = oneshot::channel();
        let Some(handle) = super::super::state().links.get(&link).cloned() else {
            return;
        };
        handle.command(Command::Check {
            window: Duration::from_millis(WAKE_CHECK_MS),
            reply: Some(reply),
        });
        let client = self.this();
        let trigger = trigger.to_owned();
        tokio::spawn(async move {
            // The link's end (told to `dropped` first) drops the reply: not alive.
            if !alive.await.unwrap_or(false) {
                let mut inner = client.inner();
                client.retry_now(&mut inner, &trigger);
            }
        });
    }

    /// Stop reconnecting and drop the link.
    pub fn close(&self) {
        let mut inner = self.inner();
        clear(&mut inner.stale);
        inner.running = false;
        clear(&mut inner.retry);
        if let Some(link) = inner.link
            && let Some(handle) = super::super::state().links.get(&link)
        {
            handle.command(Command::Destroy(Reason::Local));
        }
        self.set_state(&mut inner, LinkState::Offline);
    }

    /// Begins an attempt now (counted, logged, `connecting` told) and runs its dials in a task.
    fn spawn_attempt(&self, inner: &mut Inner, trigger: &str, delay: u64) {
        inner.attempting = true;
        let outage = inner.outage.get_or_insert(Outage {
            since: clock::now_ms(),
            attempts: 0,
            down_logged: false,
            refused: None,
        });
        outage.attempts += 1;
        if trigger != "backoff" || outage.attempts <= LOGGED_BACKOFF_ATTEMPTS {
            let mut details = json!({
                "deviceId": self.device_id,
                "n": outage.attempts,
                "delayMs": delay,
                "trigger": trigger,
            });
            if let Some(refused) = outage.refused {
                details["refused"] = refused.into();
            }
            self.log("attempt", details);
        }
        // The address lookup is a step of its own: a `peer` wake while it runs measures against it, never against
        // the last dial of an earlier attempt, whose age would end this attempt before it dialed (run 43496522688).
        inner.step += 1;
        inner.step_at = clock::now_ms();
        self.set_state(inner, LinkState::Connecting);
        let cancel = Scope::detached();
        inner.cancel = Some(cancel.clone());
        let host = self.pinned(inner);
        let client = self.this();
        tokio::spawn(async move { client.attempt(cancel, host).await });
    }

    async fn attempt(self: Arc<Client>, cancel: Scope, host: Map<String, Value>) {
        let addresses = self.addresses.resolve(host).await;
        let mut failure = Failure::unreachable("no address to dial");
        // Every address refused: the computer is there and the app is not (a timeout anywhere says otherwise).
        let mut refused = !addresses.is_empty();
        let mut remaining = addresses;
        while !remaining.is_empty() {
            let (expected, name) = {
                let mut inner = self.inner();
                if !inner.running || cancel.cancelled() {
                    break;
                }
                inner.step += 1;
                inner.step_at = clock::now_ms();
                (
                    Expected {
                        device_id: self.device_id.clone(),
                        static_pub: text(&inner.host, "staticPub"),
                    },
                    inner.name.clone(),
                )
            };
            let (address, stream) = match dial::first_to_connect(
                &remaining,
                dial::CONNECT_TIMEOUT,
                Some(&cancel),
            )
            .await
            {
                Ok(connected) => connected,
                Err(dial) => {
                    refused &= dial.refused;
                    failure = dial.failure;
                    break;
                }
            };
            remaining.retain(|other| *other != address);
            // Something listens there: the attempt was not refused everywhere.
            refused = false;
            let mut conn = Conn::new(stream);
            let answer = tokio::select! {
                answer = handshake::client(
                    &mut conn,
                    &self.identity,
                    &address,
                    Some(&expected),
                    &name,
                    &self.app_version,
                    &self.capabilities,
                ) => answer,
                () = cancel.on_cancel() => Err(Failure::unreachable("connection closed")),
            };
            match answer {
                Ok(host) => {
                    if !self.inner().running {
                        break;
                    }
                    self.online(conn, host.hello, &address);
                    return;
                }
                Err(answer) => {
                    // The host itself answered: other addresses reach the same verdict.
                    let unreachable = answer.code == "unreachable";
                    failure = answer;
                    if !unreachable {
                        break;
                    }
                }
            }
        }
        let mut inner = self.inner();
        inner.attempting = false;
        inner.cancel = None;
        if !inner.running {
            return;
        }
        if let Some(rerun) = inner.rerun.take() {
            self.retry_now(&mut inner, &rerun);
            return;
        }
        inner.error = Some(failure.code.clone());
        let name = text(&inner.host, "name");
        let (since, log_down) = {
            let outage = inner.outage.as_mut().expect("an attempt runs in an outage");
            outage.refused = Some(refused);
            let log_down = !outage.down_logged;
            outage.down_logged = true;
            (outage.since, log_down)
        };
        if log_down {
            self.log(
                "down",
                json!({"deviceId": self.device_id, "name": name, "reason": failure.code, "wasOnlineMs": 0}),
            );
        }
        self.set_state(&mut inner, LinkState::Offline);
        let within = clock::now_ms().saturating_sub(since) < REFUSED_RETRY_WINDOW_MS;
        self.schedule_retry(&mut inner, refused && within);
    }

    /// The pinned record as the file says it now (the stored one when the file has none).
    fn pinned(&self, inner: &Inner) -> Map<String, Value> {
        self.store
            .as_ref()
            .and_then(|store| {
                store
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&self.device_id)
            })
            .unwrap_or_else(|| inner.host.clone())
    }

    fn online(&self, conn: Conn, hello: Value, address: &str) {
        let id = super::super::next_id();
        let weak = self.me.clone();
        // Registered before the link runs, so even an at-once end reaches `dropped`.
        super::super::on_link_end(id, move |reason| {
            if let Some(client) = weak.upgrade() {
                client.dropped(id, reason);
            }
        });
        let link = conn.into_link(
            id,
            self.events.clone(),
            self.liveness,
            LinkOptions::default(),
        );
        super::super::state().links.insert(id, link);
        let now = clock::now_ms();
        let mut inner = self.inner();
        inner.attempting = false;
        inner.cancel = None;
        inner.rerun = None;
        if let Some(outage) = inner.outage.take() {
            // The host's build beside it: a link that misbehaves after one side updated is read from either log.
            self.log(
                "up",
                json!({
                    "deviceId": self.device_id,
                    "outageMs": now.saturating_sub(outage.since),
                    "attempts": outage.attempts,
                    "appVersion": hello.get("appVersion").cloned().unwrap_or(Value::Null),
                }),
            );
        }
        inner.online_at = Some(now);
        inner.link = Some(id);
        inner.error = None;
        inner.backoff = RECONNECT_MIN_MS;
        let mut addresses = strings(inner.host.get("addresses"));
        addresses.retain(|other| other != address);
        addresses.insert(0, address.to_owned());
        inner.host.insert("addresses".into(), json!(addresses));
        let name = hello.get("name").and_then(Value::as_str).map(str::to_owned);
        if let Some(name) = &name {
            inner.host.insert("name".into(), name.clone().into());
        }
        inner.hello = Some(hello);
        self.remember(Some(address), name.as_deref());
        self.set_state(&mut inner, LinkState::Online);
    }

    fn dropped(&self, link: u64, reason: Reason) {
        let mut inner = self.inner();
        if inner.link != Some(link) {
            return;
        }
        inner.link = None;
        let now = clock::now_ms();
        self.log(
            "down",
            json!({
                "deviceId": self.device_id,
                "name": text(&inner.host, "name"),
                "reason": reason.as_str(),
                "wasOnlineMs": now.saturating_sub(inner.online_at.unwrap_or(now)),
            }),
        );
        inner.outage = Some(Outage {
            since: now,
            attempts: 0,
            down_logged: true,
            refused: None,
        });
        self.set_state(&mut inner, LinkState::Offline);
        self.schedule_retry(&mut inner, false);
    }

    /// `refused`: the host's computer answered with a refusal, so the backoff stays at its first step.
    fn schedule_retry(&self, inner: &mut Inner, refused: bool) {
        if !inner.running {
            return;
        }
        if refused {
            inner.backoff = RECONNECT_MIN_MS;
        }
        let delay = inner.backoff;
        inner.backoff = if refused {
            RECONNECT_MIN_MS
        } else {
            (inner.backoff * 2).min(RECONNECT_MAX_MS)
        };
        clear(&mut inner.retry);
        let client = self.this();
        inner.retry = Some(clock::after(Duration::from_millis(delay), move || {
            let mut inner = client.inner();
            inner.retry = None;
            client.spawn_attempt(&mut inner, "backoff", delay);
        }));
    }

    /// End address step `step` once it has run `STALE_STEP_MS`, unless it ended first.
    fn cancel_stale(&self, inner: &mut Inner, step: u64) {
        clear(&mut inner.stale);
        if !inner.attempting || inner.step != step {
            return;
        }
        let Some(cancel) = inner.cancel.clone() else {
            return;
        };
        let left = (inner.step_at + STALE_STEP_MS).saturating_sub(clock::now_ms());
        if left > 0 {
            let client = self.this();
            inner.stale = Some(clock::after(Duration::from_millis(left), move || {
                let mut inner = client.inner();
                client.cancel_stale(&mut inner, step);
            }));
            return;
        }
        inner.rerun = Some("peer".into());
        cancel.cancel();
    }

    fn retry_now(&self, inner: &mut Inner, trigger: &str) {
        if !inner.running || inner.link.is_some() || inner.attempting {
            return;
        }
        clear(&mut inner.retry);
        inner.backoff = RECONNECT_MIN_MS;
        self.spawn_attempt(inner, trigger, 0);
    }
}

fn clear(timer: &mut Option<clock::Timer>) {
    if let Some(timer) = timer.take() {
        timer.cancel();
    }
}

/// Connect once to a host this device never connected to, pin its key and node, and record it (was `connectFirst`).
/// A host already pinned to that node must answer with the same id and key (`key_mismatch` otherwise).
pub async fn connect_first(
    store: &Arc<Mutex<Store>>,
    identity: &Arc<Identity>,
    address: &str,
    name: &str,
    app_version: &str,
    node_id: &str,
    capabilities: &Map<String, Value>,
) -> Result<Map<String, Value>, Failure> {
    let pinned = store
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .by_node(node_id);
    let (address, stream) =
        dial::first_to_connect(&[address.to_owned()], dial::CONNECT_TIMEOUT, None)
            .await
            .map_err(|dial| dial.failure)?;
    let expected = pinned.as_ref().map(|pinned| Expected {
        device_id: text(pinned, "deviceId"),
        static_pub: text(pinned, "staticPub"),
    });
    let mut conn = Conn::new(stream);
    let host = handshake::client(
        &mut conn,
        identity,
        &address,
        expected.as_ref(),
        name,
        app_version,
        capabilities,
    )
    .await?;
    conn.close().await;
    let mut store = store.lock().unwrap_or_else(|p| p.into_inner());
    let previous = store.get(&host.device_id);
    if previous
        .as_ref()
        .is_some_and(|previous| text(previous, "staticPub") != host.static_pub)
    {
        return Err(Failure::new(
            "key_mismatch",
            format!("{} answers with another key than the one pinned", host.name),
        ));
    }
    let mut addresses = vec![address.clone()];
    if let Some(previous) = &previous {
        addresses.extend(
            strings(previous.get("addresses"))
                .into_iter()
                .filter(|other| *other != address),
        );
    }
    let paired_at = previous
        .as_ref()
        .and_then(|previous| previous.get("pairedAt").cloned())
        .unwrap_or_else(|| Value::from(clock::now_ms()));
    let mut record = Map::new();
    record.insert("deviceId".into(), host.device_id.clone().into());
    record.insert("name".into(), host.name.into());
    record.insert("staticPub".into(), host.static_pub.into());
    record.insert("nodeId".into(), node_id.into());
    record.insert("addresses".into(), json!(addresses));
    record.insert("pairedAt".into(), paired_at);
    store
        .put(record.clone())
        .map_err(|error| Failure::new("protocol", error.to_string()))?;
    Ok(store.get(&host.device_id).unwrap_or(record))
}

#[cfg(test)]
mod tests {
    use std::pin::Pin;

    use tokio::sync::{Notify, mpsc};

    use super::*;

    /// Addresses that answer once the test lets them: the attempt stays in its lookup meanwhile.
    struct Held(Arc<Notify>);

    impl Addresses for Held {
        fn resolve(
            &self,
            _host: Map<String, Value>,
        ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send>> {
            let release = Arc::clone(&self.0);
            Box::pin(async move {
                release.notified().await;
                Vec::new()
            })
        }
    }

    #[tokio::test]
    async fn a_peer_link_never_ends_an_attempt_still_looking_up_its_host() {
        let _serial = clock::TEST_CLOCK.lock().await;
        clock::set_real();
        let dir = std::env::temp_dir().join(format!("ompdesk-client-peer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (frames, _read) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let mut host = Map::new();
        host.insert("deviceId".into(), "studio".into());
        let client = Client::new(ClientOptions {
            events: crate::server::test_events(&frames),
            identity: Arc::new(crate::remote::identity::load_or_create(&dir).unwrap()),
            host,
            name: "laptop".into(),
            app_version: "0.0.0".into(),
            capabilities: Map::new(),
            liveness: Liveness::default(),
            store: None,
            addresses: Box::new(Held(Arc::clone(&release))),
        });
        client.connect();
        // The other computer's link reached this one's host while the attempt has not dialed anything yet.
        client.wake("peer");
        {
            let inner = client.inner();
            assert_eq!(inner.rerun, None, "the attempt is not run again");
            assert!(
                inner
                    .cancel
                    .as_ref()
                    .is_some_and(|cancel| !cancel.cancelled()),
                "the attempt goes on"
            );
        }
        client.close();
        release.notify_one();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
