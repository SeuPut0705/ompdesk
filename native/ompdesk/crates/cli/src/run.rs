//! `run`: one invocation, from argv to an exit code, with the rendering of results and the `events` loop.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;

use serde_json::{Map, Value, json};

use crate::args::{Command, RunCommand, help_text, parse, spec};
use crate::conn::{Conn, Frame, gone, is_response_to};
use crate::endpoint::read_endpoint;
use crate::number::{is_js_space, js_string};
use crate::protocol::{CONTROL_CALLER_ENV, CONTROL_PROTOCOL_VERSION, is_caller_name};

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_NOT_RUNNING: i32 = 3;

pub struct Io<'a> {
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
    pub stdin: &'a mut dyn Read,
    pub env: HashMap<String, String>,
    /// `process.platform`: `darwin`, `win32`, `linux`.
    pub platform: &'static str,
    pub home: PathBuf,
    pub cwd: String,
    /// This user's uid; `None` skips the owner comparison (Windows, where nothing reads it).
    #[cfg_attr(not(unix), allow(dead_code))]
    pub uid: Option<u32>,
    /// `events` installs the process's Ctrl-C handler (exit 0); in-process tests leave it off.
    pub exit_on_interrupt: bool,
}

fn put(w: &mut dyn Write, text: &str) {
    let _ = w.write_all(text.as_bytes());
}

fn line(text: String) -> String {
    if text.ends_with('\n') {
        text
    } else {
        text + "\n"
    }
}

/// `JSON.stringify`, with `undefined` for a missing value.
fn stringify(value: Option<&Value>) -> String {
    value.map_or_else(
        || "undefined".into(),
        |v| serde_json::to_string(v).unwrap_or_default(),
    )
}

/// A value as a template literal shows it.
fn js_str(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map_or_else(|| n.to_string(), js_string),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_str(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn field<'v>(value: Option<&'v Value>, key: &str) -> Option<&'v Value> {
    value.and_then(|v| v.get(key))
}

/// `.replace(/\s+/g, " ")`.
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

fn status(s: Option<&Value>) -> String {
    format!(
        "{}  {}  {}",
        js_str(field(s, "session")),
        js_str(field(s, "state")),
        js_str(field(s, "title"))
    )
}

fn waited(w: Option<&Value>) -> String {
    let stop = field(w, "stopReason");
    let stop = if truthy(stop) {
        format!(", stop reason {}", js_str(stop))
    } else {
        String::new()
    };
    format!("{}  ({}{stop})", status(w), js_str(field(w, "matched")))
}

pub fn format_event(event: Option<&Value>) -> String {
    let get = |key| js_str(field(event, key));
    match field(event, "type").and_then(Value::as_str) {
        Some("session_state") => {
            let previous = match field(event, "previous") {
                None | Some(Value::Null) => "-".into(),
                previous => js_str(previous),
            };
            format!(
                "session_state {} {previous} -> {}  {}",
                get("session"),
                get("state"),
                get("title")
            )
        }
        Some("ask") => format!(
            "ask {} {}  {}: {}",
            get("session"),
            get("requestId"),
            get("title"),
            one_line(&get("text"))
        ),
        Some("turn_finished") => {
            format!(
                "turn_finished {} {}  {}",
                get("session"),
                get("stopReason"),
                get("title")
            )
        }
        Some("session_closed") => format!("session_closed {}", get("session")),
        Some("report") => format!("report to {}: {}", get("to"), one_line(&get("text"))),
        _ => "undefined".into(),
    }
}

fn render(method: &str, result: Option<&Value>) -> String {
    match method {
        "tool" => js_str(field(result, "text")),
        "state" => status(result),
        "wait" => waited(result),
        "send" if truthy(field(result, "waited")) => format!(
            "{}\n{}",
            js_str(field(result, "receipt")),
            waited(field(result, "waited"))
        ),
        "send" => js_str(field(result, "receipt")),
        _ => stringify(result),
    }
}

fn set_path(target: &mut Map<String, Value>, path: &[&str], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut at = target;
    for part in parents {
        let next = at.entry(*part).or_insert(Value::Null);
        if !next.is_object() {
            *next = Value::Object(Map::new());
        }
        let Value::Object(next) = next else {
            return;
        };
        at = next;
    }
    at.insert((*last).into(), value);
}

/// The error path: `{ok:false,error}` on stdout with `--json`, `code: message` on stderr.
fn failure(io: &mut Io, json: bool, error: Option<&Value>) -> i32 {
    if json {
        let shown = match error {
            Some(error) => json!({ "ok": false, "error": error }),
            None => json!({ "ok": false }),
        };
        put(io.stdout, &format!("{shown}\n"));
    }
    let code = field(error, "code");
    put(
        io.stderr,
        &format!(
            "ompdesk: {}: {}\n",
            js_str(code),
            js_str(field(error, "message"))
        ),
    );
    match code.and_then(Value::as_str) {
        Some("unauthorized" | "protocol_mismatch") => EXIT_NOT_RUNNING,
        _ => EXIT_FAILED,
    }
}

fn not_running(io: &mut Io, json: bool, message: &str) -> i32 {
    put(io.stderr, &format!("ompdesk: {message}\n"));
    if json {
        put(
            io.stdout,
            "{\"ok\":false,\"error\":{\"code\":\"unavailable\",\"message\":\"OMPdesk is not running\"}}\n",
        );
    }
    EXIT_NOT_RUNNING
}

pub fn run(argv: &[String], io: &mut Io) -> i32 {
    let command = match parse(argv) {
        Command::Usage(message) => {
            put(
                io.stderr,
                &format!("ompdesk: {message}\nRun `ompdesk help` for the commands.\n"),
            );
            return EXIT_USAGE;
        }
        Command::Help(topic) => {
            put(io.stdout, &help_text(topic.as_deref()));
            return match topic {
                Some(topic) if topic != "help" && spec(&topic).is_none() => EXIT_USAGE,
                _ => EXIT_OK,
            };
        }
        Command::Run(command) => command,
    };
    let mut body = command.body.clone();
    if let Some(target) = command.stdin {
        let mut bytes = Vec::new();
        let _ = io.stdin.read_to_end(&mut bytes);
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        let value = if target.json {
            match crate::json::parse(text.as_bytes()) {
                Some(value) => value,
                None => {
                    put(io.stderr, "ompdesk: stdin is not valid JSON\n");
                    return EXIT_USAGE;
                }
            }
        } else {
            if text.ends_with('\n') {
                text.pop();
            }
            Value::String(text)
        };
        set_path(&mut body, target.path, value);
    }

    let mut conn = match connect(&command, io) {
        Ok(conn) => conn,
        Err(Opened::Refused(message)) => return not_running(io, command.json, &message),
        Err(Opened::HelloFailed(response)) => {
            return failure(io, command.json, response.get("error"));
        }
    };
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if method == "subscribe" {
        return follow(&mut conn, body, &command, io);
    }
    let response = conn.request(body);
    if !truthy(response.get("ok")) {
        return failure(io, command.json, response.get("error"));
    }
    let result = response.get("result");
    if command.json {
        put(io.stdout, &format!("{}\n", stringify(result)));
    }
    if method == "tool" && truthy(field(result, "isError")) {
        put(
            io.stderr,
            &line(format!("ompdesk: {}", js_str(field(result, "text")))),
        );
        return EXIT_FAILED;
    }
    if !command.json {
        put(io.stdout, &line(render(&method, result)));
    }
    EXIT_OK
}

enum Opened {
    Refused(String),
    HelloFailed(Frame),
}

fn connect(command: &RunCommand, io: &Io) -> Result<Conn, Opened> {
    let endpoint = read_endpoint(command.socket.as_deref(), io).map_err(Opened::Refused)?;
    let mut conn = Conn::open(&endpoint.path)
        .map_err(|e| Opened::Refused(format!("OMPdesk is not running ({e})")))?;
    let caller = command
        .caller
        .as_deref()
        .or(io.env.get(CONTROL_CALLER_ENV).map(String::as_str))
        .filter(|name| is_caller_name(name));
    let mut hello = Map::new();
    hello.insert("method".into(), "hello".into());
    hello.insert("token".into(), endpoint.token.into());
    hello.insert("protocol".into(), CONTROL_PROTOCOL_VERSION.into());
    if let Some(caller) = caller {
        hello.insert("caller".into(), caller.into());
    }
    hello.insert("cwd".into(), io.cwd.clone().into());
    let response = conn.request(hello);
    if truthy(response.get("ok")) {
        Ok(conn)
    } else {
        Err(Opened::HelloFailed(response))
    }
}

/// `events`: one line per event frame until an error frame, the end of the stream, or Ctrl-C (exit 0).
fn follow(conn: &mut Conn, body: Frame, command: &RunCommand, io: &mut Io) -> i32 {
    if io.exit_on_interrupt {
        crate::sys::exit_on_interrupt();
    }
    let id = conn.send(body);
    let mut answered = false;
    while let Some(frame) = id.and_then(|_| conn.next_frame()) {
        if frame.contains_key("sub") {
            if let Some(error) = frame.get("error") {
                let lost = match (
                    field(Some(error), "code").and_then(Value::as_str),
                    error.get("lost"),
                ) {
                    (Some("events_lost"), Some(lost)) => format!(" ({} lost)", js_str(Some(lost))),
                    _ => String::new(),
                };
                let mut shown = Map::new();
                if let Some(code) = error.get("code") {
                    shown.insert("code".into(), code.clone());
                }
                shown.insert(
                    "message".into(),
                    (js_str(error.get("message")) + &lost).into(),
                );
                return failure(io, command.json, Some(&Value::Object(shown)));
            }
            let event = frame.get("event");
            let text = if command.json {
                stringify(event)
            } else {
                format_event(event)
            };
            // Nobody reads the events any more (`ompdesk events | head`): stop instead of running on unseen.
            let line = format!("{text}\n");
            if io
                .stdout
                .write_all(line.as_bytes())
                .and_then(|()| io.stdout.flush())
                .is_err()
            {
                return EXIT_OK;
            }
        } else if let Some(id) = id
            && is_response_to(&frame, id)
        {
            answered = true;
            if !truthy(frame.get("ok")) {
                return failure(io, command.json, frame.get("error"));
            }
        }
    }
    put(io.stderr, "ompdesk: OMPdesk closed the connection\n");
    if !answered {
        let response = gone(id.unwrap_or(0));
        failure(io, command.json, response.get("error"));
    }
    EXIT_NOT_RUNNING
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_each_event() {
        let cases = [
            (
                json!({ "type": "session_state", "session": "s", "title": "T", "state": "idle", "previous": null }),
                "session_state s - -> idle  T",
            ),
            (
                json!({ "type": "session_state", "session": "s", "title": "T", "state": "idle", "previous": "working" }),
                "session_state s working -> idle  T",
            ),
            (
                json!({ "type": "ask", "session": "s", "title": "T", "requestId": "r", "text": "pick\n  one\tplease" }),
                "ask s r  T: pick one please",
            ),
            (
                json!({ "type": "turn_finished", "session": "s", "title": "T", "stopReason": "stop" }),
                "turn_finished s stop  T",
            ),
            (
                json!({ "type": "session_closed", "session": "s" }),
                "session_closed s",
            ),
            (
                json!({ "type": "report", "to": "p", "text": "done\n\nall" }),
                "report to p: done all",
            ),
            (json!({ "type": "other" }), "undefined"),
        ];
        for (event, want) in cases {
            assert_eq!(format_event(Some(&event)), want);
        }
    }

    #[test]
    fn renders_results() {
        let wait = json!({ "session": "s", "title": "T", "state": "idle", "matched": "settled", "stopReason": "stop" });
        assert_eq!(
            render("wait", Some(&wait)),
            "s  idle  T  (settled, stop reason stop)"
        );
        let sent = json!({ "receipt": "queued", "waited": { "session": "s", "title": "T", "state": "blocked", "matched": "blocked" } });
        assert_eq!(
            render("send", Some(&sent)),
            "queued\ns  blocked  T  (blocked)"
        );
        assert_eq!(
            render(
                "state",
                Some(&json!({ "session": "s", "title": 5, "state": "idle" }))
            ),
            "s  idle  5"
        );
    }

    #[test]
    fn sets_a_nested_path() {
        let mut body = Map::new();
        body.insert("args".into(), 1.into());
        set_path(&mut body, &["args", "a", "b"], "x".into());
        assert_eq!(
            Value::Object(body),
            json!({ "args": { "a": { "b": "x" } } })
        );
    }
}

#[cfg(all(test, unix))]
mod end_to_end {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread::JoinHandle;
    use std::{fs, process};

    struct Fake {
        dir: PathBuf,
        socket: PathBuf,
        server: JoinHandle<Vec<Value>>,
    }

    /// A server speaking the protocol: `reply` gives the lines that answer each request after `hello`.
    fn serve(token: &'static str, reply: impl Fn(&Value) -> Vec<Value> + Send + 'static) -> Fake {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-cli-{}-{}",
            process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = dir.join("s.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(
            dir.join("endpoint.json"),
            json!({ "version": 1, "socket": socket, "pid": process::id() }).to_string(),
        )
        .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(dir.join("token"))
            .and_then(|mut f| f.write_all(b"tok\n"))
            .unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut seen = Vec::new();
            for text in BufReader::new(stream).lines() {
                let Ok(text) = text else { break };
                let request: Value = serde_json::from_str(&text).unwrap();
                seen.push(request.clone());
                let id = request["id"].clone();
                let answers = if request["method"] == "hello" {
                    if request["token"] == token {
                        vec![json!({ "id": id, "ok": true, "result": {} })]
                    } else {
                        vec![
                            json!({ "id": id, "ok": false, "error": { "code": "unauthorized", "message": "bad token" } }),
                        ]
                    }
                } else {
                    reply(&request)
                };
                for answer in answers {
                    if writeln!(writer, "{answer}").is_err() {
                        break;
                    }
                }
            }
            seen
        });
        Fake {
            dir,
            socket,
            server,
        }
    }

    impl Fake {
        fn finish(self) -> Vec<Value> {
            let seen = self.server.join().unwrap();
            let _ = fs::remove_dir_all(&self.dir);
            seen
        }
    }

    struct Ran {
        code: i32,
        out: String,
        err: String,
    }

    fn invoke(argv: &[&str], dir: &Path, env: &[(&str, &str)], uid: Option<u32>) -> Ran {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let mut stdin: &[u8] = b"from stdin\n";
        let mut vars: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        vars.insert("OMPDESK_CONTROL_DIR".into(), dir.display().to_string());
        let argv: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
        let code = run(
            &argv,
            &mut Io {
                stdout: &mut out,
                stderr: &mut err,
                stdin: &mut stdin,
                env: vars,
                platform: if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    "linux"
                },
                home: dir.to_path_buf(),
                cwd: dir.display().to_string(),
                uid,
                exit_on_interrupt: false,
            },
        );
        Ran {
            code,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
        }
    }

    fn me() -> Option<u32> {
        crate::sys::uid()
    }

    fn answer(result: Value) -> impl Fn(&Value) -> Vec<Value> + Send + 'static {
        move |request| vec![json!({ "id": request["id"], "ok": true, "result": result })]
    }

    #[test]
    fn prints_a_tools_text_and_sends_the_caller_and_cwd() {
        let fake = serve(
            "tok",
            answer(json!({ "text": "two sessions", "isError": false })),
        );
        let dir = fake.dir.clone();
        let ran = invoke(
            &["sessions", "--limit", "5"],
            &dir,
            &[("OMPDESK_CALLER", "ci")],
            me(),
        );
        let seen = fake.finish();
        assert_eq!(
            (ran.code, ran.out.as_str(), ran.err.as_str()),
            (0, "two sessions\n", "")
        );
        assert_eq!(
            seen,
            vec![
                json!({ "method": "hello", "token": "tok", "protocol": 1, "caller": "ci", "cwd": dir.display().to_string(), "id": 1 }),
                json!({ "method": "tool", "tool": "ompdesk_sessions", "args": { "limit": 5 }, "id": 2 }),
            ]
        );
        assert_eq!(
            serde_json::to_string(&seen[1]).unwrap(),
            r#"{"method":"tool","tool":"ompdesk_sessions","args":{"limit":5},"id":2}"#
        );
    }

    #[test]
    fn shows_an_error_response_with_json() {
        let fake = serve("tok", |request| {
            vec![
                json!({ "id": request["id"], "ok": false, "error": { "code": "agent_blocked", "message": "waits on the person" } }),
            ]
        });
        let ran = invoke(&["send", "s", "hi", "--json"], &fake.dir.clone(), &[], me());
        fake.finish();
        assert_eq!(ran.code, 1);
        assert_eq!(
            ran.out,
            "{\"ok\":false,\"error\":{\"code\":\"agent_blocked\",\"message\":\"waits on the person\"}}\n"
        );
        assert_eq!(ran.err, "ompdesk: agent_blocked: waits on the person\n");
    }

    #[test]
    fn exits_3_when_the_token_is_refused() {
        let fake = serve("other", answer(json!({})));
        let ran = invoke(&["sessions"], &fake.dir.clone(), &[], me());
        let seen = fake.finish();
        assert_eq!((ran.code, ran.out.as_str()), (3, ""));
        assert_eq!(ran.err, "ompdesk: unauthorized: bad token\n");
        assert_eq!(seen.len(), 1);
    }

    #[test]
    fn exits_1_when_the_tool_reports_a_failure() {
        let fake = serve(
            "tok",
            answer(json!({ "text": "no such session", "isError": true })),
        );
        let ran = invoke(&["merge", "x", "--json"], &fake.dir.clone(), &[], me());
        fake.finish();
        assert_eq!(ran.code, 1);
        assert_eq!(ran.out, "{\"text\":\"no such session\",\"isError\":true}\n");
        assert_eq!(ran.err, "ompdesk: no such session\n");
    }

    #[test]
    fn reads_a_message_from_stdin() {
        let fake = serve("tok", answer(json!({ "receipt": "queued" })));
        let ran = invoke(&["send", "s1", "-"], &fake.dir.clone(), &[], me());
        let seen = fake.finish();
        assert_eq!(
            (ran.code, ran.out.as_str(), ran.err.as_str()),
            (0, "queued\n", "")
        );
        assert_eq!(
            serde_json::to_string(&seen[1]).unwrap(),
            r#"{"method":"send","session":"s1","message":"from stdin","id":2}"#
        );
    }

    #[test]
    fn prints_the_raw_result_with_json() {
        let fake = serve("tok", |request| {
            let text = format!(
                r#"{{"id":{},"ok":true,"result":{{"z":1.50,"a":[100]}}}}"#,
                request["id"]
            );
            vec![serde_json::from_str(&text).unwrap()]
        });
        let ran = invoke(&["state", "s", "--json"], &fake.dir.clone(), &[], me());
        fake.finish();
        assert_eq!(
            (ran.code, ran.out.as_str()),
            (0, "{\"z\":1.50,\"a\":[100]}\n")
        );
    }

    #[test]
    fn streams_events_until_events_lost() {
        let fake = serve("tok", |request| {
            let id = &request["id"];
            vec![
                json!({ "sub": id, "seq": 1, "event": { "type": "turn_finished", "session": "s", "title": "T", "stopReason": "stop" } }),
                json!({ "id": id, "ok": true, "result": {} }),
                json!({ "sub": id, "error": { "code": "events_lost", "message": "too slow", "lost": 4 } }),
            ]
        });
        let ran = invoke(&["events"], &fake.dir.clone(), &[], me());
        fake.finish();
        assert_eq!(ran.code, 1);
        assert_eq!(ran.out, "turn_finished s stop  T\n");
        assert_eq!(ran.err, "ompdesk: events_lost: too slow (4 lost)\n");
    }

    #[test]
    fn never_sends_the_token_to_another_users_socket() {
        let fake = serve("tok", answer(json!({})));
        let ran = invoke(&["sessions"], &fake.dir.clone(), &[], me().map(|u| u + 1));
        drop(UnixStream::connect(&fake.socket).unwrap());
        let seen = fake.finish();
        assert_eq!(ran.code, 3);
        assert!(
            ran.err.starts_with("ompdesk: refused: socket folder "),
            "{}",
            ran.err
        );
        assert_eq!(seen, Vec::<Value>::new());
    }

    #[test]
    fn refuses_in_a_session_hosted_for_another_device() {
        let fake = serve("tok", answer(json!({})));
        let ran = invoke(
            &["sessions", "--json"],
            &fake.dir.clone(),
            &[("OMPDESK_CONTROL_OFF", "1")],
            me(),
        );
        drop(UnixStream::connect(&fake.socket).unwrap());
        assert_eq!(fake.finish(), Vec::<Value>::new());
        assert_eq!(ran.code, 3);
        assert!(ran.err.contains("another device"));
        assert_eq!(
            ran.out,
            "{\"ok\":false,\"error\":{\"code\":\"unavailable\",\"message\":\"OMPdesk is not running\"}}\n"
        );
    }

    #[test]
    fn exits_3_when_not_running() {
        let dir = std::env::temp_dir().join(format!("ompdesk-cli-none-{}", process::id()));
        let ran = invoke(&["sessions"], &dir, &[], me());
        assert_eq!(ran.code, 3);
        assert!(ran.err.contains("not running"));
    }
}
