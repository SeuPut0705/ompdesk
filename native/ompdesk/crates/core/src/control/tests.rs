//! The TypeScript server's behaviour, replayed: rows captured from `src/main/control-socket/{server,router,events}.ts`
//! before they were deleted (`captured.json`), run here against a stand-in for main. `lines`: what a connection sends
//! and what it gets back, through `conn` on an in-memory stream. `waits` and `sends`: the router on a paused clock.
//! `hub` (in `events.rs`), `callers`, `numbers` and `absolute` (in `js.rs`): the pure parts.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use super::conn::{self, Serving};
use super::events::Sink;
use super::frame::Frame;
use super::link::{Ask, Link, Push};
use super::router::{self, Connection};
use super::{Activity, Caller, SessionState, Tuning, View};
use crate::fs::disk::make_temp_dir;

/// A table of `captured.json`.
pub fn captured(table: &str) -> Vec<Value> {
    let rows: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    rows[table].as_array().unwrap().clone()
}

pub fn state_of(value: &Value) -> SessionState {
    serde_json::from_value(value.clone()).unwrap()
}

/// What main's fake backend was in the TypeScript's tests: sessions by name, in the order they were added.
#[derive(Default)]
struct Sessions(Vec<View>);

impl Sessions {
    fn add(&mut self, session: &str, state: SessionState) {
        self.0.push(View {
            session: session.to_owned(),
            title: format!("title of {session}"),
            state,
        });
    }

    fn set(&mut self, session: &str, state: SessionState) {
        if let Some(view) = self.0.iter_mut().find(|view| view.session == session) {
            view.state = state;
        }
    }

    fn get(&self, session: &str) -> Option<&View> {
        self.0.iter().find(|view| view.session == session)
    }
}

fn view_json(view: &View) -> String {
    json!({ "session": view.session, "title": view.title, "state": view.state }).to_string()
}

/// One step a row's script takes on main's side: `=state`, `x` (the session goes), `!type[:stopReason][@tab]`.
#[derive(Clone)]
enum Op {
    State(SessionState),
    Remove,
    Fire(Activity),
    Advance(u64),
}

fn ops(value: &Value) -> Vec<Op> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|op| {
            let op = op.as_str().unwrap();
            if let Some(state) = op.strip_prefix('=') {
                Op::State(state_of(&json!(state)))
            } else if op == "x" {
                Op::Remove
            } else if let Some(ms) = op.strip_prefix('+') {
                Op::Advance(ms.parse().unwrap())
            } else {
                let fired = op.strip_prefix('!').unwrap();
                let (fired, tab) = fired.split_once('@').unwrap_or((fired, "t1"));
                let (kind, stop_reason) = match fired.split_once(':') {
                    Some((kind, reason)) => (kind, Some(reason.to_owned())),
                    None => (fired, None),
                };
                Op::Fire(Activity {
                    kind: kind.to_owned(),
                    tab_id: tab.to_owned(),
                    request_id: (kind == "ask").then(|| "q1".to_owned()),
                    text: (kind == "ask").then(|| "Proceed?".to_owned()),
                    stop_reason,
                })
            }
        })
        .collect()
}

/// The stand-in for main: it answers the core's asks from `sessions` and tells what its script does, each as a
/// numbered push, in the order main's control backend (`src/main/control-socket/backend.ts`) sends them.
struct Main {
    link: Arc<Link>,
    asks: mpsc::UnboundedReceiver<Ask>,
    sessions: Sessions,
    seq: u64,
    watching: bool,
    /// What the session does while main resolves a name, and while it runs the send tool.
    during_resolve: Vec<Op>,
    during_run: Vec<Op>,
    /// How a tool call ends: an outcome, `never`, `throw`; none runs the row's default.
    run: Value,
    calls: Vec<Value>,
    resolves: Vec<Value>,
}

impl Main {
    fn new(tuning: Tuning) -> Main {
        let (sender, asks) = mpsc::unbounded_channel();
        let link = Link::new(tuning, move |ask| {
            let _ = sender.send(ask);
        });
        Main {
            link,
            asks,
            sessions: Sessions::default(),
            seq: 0,
            watching: false,
            during_resolve: Vec::new(),
            during_run: Vec::new(),
            run: Value::Null,
            calls: Vec::new(),
            resolves: Vec::new(),
        }
    }

    fn push(&mut self, push: Push) {
        self.seq += 1;
        let views = self.watching.then(|| self.sessions.0.clone());
        self.link.apply(self.seq, push, views);
    }

    fn apply(&mut self, op: &Op) {
        match op {
            Op::State(state) => self.sessions.set("t1", *state),
            Op::Remove => self.sessions.0.retain(|view| view.session != "t1"),
            Op::Fire(activity) => {
                if self.watching {
                    self.push(Push::Activity(activity.clone()));
                }
            }
            Op::Advance(_) => unreachable!("time passes outside main"),
        }
    }

    /// Answers every ask the core has sent so far.
    fn serve(&mut self) {
        while let Ok(ask) = self.asks.try_recv() {
            match ask {
                Ask::Watch { on } => {
                    self.watching = on;
                    if on {
                        self.push(Push::Views);
                    }
                }
                Ask::Poll => self.push(Push::Views),
                Ask::Release { .. } => {}
                Ask::Resolve { call, caller, name } => {
                    let name: String = serde_json::from_str(name.get()).unwrap();
                    self.resolves
                        .push(json!({ "caller": *caller, "name": name }));
                    for op in std::mem::take(&mut self.during_resolve) {
                        self.apply(&op);
                    }
                    let result = match self.sessions.get(&name) {
                        Some(view) => Ok(raw(view_json(view))),
                        None => Err(format!("No session \"{name}\" is open")),
                    };
                    self.push(Push::Reply {
                        call,
                        result,
                        began: None,
                    });
                }
                Ask::Run {
                    call,
                    caller,
                    tool,
                    args,
                } => {
                    let began = self.seq;
                    let tool: String = serde_json::from_str(tool.get()).unwrap();
                    let spelled = args
                        .as_ref()
                        .map_or_else(|| "undefined".to_owned(), |args| args.get().to_owned());
                    let args: Option<Value> =
                        args.map(|args| serde_json::from_str(args.get()).unwrap());
                    for op in std::mem::take(&mut self.during_run) {
                        self.apply(&op);
                    }
                    let outcome = match &self.run {
                        Value::String(never) if never == "never" => continue,
                        Value::String(_) => Err("boom".to_owned()),
                        Value::Object(_) => Ok(self.run.clone()),
                        _ if tool == "throw" => Err("boom".to_owned()),
                        _ if tool == "ompdesk_session_send" => {
                            Ok(json!({ "text": format!("sent {spelled}"), "isError": false }))
                        }
                        _ => Ok(
                            json!({ "text": format!("ran {tool} {spelled}"), "isError": tool == "fail" }),
                        ),
                    };
                    if let Ok(outcome) = &outcome {
                        let mut call = json!({
                            "caller": *caller, "tool": tool,
                            "text": outcome["text"], "isError": outcome["isError"],
                        });
                        if let Some(args) = args {
                            call["args"] = args;
                        }
                        self.calls.push(call);
                    }
                    self.push(Push::Reply {
                        call,
                        result: outcome.map(|outcome| {
                            raw(format!(
                                "{{\"text\":{},\"isError\":{}}}",
                                outcome["text"], outcome["isError"]
                            ))
                        }),
                        began: Some(began),
                    });
                }
            }
        }
    }
}

fn raw(text: String) -> Box<serde_json::value::RawValue> {
    serde_json::value::RawValue::from_string(text).unwrap()
}

/// Lets every task that can run now run to where it waits.
async fn settle() {
    for _ in 0..40 {
        tokio::task::yield_now().await;
    }
}

struct Nowhere;

impl Sink for Nowhere {
    fn write(&self, _line: String) -> bool {
        true
    }
}

/// A row of `waits` or `sends`: `[request, start, duringResolve, duringRun, run, after, response]`. The request runs
/// through the router while the stand-in main plays the script; `response` is what the TypeScript router answered at
/// the script's end, or `pending`.
async fn scenario(row: &Value) -> String {
    let mut main = Main::new(Tuning::default());
    main.sessions.add("t1", state_of(&row[1]));
    main.sessions.add("other", SessionState::Idle);
    main.during_resolve = ops(&row[2]);
    main.during_run = ops(&row[3]);
    main.run = if row[4].is_null() {
        json!({ "text": "sent", "isError": false })
    } else {
        row[4].clone()
    };
    let mut request = row[0].clone();
    request["id"] = json!(1);
    let frame = Frame::parse(&request.to_string()).unwrap();
    let connection = Connection {
        caller: Arc::new(Caller {
            id: "outside:cli#1".into(),
            name: "cli".into(),
            title: "outside process \"cli\" (self-declared)".into(),
            cwd: "/tmp".into(),
        }),
        number: 1,
        sink: Arc::new(Nowhere),
    };
    let mut answering = tokio::spawn(router::handle(
        Arc::clone(&main.link),
        connection,
        "1".into(),
        frame,
    ));
    // Asks are answered until none comes; time moves only where the script says.
    async fn quiesce(main: &mut Main) {
        loop {
            settle().await;
            if main.asks.is_empty() {
                return;
            }
            main.serve();
        }
    }
    quiesce(&mut main).await;
    for op in ops(&row[5]) {
        match op {
            Op::Advance(ms) => {
                // No state changes between beats: let main answer each poll before advancing farther.
                let mut left = ms;
                while left > 0 {
                    let step = left.min(500);
                    tokio::time::advance(Duration::from_millis(step)).await;
                    quiesce(&mut main).await;
                    left -= step;
                }
            }
            op => {
                main.apply(&op);
                quiesce(&mut main).await;
            }
        }
    }
    let answer = if answering.is_finished() {
        match (&mut answering).await.unwrap() {
            Ok(result) => conn::ok_line("1", &result),
            Err(failure) => conn::error_line("1", failure.code, &failure.message),
        }
        .trim_end()
        .to_owned()
    } else {
        "pending".to_owned()
    };
    // The connection closes: nothing of the request stays behind, and main is told to stop watching.
    if !answering.is_finished() {
        answering.abort();
        let _ = answering.await;
    }
    settle().await;
    main.serve();
    assert!(!main.watching, "main still watched after {row}");
    answer
}

async fn replay(table: &str, expected_rows: usize) {
    let rows = captured(table);
    assert_eq!(rows.len(), expected_rows);
    let mut wrong = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let answer = scenario(row).await;
        if answer != row[6].as_str().unwrap() {
            wrong.push(format!("{table}[{index}] {row}\n   got {answer}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} rows differ:\n{}",
        wrong.len(),
        rows.len(),
        wrong[..wrong.len().min(12)].join("\n")
    );
}

#[tokio::test(start_paused = true)]
async fn waits_answer_as_the_typescript_router_did() {
    replay("waits", 487).await;
}

#[tokio::test(start_paused = true)]
async fn sends_answer_as_the_typescript_router_did() {
    replay("sends", 907).await;
}

/// `<DIR>` and `<HOME>` in a captured row are a real folder and the caller's home here.
fn placed(text: &str, dir: &str, home: &str, json_depth: usize) -> String {
    let spell = |path: &str| {
        let mut spelled = path.to_owned();
        for _ in 0..json_depth {
            let quoted = serde_json::to_string(&spelled).unwrap();
            spelled = quoted[1..quoted.len() - 1].to_owned();
        }
        spelled
    };
    text.replace("<DIR>", &spell(dir))
        .replace("<HOME>", &spell(home))
}

fn place_value(value: &Value, dir: &str, home: &str) -> Value {
    serde_json::from_str(&placed(&value.to_string(), dir, home, 1)).unwrap()
}

/// What a connection gets back, line for line, and what main was asked: 120 scripts through the TypeScript server
/// (the hello and every refusal of it, both frame limits, every shape of a bad request, each method's checks in the
/// order they were made, ids and numbers as JavaScript spelled them).
#[tokio::test]
async fn a_connection_gets_what_the_typescript_server_wrote() {
    let rows = captured("lines");
    assert_eq!(rows.len(), 120);
    let dir = make_temp_dir("ompdesk-core-lines-").unwrap();
    let dir_text = dir.to_string_lossy().into_owned();
    let home = "/the/home";
    let token = "5".repeat(64);
    let mut wrong = Vec::new();
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        let mut main = Main::new(Tuning::default());
        for (session, state) in [
            ("t1", SessionState::Idle),
            ("t2", SessionState::Blocked),
            ("t3", SessionState::Stopped),
            ("t4", SessionState::Working),
        ] {
            main.sessions.add(session, state);
        }
        let serving = Serving {
            link: Arc::clone(&main.link),
            token: token.as_str().into(),
            home: home.into(),
            caller_prefix: "".into(),
            hello_timeout: Duration::from_secs(10),
            max_in_flight: 16,
            half_close: true,
        };
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let (shutdown, closed) = watch::channel(false);
        let serving_task = tokio::spawn(conn::serve(serving, 1, server_read, server_write, closed));
        let (mut client_read, mut client_write) = tokio::io::split(client);
        // Everything the server writes, as it comes.
        let got = Arc::new(Mutex::new((Vec::<u8>::new(), false)));
        let reading = {
            let got = Arc::clone(&got);
            tokio::spawn(async move {
                let mut chunk = [0u8; 4096];
                loop {
                    match client_read.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => got.lock().unwrap().0.extend_from_slice(&chunk[..count]),
                    }
                }
                got.lock().unwrap().1 = true;
            })
        };
        let lines = |got: &Arc<Mutex<(Vec<u8>, bool)>>| -> Vec<String> {
            let bytes = got.lock().unwrap().0.clone();
            let text = String::from_utf8(bytes).unwrap();
            let whole = text.rfind('\n').map_or(0, |end| end + 1);
            text[..whole].lines().map(str::to_owned).collect()
        };
        let sends = row["sends"].as_array().unwrap();
        let mut ended = false;
        for (index, send) in sends.iter().enumerate() {
            let bytes = match send {
                Value::String(line) => format!("{}\n", placed(line, &dir_text, home, 1)),
                send if send.get("repeat").is_some() => send["repeat"][0]
                    .as_str()
                    .unwrap()
                    .repeat(send["repeat"][1].as_u64().unwrap() as usize),
                send => {
                    let text = send["padded"][0].as_str().unwrap();
                    let width = send["padded"][1].as_u64().unwrap() as usize;
                    format!("{text}{}\n", " ".repeat(width - text.len()))
                }
            };
            // A server that hung up no longer reads: the rest of an oversize line goes nowhere.
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                client_write.write_all(bytes.as_bytes()),
            )
            .await;
            // Each send is answered before the next goes out, as the capture waited.
            let answered = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    main.serve();
                    if lines(&got).len() > index || got.lock().unwrap().1 {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await;
            assert!(answered.is_ok(), "{name}: no answer to send {index}");
            if got.lock().unwrap().1 {
                ended = true;
                break;
            }
        }
        // The server ends its side after a refusal; otherwise the connection stays open.
        if !ended {
            ended = tokio::time::timeout(Duration::from_millis(30), async {
                while !got.lock().unwrap().1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .is_ok();
        }
        let expected_lines: Vec<String> = row["responses"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|line| line.as_str().map(str::to_owned))
            .collect();
        if lines(&got) != expected_lines {
            wrong.push(format!(
                "{name}: wrote {:?}\n   expected {expected_lines:?}",
                lines(&got)
            ));
        }
        if ended != row["closed"].as_bool().unwrap() {
            wrong.push(format!("{name}: closed {ended}"));
        }
        let calls = place_value(&row["calls"], &dir_text, home);
        if Value::Array(main.calls.clone()) != calls {
            wrong.push(format!(
                "{name}: called {:?}\n   expected {calls}",
                main.calls
            ));
        }
        let resolves = place_value(&row["resolves"], &dir_text, home);
        if Value::Array(main.resolves.clone()) != resolves {
            wrong.push(format!("{name}: resolved {:?}", main.resolves));
        }
        shutdown.send_replace(true);
        drop(client_write);
        serving_task.await.unwrap();
        reading.abort();
    }
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
        wrong.is_empty(),
        "{} differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

/// `outsideCaller`: the name a process may give itself, and where it starts.
#[test]
fn names_a_caller_as_the_typescript_did() {
    let rows = captured("callers");
    assert_eq!(rows.len(), 24);
    let dir = make_temp_dir("ompdesk-core-callers-").unwrap();
    let file = dir.join("file");
    std::fs::write(&file, "x").unwrap();
    let missing = dir.join("missing");
    let home = "/the/home";
    let place = |value: &Value| -> Value {
        let text = value
            .to_string()
            .replace("<MISSING>", &spelled(&missing.to_string_lossy()))
            .replace("<FILE>", &spelled(&file.to_string_lossy()));
        serde_json::from_str(&placed(&text, &dir.to_string_lossy(), home, 1)).unwrap()
    };
    for row in rows {
        let hello = Frame::parse(&place(&row[0]).to_string()).unwrap();
        let caller = conn::outside_caller(&hello, row[1].as_u64().unwrap(), home);
        assert_eq!(json!(caller), place(&row[2]), "{}", row[0]);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

/// A path as JSON spells it inside a string.
fn spelled(path: &str) -> String {
    let quoted = serde_json::to_string(path).unwrap();
    quoted[1..quoted.len() - 1].to_owned()
}

/// Main's pushes are applied in their numbers' order, whatever order their requests ran in.
#[tokio::test(start_paused = true)]
async fn applies_pushes_in_the_order_main_sent_them() {
    let main = Main::new(Tuning::default());
    let link = Arc::clone(&main.link);
    let watching = link.watch();
    watching.bind("t1");
    let view = |state| {
        Some(vec![View {
            session: "t1".into(),
            title: "t".into(),
            state,
        }])
    };
    let activity = |kind: &str| {
        Push::Activity(Activity {
            kind: kind.into(),
            tab_id: "t1".into(),
            request_id: None,
            text: None,
            stop_reason: None,
        })
    };
    // The later push's request runs first.
    let second = tokio::spawn({
        let link = Arc::clone(&link);
        let views = view(SessionState::Idle);
        let push = activity("idle");
        async move { link.push(2, push, views).await }
    });
    settle().await;
    assert!(!second.is_finished());
    link.push(1, activity("busy"), view(SessionState::Working))
        .await
        .unwrap();
    second.await.unwrap().unwrap();
    let kinds = link.look(&watching, |look| {
        (
            look.since(0)
                .map(|step| (step.seq, step.kind))
                .collect::<Vec<_>>(),
            look.view().map(|view| view.state),
        )
    });
    assert_eq!(
        kinds,
        (
            vec![
                (1, super::link::StepKind::Working),
                (2, super::link::StepKind::Ended)
            ],
            Some(SessionState::Idle)
        )
    );
    // A number main skipped never gets its turn: the push fails instead of holding its request.
    let skipped = link.push(5, activity("busy"), None).await.unwrap_err();
    assert_eq!(skipped.code, "out_of_order");
}

/// Main is asked to watch only while a wait runs or somebody is subscribed, and told when the last one went.
#[tokio::test(start_paused = true)]
async fn asks_main_to_watch_only_while_somebody_needs_it() {
    let mut main = Main::new(Tuning::default());
    let link = Arc::clone(&main.link);
    let asked = |main: &mut Main| -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(ask) = main.asks.try_recv() {
            out.push(match ask {
                Ask::Watch { on } => format!("watch {on}"),
                Ask::Poll => "poll".into(),
                other => format!("{other:?}"),
            });
        }
        out
    };
    assert!(asked(&mut main).is_empty());
    let first = link.watch();
    let second = link.watch();
    assert_eq!(asked(&mut main), ["watch true"]);
    drop(first);
    assert!(asked(&mut main).is_empty());
    link.subscribe(7, "outside:cli#7", "3", Arc::new(Nowhere));
    drop(second);
    assert!(asked(&mut main).is_empty());
    settle().await;
    // A subscriber alone keeps the watch, and the sessions are asked for on its beat.
    tokio::time::advance(Duration::from_millis(1_000)).await;
    settle().await;
    assert_eq!(asked(&mut main), ["poll"]);
    link.unsubscribe(7);
    assert_eq!(asked(&mut main), ["watch false"]);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    settle().await;
    assert!(asked(&mut main).is_empty());
}
