//! `backfill.test.ts`: journals on disk, a stand-in server (`client` asks: sessions paged like the real route, native
//! conclusions, written copies) and a stand-in stock worker (`facts`, `journal` asks).

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::*;

const OMPDESK: (&str, &str) = ("default", "ompdesk");
const OTHER: (&str, &str) = ("default", "other");
const ORIGIN: &str = "device-mac";
const MINUTE: f64 = 60_000.0;

fn now() -> f64 {
    ms("2026-10-20T12:00:00Z")
}

struct FakeSession {
    id: String,
    cwd: String,
    project: (&'static str, &'static str),
    title: Option<&'static str>,
}

struct Native {
    seq: u64,
    id: String,
    session_id: String,
    body: String,
    at: String,
}

/// A stateful stand-in for the server.
struct Server {
    sessions: Vec<FakeSession>,
    natives: Vec<Native>,
    store: &'static str,
    written: Vec<(String, Value)>,
    fail_writes: bool,
    writes: u64,
    sessions_calls: Vec<Value>,
}

impl Server {
    fn new(sessions: Vec<FakeSession>, natives: Vec<Native>) -> Server {
        Server {
            sessions,
            natives,
            store: "store-1",
            written: Vec::new(),
            fail_writes: false,
            writes: 0,
            sessions_calls: Vec::new(),
        }
    }

    fn answer(&mut self, op: &str, args: &[Value]) -> Said {
        match op {
            "projects" => Said::Value(json!([OMPDESK, OTHER].map(|(workspace, project)| {
                json!({ "workspace": workspace, "project": project, "pages": 0, "lastUpdated": null })
            }))),
            "sessions" => {
                self.sessions_calls.push(json!(args));
                let project = args[0]["project"].as_str().unwrap();
                let limit = args.get(1).and_then(Value::as_u64).unwrap_or(30) as usize;
                let offset = args.get(2).and_then(Value::as_u64).unwrap_or(0) as usize;
                let rows: Vec<Value> = self
                    .sessions
                    .iter()
                    .filter(|session| session.project.1 == project)
                    .skip(offset)
                    .take(limit)
                    .map(|session| {
                        json!({ "id": session.id, "cwd": session.cwd, "agent": "omp", "startedAt": null,
                                "endedAt": null, "observations": 1, "consolidation": null })
                    })
                    .collect();
                Said::Value(json!(rows))
            }
            "pages" => {
                let project = args[0]["project"].as_str().unwrap();
                let refs: Vec<Value> = self
                    .sessions
                    .iter()
                    .filter(|session| session.project.1 == project && session.title.is_some())
                    .map(|session| {
                        json!({ "workspace": "default", "project": project,
                                "path": format!("sessions/{}.md", session.id),
                                "title": session.title, "tier": null, "updatedAt": null })
                    })
                    .collect();
                Said::Value(json!(refs))
            }
            "conclusions" => {
                let after = args[1].as_u64().unwrap();
                let limit = args[2].as_u64().unwrap() as usize;
                let later: Vec<&Native> = self.natives.iter().filter(|row| row.seq > after).collect();
                let rows: Vec<Value> = later
                    .iter()
                    .take(limit)
                    .map(|row| {
                        json!({ "seq": row.seq, "workspace": "default", "project": "ompdesk", "id": row.id,
                                "sessionId": row.session_id, "title": "t", "body": row.body, "at": row.at })
                    })
                    .collect();
                let next = rows.last().map_or(after, |row| row["seq"].as_u64().unwrap());
                Said::Value(json!({
                    "rows": rows, "next": next, "more": later.len() > rows.len(), "store": self.store,
                    "last": self.natives.last().map_or(0, |row| row.seq),
                }))
            }
            "writeConclusions" => {
                if self.fail_writes {
                    return Said::Error("server down");
                }
                self.writes += 1;
                let project = args[0].clone();
                let origin = args[1].clone();
                let statuses: Vec<&str> = args[2]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| {
                        if item["body"].as_str().unwrap().trim().is_empty() {
                            return "skipped";
                        }
                        let id = item["id"].as_str().unwrap();
                        if self.written.iter().any(|(known, _)| known == id) {
                            return "same";
                        }
                        let mut row = item.clone();
                        row["project"] = project.clone();
                        row["origin"] = origin.clone();
                        self.written.push((id.to_owned(), row));
                        "written"
                    })
                    .collect();
                Said::Value(json!(statuses))
            }
            other => panic!("{other}"),
        }
    }

    fn bodies(&self) -> Vec<String> {
        self.written
            .iter()
            .map(|(_, row)| row["body"].as_str().unwrap().to_owned())
            .collect()
    }
}

/// The text stand-ins for the memory prompt's functions on the stock worker: an agent's prompt starts like a brief or
/// a message; a title is a `Title:` line, else the first line.
fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn facts_of(item: &Value) -> Value {
    let text = item["text"].as_str().unwrap();
    let explicit = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("Title:"))
        .map(|title| title.trim().to_owned());
    let agent = text.starts_with("Complete assignment thoroughly:")
        || text.starts_with("<ompdesk-agent-message");
    json!({
        "agent": agent, "junk": text.trim().is_empty() || text == "Untitled",
        "title": explicit.clone().or_else(|| first_line(text)).filter(|_| !agent || explicit.is_some()),
        "explicit": explicit, "body": text, "firstLine": first_line(text),
    })
}

struct Fixture {
    sessions: PathBuf,
    /// path → what the journal ask answers.
    journals: HashMap<String, Value>,
    seq: u64,
}

fn uuid(seq: u64) -> String {
    format!("01a14f00-0000-7000-8000-{seq:012}")
}

fn assistant(text: &str, at: f64) -> Value {
    json!({ "at": at, "body": text })
}

impl Fixture {
    fn new() -> Fixture {
        let dir = temp("backfill");
        Fixture {
            sessions: dir.join("sessions"),
            journals: HashMap::new(),
            seq: 0,
        }
    }

    fn uuid(&mut self) -> String {
        self.seq += 1;
        uuid(self.seq)
    }

    /// A journal on disk (stock layout, header only) whose transcript the journal ask answers.
    fn journal(
        &mut self,
        relative: &str,
        header: Value,
        first_prompt: Option<&str>,
        turns: Vec<Value>,
    ) -> PathBuf {
        let path = joined(&self.sessions, relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut session =
            json!({ "type": "session", "version": 3, "timestamp": "2026-10-18T00:00:00Z" });
        for (name, value) in header.as_object().unwrap() {
            session[name] = value.clone();
        }
        let text = [
            json!({ "type": "title", "v": 1, "title": "ignored", "pad": " ".repeat(120) })
                .to_string(),
            session.to_string(),
            json!({ "type": "message", "id": "m1" }).to_string(),
        ]
        .join("\n");
        std::fs::write(&path, text).unwrap();
        self.journals.insert(
            path_text(&path),
            json!({ "firstPrompt": first_prompt, "turns": turns }),
        );
        path
    }

    fn params(&self, memo: &Map<String, Value>, extra: Value) -> Value {
        with(
            common(&["client", "facts", "journal"], Some(now())),
            with(
                json!({ "sessionsDir": path_text(&self.sessions), "origin": ORIGIN, "memo": memo }),
                extra,
            ),
        )
    }
}

fn session_of(
    id: &str,
    cwd: &str,
    project: (&'static str, &'static str),
    title: Option<&'static str>,
) -> FakeSession {
    FakeSession {
        id: id.to_owned(),
        cwd: cwd.to_owned(),
        project,
        title,
    }
}

fn native(session: &str, at: &str, body: &str, seq: u64) -> Native {
    Native {
        seq,
        id: format!("obs-{seq}"),
        session_id: session.replace('-', ""),
        body: body.to_owned(),
        at: at.to_owned(),
    }
}

struct Pass {
    response: Value,
    logs: Vec<Value>,
}

impl Pass {
    fn report(&self) -> &Value {
        assert_eq!(self.response["ok"], true, "{}", self.response);
        &self.response["result"]["report"]
    }

    fn memo(&self) -> Map<String, Value> {
        map(self.response["result"]["memo"].clone())
    }
}

async fn pass(
    driver: &mut Driver,
    fixture: &Fixture,
    server: &mut Server,
    memo: &Map<String, Value>,
    extra: Value,
) -> Pass {
    let mut said = |asked: &Value| match asked["kind"].as_str().unwrap() {
        "client" => {
            let (op, args) = client_op(asked).unwrap();
            server.answer(op, args)
        }
        "journal" => match fixture
            .journals
            .get(asked["params"]["path"].as_str().unwrap())
        {
            Some(journal) => Said::Value(journal.clone()),
            None => Said::Error("no such journal"),
        },
        "facts" => {
            let items = asked["params"]["items"].as_array().unwrap();
            Said::Value(json!(items.iter().map(facts_of).collect::<Vec<_>>()))
        }
        other => panic!("{other}"),
    };
    let before = driver.events.len();
    let response = driver
        .call("care.backfill", fixture.params(memo, extra), &mut said)
        .await;
    let logs = driver.events[before..]
        .iter()
        .filter(|event| event["data"]["message"] == "care-backfill")
        .map(|event| event["data"]["details"].clone())
        .collect();
    Pass { response, logs }
}

fn contains(report: &Value, expected: Value) {
    for (name, value) in expected.as_object().unwrap() {
        assert_eq!(&report[name], value, "{name} in {report}");
    }
}

#[tokio::test]
async fn writes_the_last_reply_of_each_run_of_a_mapped_session_under_this_computers_origin() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    let t1 = ms("2026-10-10T10:00:00Z");
    fixture.journal(
        "-work-app/2026-10-10T10-00-00-000Z_x.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        Some("fix it"),
        vec![
            assistant("Fixed the token check.", t1),
            assistant("Second run: added a test.", t1 + MINUTE),
        ],
    );
    let other = fixture.uuid();
    let mut server = Server::new(
        vec![session_of(&id, "/work/app", OMPDESK, Some("Fix the login"))],
        vec![native(&other, "2026-10-19T22:00:00Z", "later", 1)],
    );
    let mut driver = Driver::start().await;
    let run = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(
        run.report(),
        json!({ "mappedById": 1, "turns": 2, "written": 2, "failed": false }),
    );
    let rows: Vec<&(String, Value)> = server.written.iter().collect();
    assert_eq!(
        rows.iter()
            .map(|(row_id, _)| row_id.clone())
            .collect::<Vec<_>>(),
        [
            format!("backfill:{id}:{}", t1 as i64),
            format!("backfill:{id}:{}", (t1 + MINUTE) as i64)
        ]
    );
    let first = &rows[0].1;
    assert_eq!(first["origin"], ORIGIN);
    assert_eq!(
        first["project"],
        json!({ "workspace": "default", "project": "ompdesk" })
    );
    assert_eq!(first["title"], "Fix the login");
    assert_eq!(first["sessionId"], id);
    assert_eq!(first["at"], crate::care::iso_of(t1));
    // The state names the journal as node spells its path below the sessions folder.
    let key = format!(
        "-work-app{}2026-10-10T10-00-00-000Z_x.jsonl",
        std::path::MAIN_SEPARATOR
    );
    assert_eq!(run.memo()["backfill"]["done"][&key], -1);
    assert_eq!(run.memo()["backfill"]["store"], "store-1");
    assert_eq!(run.memo()["backfill"]["v"], 1);
}

#[tokio::test]
async fn takes_the_title_of_the_first_prompt_when_the_server_holds_no_page_for_the_session() {
    let mut fixture = Fixture::new();
    let known = fixture.uuid();
    let id = fixture.uuid();
    fixture.journal(
        "-work-app/2026-10-10T10-00-00-000Z_x/1-Scout.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        Some("Complete assignment thoroughly:\nTitle: 로그인 점검\n\nlook at it"),
        vec![assistant("done", ms("2026-10-10T10:00:00Z"))],
    );
    let mut server = Server::new(vec![session_of(&known, "/work/app", OMPDESK, None)], vec![]);
    let mut driver = Driver::start().await;
    pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    assert_eq!(server.written[0].1["title"], "로그인 점검");
}

#[tokio::test]
async fn titles_a_conclusion_by_its_first_turn_and_then_the_session_id_when_no_prompt_names_it() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    let blank = fixture.uuid();
    fixture.journal(
        "-w/a.jsonl",
        json!({ "id": id, "cwd": "/w" }),
        None,
        vec![assistant(
            "\n\nFirst real line.\nmore",
            ms("2026-10-10T10:00:00Z"),
        )],
    );
    fixture.journal(
        "-w/b.jsonl",
        json!({ "id": blank, "cwd": "/w" }),
        None,
        vec![
            assistant("  ", ms("2026-10-10T10:00:00Z")),
            assistant("x", ms("2026-10-10T10:01:00Z")),
        ],
    );
    let mut server = Server::new(
        vec![
            session_of(&id, "/w", OMPDESK, None),
            session_of(&blank, "/w", OMPDESK, None),
        ],
        vec![],
    );
    let mut driver = Driver::start().await;
    pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    assert_eq!(server.written[0].1["title"], "First real line.");
    // The blank first turn names nothing, and is refused by the server; the title still comes from it.
    assert_eq!(server.written[1].1["title"], format!("Session {blank}"));
    assert_eq!(server.written[1].1["body"], "x");
}

#[tokio::test]
async fn copies_a_session_an_agent_started_only_when_its_brief_names_the_task_with_a_title_line() {
    let mut fixture = Fixture::new();
    let known = fixture.uuid();
    let at = ms("2026-10-10T10:00:00Z");
    let (person, titled, plumbing, opened) = (
        fixture.uuid(),
        fixture.uuid(),
        fixture.uuid(),
        fixture.uuid(),
    );
    fixture.journal(
        "-work-app/p.jsonl",
        json!({ "id": person, "cwd": "/work/app" }),
        Some("왜 로그인이 안 돼?"),
        vec![assistant("토큰 만료 검사가 빠져 있었어요.", at)],
    );
    fixture.journal(
        "-work-app/p/1-Task.jsonl",
        json!({ "id": titled, "cwd": "/work/app" }),
        Some("Complete assignment thoroughly:\nTitle: 로그인 점검\n\nlook at it"),
        vec![assistant("Checked the token path.", at)],
    );
    fixture.journal(
        "-work-app/p/2-Task.jsonl",
        json!({ "id": plumbing, "cwd": "/work/app" }),
        Some("Complete assignment thoroughly:\n# Target\nRead history://FlakeHunt2 §1."),
        vec![assistant("Read it; nothing new.", at)],
    );
    fixture.journal(
        "-work-app/o.jsonl",
        json!({ "id": opened, "cwd": "/work/app" }),
        Some("<ompdesk-agent-message from=\"Boss\">\nContinue Shell3's work.\n</ompdesk-agent-message>"),
        vec![assistant("Continued.", at)],
    );
    let mut server = Server::new(vec![session_of(&known, "/work/app", OMPDESK, None)], vec![]);
    let mut driver = Driver::start().await;
    let run = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(run.report(), json!({ "untitled": 2, "written": 2 }));
    let mut sessions: Vec<String> = server
        .written
        .iter()
        .map(|(_, row)| row["sessionId"].as_str().unwrap().to_owned())
        .collect();
    sessions.sort();
    let mut expected = vec![person, titled];
    expected.sort();
    assert_eq!(sessions, expected);
    let again = pass(&mut driver, &fixture, &mut server, &run.memo(), json!({})).await;
    assert_eq!(again.report()["written"], 0);
}

#[tokio::test]
async fn maps_by_the_folder_only_when_every_known_session_there_belongs_to_one_project_and_counts_what_it_skips()
 {
    let mut fixture = Fixture::new();
    let ids: Vec<String> = (0..7).map(|_| fixture.uuid()).collect();
    let reply = |at: f64| vec![assistant("answer", at)];
    let at = ms("2026-10-10T10:00:00Z");
    fixture.journal(
        "-solo/a.jsonl",
        json!({ "id": ids[3], "cwd": "/solo" }),
        Some("q"),
        reply(at),
    );
    fixture.journal(
        "-shared/b.jsonl",
        json!({ "id": ids[4], "cwd": "/shared" }),
        Some("q"),
        reply(at),
    );
    fixture.journal(
        "-nowhere/c.jsonl",
        json!({ "id": ids[5], "cwd": "/nowhere" }),
        Some("q"),
        reply(at),
    );
    fixture.journal(
        "-solo/__advisor.jsonl",
        json!({ "id": ids[6], "cwd": "/solo" }),
        Some("q"),
        reply(at),
    );
    std::fs::write(fixture.sessions.join("-solo").join("d.jsonl"), "not json\n").unwrap();
    let mut server = Server::new(
        vec![
            session_of(&ids[0], "/solo", OMPDESK, None),
            session_of(&ids[1], "/shared", OMPDESK, None),
            session_of(&ids[2], "/shared", OTHER, None),
        ],
        vec![],
    );
    let mut driver = Driver::start().await;
    let run = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(
        run.report(),
        json!({ "journals": 4, "mappedByCwd": 1, "ambiguous": 1, "unmapped": 1, "noHeader": 1, "written": 1 }),
    );
    assert_eq!(
        server
            .written
            .iter()
            .map(|(_, row)| row["project"].clone())
            .collect::<Vec<_>>(),
        [json!({ "workspace": "default", "project": "ompdesk" })]
    );
}

#[tokio::test]
async fn finds_a_session_past_the_servers_first_100_in_a_project() {
    let mut fixture = Fixture::new();
    let ids: Vec<String> = (0..130).map(|_| fixture.uuid()).collect();
    let sessions: Vec<FakeSession> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| session_of(id, &format!("/f{index}"), OMPDESK, None))
        .collect();
    fixture.journal(
        "-f/last.jsonl",
        json!({ "id": ids[129], "cwd": "/elsewhere" }),
        None,
        vec![assistant("old answer", ms("2026-10-10T10:00:00Z"))],
    );
    let mut server = Server::new(sessions, vec![]);
    let mut driver = Driver::start().await;
    let run = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(run.report(), json!({ "mappedById": 1, "written": 1 }));
    // Two pages of the first project (100, then the 30 left), one of the other.
    let paged: Vec<&Value> = server.sessions_calls.iter().collect();
    assert_eq!(
        paged[0],
        &json!([{ "workspace": "default", "project": "ompdesk" }, 100, 0])
    );
    assert_eq!(
        paged[1],
        &json!([{ "workspace": "default", "project": "ompdesk" }, 100, 100])
    );
    assert_eq!(paged.len(), 3);
}

#[tokio::test]
async fn leaves_the_turns_the_server_captured_itself() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    let cut = ms("2026-10-19T22:00:00Z");
    fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![
            assistant("An old turn", cut - 3_600_000.0),
            assistant("The turn the server kept itself", cut),
            assistant("A later turn the server also kept", cut + 3_600_000.0),
        ],
    );
    let other = fixture.uuid();
    let mut server = Server::new(
        vec![session_of(&id, "/work/app", OMPDESK, None)],
        vec![
            native(
                &id,
                &crate::care::iso_of(cut + 8000.0),
                "The turn the server kept itself",
                1,
            ),
            native(
                &other,
                "2026-10-19T21:49:56Z",
                "another session, earlier start of capture",
                2,
            ),
        ],
    );
    let mut driver = Driver::start().await;
    let run = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    assert_eq!(run.report()["written"], 1);
    assert_eq!(server.bodies(), ["An old turn"]);
}

#[tokio::test]
async fn uses_the_start_of_capture_for_a_session_with_no_native_conclusion_and_ten_minutes_ago_when_the_store_has_none()
 {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    let at = ms("2026-10-19T21:49:56Z");
    let path = fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![
            assistant("before capture", at - 1000.0),
            assistant("after capture began", at + 1000.0),
        ],
    );
    let other = fixture.uuid();
    let mut with_natives = Server::new(
        vec![session_of(&id, "/work/app", OMPDESK, None)],
        vec![native(&other, "2026-10-19T21:49:56Z", "x", 1)],
    );
    let mut driver = Driver::start().await;
    pass(
        &mut driver,
        &fixture,
        &mut with_natives,
        &Map::new(),
        json!({}),
    )
    .await;
    assert_eq!(with_natives.bodies(), ["before capture"]);

    fixture.journals.insert(
        path_text(&path),
        json!({ "firstPrompt": null, "turns": [
            assistant("an hour ago", now() - 60.0 * MINUTE),
            assistant("a minute ago, its Stop may still arrive", now() - MINUTE),
        ] }),
    );
    let mut empty = Server::new(vec![session_of(&id, "/work/app", OMPDESK, None)], vec![]);
    pass(&mut driver, &fixture, &mut empty, &Map::new(), json!({})).await;
    assert_eq!(empty.bodies(), ["an hour ago"]);
}

#[tokio::test]
async fn writes_nothing_new_on_a_second_pass_with_or_without_the_state() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![assistant("one", ms("2026-10-10T10:00:00Z"))],
    );
    let other = fixture.uuid();
    let mut server = Server::new(
        vec![session_of(&id, "/work/app", OMPDESK, None)],
        vec![native(&other, "2026-10-19T22:00:00Z", "x", 1)],
    );
    let mut driver = Driver::start().await;
    let first = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(first.report(), json!({ "written": 1, "read": 1 }));
    let again = pass(&mut driver, &fixture, &mut server, &first.memo(), json!({})).await;
    contains(
        again.report(),
        json!({ "written": 0, "same": 0, "read": 0, "done": 1 }),
    );
    assert_eq!(again.logs.len(), 0);
    let stateless = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(
        stateless.report(),
        json!({ "written": 0, "same": 1, "read": 1 }),
    );
}

#[tokio::test]
async fn starts_over_for_a_new_store() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![assistant("one", ms("2026-10-10T10:00:00Z"))],
    );
    let mut first = Server::new(vec![session_of(&id, "/work/app", OMPDESK, None)], vec![]);
    first.store = "store-a";
    let mut driver = Driver::start().await;
    let run = pass(&mut driver, &fixture, &mut first, &Map::new(), json!({})).await;
    let mut second = Server::new(vec![session_of(&id, "/work/app", OMPDESK, None)], vec![]);
    second.store = "store-b";
    let again = pass(&mut driver, &fixture, &mut second, &run.memo(), json!({})).await;
    contains(again.report(), json!({ "read": 1, "written": 1 }));
    assert_eq!(again.memo()["backfill"]["store"], "store-b");
}

#[tokio::test]
async fn reads_a_state_of_another_shape_as_none() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    let path = fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![assistant("one", ms("2026-10-10T10:00:00Z"))],
    );
    let size = std::fs::metadata(&path).unwrap().len();
    let key = format!("-work-app{}a.jsonl", std::path::MAIN_SEPARATOR);
    let mut driver = Driver::start().await;
    for saved in [
        // The version, a string for the store, a number for every journal: anything else starts over.
        json!({ "v": 2, "store": "store-1", "done": { key.clone(): size } }),
        json!({ "v": 1, "store": "store-1", "done": { key.clone(): "x" } }),
        json!({ "v": 1, "store": 5, "done": {} }),
        json!([]),
    ] {
        let mut server = Server::new(vec![session_of(&id, "/work/app", OMPDESK, None)], vec![]);
        let mut memo = Map::new();
        memo.insert("backfill".to_owned(), saved);
        let run = pass(&mut driver, &fixture, &mut server, &memo, json!({})).await;
        contains(run.report(), json!({ "read": 1, "done": 0 }));
    }
    // A state that holds the journal at its size is read as done, and members beside the three are dropped.
    let mut server = Server::new(vec![session_of(&id, "/work/app", OMPDESK, None)], vec![]);
    let mut memo = Map::new();
    memo.insert(
        "backfill".to_owned(),
        json!({ "v": 1, "store": "store-1", "done": { key: size }, "extra": true }),
    );
    let run = pass(&mut driver, &fixture, &mut server, &memo, json!({})).await;
    contains(run.report(), json!({ "read": 0, "done": 1 }));
    assert!(run.memo()["backfill"].get("extra").is_none());
}

#[tokio::test]
async fn reads_and_writes_within_its_budget_and_goes_on_from_the_state() {
    let mut fixture = Fixture::new();
    let ids: Vec<String> = (0..3).map(|_| fixture.uuid()).collect();
    let sessions: Vec<FakeSession> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| session_of(id, &format!("/f{index}"), OMPDESK, None))
        .collect();
    for (index, id) in ids.iter().enumerate() {
        fixture.journal(
            &format!("-f/{index}.jsonl"),
            json!({ "id": id, "cwd": format!("/f{index}") }),
            None,
            vec![assistant(
                &format!("answer {index}"),
                ms("2026-10-10T10:00:00Z") + index as f64,
            )],
        );
    }
    let other = fixture.uuid();
    let mut server = Server::new(
        sessions,
        vec![native(&other, "2026-10-19T22:00:00Z", "x", 1)],
    );
    let mut driver = Driver::start().await;
    let one = pass(
        &mut driver,
        &fixture,
        &mut server,
        &Map::new(),
        json!({ "maxJournals": 2 }),
    )
    .await;
    contains(
        one.report(),
        json!({ "read": 2, "written": 2, "remaining": 1 }),
    );
    let two = pass(
        &mut driver,
        &fixture,
        &mut server,
        &one.memo(),
        json!({ "maxJournals": 2 }),
    )
    .await;
    contains(
        two.report(),
        json!({ "read": 1, "written": 1, "remaining": 0, "done": 2 }),
    );
    assert_eq!(server.written.len(), 3);
}

#[tokio::test]
async fn stops_on_a_failed_write_and_reads_that_journal_again_next_time() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![assistant("one", ms("2026-10-10T10:00:00Z"))],
    );
    let other = fixture.uuid();
    let mut server = Server::new(
        vec![session_of(&id, "/work/app", OMPDESK, None)],
        vec![native(&other, "2026-10-19T22:00:00Z", "x", 1)],
    );
    server.fail_writes = true;
    let mut driver = Driver::start().await;
    let failed = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(
        failed.report(),
        json!({ "failed": true, "written": 0, "remaining": 1 }),
    );
    server.fail_writes = false;
    let again = pass(
        &mut driver,
        &fixture,
        &mut server,
        &failed.memo(),
        json!({}),
    )
    .await;
    contains(again.report(), json!({ "failed": false, "written": 1 }));
}

#[tokio::test]
async fn logs_one_care_backfill_line_per_pass_that_read_a_journal_and_none_when_there_was_nothing_to_do()
 {
    let mut fixture = Fixture::new();
    let mut nothing = Server::new(vec![], vec![]);
    let mut driver = Driver::start().await;
    let first = pass(&mut driver, &fixture, &mut nothing, &Map::new(), json!({})).await;
    assert_eq!(first.logs, Vec::<Value>::new());
    let id = fixture.uuid();
    fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![assistant("one", ms("2026-10-10T10:00:00Z"))],
    );
    let mut with_session = Server::new(vec![session_of(&id, "/work/app", OMPDESK, None)], vec![]);
    let run = pass(
        &mut driver,
        &fixture,
        &mut with_session,
        &Map::new(),
        json!({}),
    )
    .await;
    assert_eq!(run.logs.len(), 1);
    let line = &run.logs[0];
    assert_eq!(line["written"], 1);
    assert_eq!(line["read"], 1);
    assert_eq!(line["mappedById"], 1);
    assert_eq!(
        line.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "store",
            "journals",
            "done",
            "read",
            "mappedById",
            "mappedByCwd",
            "noHeader",
            "unmapped",
            "ambiguous",
            "unreadable",
            "untitled",
            "turns",
            "written",
            "same",
            "refused",
            "remaining",
            "failed",
            "ms",
        ]
    );
}

#[tokio::test]
async fn counts_a_journal_stock_cannot_read_and_leaves_it_done_at_its_size() {
    let mut fixture = Fixture::new();
    let id = fixture.uuid();
    let path = fixture.journal(
        "-work-app/a.jsonl",
        json!({ "id": id, "cwd": "/work/app" }),
        None,
        vec![assistant("one", ms("2026-10-10T10:00:00Z"))],
    );
    // The journal ask has no answer for it: main's reader refused.
    fixture.journals.remove(&path_text(&path));
    let mut server = Server::new(vec![session_of(&id, "/work/app", OMPDESK, None)], vec![]);
    let mut driver = Driver::start().await;
    let run = pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    contains(
        run.report(),
        json!({ "unreadable": 1, "read": 1, "written": 0 }),
    );
    let key = format!("-work-app{}a.jsonl", std::path::MAIN_SEPARATOR);
    assert_eq!(
        run.memo()["backfill"]["done"][&key],
        json!(std::fs::metadata(&path).unwrap().len())
    );
}

#[tokio::test]
async fn walks_the_journals_in_utf16_order_of_their_paths() {
    let mut fixture = Fixture::new();
    let reply = |at: f64| vec![assistant("answer", at)];
    let at = ms("2026-10-10T10:00:00Z");
    let mut ids = Vec::new();
    let mut sessions = Vec::new();
    // `-` (U+002D) and `.` (U+002E) sort before the platform's separator on POSIX only for `-`; Korean and an emoji
    // sort by UTF-16 unit, the emoji's surrogate (U+D83D) before U+FF21.
    for (index, name) in [
        "b.jsonl",
        "a-b.jsonl",
        "a.jsonl",
        "가.jsonl",
        "😀.jsonl",
        "Ａ.jsonl",
    ]
    .into_iter()
    .enumerate()
    {
        let id = fixture.uuid();
        fixture.journal(
            &format!("-dir/{name}"),
            json!({ "id": id, "cwd": format!("/c{index}") }),
            None,
            reply(at),
        );
        sessions.push(session_of(&id, &format!("/c{index}"), OMPDESK, None));
        ids.push(id);
    }
    let mut server = Server::new(sessions, vec![]);
    let mut driver = Driver::start().await;
    pass(&mut driver, &fixture, &mut server, &Map::new(), json!({})).await;
    let order: Vec<&str> = server
        .written
        .iter()
        .map(|(_, row)| row["sessionId"].as_str().unwrap())
        .collect();
    let name_of = |id: &str| {
        ["b", "a-b", "a", "가", "😀", "Ａ"][ids.iter().position(|known| known == id).unwrap()]
    };
    let sep = std::path::MAIN_SEPARATOR;
    let mut expected: Vec<String> = ["b", "a-b", "a", "가", "😀", "Ａ"]
        .iter()
        .map(|name| format!("-dir{sep}{name}.jsonl"))
        .collect();
    expected.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    assert_eq!(
        order
            .iter()
            .map(|id| format!("-dir{sep}{}.jsonl", name_of(id)))
            .collect::<Vec<_>>(),
        expected
    );
}
