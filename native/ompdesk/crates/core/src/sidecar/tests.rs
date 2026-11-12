//! The lane against real processes: a stand-in omp (this test binary run again on one test that acts as omp, so the
//! same code runs on every OS) and a stand-in main that answers the lane's asks. Each test owns a tab id.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::server::{registry, serve};

const FAKE: &str = "OMPDESK_FAKE_OMP";
const LIMITS: &str = "{\"type\":\"ready\",\"supportedProtocolVersions\":[1,2],\"maxFrameBytes\":1048576,\"maxReassembledFrameBytes\":67108864}";

/// The stand-in omp. Run as a test it does nothing; run with `OMPDESK_FAKE_OMP` set it speaks omp's side of the wire
/// until its stdin ends (exit 0), or as its mode says.
#[test]
fn fake_omp_stand_in() {
    let Ok(mode) = std::env::var(FAKE) else {
        return;
    };
    fake_omp(&mode);
}

fn note(line: &str) {
    if let Ok(path) = std::env::var("OMPDESK_FAKE_LOG")
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn fake_omp(mode: &str) {
    note(&format!(
        "start {}",
        std::env::args().skip(4).collect::<Vec<_>>().join(" ")
    ));
    // The harness prints its own text on this line first.
    say("");
    match mode {
        "crash" => {
            eprintln!("fatal: boom");
            std::process::exit(3);
        }
        "crash-model" => {
            eprintln!("error: saved model gone");
            std::process::exit(3);
        }
        "silent" => {}
        "refresh" => {
            say("up");
            // An omp whose exit waits on a login refresh it has to save: asked to stop (its stdin ends, as on
            // Windows), it says what stock's exit says (`postmortem.ts`), then saves and exits once the gate exists.
            for _ in std::io::stdin().lock().lines() {}
            let hold = std::env::var("FAKE_HOLD").unwrap_or_default();
            if hold != "0" {
                eprintln!("Waiting for the login refresh to finish saving (up to {hold} s)…");
            }
            let gate = PathBuf::from(std::env::var("FAKE_GATE").unwrap_or_default());
            loop {
                if gate.exists() {
                    let _ =
                        std::fs::write(std::env::var("FAKE_SAVED").unwrap_or_default(), "token");
                    std::process::exit(0);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        _ => {
            // The extension listens before omp prints `ready`.
            if let Ok(address) = std::env::var("OMP_GUI_BRIDGE") {
                serve_bridge(address);
            }
            say(LIMITS);
        }
    }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        note(&format!("in {line}"));
        let Ok(command) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (id, ty) = (
            command["id"].clone(),
            command["type"].as_str().unwrap_or(""),
        );
        if mode == "silent" {
            continue;
        }
        let reply = |data: Value| {
            say(&json!({ "type": "response", "id": id, "command": ty, "success": true, "data": data }).to_string());
        };
        match ty {
            "get_state" => {
                let file = std::env::var("FAKE_SESSION_FILE").ok();
                reply(json!({ "sessionId": "s1", "sessionFile": file }));
            }
            "new_session" | "switch_session" => reply(json!({ "cancelled": false })),
            "exit0" => {
                reply(json!({}));
                std::process::exit(0);
            }
            "noisy" => {
                eprintln!("\u{1b}[31mwarning: noisy\u{1b}[0m");
                reply(json!({}));
            }
            "slow_echo" => {
                std::thread::sleep(Duration::from_millis(300));
                reply(json!({ "slow": true }));
            }
            "prompt" => {
                let user = json!({ "role": "user", "content": "hi", "timestamp": 1 });
                let assistant = json!({ "role": "assistant", "content": "ok", "timestamp": 2 });
                say(&json!({ "type": "agent_start" }).to_string());
                say(&json!({ "type": "message_end", "message": user }).to_string());
                say(&json!({ "type": "message_end", "message": assistant }).to_string());
                // The terminal frame carries only the last message: the first was already delivered.
                say(&json!({ "type": "agent_end", "messages": [assistant] }).to_string());
                reply(json!({}));
                say(&json!({ "type": "prompt_result", "status": "completed" }).to_string());
            }
            _ => reply(json!({})),
        }
    }
    note("eof");
}

/// The bridge extension's stand-in: answers `sessions.attach_entry_ids` with an `entryId` per message.
fn serve_bridge(address: String) {
    let (up, ready) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a runtime");
        runtime.block_on(async move {
            let streams = listen_for_bridge(&address);
            let _ = up.send(());
            let mut streams = streams;
            while let Some(stream) = streams.recv().await {
                tokio::spawn(bridge_connection(stream));
            }
        });
    });
    let _ = ready.recv();
}

type BoxedIo = Box<dyn BridgeIo>;
trait BridgeIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> BridgeIo for T {}

#[cfg(unix)]
fn listen_for_bridge(address: &str) -> mpsc::UnboundedReceiver<BoxedIo> {
    let (accepted, streams) = mpsc::unbounded_channel();
    let listener = tokio::net::UnixListener::bind(address).expect("a socket");
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let _ = accepted.send(Box::new(stream) as BoxedIo);
        }
    });
    streams
}

#[cfg(windows)]
fn listen_for_bridge(address: &str) -> mpsc::UnboundedReceiver<BoxedIo> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let (accepted, streams) = mpsc::unbounded_channel();
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(address)
        .expect("a pipe");
    let address = address.to_owned();
    tokio::spawn(async move {
        loop {
            if server.connect().await.is_err() {
                break;
            }
            let next = ServerOptions::new().create(&address).expect("a pipe");
            let _ = accepted.send(Box::new(std::mem::replace(&mut server, next)) as BoxedIo);
        }
    });
    streams
}

async fn bridge_connection(stream: BoxedIo) {
    let (read, mut write) = tokio::io::split(stream);
    let mut read = tokio::io::BufReader::new(read);
    let mut line = String::new();
    while let Ok(n) = read.read_line(&mut line).await {
        if n == 0 {
            break;
        }
        let request: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        line.clear();
        let method = request["method"].as_str().unwrap_or("");
        note(&format!("bridge {method}"));
        let result = if method == "sessions.attach_entry_ids" {
            let messages: Vec<Value> = request["params"]["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .map(|(at, mut message)| {
                    message["entryId"] = json!(format!("e{at}"));
                    message
                })
                .collect();
            json!({ "messages": messages })
        } else {
            Value::Null
        };
        let reply = json!({ "id": request["id"], "ok": true, "result": result });
        if write
            .write_all(format!("{reply}\n").as_bytes())
            .await
            .is_err()
        {
            break;
        }
    }
}

// ---- the stand-in main --------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Event {
    name: String,
    data: Value,
    bin: Vec<u8>,
}

/// How the stand-in main answers each of the lane's asks.
#[derive(Clone)]
struct Behaviour {
    mode: String,
    dir: PathBuf,
    session_file: Option<String>,
    resolve: String,
    plan: Value,
    gate_cwd: Option<String>,
    log: PathBuf,
}

/// The stand-in omp is a process of this test binary: starting many at once on Windows made some of them silent, so
/// the tests that start processes take turns.
static TURNS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Rig {
    _turn: tokio::sync::MutexGuard<'static, ()>,
    tab: String,
    seq: u64,
    writer: mpsc::UnboundedSender<Vec<u8>>,
    events: mpsc::UnboundedReceiver<Event>,
    replies: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next: Arc<AtomicU64>,
    behaviour: Arc<Mutex<Behaviour>>,
    /// Every event read so far, in order.
    seen: Vec<Event>,
    /// Events read while looking for a command's answer, not yet taken by a test.
    backlog: VecDeque<Event>,
    dir: PathBuf,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ompdesk-core-lane-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

impl Rig {
    async fn new(name: &str, mode: &str) -> Rig {
        let turn = TURNS.lock().await;
        let dir = temp(name);
        let (client, server_io) = tokio::io::duplex(1 << 20);
        let (server_read, server_write) = tokio::io::split(server_io);
        let server = tokio::spawn(serve(server_read, server_write, registry()));
        let (client_read, mut input) = tokio::io::split(client);
        let mut lines = tokio::io::BufReader::new(client_read);
        let mut first = String::new();
        lines.read_line(&mut first).await.unwrap();
        assert!(first.contains("\"ready\""), "{first}");

        let behaviour = Arc::new(Mutex::new(Behaviour {
            mode: mode.into(),
            dir: dir.clone(),
            session_file: None,
            resolve: "ok".into(),
            plan: json!("restart"),
            gate_cwd: None,
            log: dir.join("omp.log"),
        }));
        let replies: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::default();
        let next = Arc::new(AtomicU64::new(1_000));
        let (writer, mut outbound) = mpsc::unbounded_channel::<Vec<u8>>();
        let (events_tx, events) = mpsc::unbounded_channel();
        // One writer to the core's input; it ends with the rig, which ends the core's input.
        tokio::spawn(async move {
            while let Some(line) = outbound.recv().await {
                // An empty message ends the core's input.
                if line.is_empty() || input.write_all(&line).await.is_err() {
                    break;
                }
            }
            let _ = input.shutdown().await;
        });
        let reader_replies = Arc::clone(&replies);
        let reader_behaviour = Arc::clone(&behaviour);
        let (answer_tx, answer_next) = (writer.clone(), Arc::clone(&next));
        tokio::spawn(async move {
            loop {
                let mut head = String::new();
                if lines.read_line(&mut head).await.unwrap_or(0) == 0 {
                    break;
                }
                let frame: Value = serde_json::from_str(&head).unwrap();
                let mut bin = vec![0u8; frame["bin"].as_u64().unwrap_or(0) as usize];
                lines.read_exact(&mut bin).await.unwrap();
                if let Some(name) = frame["event"].as_str() {
                    let event = Event {
                        name: name.into(),
                        data: frame["data"].clone(),
                        bin,
                    };
                    let behaviour = reader_behaviour.lock().unwrap().clone();
                    if let Some((method, params)) = answer(&behaviour, &event) {
                        let id = answer_next.fetch_add(1, Ordering::SeqCst);
                        let line = format!(
                            "{}\n",
                            json!({ "id": id, "method": method, "params": params })
                        );
                        let _ = answer_tx.send(line.into_bytes());
                    }
                    let _ = events_tx.send(event);
                } else if let Some(id) = frame["id"].as_u64()
                    && let Some(reply) = reader_replies.lock().unwrap().remove(&id)
                {
                    let _ = reply.send(frame);
                }
            }
        });
        Rig {
            _turn: turn,
            tab: format!("{name}-tab"),
            seq: 0,
            writer,
            events,
            replies,
            next,
            behaviour,
            seen: Vec::new(),
            backlog: VecDeque::new(),
            dir,
            server,
        }
    }

    /// Sends a request now; the receiver gets its answer frame.
    fn post(&self, method: &str, params: Value) -> oneshot::Receiver<Value> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (reply, answer) = oneshot::channel();
        self.replies.lock().unwrap().insert(id, reply);
        let line = format!(
            "{}\n",
            json!({ "id": id, "method": method, "params": params })
        );
        let _ = self.writer.send(line.into_bytes());
        answer
    }

    /// A request, answered as the core answered it (`ok: true` → `result`; else `error`).
    async fn call(&self, method: &str, params: Value) -> Result<Value, Value> {
        settle(self.post(method, params)).await
    }

    /// The next request of the tab's order: its `seq` is added.
    fn seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    fn open_params(&self, seq: u64, tuning: Value) -> Value {
        json!({
            "tab": self.tab, "seq": seq, "cwd": self.dir.to_string_lossy(), "kind": "agent", "fresh": true,
            "eventFilter": ["agent_end", "message_end"],
            "bridge": self.behaviour.lock().unwrap().mode.contains("bridge"),
            "startSlowMs": 60_000, "tuning": tuning,
        })
    }

    /// `sidecar.open`: it answers only once the tab is gone, so the answer is awaited at the end of a test.
    fn open(&mut self, tuning: Value) -> oneshot::Receiver<Value> {
        let seq = self.seq();
        self.post("sidecar.open", self.open_params(seq, tuning))
    }

    async fn tab_call(&mut self, method: &str, extra: Value) -> Result<Value, Value> {
        let seq = self.seq();
        let mut params = json!({ "tab": self.tab, "seq": seq });
        if let (Some(base), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            base.extend(extra.clone());
        }
        let answer = self.call(method, params).await?;
        if method != "sidecar.command" {
            return Ok(answer);
        }
        // A stock command's answer is an event, in order with the frames; the request settles behind it.
        let found = loop {
            let event = self.recv("the command's answer").await;
            if event.name == "sidecar.answer" && event.data["seq"] == json!(seq) {
                break event;
            }
            self.backlog.push_back(event);
        };
        Ok(json!({ "response": serde_json::from_slice::<Value>(&found.bin).unwrap() }))
    }

    /// Events until one satisfies `want` (every event read is kept in `seen`).
    async fn until(&mut self, what: &str, want: impl Fn(&Event) -> bool) -> Event {
        loop {
            let event = match self.backlog.pop_front() {
                Some(event) => event,
                None => self.recv(what).await,
            };
            self.seen.push(event.clone());
            if want(&event) {
                return event;
            }
        }
    }

    /// The next event from the core.
    async fn recv(&mut self, what: &str) -> Event {
        tokio::time::timeout(Duration::from_secs(30), self.events.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}; saw {:?}", self.names()))
            .expect("the core ended")
    }

    /// Reads what has arrived so far.
    fn drain(&mut self) {
        while let Some(event) = self.backlog.pop_front() {
            self.seen.push(event);
        }
        while let Ok(event) = self.events.try_recv() {
            self.seen.push(event);
        }
    }

    fn names(&self) -> Vec<String> {
        self.seen
            .iter()
            .map(|event| match event.name.as_str() {
                "sidecar.status" => format!("status:{}", event.data["payload"]["status"]),
                "sidecar.stderr" => format!("stderr:{}", event.data["text"]),
                other => other.to_owned(),
            })
            .collect()
    }

    async fn status(&mut self, status: &str) -> Event {
        let status = status.to_owned();
        self.until(&format!("status {status}"), move |event| {
            event.name == "sidecar.status" && event.data["payload"]["status"] == status
        })
        .await
    }

    fn event(&self, name: &str) -> Option<&Event> {
        self.seen.iter().find(|event| event.name == name)
    }
}

async fn settle(answer: oneshot::Receiver<Value>) -> Result<Value, Value> {
    let frame = tokio::time::timeout(Duration::from_secs(30), answer)
        .await
        .expect("the core never answered")
        .unwrap();
    if frame["ok"] == true {
        Ok(frame["result"].clone())
    } else {
        Err(frame["error"].clone())
    }
}

/// What the stand-in main answers to an ask of the lane: the request it makes.
fn answer(behaviour: &Behaviour, event: &Event) -> Option<(&'static str, Value)> {
    let (tab, ask) = (&event.data["tab"], &event.data["ask"]);
    match event.name.as_str() {
        "sidecar.resolve" => Some((
            "sidecar.resolved",
            json!({ "tab": tab, "ask": ask, "outcome": behaviour.resolve, "message": "no omp" }),
        )),
        "sidecar.launch" => {
            let exe = std::env::current_exe().unwrap();
            let mut env: serde_json::Map<String, Value> = std::env::vars()
                .map(|(key, value)| (key, json!(value)))
                .collect();
            env.insert(
                FAKE.into(),
                json!(behaviour.mode.split('+').next().unwrap_or("ok")),
            );
            env.insert(
                "OMPDESK_FAKE_LOG".into(),
                json!(behaviour.log.to_string_lossy()),
            );
            if let Some(file) = &behaviour.session_file {
                env.insert("FAKE_SESSION_FILE".into(), json!(file));
            }
            // The stand-in serves the bridge only when the lane named an address (this shell may be an omp's own).
            env.remove("OMP_GUI_BRIDGE");
            if let Some(address) = event.data["bridgeAddress"].as_str() {
                env.insert("OMP_GUI_BRIDGE".into(), json!(address));
            }
            let mut args = vec![
                json!("sidecar::tests::fake_omp_stand_in"),
                json!("--exact"),
                json!("--nocapture"),
            ];
            args.push(json!(format!("open={}", event.data["open"])));
            args.push(json!(format!("model={}", event.data["model"])));
            Some((
                "sidecar.launched",
                json!({ "tab": tab, "ask": ask, "hostTools": [{ "name": "terminal_read" }], "start": {
                    "bin": exe.to_string_lossy(), "args": args, "env": env,
                    "cwd": behaviour.dir.to_string_lossy(), "shell": false,
                } }),
            ))
        }
        "sidecar.exit" => Some((
            "sidecar.exitPlan",
            json!({ "tab": tab, "ask": ask, "plan": behaviour.plan }),
        )),
        "sidecar.gateAsk" => Some((
            "sidecar.gated",
            json!({ "tab": tab, "ask": ask, "cwd": behaviour.gate_cwd }),
        )),
        "sidecar.slow" => Some((
            "sidecar.slowLog",
            json!({ "tab": tab, "ask": ask, "lines": ["its own log"] }),
        )),
        "sidecar.sessionWait" => Some((
            "sidecar.sessionFreed",
            json!({ "tab": tab, "ask": ask, "outcome": "free" }),
        )),
        _ => None,
    }
}

fn frames(rig: &Rig) -> Vec<Value> {
    rig.seen
        .iter()
        .filter(|event| event.name == "sidecar.frame")
        .map(|event| serde_json::from_slice(&event.bin).unwrap())
        .collect()
}

fn statuses(rig: &Rig) -> Vec<String> {
    rig.seen
        .iter()
        .filter(|event| event.name == "sidecar.status")
        .map(|event| event.data["payload"]["status"].as_str().unwrap().to_owned())
        .collect()
}

fn log(rig: &Rig) -> String {
    std::fs::read_to_string(rig.dir.join("omp.log")).unwrap_or_default()
}

/// Ends the tab, so no omp outlives the test.
async fn finish(mut rig: Rig) {
    let _ = rig.tab_call("sidecar.dispose", json!({})).await;
    rig.until("disposed", |event| event.name == "sidecar.disposed")
        .await;
    let _ = std::fs::remove_dir_all(&rig.dir);
}

const NO_QUEUE: &str = "{\"startsAtOnce\":0}";

fn no_queue() -> Value {
    serde_json::from_str(NO_QUEUE).unwrap()
}

// ---- tests --------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_started_tab_negotiates_answers_get_state_and_reads_ready() {
    let mut rig = Rig::new("ready", "ok").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    assert_eq!(statuses(&rig), ["starting", "ready"]);
    let ready = rig
        .seen
        .iter()
        .find(|e| e.data["payload"]["status"] == "ready")
        .unwrap();
    assert_eq!(
        ready.data["payload"]["cwd"],
        json!(rig.dir.to_string_lossy())
    );
    assert!(
        rig.seen
            .iter()
            .any(|e| e.name == "sidecar.spawned" && e.data["pid"].is_u64())
    );
    // `ready` is never delivered as a frame.
    assert!(frames(&rig).iter().all(|frame| frame["type"] != "ready"));
    // omp was told the protocol, its event filter and the ask dialog.
    let text = log(&rig);
    assert!(text.contains("\"type\":\"negotiate_protocol\""), "{text}");
    assert!(
        text.contains("\"type\":\"set_event_filter\"") && text.contains("agent_end"),
        "{text}"
    );
    assert!(text.contains("\"type\":\"set_ask_dialog\""), "{text}");
    // The tools main's launch answer named are registered before the first `get_state`.
    let host_tools = text
        .find("\"type\":\"set_host_tools\"")
        .expect("host tools set");
    assert!(text.contains("terminal_read"), "{text}");
    assert!(
        host_tools < text.find("\"type\":\"get_state\"").expect("get_state"),
        "{text}"
    );
    // The launch ask said how the session opens: a fresh tab starts a new one.
    assert_eq!(rig.event("sidecar.launch").unwrap().data["open"], "new");

    // A stock command is answered with omp's response, under an id of the lane's own.
    let answer = rig
        .tab_call(
            "sidecar.command",
            json!({ "command": { "type": "get_state" } }),
        )
        .await
        .unwrap();
    assert_eq!(answer["response"]["success"], true);
    assert_eq!(answer["response"]["data"]["sessionId"], "s1");
    assert!(
        answer["response"]["id"]
            .as_str()
            .unwrap()
            .starts_with("gui-")
    );
    finish(rig).await;
}

#[tokio::test]
async fn requests_that_arrive_early_are_applied_in_their_order() {
    let mut rig = Rig::new("order", "ok").await;
    // `start` (seq 2) is sent before `open` (seq 1): the core may see them in either order.
    let start = rig.post("sidecar.start", json!({ "tab": rig.tab, "seq": 2 }));
    let _open = rig.open(no_queue());
    rig.seq = 2;
    settle(start).await.unwrap();
    rig.status("ready").await;
    let starting = rig
        .seen
        .iter()
        .find(|e| e.data["payload"]["status"] == "starting")
        .unwrap();
    // The start was applied after the open: its events name seq 2.
    assert_eq!(starting.data["cmd"], 2);
    finish(rig).await;
}

#[tokio::test]
async fn a_crash_loop_restarts_three_times_then_reads_error_with_the_stderr() {
    let mut rig = Rig::new("crash", "crash").await;
    let _open = rig.open(json!({ "startsAtOnce": 0, "restartDelaysMs": [10, 10, 10] }));
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    let error = rig.status("error").await;
    let payload = &error.data["payload"];
    assert_eq!(payload["message"], "Exit code 3 — fatal: boom");
    assert_eq!(
        payload["restart"],
        json!({ "attempt": 3, "maxAttempts": 3 })
    );
    let attempts: Vec<Value> = rig
        .seen
        .iter()
        .filter(|e| e.data["payload"]["status"] == "restarting")
        .map(|e| e.data["payload"]["restart"]["attempt"].clone())
        .collect();
    assert_eq!(attempts, [1, 2, 3]);
    let reports: Vec<&Event> = rig
        .seen
        .iter()
        .filter(|e| e.name == "sidecar.failure")
        .collect();
    assert_eq!(reports.len(), 4);
    assert_eq!(reports[3].data["report"]["stderr"], json!(["fatal: boom"]));
    // A spawn that died before `ready` asked main whether its model was the cause.
    assert!(
        rig.seen
            .iter()
            .any(|e| e.name == "sidecar.exit" && e.data["booted"] == false)
    );
    finish(rig).await;
}

#[tokio::test]
async fn a_fallback_plan_respawns_on_the_default_model_outside_the_crash_budget() {
    let mut rig = Rig::new("fallback", "crash-model").await;
    rig.behaviour.lock().unwrap().plan = json!({ "fallback": "anthropic/gone" });
    let _open = rig.open(json!({ "startsAtOnce": 0, "restartDelaysMs": [10] }));
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    // The first spawn dies; the plan arms the fallback; the respawn's launch ask carries `@default`.
    rig.until("the second launch", |event| {
        event.name == "sidecar.launch" && event.data["model"] == "@default"
    })
    .await;
    // No restart was counted for the first death; the respawn dies too, and main's same plan is refused (the
    // fallback is armed already), so its death is the crash loop's first step.
    let failure = rig
        .until("the crash loop's first report", |e| {
            e.name == "sidecar.failure"
        })
        .await;
    assert_eq!(failure.data["report"]["attempt"], 1);
    assert!(
        statuses(&rig).iter().all(|s| s != "restarting") || failure.data["report"]["attempt"] == 1
    );
    finish(rig).await;
}

#[tokio::test]
async fn an_exit_of_code_zero_reads_exited_normal_shutdown() {
    let mut rig = Rig::new("exit0", "ok").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    // The answer omp wrote just before it exited is read before the exit is told, not lost to it.
    let answer = rig
        .tab_call("sidecar.command", json!({ "command": { "type": "exit0" } }))
        .await
        .unwrap();
    assert_eq!(answer["response"]["success"], true);
    let exited = rig.status("exited").await;
    assert_eq!(exited.data["payload"]["message"], "Normal shutdown");
    assert!(rig.event("sidecar.exited").is_some());
    finish(rig).await;
}

#[tokio::test]
async fn sleep_stops_the_omp_and_reads_asleep_and_a_start_wakes_it() {
    let mut rig = Rig::new("sleep", "ok").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    rig.tab_call("sidecar.sleep", json!({})).await.unwrap();
    rig.status("asleep").await;
    // `whenExited` answers once the omp that was stopped has exited.
    rig.tab_call("sidecar.whenExited", json!({})).await.unwrap();
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    let mut states = statuses(&rig);
    // A start waits for the stopped omp's exit first, which reads `queued`: a second `starting` the exit's end clears.
    states.dedup();
    assert_eq!(states, ["starting", "ready", "asleep", "starting", "ready"]);
    finish(rig).await;
}

#[tokio::test]
async fn stderr_is_stripped_of_its_colors_before_main_reads_it() {
    let mut rig = Rig::new("stderr", "ok").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    let _ = rig
        .tab_call("sidecar.command", json!({ "command": { "type": "noisy" } }))
        .await
        .unwrap();
    let said = rig.until("stderr", |e| e.name == "sidecar.stderr").await;
    assert_eq!(said.data["text"], "warning: noisy");
    finish(rig).await;
}

#[tokio::test]
async fn a_new_session_and_get_state_move_the_tab_s_session_and_tell_main() {
    let mut rig = Rig::new("session", "ok").await;
    let exe = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    rig.behaviour.lock().unwrap().session_file = Some(exe.clone());
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    // The `get_state` that made the tab ready named the session: the tab is no longer new. Told before `ready`.
    let session = rig
        .event("sidecar.tabSession")
        .expect("the session was not told");
    assert_eq!(session.data["sessionPath"], json!(exe));
    assert_eq!(session.data["isNew"], false);
    let identity = rig.event("sidecar.session").unwrap();
    assert_eq!(identity.data["identity"]["sessionId"], "s1");
    // A new session inside omp: the identity is unknown and the next spawn starts a new one.
    let _ = rig
        .tab_call(
            "sidecar.command",
            json!({ "command": { "type": "new_session" } }),
        )
        .await
        .unwrap();
    rig.until("identity null", |e| {
        e.name == "sidecar.session" && e.data["identity"].is_null()
    })
    .await;
    let fresh = rig
        .until("tabSession again", |e| e.name == "sidecar.tabSession")
        .await;
    assert_eq!(fresh.data["sessionPath"], Value::Null);
    assert_eq!(fresh.data["isNew"], true);
    // A restart that names no session reopens none: the launch asks `new`; naming one reopens it (the file exists).
    rig.tab_call("sidecar.restart", json!({ "resumeSessionPath": exe }))
        .await
        .unwrap();
    rig.until("the relaunch", |e| {
        e.name == "sidecar.launch" && e.data["open"] == json!({ "session": exe })
    })
    .await;
    finish(rig).await;
}

#[tokio::test]
async fn a_rename_is_delivered_as_a_session_info_update_frame() {
    let mut rig = Rig::new("rename", "ok").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    rig.tab_call(
        "sidecar.command",
        json!({ "command": { "type": "set_session_name", "name": "  My title \u{feff}" } }),
    )
    .await
    .unwrap();
    rig.until("the frame", |e| {
        e.name == "sidecar.frame" && e.bin.starts_with(b"{\"type\":\"session_info_update\"")
    })
    .await;
    let frame = frames(&rig)
        .into_iter()
        .find(|f| f["type"] == "session_info_update")
        .unwrap();
    assert_eq!(frame["title"], "My title");
    // The identity was unknown from then on.
    rig.drain();
    assert!(
        rig.seen
            .iter()
            .any(|e| e.name == "sidecar.session" && e.data["identity"].is_null())
    );
    finish(rig).await;
}

#[tokio::test]
async fn an_agent_end_waits_for_its_entry_ids_over_the_bridge_and_delivers_the_run_complete() {
    let mut rig = Rig::new("held", "ok+bridge").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    let state = rig
        .until("bridge state", |e| e.name == "sidecar.bridgeState")
        .await;
    assert_eq!(state.data["connected"], true);
    rig.status("ready").await;
    let answer = rig
        .tab_call(
            "sidecar.command",
            json!({ "command": { "type": "prompt", "message": "hi" }, "timeoutMs": 20_000 }),
        )
        .await
        .unwrap();
    assert_eq!(answer["response"]["success"], true);
    // The answer came after every frame omp sent before it: nothing is held when the barrier answers.
    rig.tab_call("sidecar.barrier", json!({})).await.unwrap();
    rig.until("prompt_result", |e| {
        e.name == "sidecar.frame" && String::from_utf8_lossy(&e.bin).contains("prompt_result")
    })
    .await;
    let delivered = frames(&rig);
    let types: Vec<&str> = delivered
        .iter()
        .map(|f| f["type"].as_str().unwrap_or(""))
        .collect();
    // The `agent_end` left before the frames behind it, `prompt_result` among them.
    let end = types.iter().position(|t| *t == "agent_end").unwrap();
    assert!(
        types.iter().position(|t| *t == "prompt_result").unwrap() > end,
        "{types:?}"
    );
    let messages = delivered[end]["messages"].as_array().unwrap();
    // Both messages of the run, with the ids the bridge attached; stock's frame had only the last.
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["entryId"], "e0");
    assert_eq!(messages[1]["entryId"], "e1");
    assert!(log(&rig).contains("bridge sessions.attach_entry_ids"));
    // A request to the bridge goes through the lane.
    let result = rig
        .tab_call(
            "sidecar.bridge",
            json!({ "method": "ping", "timeoutMs": 5000 }),
        )
        .await
        .unwrap();
    assert!(result.get("result").is_none_or(Value::is_null), "{result}");
    finish(rig).await;
}

#[tokio::test]
async fn the_start_gate_runs_between_ready_and_the_ready_status_and_may_move_the_tab() {
    let mut rig = Rig::new("gate", "ok+bridge").await;
    rig.behaviour.lock().unwrap().gate_cwd = Some(rig.dir.to_string_lossy().into_owned());
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.gate", json!({})).await.unwrap();
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.until("the gate ask", |e| e.name == "sidecar.gateAsk")
        .await;
    // The gate answered a folder: the tab restarts in it as a new session; the gate runs once.
    rig.behaviour.lock().unwrap().gate_cwd = None;
    rig.status("ready").await;
    let names = rig.names();
    let ask = names.iter().position(|n| n == "sidecar.gateAsk").unwrap();
    let ready = names.iter().position(|n| n == "status:\"ready\"").unwrap();
    assert!(ready > ask, "{names:?}");
    let launches = rig
        .seen
        .iter()
        .filter(|e| e.name == "sidecar.launch")
        .count();
    assert_eq!(launches, 2, "{names:?}");
    assert_eq!(
        rig.seen
            .iter()
            .filter(|e| e.name == "sidecar.gateAsk")
            .count(),
        1
    );
    finish(rig).await;
}

#[tokio::test]
async fn a_late_answer_to_a_cancelled_command_is_delivered_as_a_frame() {
    let mut rig = Rig::new("late", "ok").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    let seq = rig.seq();
    let id = rig.next.fetch_add(1, Ordering::SeqCst);
    let (reply, answer) = oneshot::channel();
    rig.replies.lock().unwrap().insert(id, reply);
    let params = json!({ "tab": rig.tab, "seq": seq, "command": { "type": "slow_echo" } });
    let line = format!(
        "{}\n{}\n",
        json!({ "id": id, "method": "sidecar.command", "params": params }),
        json!({ "cancel": id })
    );
    rig.writer.send(line.into_bytes()).unwrap();
    let cancelled = answer.await.unwrap();
    assert_eq!(cancelled["error"]["code"], "cancelled");
    let late = rig
        .until("the late response", |e| {
            e.name == "sidecar.frame" && String::from_utf8_lossy(&e.bin).contains("\"slow\":true")
        })
        .await;
    assert_eq!(
        serde_json::from_slice::<Value>(&late.bin).unwrap()["type"],
        "response"
    );
    finish(rig).await;
}

#[tokio::test]
async fn a_command_with_no_omp_running_is_refused_as_disconnected() {
    let mut rig = Rig::new("none", "ok").await;
    let _open = rig.open(no_queue());
    let refused = rig
        .tab_call(
            "sidecar.command",
            json!({ "command": { "type": "get_state" } }),
        )
        .await
        .unwrap_err();
    assert_eq!(refused["code"], "sidecar_disconnected");
    assert_eq!(refused["message"], "Sidecar disconnected");
    let bridge = rig
        .tab_call("sidecar.bridge", json!({ "method": "x" }))
        .await
        .unwrap_err();
    assert_eq!(bridge["code"], "bridge_disconnected");
    assert_eq!(bridge["message"], "gui-bridge not connected");
    finish(rig).await;
}

#[tokio::test]
async fn a_waiting_omp_resolution_reads_waiting_and_an_owned_session_reads_error_then_starts_when_freed()
 {
    let mut rig = Rig::new("resolve", "ok").await;
    rig.behaviour.lock().unwrap().resolve = "waiting".into();
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    let waiting = rig.status("waiting").await;
    assert_eq!(waiting.data["payload"]["message"], "no omp");
    // The session is held by another omp: error with `sessionHeld`; the wait ends when main says it is free.
    rig.behaviour.lock().unwrap().resolve = "owned".into();
    let path = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    rig.tab_call("sidecar.restart", json!({ "resumeSessionPath": path }))
        .await
        .unwrap();
    let held = rig.status("error").await;
    assert_eq!(held.data["payload"]["sessionHeld"], true);
    rig.behaviour.lock().unwrap().resolve = "ok".into();
    rig.status("ready").await;
    finish(rig).await;
}

#[tokio::test]
async fn disposing_ends_the_omp_through_its_stdin_and_answers_the_open_request_after_its_exit() {
    let mut rig = Rig::new("dispose", "ok").await;
    let open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    rig.tab_call("sidecar.dispose", json!({ "stdinGraceMs": 10_000 }))
        .await
        .unwrap();
    rig.until("disposed", |e| e.name == "sidecar.disposed")
        .await;
    assert_eq!(settle(open).await.unwrap(), json!({}));
    // A tab that is gone answers what is left of its requests the way a tab with no omp does.
    let refused = rig
        .tab_call(
            "sidecar.command",
            json!({ "command": { "type": "get_state" } }),
        )
        .await
        .unwrap_err();
    assert_eq!(refused["code"], "sidecar_disconnected");
    rig.tab_call("sidecar.whenExited", json!({})).await.unwrap();
    // Disposed: the omp's exit reports nothing.
    rig.drain();
    assert!(
        statuses(&rig)
            .iter()
            .all(|s| s != "exited" && s != "restarting")
    );
    let _ = std::fs::remove_dir_all(&rig.dir);
}

#[tokio::test]
async fn the_quit_stops_every_omp_tells_how_many_and_nothing_starts_again() {
    let mut rig = Rig::new("quit", "ok").await;
    let _open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    let told = rig
        .call("sidecar.stopAll", json!({ "boundMs": 20_000 }))
        .await
        .unwrap();
    assert!(told["told"].as_u64().unwrap() >= 1, "{told}");
    rig.tab_call("sidecar.whenExited", json!({})).await.unwrap();
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    rig.drain();
    assert_eq!(
        rig.seen
            .iter()
            .filter(|e| e.name == "sidecar.launch")
            .count(),
        1
    );
    finish(rig).await;
}

#[tokio::test]
async fn the_start_queue_holds_a_start_back_and_the_tab_reads_queued() {
    let mut rig = Rig::new("queued", "ok").await;
    let _open = rig.open(json!({ "startsAtOnce": 8, "startSlotCapMs": 60_000 }));
    rig.call("sidecar.holdStarts", json!({ "hold": true }))
        .await
        .unwrap();
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    let queued = rig
        .until("queued", |e| e.data["payload"]["queued"] == true)
        .await;
    assert_eq!(queued.data["payload"]["status"], "starting");
    rig.call("sidecar.holdStarts", json!({ "hold": false }))
        .await
        .unwrap();
    rig.status("ready").await;
    // The place was given back at the first answer; the tab no longer reads queued.
    let ready = rig.seen.last().unwrap();
    assert!(ready.data["payload"].get("queued").is_none());
    finish(rig).await;
}

#[tokio::test]
async fn four_tabs_start_through_a_queue_of_two_and_all_read_ready() {
    let mut rig = Rig::new("many", "ok").await;
    let tabs = ["many-a", "many-b", "many-c", "many-d"];
    let mut opens = Vec::new();
    for tab in tabs {
        rig.tab = tab.into();
        rig.seq = 0;
        opens.push(rig.open(json!({ "startsAtOnce": 2, "startSlotCapMs": 60_000 })));
        rig.tab_call("sidecar.start", json!({})).await.unwrap();
    }
    let mut ready = std::collections::HashSet::new();
    while ready.len() < tabs.len() {
        let event = rig
            .until("every tab ready", |e| {
                e.name == "sidecar.status" && e.data["payload"]["status"] == "ready"
            })
            .await;
        ready.insert(event.data["tab"].as_str().unwrap().to_owned());
    }
    // At most two were starting at once: every later start waited, and read `queued` while it did.
    assert!(
        rig.seen.iter().any(|e| e.data["payload"]["queued"] == true),
        "{:?}",
        rig.names()
    );
    for (at, tab) in tabs.iter().enumerate() {
        rig.tab = (*tab).into();
        rig.seq = 2;
        let _ = rig.tab_call("sidecar.dispose", json!({})).await;
        let _ = at;
    }
    for open in opens {
        assert_eq!(settle(open).await.unwrap(), json!({}));
    }
    let _ = std::fs::remove_dir_all(&rig.dir);
}

#[tokio::test]
async fn the_end_of_the_cores_input_stops_the_omps() {
    let mut rig = Rig::new("closeall", "ok").await;
    let open = rig.open(no_queue());
    rig.tab_call("sidecar.start", json!({})).await.unwrap();
    rig.status("ready").await;
    // Main's `stop()` ends the core's stdin: the core stops what it runs and answers the open request.
    rig.writer.send(Vec::new()).unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(20), &mut rig.server)
        .await
        .expect("the core did not end with its input");
    ended.unwrap().unwrap();
    assert_eq!(settle(open).await.unwrap(), json!({}));
    // On Windows omp is asked to stop by its stdin's end, and saw it; POSIX asks with SIGTERM, which ends the
    // stand-in before it reads anything more (the open's answer above says it exited).
    if cfg!(windows) {
        assert!(log(&rig).contains("eof"), "{}", log(&rig));
    }
    let _ = std::fs::remove_dir_all(&rig.dir);
}
