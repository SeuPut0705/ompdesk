//! The command table and `parse`: argv to a request body, with node `util.parseArgs` strict semantics.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::number::{is_integer, js_number, js_trim, to_json};
use crate::protocol::WAIT_UNTIL;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// A string.
    S,
    /// A boolean.
    B,
    /// A non-negative finite number.
    N,
    /// A string given any number of times.
    M,
}

/// `-` was given: `run` reads stdin and puts it at `path` of the body (parsed as JSON when `json`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StdinTarget {
    pub path: &'static [&'static str],
    pub json: bool,
}

#[derive(Clone, PartialEq, Debug)]
pub struct RunCommand {
    pub body: Map<String, Value>,
    pub stdin: Option<StdinTarget>,
    pub socket: Option<String>,
    pub caller: Option<String>,
    pub json: bool,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Command {
    Help(Option<String>),
    Run(RunCommand),
    Usage(String),
}

#[derive(Clone, Debug)]
enum Flag {
    Str(String),
    Bool,
    Num(f64),
    List(Vec<String>),
}

struct Parsed {
    v: HashMap<&'static str, Flag>,
    pos: Vec<String>,
}

impl Parsed {
    fn str(&self, flag: &str) -> Option<&str> {
        match self.v.get(flag) {
            Some(Flag::Str(s)) => Some(s),
            _ => None,
        }
    }
    fn bool(&self, flag: &str) -> bool {
        matches!(self.v.get(flag), Some(Flag::Bool))
    }
    fn num(&self, flag: &str) -> Option<f64> {
        match self.v.get(flag) {
            Some(Flag::Num(n)) => Some(*n),
            _ => None,
        }
    }
    fn list(&self, flag: &str) -> Option<&[String]> {
        match self.v.get(flag) {
            Some(Flag::List(l)) => Some(l),
            _ => None,
        }
    }
    fn json(&self, flag: &str) -> Option<Value> {
        Some(match self.v.get(flag)? {
            Flag::Str(s) => Value::String(s.clone()),
            Flag::Bool => Value::Bool(true),
            Flag::Num(n) => to_json(*n),
            Flag::List(l) => json!(l),
        })
    }
    /// The named flags that were given, as a tool's args (flag `every-minutes` is `every_minutes`).
    fn args(&self, names: &[&str]) -> Map<String, Value> {
        let mut out = Map::new();
        self.args_into(&mut out, names);
        out
    }
    fn args_into(&self, out: &mut Map<String, Value>, names: &[&str]) {
        for name in names {
            if let Some(value) = self.json(name) {
                out.insert(name.replace('-', "_"), value);
            }
        }
    }
    fn pos(&self, at: usize) -> Option<&str> {
        self.pos.get(at).map(String::as_str)
    }
}

struct Built {
    body: Map<String, Value>,
    stdin: Option<StdinTarget>,
}

type Build = fn(&Parsed) -> Result<Built, String>;

pub struct Spec {
    pub name: &'static str,
    pub usage: &'static str,
    pub summary: &'static str,
    flags: &'static [(&'static str, Kind)],
    min: usize,
    max: usize,
    build: Build,
}

fn body(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn tool(name: &str, args: impl Into<Value>) -> Built {
    Built {
        body: body(json!({ "method": "tool", "tool": name, "args": args.into() })),
        stdin: None,
    }
}

fn with_stdin(mut built: Built, path: &'static [&'static str], json: bool) -> Built {
    built.stdin = Some(StdinTarget { path, json });
    built
}

fn one_of(value: Option<&str>, allowed: &[&str], flag: &str) -> Result<(), String> {
    match value {
        Some(v) if !allowed.contains(&v) => {
            Err(format!("--{flag} is one of {}", allowed.join(", ")))
        }
        _ => Ok(()),
    }
}

fn parse_json(text: &str, what: &str) -> Result<Value, String> {
    crate::json::parse(text.as_bytes()).ok_or_else(|| format!("{what} is not valid JSON"))
}

/// node's wording for an option `parseArgs` does not know (its closing quote is missing there too).
fn unknown_option(shown: &str) -> String {
    format!(
        "Unknown option '{shown}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{shown}\""
    )
}

/// A positional that may be `-` (read stdin): otherwise the value goes into the tool's args at `field`.
fn text_arg(
    value: Option<&str>,
    name: &str,
    mut args: Map<String, Value>,
    path: &'static [&'static str],
) -> Built {
    match value {
        Some("-") => with_stdin(tool(name, args), path, false),
        Some(v) => {
            args.insert(path[path.len() - 1].into(), v.into());
            tool(name, args)
        }
        None => tool(name, args),
    }
}

fn session(p: &Parsed) -> Map<String, Value> {
    let mut a = Map::new();
    a.insert("session".into(), p.pos(0).unwrap_or_default().into());
    a
}

fn build_sessions(p: &Parsed) -> Result<Built, String> {
    one_of(p.str("scope"), &["window", "app", "stored"], "scope")?;
    one_of(p.str("status"), &["running", "waiting", "idle"], "status")?;
    Ok(tool(
        "ompdesk_sessions",
        p.args(&[
            "scope", "device", "folder", "status", "mine", "query", "limit",
        ]),
    ))
}

fn build_open(p: &Parsed) -> Result<Built, String> {
    one_of(p.str("mode"), &["plan", "goal"], "mode")?;
    one_of(
        p.str("show"),
        &["background", "focus", "split-right", "split-down"],
        "show",
    )?;
    let mut a = p.args(&[
        "folder", "device", "model", "mode", "reopen", "restore", "show",
    ]);
    let (branch, base) = (p.str("branch"), p.str("base"));
    if branch.is_some() || base.is_some() {
        let mut worktree = Map::new();
        if let Some(branch) = branch {
            worktree.insert("branch".into(), branch.into());
        }
        if let Some(base) = base {
            worktree.insert("base".into(), base.into());
        }
        a.insert("worktree".into(), worktree.into());
    } else if p.bool("worktree") {
        a.insert("worktree".into(), true.into());
    }
    Ok(text_arg(
        p.pos(0),
        "ompdesk_session_open",
        a,
        &["args", "message"],
    ))
}

fn wait_fields(out: &mut Map<String, Value>, until: Option<&str>, timeout: Option<f64>) {
    if let Some(until) = until {
        out.insert("until".into(), until.into());
    }
    if let Some(timeout) = timeout {
        out.insert("timeoutMs".into(), to_json(timeout * 1000.0));
    }
}

fn build_send(p: &Parsed) -> Result<Built, String> {
    let until = p.str("until");
    one_of(until, WAIT_UNTIL, "until")?;
    let timeout = p.num("timeout");
    let stdin = p.pos(1) == Some("-");
    let mut b = Map::new();
    b.insert("method".into(), "send".into());
    b.insert("session".into(), p.pos(0).unwrap_or_default().into());
    b.insert(
        "message".into(),
        if stdin {
            ""
        } else {
            p.pos(1).unwrap_or_default()
        }
        .into(),
    );
    if p.bool("steer") {
        b.insert("delivery".into(), "steer".into());
    }
    if let Some(id) = p.str("request-id") {
        b.insert("requestId".into(), id.into());
    }
    if p.bool("force") {
        b.insert("force".into(), true.into());
    }
    if p.bool("wait") || until.is_some() || timeout.is_some() {
        let mut wait = Map::new();
        wait_fields(&mut wait, until, timeout);
        b.insert("wait".into(), wait.into());
    }
    let built = Built {
        body: b,
        stdin: None,
    };
    Ok(if stdin {
        with_stdin(built, &["message"], false)
    } else {
        built
    })
}

fn build_wait(p: &Parsed) -> Result<Built, String> {
    let until = p.str("until");
    one_of(until, WAIT_UNTIL, "until")?;
    let mut b = Map::new();
    b.insert("method".into(), "wait".into());
    b.insert("session".into(), p.pos(0).unwrap_or_default().into());
    wait_fields(&mut b, until, p.num("timeout"));
    Ok(Built {
        body: b,
        stdin: None,
    })
}

fn build_state(p: &Parsed) -> Result<Built, String> {
    Ok(Built {
        body: body(json!({ "method": "state", "session": p.pos(0).unwrap_or_default() })),
        stdin: None,
    })
}

fn build_result(p: &Parsed) -> Result<Built, String> {
    one_of(p.str("until"), &["all", "any"], "until")?;
    let mut a = p.args(&["wait", "until"]);
    if let Some(timeout) = p.num("timeout") {
        a.insert("timeout_seconds".into(), to_json(timeout));
    }
    if p.pos.len() == 1 {
        a.insert("session".into(), p.pos[0].clone().into());
    } else {
        a.insert("sessions".into(), json!(p.pos));
    }
    Ok(tool("ompdesk_session_result", a))
}

fn build_read(p: &Parsed) -> Result<Built, String> {
    let mut a = session(p);
    p.args_into(&mut a, &["limit", "before"]);
    Ok(tool("ompdesk_session_read", a))
}

fn build_answer(p: &Parsed) -> Result<Built, String> {
    if p.bool("approve") && p.bool("deny") {
        return Err("--approve and --deny exclude each other".into());
    }
    let mut a = session(p);
    p.args_into(&mut a, &["request", "choice"]);
    if p.bool("approve") {
        a.insert("approve".into(), true.into());
    }
    if p.bool("deny") {
        a.insert("approve".into(), false.into());
    }
    if let Some(answers) = p.str("answers") {
        a.insert("answers".into(), parse_json(answers, "--answers")?);
    }
    if p.str("text") == Some("-") {
        return Ok(with_stdin(
            tool("ompdesk_session_answer", a),
            &["args", "text"],
            false,
        ));
    }
    p.args_into(&mut a, &["text"]);
    Ok(tool("ompdesk_session_answer", a))
}

fn build_stop(p: &Parsed) -> Result<Built, String> {
    let mut a = session(p);
    p.args_into(&mut a, &["close", "delete", "device"]);
    Ok(tool("ompdesk_session_stop", a))
}

fn build_show(p: &Parsed) -> Result<Built, String> {
    one_of(p.str("how"), &["focus", "split-right", "split-down"], "how")?;
    let mut a = session(p);
    p.args_into(&mut a, &["how"]);
    Ok(tool("ompdesk_tab_focus", a))
}

fn build_notify(p: &Parsed) -> Result<Built, String> {
    let mut a = Map::new();
    a.insert("title".into(), p.pos(0).unwrap_or_default().into());
    p.args_into(&mut a, &["body"]);
    Ok(tool("ompdesk_notify", a))
}

fn build_compare(p: &Parsed) -> Result<Built, String> {
    let mut a = Map::new();
    if !p.pos.is_empty() {
        a.insert("sessions".into(), json!(p.pos));
    }
    p.args_into(&mut a, &["criteria"]);
    Ok(tool("ompdesk_compare", a))
}

fn build_merge(p: &Parsed) -> Result<Built, String> {
    Ok(tool("ompdesk_merge", session(p)))
}

fn build_report(p: &Parsed) -> Result<Built, String> {
    let mut a = Map::new();
    a.insert("kind".into(), p.pos(0).unwrap_or_default().into());
    p.args_into(&mut a, &["to", "dispatch", "id"]);
    if let Some(files) = p.list("file") {
        a.insert("files".into(), json!(files));
    }
    let checks: Vec<Value> = [("pass", true), ("fail", false)]
        .iter()
        .flat_map(|(flag, passed)| {
            p.list(flag)
                .unwrap_or_default()
                .iter()
                .map(move |command| json!({ "command": command, "passed": passed }))
        })
        .collect();
    if !checks.is_empty() {
        a.insert("checks".into(), checks.into());
    }
    Ok(text_arg(p.pos(1), "ompdesk_report", a, &["args", "text"]))
}

fn build_schedule(p: &Parsed) -> Result<Built, String> {
    let action = p.pos(0).unwrap_or_default();
    one_of(Some(action), &["create", "list", "cancel"], "action")?;
    let mut a = Map::new();
    a.insert("action".into(), action.into());
    p.args_into(
        &mut a,
        &[
            "name",
            "folder",
            "every-minutes",
            "daily-at",
            "model",
            "id",
            "device",
        ],
    );
    if let Some(days) = p.str("days") {
        let days = days
            .split(',')
            .map(|day| {
                let n = js_number(day);
                if is_integer(n) {
                    Ok(to_json(n))
                } else {
                    Err("--days is a comma list of 0-6".to_string())
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        a.insert("days".into(), days.into());
    }
    if p.str("prompt") == Some("-") {
        return Ok(with_stdin(
            tool("ompdesk_schedule", a),
            &["args", "prompt"],
            false,
        ));
    }
    p.args_into(&mut a, &["prompt"]);
    Ok(tool("ompdesk_schedule", a))
}

fn build_autopilot(p: &Parsed) -> Result<Built, String> {
    let action = p.pos(0).unwrap_or_default();
    one_of(Some(action), &["start", "status", "stop"], "action")?;
    one_of(p.str("ship"), &["commit", "push", "release"], "ship")?;
    let mut a = Map::new();
    a.insert("action".into(), action.into());
    p.args_into(&mut a, &["folder", "device", "guide", "ship", "now"]);
    if let Some(session) = p.pos(1) {
        a.insert("session".into(), session.into());
    }
    let branch = p.str("branch");
    if p.bool("new-branch") {
        let mut b = Map::new();
        b.insert("kind".into(), "new".into());
        if let Some(name) = branch {
            b.insert("name".into(), name.into());
        }
        a.insert("branch".into(), b.into());
    } else if let Some(name) = branch {
        a.insert("branch".into(), json!({ "kind": "existing", "name": name }));
    }
    Ok(tool("ompdesk_autopilot", a))
}

fn build_app(p: &Parsed) -> Result<Built, String> {
    let action = p.pos(0).unwrap_or_default();
    if action == "list" {
        if p.pos.len() > 1 {
            return Err("app list takes no argument".into());
        }
        return Ok(tool("ompdesk_app_list", p.args(&["area", "query"])));
    }
    if p.str("area").is_some() || p.str("query").is_some() {
        return Err("--area and --query go with app list".into());
    }
    match p.pos(1) {
        None => Ok(tool("ompdesk_app", json!({ "action": action }))),
        Some("-") => Ok(with_stdin(
            tool("ompdesk_app", json!({ "action": action })),
            &["args", "args"],
            true,
        )),
        Some(inner) => {
            let args = parse_json(inner, "the action args")?;
            Ok(tool(
                "ompdesk_app",
                json!({ "action": action, "args": args }),
            ))
        }
    }
}

fn build_call(p: &Parsed) -> Result<Built, String> {
    let name = p.pos(0).unwrap_or_default();
    match p.pos(1) {
        None => Ok(tool(name, Map::new())),
        Some("-") => Ok(with_stdin(tool(name, Map::new()), &["args"], true)),
        Some(inner) => Ok(tool(name, parse_json(inner, "the args")?)),
    }
}

fn build_events(_: &Parsed) -> Result<Built, String> {
    Ok(Built {
        body: body(json!({ "method": "subscribe" })),
        stdin: None,
    })
}

use Kind::{B, M, N, S};

pub static SPECS: &[Spec] = &[
    Spec {
        name: "sessions",
        usage: "sessions [--scope window|app|stored] [--device D] [--folder TEXT] [--status running|waiting|idle] [--mine] [--query TEXT] [--limit N]",
        summary: "List sessions (ompdesk_sessions).",
        flags: &[
            ("scope", S),
            ("device", S),
            ("folder", S),
            ("status", S),
            ("mine", B),
            ("query", S),
            ("limit", N),
        ],
        min: 0,
        max: 0,
        build: build_sessions,
    },
    Spec {
        name: "open",
        usage: "open [MESSAGE|-] [--folder F] [--device D] [--model M] [--mode plan|goal] [--worktree [--branch B] [--base REF]] [--reopen ID [--restore]] [--show background|focus|split-right|split-down]",
        summary: "Open a session (ompdesk_session_open); MESSAGE `-` reads stdin.",
        flags: &[
            ("folder", S),
            ("device", S),
            ("model", S),
            ("mode", S),
            ("worktree", B),
            ("branch", S),
            ("base", S),
            ("reopen", S),
            ("restore", B),
            ("show", S),
        ],
        min: 0,
        max: 1,
        build: build_open,
    },
    Spec {
        name: "send",
        usage: "send SESSION MESSAGE|- [--steer] [--request-id ID] [--force] [--wait] [--until idle|blocked|done|any] [--timeout SECONDS]",
        summary: "Message a session; --wait returns after its turn. Refused while it waits on the person unless --force.",
        flags: &[
            ("steer", B),
            ("request-id", S),
            ("force", B),
            ("wait", B),
            ("until", S),
            ("timeout", N),
        ],
        min: 2,
        max: 2,
        build: build_send,
    },
    Spec {
        name: "wait",
        usage: "wait SESSION [--until idle|blocked|done|any] [--timeout SECONDS]",
        summary: "Wait for a session to settle (idle or blocked), or for --until.",
        flags: &[("until", S), ("timeout", N)],
        min: 1,
        max: 1,
        build: build_wait,
    },
    Spec {
        name: "state",
        usage: "state SESSION",
        summary: "A session's state: working, blocked, idle, starting or stopped.",
        flags: &[],
        min: 1,
        max: 1,
        build: build_state,
    },
    Spec {
        name: "result",
        usage: "result SESSION... [--wait] [--until all|any] [--timeout SECONDS]",
        summary: "A session's last answer (ompdesk_session_result).",
        flags: &[("wait", B), ("until", S), ("timeout", N)],
        min: 1,
        max: usize::MAX,
        build: build_result,
    },
    Spec {
        name: "read",
        usage: "read SESSION [--limit N] [--before CURSOR]",
        summary: "Read a session's transcript, newest first (ompdesk_session_read).",
        flags: &[("limit", N), ("before", S)],
        min: 1,
        max: 1,
        build: build_read,
    },
    Spec {
        name: "answer",
        usage: "answer SESSION [--request ID] [--choice TEXT] [--approve | --deny] [--text TEXT|-] [--answers JSON]",
        summary: "Answer a session's question or approval (ompdesk_session_answer).",
        flags: &[
            ("request", S),
            ("choice", S),
            ("approve", B),
            ("deny", B),
            ("text", S),
            ("answers", S),
        ],
        min: 1,
        max: 1,
        build: build_answer,
    },
    Spec {
        name: "stop",
        usage: "stop SESSION [--close] [--delete] [--device D]",
        summary: "Stop a session's work; --close closes its tab, --delete removes it.",
        flags: &[("close", B), ("delete", B), ("device", S)],
        min: 1,
        max: 1,
        build: build_stop,
    },
    Spec {
        name: "show",
        usage: "show SESSION [--how focus|split-right|split-down]",
        summary: "Bring a session's tab forward (ompdesk_tab_focus).",
        flags: &[("how", S)],
        min: 1,
        max: 1,
        build: build_show,
    },
    Spec {
        name: "notify",
        usage: "notify TITLE [--body TEXT]",
        summary: "Raise a notification for the person (ompdesk_notify).",
        flags: &[("body", S)],
        min: 1,
        max: 1,
        build: build_notify,
    },
    Spec {
        name: "compare",
        usage: "compare [SESSION...] [--criteria TEXT]...",
        summary: "Evidence and a ranked verdict over sessions (ompdesk_compare).",
        flags: &[("criteria", M)],
        min: 0,
        max: usize::MAX,
        build: build_compare,
    },
    Spec {
        name: "merge",
        usage: "merge SESSION",
        summary: "Merge a session's worktree branch (ompdesk_merge).",
        flags: &[],
        min: 1,
        max: 1,
        build: build_merge,
    },
    Spec {
        name: "report",
        usage: "report KIND TEXT|- [--file F]... [--pass CMD]... [--fail CMD]... [--to SESSION] [--dispatch ID] [--id ID]",
        summary: "Send a report (ompdesk_report): kind progress, done, blocked, question, review or note.",
        flags: &[
            ("file", M),
            ("pass", M),
            ("fail", M),
            ("to", S),
            ("dispatch", S),
            ("id", S),
        ],
        min: 2,
        max: 2,
        build: build_report,
    },
    Spec {
        name: "schedule",
        usage: "schedule create|list|cancel [--name N] [--prompt TEXT|-] [--folder F] [--every-minutes N | --daily-at HH:MM [--days 0,1,..]] [--model M] [--id ID] [--device D]",
        summary: "Recurring runs (ompdesk_schedule).",
        flags: &[
            ("name", S),
            ("prompt", S),
            ("folder", S),
            ("every-minutes", N),
            ("daily-at", S),
            ("days", S),
            ("model", S),
            ("id", S),
            ("device", S),
        ],
        min: 1,
        max: 1,
        build: build_schedule,
    },
    Spec {
        name: "autopilot",
        usage: "autopilot start|status|stop [SESSION] [--folder F] [--device D] [--guide TEXT] [--ship commit|push|release] [--branch NAME [--new-branch]] [--now]",
        summary: "Endless repo improvement (ompdesk_autopilot); `stop` and `status` name a session.",
        flags: &[
            ("folder", S),
            ("device", S),
            ("guide", S),
            ("ship", S),
            ("branch", S),
            ("new-branch", B),
            ("now", B),
        ],
        min: 1,
        max: 2,
        build: build_autopilot,
    },
    Spec {
        name: "app",
        usage: "app list [--area A] [--query TEXT]  |  app ACTION [JSON|-]",
        summary: "List (ompdesk_app_list) or run (ompdesk_app) an OMPdesk setting or view action; JSON is the action's args.",
        flags: &[("area", S), ("query", S)],
        min: 1,
        max: 2,
        build: build_app,
    },
    Spec {
        name: "call",
        usage: "call TOOL [JSON|-]",
        summary: "Call any ompdesk_* tool with raw JSON args.",
        flags: &[],
        min: 1,
        max: 2,
        build: build_call,
    },
    Spec {
        name: "events",
        usage: "events",
        summary: "Print one line per event (state changes, asks, finished turns, reports) until interrupted.",
        flags: &[],
        min: 0,
        max: 0,
        build: build_events,
    },
];

pub fn spec(name: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.name == name)
}

const GLOBAL_FLAGS: &str = "[--json] [--socket PATH] [--caller NAME]";

pub fn help_text(topic: Option<&str>) -> String {
    if let Some(topic) = topic.filter(|t| *t != "help") {
        return match spec(topic) {
            Some(spec) => format!(
                "ompdesk {}\n{}\nFlags for every command: {GLOBAL_FLAGS}\n",
                spec.usage, spec.summary
            ),
            None => format!("ompdesk: unknown command \"{topic}\"\n{}", help_text(None)),
        };
    }
    let mut out = String::from(
        "ompdesk: drive a running OMPdesk from a terminal, a script or another agent. Works inside or outside OMPdesk.\n\n",
    );
    out.push_str(&format!(
        "Usage: ompdesk <command> [args] {GLOBAL_FLAGS}\n\n"
    ));
    for spec in SPECS {
        out.push_str(&format!("  {:<10}{}\n", spec.name, spec.summary));
    }
    out.push_str("\nWithout a running OMPdesk:\n");
    out.push_str(ompdesk_checks::cli::HELP);
    out.push_str("  help      `ompdesk help <command>` shows a command's flags.\n\n");
    out.push_str("A message argument of `-` reads it from stdin. --json prints the raw result (or {ok:false,error}) as JSON.\n");
    out.push_str("Exit codes: 0 ok, 1 failed (tool error, agent_blocked, timeout, session_gone, events_lost), 2 usage, 3 OMPdesk not running or refused.\n");
    out
}

pub fn parse(argv: &[String]) -> Command {
    let Some(name) = argv.first() else {
        return Command::Help(None);
    };
    if name == "--help" || name == "-h" {
        return Command::Help(None);
    }
    let rest = &argv[1..];
    if name == "help" {
        return if rest.len() > 1 {
            Command::Usage("help takes one command".into())
        } else {
            Command::Help(rest.first().cloned())
        };
    }
    let Some(spec) = spec(name) else {
        return Command::Usage(format!("unknown command \"{name}\""));
    };
    parse_command(spec, rest).unwrap_or_else(Command::Usage)
}

#[derive(Default)]
struct Options {
    json: bool,
    help: bool,
    socket: Option<String>,
    caller: Option<String>,
    raw: HashMap<&'static str, Flag>,
}

fn kind_of(spec: &Spec, name: &str) -> Option<(&'static str, Kind)> {
    match name {
        "json" => Some(("json", B)),
        "help" => Some(("help", B)),
        "socket" => Some(("socket", S)),
        "caller" => Some(("caller", S)),
        _ => spec.flags.iter().find(|(flag, _)| *flag == name).copied(),
    }
}

impl Options {
    /// One option token, checked the way strict `parseArgs` checks it.
    fn store(
        &mut self,
        spec: &Spec,
        name: &str,
        value: Option<&str>,
        inline: bool,
    ) -> Result<(), String> {
        let Some((flag, kind)) = kind_of(spec, name) else {
            return Err(unknown_option(&format!("--{name}")));
        };
        if kind == B {
            if value.is_some() {
                let shown = if flag == "help" {
                    "-h, --help"
                } else {
                    &format!("--{flag}")
                };
                return Err(format!("Option '{shown}' does not take an argument"));
            }
            match flag {
                "json" => self.json = true,
                "help" => self.help = true,
                _ => {
                    self.raw.insert(flag, Flag::Bool);
                }
            }
            return Ok(());
        }
        let Some(value) = value else {
            return Err(format!("Option '--{flag} <value>' argument missing"));
        };
        if !inline && value.len() > 1 && value.starts_with('-') {
            return Err(format!(
                "Option '--{flag}' argument is ambiguous.\nDid you forget to specify the option argument for '--{flag}'?\nTo specify an option argument starting with a dash use '--{flag}=-XYZ'."
            ));
        }
        match (flag, kind) {
            ("socket", _) => self.socket = Some(value.into()),
            ("caller", _) => self.caller = Some(value.into()),
            (_, M) => match self
                .raw
                .entry(flag)
                .or_insert_with(|| Flag::List(Vec::new()))
            {
                Flag::List(list) => list.push(value.into()),
                other => *other = Flag::List(vec![value.into()]),
            },
            _ => {
                self.raw.insert(flag, Flag::Str(value.into()));
            }
        }
        Ok(())
    }
}

fn parse_command(spec: &Spec, rest: &[String]) -> Result<Command, String> {
    let mut options = Options::default();
    let mut positionals = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        let arg = &rest[i];
        i += 1;
        if arg == "--" {
            positionals.extend_from_slice(&rest[i..]);
            break;
        }
        if arg == "-" || !arg.starts_with('-') {
            positionals.push(arg.clone());
            continue;
        }
        if let Some(long) = arg.strip_prefix("--") {
            if long.starts_with('=') {
                return Err(unknown_option(arg));
            }
            if let Some((name, value)) = long.split_once('=') {
                options.store(spec, name, Some(value), true)?;
                continue;
            }
            let takes_value = kind_of(spec, long).is_some_and(|(_, kind)| kind != B);
            let value = if takes_value { rest.get(i) } else { None };
            if value.is_some() {
                i += 1;
            }
            options.store(spec, long, value.map(String::as_str), false)?;
            continue;
        }
        for short in arg.chars().skip(1) {
            if short != 'h' {
                // A lone `-x` is named whole, a member of a group (`-hx`) by its letter, as node does.
                let shown = if arg.chars().count() > 2 {
                    short.to_string()
                } else {
                    arg.clone()
                };
                return Err(unknown_option(&shown));
            }
            options.store(spec, "help", None, false)?;
        }
    }
    if options.help {
        return Ok(Command::Help(Some(spec.name.into())));
    }

    let mut v = HashMap::new();
    for (flag, kind) in spec.flags {
        let Some(value) = options.raw.remove(flag) else {
            continue;
        };
        let value = match (kind, value) {
            (N, Flag::Str(text)) => {
                let n = js_number(&text);
                if !n.is_finite() || n < 0.0 || js_trim(&text).is_empty() {
                    return Err(format!("--{flag} is a number"));
                }
                Flag::Num(n)
            }
            (_, value) => value,
        };
        v.insert(*flag, value);
    }
    if positionals.len() < spec.min {
        let what = spec
            .usage
            .split_whitespace()
            .nth(1)
            .unwrap_or("an argument");
        return Err(format!("{} needs {what}", spec.name));
    }
    if positionals.len() > spec.max {
        let plural = if spec.max == 1 { "" } else { "s" };
        return Err(format!(
            "{} takes at most {} argument{plural}",
            spec.name, spec.max
        ));
    }
    let built = (spec.build)(&Parsed {
        v,
        pos: positionals,
    })?;
    Ok(Command::Run(RunCommand {
        body: built.body,
        stdin: built.stdin,
        socket: options.socket,
        caller: options.caller,
        json: options.json,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    fn run(args: &[&str]) -> RunCommand {
        match parse(&argv(args)) {
            Command::Run(command) => command,
            other => panic!("not a run: {args:?} -> {other:?}"),
        }
    }

    fn tool(name: &str, args: Value) -> Value {
        json!({ "method": "tool", "tool": name, "args": args })
    }

    #[test]
    fn builds_each_command() {
        let table: Vec<(&[&str], Value)> = vec![
            (&["sessions"], tool("ompdesk_sessions", json!({}))),
            (
                &["sessions", "--scope", "app", "--mine", "--limit", "5"],
                tool(
                    "ompdesk_sessions",
                    json!({ "scope": "app", "mine": true, "limit": 5 }),
                ),
            ),
            (
                &[
                    "open",
                    "do it",
                    "--folder",
                    "/x",
                    "--mode",
                    "goal",
                    "--worktree",
                    "--branch",
                    "b",
                ],
                tool(
                    "ompdesk_session_open",
                    json!({ "message": "do it", "folder": "/x", "mode": "goal", "worktree": { "branch": "b" } }),
                ),
            ),
            (
                &["open", "--reopen", "abc", "--restore"],
                tool(
                    "ompdesk_session_open",
                    json!({ "reopen": "abc", "restore": true }),
                ),
            ),
            (
                &[
                    "send",
                    "s1",
                    "hi",
                    "--steer",
                    "--request-id",
                    "r1",
                    "--force",
                ],
                json!({ "method": "send", "session": "s1", "message": "hi", "delivery": "steer", "requestId": "r1", "force": true }),
            ),
            (
                &[
                    "send",
                    "s1",
                    "hi",
                    "--wait",
                    "--until",
                    "done",
                    "--timeout",
                    "30",
                ],
                json!({ "method": "send", "session": "s1", "message": "hi", "wait": { "until": "done", "timeoutMs": 30_000 } }),
            ),
            (
                &["wait", "s1", "--until", "blocked"],
                json!({ "method": "wait", "session": "s1", "until": "blocked" }),
            ),
            (
                &["state", "s1"],
                json!({ "method": "state", "session": "s1" }),
            ),
            (
                &["result", "a"],
                tool("ompdesk_session_result", json!({ "session": "a" })),
            ),
            (
                &[
                    "result",
                    "a",
                    "b",
                    "--wait",
                    "--until",
                    "any",
                    "--timeout",
                    "9",
                ],
                tool(
                    "ompdesk_session_result",
                    json!({ "sessions": ["a", "b"], "wait": true, "until": "any", "timeout_seconds": 9 }),
                ),
            ),
            (
                &["read", "a", "--limit", "3"],
                tool(
                    "ompdesk_session_read",
                    json!({ "session": "a", "limit": 3 }),
                ),
            ),
            (
                &["answer", "a", "--deny", "--request", "q"],
                tool(
                    "ompdesk_session_answer",
                    json!({ "session": "a", "request": "q", "approve": false }),
                ),
            ),
            (
                &["stop", "a", "--close"],
                tool(
                    "ompdesk_session_stop",
                    json!({ "session": "a", "close": true }),
                ),
            ),
            (
                &["show", "a", "--how", "split-right"],
                tool(
                    "ompdesk_tab_focus",
                    json!({ "session": "a", "how": "split-right" }),
                ),
            ),
            (
                &["notify", "T", "--body", "B"],
                tool("ompdesk_notify", json!({ "title": "T", "body": "B" })),
            ),
            (
                &["compare", "a", "b", "--criteria", "x"],
                tool(
                    "ompdesk_compare",
                    json!({ "sessions": ["a", "b"], "criteria": ["x"] }),
                ),
            ),
            (
                &["merge", "a"],
                tool("ompdesk_merge", json!({ "session": "a" })),
            ),
            (
                &[
                    "report", "done", "ok", "--file", "f.ts", "--pass", "bun test", "--to", "p",
                ],
                tool(
                    "ompdesk_report",
                    json!({ "kind": "done", "to": "p", "files": ["f.ts"], "checks": [{ "command": "bun test", "passed": true }], "text": "ok" }),
                ),
            ),
            (
                &[
                    "schedule",
                    "create",
                    "--name",
                    "n",
                    "--prompt",
                    "p",
                    "--every-minutes",
                    "60",
                    "--days",
                    "1,2",
                ],
                tool(
                    "ompdesk_schedule",
                    json!({ "action": "create", "name": "n", "prompt": "p", "every_minutes": 60, "days": [1, 2] }),
                ),
            ),
            (
                &[
                    "autopilot",
                    "start",
                    "--folder",
                    "/r",
                    "--ship",
                    "push",
                    "--branch",
                    "x",
                    "--new-branch",
                ],
                tool(
                    "ompdesk_autopilot",
                    json!({ "action": "start", "folder": "/r", "ship": "push", "branch": { "kind": "new", "name": "x" } }),
                ),
            ),
            (
                &["autopilot", "stop", "s", "--now"],
                tool(
                    "ompdesk_autopilot",
                    json!({ "action": "stop", "now": true, "session": "s" }),
                ),
            ),
            (
                &["app", "list", "--area", "theme"],
                tool("ompdesk_app_list", json!({ "area": "theme" })),
            ),
            (
                &["app", "theme.set", r#"{"name":"dark"}"#],
                tool(
                    "ompdesk_app",
                    json!({ "action": "theme.set", "args": { "name": "dark" } }),
                ),
            ),
            (
                &["call", "ompdesk_merge", r#"{"session":"a"}"#],
                tool("ompdesk_merge", json!({ "session": "a" })),
            ),
            (&["events"], json!({ "method": "subscribe" })),
        ];
        for (args, want) in table {
            assert_eq!(Value::Object(run(args).body), want, "{args:?}");
        }
    }

    #[test]
    fn keeps_the_typescript_key_order() {
        let body = run(&[
            "send",
            "s",
            "hi",
            "--timeout",
            "2",
            "--force",
            "--request-id",
            "r",
            "--steer",
        ])
        .body;
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"method":"send","session":"s","message":"hi","delivery":"steer","requestId":"r","force":true,"wait":{"timeoutMs":2000}}"#
        );
        let body = run(&[
            "schedule",
            "create",
            "--days",
            "1,,2",
            "--daily-at",
            "09:00",
            "--every-minutes",
            "0x10",
        ])
        .body;
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            r#"{"method":"tool","tool":"ompdesk_schedule","args":{"action":"create","every_minutes":16,"daily_at":"09:00","days":[1,0,2]}}"#
        );
    }

    #[test]
    fn marks_dash_for_stdin() {
        let target = |path, json| Some(StdinTarget { path, json });
        assert_eq!(
            run(&["open", "-"]).stdin,
            target(&["args", "message"], false)
        );
        assert_eq!(run(&["send", "s", "-"]).stdin, target(&["message"], false));
        assert_eq!(
            run(&["call", "ompdesk_merge", "-"]).stdin,
            target(&["args"], true)
        );
        assert_eq!(
            run(&["answer", "s", "--text", "-"]).stdin,
            target(&["args", "text"], false)
        );
        assert_eq!(
            run(&["app", "x", "-"]).stdin,
            target(&["args", "args"], true)
        );
        assert_eq!(run(&["send", "s", "hi"]).stdin, None);
    }

    #[test]
    fn reads_the_global_flags() {
        let command = run(&["state", "s", "--json", "--socket", "/p", "--caller", "ci"]);
        assert!(command.json);
        assert_eq!(command.socket.as_deref(), Some("/p"));
        assert_eq!(command.caller.as_deref(), Some("ci"));
        let command = run(&[
            "state",
            "--socket=-x",
            "s",
            "--caller",
            "a",
            "--caller",
            "b",
        ]);
        assert_eq!(command.socket.as_deref(), Some("-x"));
        assert_eq!(command.caller.as_deref(), Some("b"));
    }

    #[test]
    fn help_forms() {
        assert_eq!(parse(&[]), Command::Help(None));
        assert_eq!(parse(&argv(&["--help"])), Command::Help(None));
        assert_eq!(parse(&argv(&["-h"])), Command::Help(None));
        assert_eq!(
            parse(&argv(&["help", "send"])),
            Command::Help(Some("send".into()))
        );
        assert_eq!(
            parse(&argv(&["send", "--help"])),
            Command::Help(Some("send".into()))
        );
        assert_eq!(
            parse(&argv(&["send", "-h"])),
            Command::Help(Some("send".into()))
        );
        assert!(help_text(None).contains("Exit codes"));
        assert!(help_text(Some("send")).starts_with("ompdesk send SESSION MESSAGE|-"));
        assert!(
            help_text(Some("nope"))
                .starts_with("ompdesk: unknown command \"nope\"\nompdesk: drive")
        );
    }

    #[test]
    fn usage_errors() {
        let cases: &[(&[&str], Option<&str>)] = &[
            (&["nope"], Some("unknown command \"nope\"")),
            (
                &["sessions", "--bogus"],
                Some(
                    "Unknown option '--bogus'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--bogus\"",
                ),
            ),
            (
                &["sessions", "--=x"],
                Some(
                    "Unknown option '--=x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--=x\"",
                ),
            ),
            (
                &["sessions", "--query", "-x"],
                Some(
                    "Option '--query' argument is ambiguous.\nDid you forget to specify the option argument for '--query'?\nTo specify an option argument starting with a dash use '--query=-XYZ'.",
                ),
            ),
            (
                &["sessions", "--help=1"],
                Some("Option '-h, --help' does not take an argument"),
            ),
            (
                &["sessions", "--json=1"],
                Some("Option '--json' does not take an argument"),
            ),
            (&["send", "only-session"], Some("send needs SESSION")),
            (&["state"], Some("state needs SESSION")),
            (&["state", "a", "b"], Some("state takes at most 1 argument")),
            (
                &["wait", "s", "--until", "never"],
                Some("--until is one of idle, blocked, done, any"),
            ),
            (
                &["sessions", "--limit", "many"],
                Some("--limit is a number"),
            ),
            (
                &["sessions", "--scope", "galaxy"],
                Some("--scope is one of window, app, stored"),
            ),
            (&["call", "t", "{bad"], Some("the args is not valid JSON")),
            (
                &["schedule", "explode"],
                Some("--action is one of create, list, cancel"),
            ),
            (&["help", "a", "b"], Some("help takes one command")),
            (&["sessions", "--limit", ""], Some("--limit is a number")),
            (&["sessions", "--limit", " "], Some("--limit is a number")),
            (&["sessions", "--limit", "-1"], None),
            (&["sessions", "--limit=-1"], Some("--limit is a number")),
            (
                &["sessions", "--limit", "Infinity"],
                Some("--limit is a number"),
            ),
            (&["sessions", "--limit", "inf"], Some("--limit is a number")),
            (&["sessions", "--limit", "NaN"], Some("--limit is a number")),
            (&["sessions", "--limit"], None),
            (&["sessions", "--mine=yes"], None),
            (
                &["sessions", "-x"],
                Some(
                    "Unknown option '-x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-x\"",
                ),
            ),
            (
                &["sessions", "-hx"],
                Some(
                    "Unknown option 'x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"x\"",
                ),
            ),
            (
                &["schedule", "create", "--days", "1.5"],
                Some("--days is a comma list of 0-6"),
            ),
            (
                &["schedule", "create", "--days", "x"],
                Some("--days is a comma list of 0-6"),
            ),
            (
                &["sessions", "extra"],
                Some("sessions takes at most 0 arguments"),
            ),
            (
                &["answer", "s", "--approve", "--deny"],
                Some("--approve and --deny exclude each other"),
            ),
            (&["app", "list", "x"], Some("app list takes no argument")),
            (
                &["app", "x", "--area", "a"],
                Some("--area and --query go with app list"),
            ),
            (
                &["answer", "s", "--answers", "{"],
                Some("--answers is not valid JSON"),
            ),
        ];
        for (args, want) in cases {
            match parse(&argv(args)) {
                Command::Usage(message) => {
                    if let Some(want) = want {
                        assert_eq!(&message, want, "{args:?}");
                    }
                }
                other => panic!("{args:?} is not a usage error: {other:?}"),
            }
        }
    }

    #[test]
    fn dash_and_double_dash_are_positionals() {
        assert_eq!(run(&["notify", "-"]).body["args"]["title"], "-");
        assert_eq!(
            run(&["notify", "--", "--json"]).body["args"]["title"],
            "--json"
        );
        assert_eq!(
            run(&["notify", "T", "--body", "-"]).body["args"]["body"],
            "-"
        );
        assert_eq!(
            run(&["sessions", "--limit", " 7 "]).body["args"]["limit"],
            7
        );
    }
}
