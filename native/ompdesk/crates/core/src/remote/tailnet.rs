//! Read-only Tailscale facts for sharing this computer with other OMPdesk computers (native-rust ledger R5; was the
//! logic of `src/main/tailscale/tailnet.ts`): the tailnet (`status --json`: this machine's addresses, the other
//! nodes) and who an address belongs to (`whois`), and the address test the gate uses. The CLI runs and what they
//! print are `crate::tailscale`'s; what is kept here is computer sharing's own state: the CLI it found, a status for
//! 3 s (one read in flight is shared by whoever asks meanwhile) and a successful whois for 60 s, up to 256 of them,
//! then all of them start over (one per connection would cost a CLI call each).
//!
//! The CLI is found by asking main (`remote.ask` `locate` `{tailnet}`), which answers how to run it as it hands
//! every `tailscale.*` request: `{bin, args, env, timeoutMs, maxBytes}`, or null when Tailscale is not installed. A
//! found CLI is kept; a null answer is asked again next time (it may have been installed meanwhile).
//!
//! Time is the caller's (`now`, ms: a TypeScript client built with a clock passes its own, so a test moves it) or,
//! without one, `clock::now_ms()`. A cache entry is stamped when its read ends, as the TypeScript did, so a caller
//! without a clock gets that moment by the core's clock.
//!
//! Methods: `remote.tailnet.open` `{}` → `{tailnet}`, `remote.tailnet.status|phase|whois` `{tailnet, ip?, nowMs?}`.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::clock;
use crate::run::Runner;
use crate::server::{Call, Events, Fault, Registry, Reply, Scope};

/// How long a status read is kept.
const STATUS_CACHE_MS: u64 = 3_000;
/// How long a successful whois is kept.
const WHOIS_CACHE_MS: u64 = 60_000;
/// How many whois answers are kept before the cache starts over.
const WHOIS_CACHE_MAX: usize = 256;

/// What an address is, as node's `isIP` says.
#[derive(Debug, PartialEq)]
enum Family {
    V4([u8; 4]),
    V6,
}

/// `isIP`: a dotted IPv4 without leading zeros, or an IPv6 with an optional `%zone` of letters, digits and `-.:`.
fn family(address: &str) -> Option<Family> {
    if let Ok(IpAddr::V4(v4)) = address.parse::<IpAddr>() {
        return Some(Family::V4(v4.octets()));
    }
    let (host, zone) = match address.split_once('%') {
        Some((host, zone)) => (host, Some(zone)),
        None => (address, None),
    };
    let zone_ok = zone.is_none_or(|zone| {
        !zone.is_empty()
            && zone
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':'))
    });
    (zone_ok && host.parse::<Ipv6Addr>().is_ok()).then_some(Family::V6)
}

/// `ip` without a leading `::ffff:` (an IPv4 address a dual-stack socket reports).
fn unmapped(ip: &str) -> &str {
    match ip.get(..7) {
        Some(head) if head.eq_ignore_ascii_case("::ffff:") => &ip[7..],
        _ => ip,
    }
}

/// A tailnet address: 100.64.0.0/10 or fd7a:115c:a1e0::/48.
pub fn is_tailnet_address(ip: &str) -> bool {
    match family(unmapped(ip)) {
        Some(Family::V4([a, b, _, _])) => a == 100 && (64..=127).contains(&b),
        Some(Family::V6) => unmapped(ip)
            .get(..15)
            .is_some_and(|head| head.eq_ignore_ascii_case("fd7a:115c:a1e0:")),
        None => false,
    }
}

/// One answer that several callers wait for: the work runs in a task of its own, so a caller that goes away does not
/// end it for the others.
struct Flight<T>(watch::Receiver<Option<T>>);

impl<T> Clone for Flight<T> {
    fn clone(&self) -> Self {
        Flight(self.0.clone())
    }
}

impl<T: Clone + Send + Sync + 'static> Flight<T> {
    fn spawn(work: impl Future<Output = T> + Send + 'static) -> Flight<T> {
        let (answer, answered) = watch::channel(None);
        tokio::spawn(async move {
            answer.send_replace(Some(work.await));
        });
        Flight(answered)
    }

    /// The answer; none when the work ended without one (it panicked).
    async fn wait(&self) -> Option<T> {
        let mut answered = self.0.clone();
        let answer = answered.wait_for(Option::is_some).await.ok()?;
        answer.clone()
    }
}

/// What the instance needs of the world: main's answer for the CLI and what the CLI says. Tests play it.
trait Reads: Send + Sync + 'static {
    /// How to run the CLI (a `Runner` as JSON); none when Tailscale is not installed.
    fn locate(&self) -> impl Future<Output = Option<Value>> + Send;
    /// The status document when the CLI exited 0 and printed one.
    fn status(&self, runner: &Value) -> impl Future<Output = Option<Value>> + Send;
    /// `{nodeId, nodeName, login}` of an address; none when the CLI did not say.
    fn whois(&self, runner: &Value, ip: &str) -> impl Future<Output = Option<Value>> + Send;
}

enum Cli {
    /// Not found yet, or not installed when last looked for.
    Unknown,
    Locating(Flight<Option<Value>>),
    Found(Value),
}

struct Cached {
    value: Option<Value>,
    installed: bool,
    at: u64,
}

struct State {
    cli: Cli,
    status: Option<Cached>,
    pending: Option<Flight<Option<Value>>>,
    whois: HashMap<String, (Value, u64)>,
}

/// One computer-sharing tailnet cache (a `Tailnet` of main, or one of the devices instance's).
struct Tailnet<R> {
    reads: R,
    state: Mutex<State>,
}

/// The caller's clock, or the core's.
fn stamp(now: Option<u64>) -> u64 {
    now.unwrap_or_else(clock::now_ms)
}

impl<R: Reads> Tailnet<R> {
    fn new(reads: R) -> Arc<Tailnet<R>> {
        Arc::new(Tailnet {
            reads,
            state: Mutex::new(State {
                cli: Cli::Unknown,
                status: None,
                pending: None,
                whois: HashMap::new(),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The CLI's runner; located once, and a missing CLI is looked for again next time. Callers that ask while one
    /// lookup is out share its answer.
    async fn cli(self: &Arc<Self>) -> Option<Value> {
        let flight = {
            let mut state = self.lock();
            match &state.cli {
                Cli::Found(runner) => return Some(runner.clone()),
                Cli::Locating(flight) => flight.clone(),
                Cli::Unknown => {
                    let this = Arc::clone(self);
                    let flight = Flight::spawn(async move {
                        let found = this.reads.locate().await;
                        this.lock().cli = match &found {
                            Some(runner) => Cli::Found(runner.clone()),
                            None => Cli::Unknown,
                        };
                        found
                    });
                    state.cli = Cli::Locating(flight.clone());
                    flight
                }
            }
        };
        let found = flight.wait().await;
        if found.is_none() {
            let mut state = self.lock();
            if matches!(state.cli, Cli::Locating(_)) {
                state.cli = Cli::Unknown;
            }
        }
        found.flatten()
    }

    /// The status document, or none when Tailscale is missing or does not answer.
    async fn status(self: &Arc<Self>, now: Option<u64>) -> Option<Value> {
        let flight = {
            let mut state = self.lock();
            if let Some(cached) = &state.status
                && stamp(now).saturating_sub(cached.at) < STATUS_CACHE_MS
            {
                return cached.value.clone();
            }
            match &state.pending {
                Some(flight) => flight.clone(),
                None => {
                    let this = Arc::clone(self);
                    let flight = Flight::spawn(async move {
                        let cli = this.cli().await;
                        let value = match &cli {
                            Some(runner) => this.reads.status(runner).await,
                            None => None,
                        };
                        let mut state = this.lock();
                        state.status = Some(Cached {
                            value: value.clone(),
                            installed: cli.is_some(),
                            at: stamp(now),
                        });
                        state.pending = None;
                        value
                    });
                    state.pending = Some(flight.clone());
                    flight
                }
            }
        };
        match flight.wait().await {
            Some(value) => value,
            // The read ended without an answer: the next one starts afresh.
            None => {
                self.lock().pending = None;
                None
            }
        }
    }

    /// Where sharing stands: Tailscale missing, not answering, signed out, or up.
    async fn phase(self: &Arc<Self>, now: Option<u64>) -> &'static str {
        let status = self.status(now).await;
        let backend = status
            .as_ref()
            .and_then(|status| status.get("backend"))
            .and_then(Value::as_str);
        if backend == Some("running") {
            return "ready";
        }
        if self
            .lock()
            .status
            .as_ref()
            .is_some_and(|cached| !cached.installed)
        {
            return "not-installed";
        }
        if backend == Some("needs-login") {
            return "needs-login";
        }
        "not-running"
    }

    /// Which node and user `ip` belongs to; none when it is no address, or Tailscale cannot say.
    async fn whois(self: &Arc<Self>, ip: &str, now: Option<u64>) -> Option<Value> {
        let address = unmapped(ip);
        family(address)?;
        {
            let state = self.lock();
            if let Some((peer, at)) = state.whois.get(address)
                && stamp(now).saturating_sub(*at) < WHOIS_CACHE_MS
            {
                return Some(peer.clone());
            }
        }
        let runner = self.cli().await?;
        let peer = self.reads.whois(&runner, address).await?;
        let mut state = self.lock();
        if state.whois.len() >= WHOIS_CACHE_MAX {
            state.whois.clear();
        }
        state
            .whois
            .insert(address.to_owned(), (peer.clone(), stamp(now)));
        Some(peer)
    }
}

/// The real world: main answers where the CLI is, `crate::tailscale` runs it.
struct Live {
    id: u64,
    events: Events,
}

impl Reads for Live {
    async fn locate(&self) -> Option<Value> {
        let answer = super::ask(&self.events, "locate", json!({"tailnet": self.id})).await?;
        // A runner main could not make whole is no CLI.
        serde_json::from_value::<Runner>(answer.clone()).ok()?;
        Some(answer)
    }

    async fn status(&self, runner: &Value) -> Option<Value> {
        let runner = serde_json::from_value(runner.clone()).ok()?;
        crate::tailscale::read_status(runner, Scope::detached()).await
    }

    async fn whois(&self, runner: &Value, ip: &str) -> Option<Value> {
        let runner = serde_json::from_value(runner.clone()).ok()?;
        crate::tailscale::read_whois(runner, ip, Scope::detached()).await
    }
}

static INSTANCES: LazyLock<Mutex<HashMap<u64, Arc<Tailnet<Live>>>>> = LazyLock::new(Mutex::default);

fn instances() -> MutexGuard<'static, HashMap<u64, Arc<Tailnet<Live>>>> {
    INSTANCES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn instance(id: u64) -> Option<Arc<Tailnet<Live>>> {
    instances().get(&id).cloned()
}

/// A new instance; `events` carries its `locate` asks to main.
pub fn open(events: Events) -> u64 {
    let id = super::next_id();
    instances().insert(id, Tailnet::new(Live { id, events }));
    id
}

/// The status document (`TailscaleStatus` as main's `status.ts` types it), or none.
pub async fn status(tailnet: u64, now: Option<u64>) -> Option<Value> {
    instance(tailnet)?.status(now).await
}

/// `not-installed`, `not-running`, `needs-login` or `ready`.
pub async fn phase(tailnet: u64, now: Option<u64>) -> &'static str {
    match instance(tailnet) {
        Some(tailnet) => tailnet.phase(now).await,
        None => "not-running",
    }
}

/// `{nodeId, nodeName, login}` of an address, or none.
pub async fn whois(tailnet: u64, ip: &str, now: Option<u64>) -> Option<Value> {
    instance(tailnet)?.whois(ip, now).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TailnetParams {
    tailnet: u64,
    ip: Option<String>,
    now_ms: Option<u64>,
}

fn known(params: &TailnetParams) -> Result<(), Fault> {
    instance(params.tailnet)
        .map(|_| ())
        .ok_or_else(|| Fault::new("no_tailnet", "The tailnet is not open"))
}

pub fn register(registry: &mut Registry) {
    registry.add("remote.tailnet.open", |call: Call| {
        Box::pin(async move { Reply::json(&json!({"tailnet": open(call.events)})) })
    });
    registry.add("remote.tailnet.status", |call: Call| {
        Box::pin(async move {
            let params: TailnetParams = call.params()?;
            known(&params)?;
            Reply::json(&status(params.tailnet, params.now_ms).await)
        })
    });
    registry.add("remote.tailnet.phase", |call: Call| {
        Box::pin(async move {
            let params: TailnetParams = call.params()?;
            known(&params)?;
            Reply::json(&phase(params.tailnet, params.now_ms).await)
        })
    });
    registry.add("remote.tailnet.whois", |call: Call| {
        Box::pin(async move {
            let params: TailnetParams = call.params()?;
            known(&params)?;
            let ip = params.ip.as_deref().unwrap_or_default();
            Reply::json(&whois(params.tailnet, ip, params.now_ms).await)
        })
    });
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Row {
        ip: String,
        tailnet: bool,
        family: u8,
        stripped: String,
    }

    #[derive(Deserialize)]
    struct Captured {
        addresses: Vec<Row>,
    }

    fn captured() -> Captured {
        serde_json::from_str(include_str!("tailnet-captured.json")).expect("captured rows")
    }

    #[test]
    fn tailnet_addresses_are_the_cgnat_range_and_the_ipv6_prefix_only() {
        for ip in [
            "100.64.0.1",
            "100.127.255.254",
            "::ffff:100.100.1.2",
            "fd7a:115c:a1e0:ab12::1",
        ] {
            assert!(is_tailnet_address(ip), "{ip}");
        }
        for ip in [
            "100.63.255.255",
            "100.128.0.1",
            "127.0.0.1",
            "192.168.1.2",
            "fd12::1",
            "::1",
            "x",
        ] {
            assert!(!is_tailnet_address(ip), "{ip}");
        }
    }

    #[test]
    fn address_rows_captured_from_the_typescript_read_the_same() {
        let rows = captured().addresses;
        assert_eq!(rows.len(), 71);
        for row in &rows {
            assert_eq!(
                is_tailnet_address(&row.ip),
                row.tailnet,
                "tailnet {:?}",
                row.ip
            );
            assert_eq!(unmapped(&row.ip), row.stripped, "stripped {:?}", row.ip);
            let kind = match family(unmapped(&row.ip)) {
                None => 0,
                Some(Family::V4(_)) => 4,
                Some(Family::V6) => 6,
            };
            assert_eq!(kind, row.family, "family {:?}", row.ip);
        }
    }

    /// A world with a CLI that counts its runs, and a scenario a test changes.
    struct Fake {
        installed: Mutex<bool>,
        status: Mutex<Option<Value>>,
        located: AtomicUsize,
        statuses: AtomicUsize,
        whoises: AtomicUsize,
        /// How long a status read takes on the core's clock.
        slow: Duration,
    }

    impl Fake {
        fn new(slow: Duration) -> Arc<Fake> {
            Arc::new(Fake {
                installed: Mutex::new(true),
                status: Mutex::new(Some(
                    json!({"backend": "running", "selfIps": ["100.64.0.5"]}),
                )),
                located: AtomicUsize::new(0),
                statuses: AtomicUsize::new(0),
                whoises: AtomicUsize::new(0),
                slow,
            })
        }

        fn set_backend(&self, backend: &str) {
            *self.status.lock().unwrap() = Some(json!({"backend": backend}));
        }

        fn down(&self) {
            *self.status.lock().unwrap() = None;
        }
    }

    impl Reads for Arc<Fake> {
        async fn locate(&self) -> Option<Value> {
            self.located.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            (*self.installed.lock().unwrap()).then(|| json!({"bin": "/fake/tailscale"}))
        }

        async fn status(&self, _runner: &Value) -> Option<Value> {
            self.statuses.fetch_add(1, Ordering::SeqCst);
            clock::sleep(self.slow).await;
            self.status.lock().unwrap().clone()
        }

        async fn whois(&self, _runner: &Value, ip: &str) -> Option<Value> {
            self.whoises.fetch_add(1, Ordering::SeqCst);
            (ip == "100.64.0.9" || ip.starts_with("10.9."))
                .then(|| json!({"nodeId": "nIPHONE1CNTRL", "nodeName": "iphone", "login": null}))
        }
    }

    fn rig() -> (Arc<Fake>, Arc<Tailnet<Arc<Fake>>>) {
        let fake = Fake::new(Duration::ZERO);
        (Arc::clone(&fake), Tailnet::new(fake))
    }

    #[tokio::test]
    async fn a_whois_is_kept_a_minute_and_an_unknown_address_costs_a_call_each_time() {
        let (fake, tailnet) = rig();
        let whoises = || fake.whoises.load(Ordering::SeqCst);
        let peer = tailnet.whois("100.64.0.9", Some(1_000)).await;
        assert_eq!(
            peer.as_ref().and_then(|p| p.get("nodeId")),
            Some(&json!("nIPHONE1CNTRL"))
        );
        tailnet.whois("::ffff:100.64.0.9", Some(1_000)).await;
        assert_eq!(whoises(), 1);
        tailnet
            .whois("100.64.0.9", Some(1_000 + WHOIS_CACHE_MS - 1))
            .await;
        assert_eq!(whoises(), 1);
        tailnet
            .whois("100.64.0.9", Some(1_000 + WHOIS_CACHE_MS))
            .await;
        assert_eq!(whoises(), 2);
        assert_eq!(tailnet.whois("100.64.0.200", Some(1_000)).await, None);
        assert_eq!(tailnet.whois("--help", Some(1_000)).await, None);
        assert_eq!(whoises(), 3);
    }

    #[tokio::test]
    async fn a_full_whois_cache_starts_over() {
        let (fake, tailnet) = rig();
        for n in 0..WHOIS_CACHE_MAX {
            let ip = format!("10.9.{}.{}", n / 256, n % 256);
            assert!(tailnet.whois(&ip, Some(1_000)).await.is_some());
        }
        assert_eq!(tailnet.lock().whois.len(), WHOIS_CACHE_MAX);
        let first = "10.9.0.0".to_owned();
        tailnet.whois(&first, Some(1_000)).await;
        assert_eq!(fake.whoises.load(Ordering::SeqCst), WHOIS_CACHE_MAX);
        // The 257th address finds the cache full and clears it before it is kept.
        assert!(tailnet.whois("10.9.9.9", Some(1_000)).await.is_some());
        assert_eq!(tailnet.lock().whois.len(), 1);
        tailnet.whois(&first, Some(1_000)).await;
        assert_eq!(fake.whoises.load(Ordering::SeqCst), WHOIS_CACHE_MAX + 2);
    }

    #[tokio::test]
    async fn a_status_is_kept_three_seconds_and_phase_reads_the_backend() {
        let (fake, tailnet) = rig();
        let status = tailnet.status(Some(1_000)).await.expect("status");
        assert_eq!(status["selfIps"], json!(["100.64.0.5"]));
        tailnet.status(Some(1_000 + STATUS_CACHE_MS - 1)).await;
        assert_eq!(fake.statuses.load(Ordering::SeqCst), 1);
        fake.set_backend("needs-login");
        assert_eq!(
            tailnet.phase(Some(1_000 + STATUS_CACHE_MS - 1)).await,
            "ready"
        );
        assert_eq!(
            tailnet.phase(Some(1_000 + STATUS_CACHE_MS)).await,
            "needs-login"
        );
        assert_eq!(fake.statuses.load(Ordering::SeqCst), 2);
        fake.set_backend("stopped");
        assert_eq!(tailnet.phase(Some(10_000)).await, "not-running");
    }

    #[tokio::test]
    async fn a_missing_cli_is_told_from_one_that_does_not_answer_and_is_looked_for_again() {
        let (fake, tailnet) = rig();
        *fake.installed.lock().unwrap() = false;
        assert_eq!(tailnet.phase(Some(1_000)).await, "not-installed");
        *fake.installed.lock().unwrap() = true;
        fake.down();
        assert_eq!(
            tailnet.phase(Some(1_000 + STATUS_CACHE_MS)).await,
            "not-running"
        );
        assert_eq!(fake.located.load(Ordering::SeqCst), 2);
        *fake.status.lock().unwrap() = Some(json!({"backend": "running"}));
        assert_eq!(
            tailnet.phase(Some(1_000 + 2 * STATUS_CACHE_MS)).await,
            "ready"
        );
        // Found once, kept.
        assert_eq!(fake.located.load(Ordering::SeqCst), 2);
        assert_eq!(fake.statuses.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_whois_without_a_cli_is_none_and_asks_again_next_time() {
        let (fake, tailnet) = rig();
        *fake.installed.lock().unwrap() = false;
        assert_eq!(tailnet.whois("100.64.0.9", Some(1)).await, None);
        assert_eq!(tailnet.whois("100.64.0.9", Some(1)).await, None);
        assert_eq!(fake.located.load(Ordering::SeqCst), 2);
        assert_eq!(fake.whoises.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn callers_that_ask_together_share_one_lookup_and_one_read() {
        let (fake, tailnet) = rig();
        let (a, b, c) = tokio::join!(
            tailnet.status(Some(1_000)),
            tailnet.status(Some(1_000)),
            tailnet.whois("100.64.0.9", Some(1_000)),
        );
        assert!(a.is_some() && a == b && c.is_some());
        assert_eq!(fake.located.load(Ordering::SeqCst), 1);
        assert_eq!(fake.statuses.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn without_a_caller_clock_an_entry_is_stamped_when_its_read_ends_by_the_core_clock() {
        let _serial = clock::TEST_CLOCK.lock().await;
        clock::set_manual(10_000);
        let tailnet = Tailnet::new(Fake::new(Duration::from_millis(2_000)));
        let read = tokio::spawn({
            let tailnet = Arc::clone(&tailnet);
            async move { tailnet.status(None).await }
        });
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        clock::advance(2_000).await;
        assert!(read.await.expect("joined").is_some());
        // Stamped at 12 000: still kept at 14 999, read again at 15 000.
        clock::advance(2_999).await;
        let calls = || tailnet.reads.statuses.load(Ordering::SeqCst);
        tailnet.status(None).await;
        assert_eq!(calls(), 1);
        clock::advance(1).await;
        let again = tokio::spawn({
            let tailnet = Arc::clone(&tailnet);
            async move { tailnet.status(None).await }
        });
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        clock::advance(2_000).await;
        assert!(again.await.expect("joined").is_some());
        assert_eq!(calls(), 2);
        clock::set_real();
    }
}
