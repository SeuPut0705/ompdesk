//! The pool through the hub, with a scripted main: a client that answers the core's questions as main's collaborators
//! would (a fake sidecar factory, windows that are never destroyed) and keeps everything the core pushed, in order.
//! The pool's parity suite (`src/main/sidecar-pool.test.ts`, 165 cases) runs the same rules through the real client.

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(7000);

thread_local! {
    /// The tabs main started (each test runs on a thread of its own).
    static STARTED: RefCell<HashSet<String>> = RefCell::default();
}

type Answer = Box<dyn FnMut(&str, &Value) -> Value>;

struct Main {
    write: WriteHalf<DuplexStream>,
    lines: BufReader<ReadHalf<DuplexStream>>,
    instance: u64,
    next: u64,
    /// Every item the core pushed, in order.
    items: Vec<Value>,
    /// Every question the core asked, in order, with its payload.
    asked: Vec<(String, Value)>,
    answer: Answer,
}

fn default_answer(q: &str, item: &Value) -> Value {
    match q {
        "blocked" => json!(false),
        "spawn" => json!({"status": "starting"}),
        "facts" => {
            let mut facts = serde_json::Map::new();
            for tab in item["tabs"].as_array().into_iter().flatten() {
                let started =
                    STARTED.with(|started| started.borrow().contains(tab.as_str().unwrap()));
                facts.insert(
                    tab.as_str().unwrap().to_string(),
                    json!({"cwd": "/work", "status": if started { "ready" } else { "asleep" }, "processAlive": false, "shared": false,
                           "sleep": true, "rpc": true, "bridge": true}),
                );
            }
            Value::Object(facts)
        }
        "window" => json!({"destroyed": false, "web": false}),
        "decide" => json!("wait"),
        "start" => {
            STARTED.with(|started| {
                started
                    .borrow_mut()
                    .insert(item["tab"].as_str().unwrap().to_string())
            });
            Value::Null
        }
        _ => Value::Null,
    }
}

impl Main {
    async fn start(opts: Value) -> Main {
        let (client, server_io) = tokio::io::duplex(1 << 20);
        let (server_read, server_write) = tokio::io::split(server_io);
        tokio::spawn(crate::hub::serve_conn(server_read, server_write, None));
        let (read, write) = tokio::io::split(client);
        let instance = NEXT_INSTANCE.fetch_add(1, Ordering::SeqCst);
        let mut main = Main {
            write,
            lines: BufReader::new(read),
            instance,
            next: 0,
            items: Vec::new(),
            asked: Vec::new(),
            answer: Box::new(default_answer),
        };
        main.request(
            "hub.open",
            json!({"id": instance, "kind": "pool", "opts": opts}),
        )
        .await;
        main
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let id = self.next;
        let line = json!({"id": id, "method": method, "params": params}).to_string() + "\n";
        self.write.write_all(line.as_bytes()).await.unwrap();
        loop {
            let mut line = String::new();
            assert!(
                self.lines.read_line(&mut line).await.unwrap() > 0,
                "the core ended"
            );
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["id"] == id {
                assert_eq!(frame["ok"], true, "{method} failed: {frame}");
                return frame["result"].clone();
            }
            if frame["event"] == "hub.out" {
                for item in frame["data"]["items"].as_array().unwrap() {
                    if item["k"] == "ask" {
                        let q = item["q"].as_str().unwrap().to_string();
                        self.asked.push((q.clone(), item.clone()));
                        let value = (self.answer)(&q, item);
                        self.next += 1;
                        let reply = json!({"id": self.next, "method": "hub.answer",
                                           "params": {"ask": item["ask"], "value": value}})
                        .to_string()
                            + "\n";
                        self.write.write_all(reply.as_bytes()).await.unwrap();
                    } else {
                        self.items.push(item.clone());
                    }
                }
            }
        }
    }

    async fn call(&mut self, method: &str, mut params: Value) -> Value {
        params["now"] = json!(1_000);
        let to = self.instance;
        self.request(
            "hub.call",
            json!({"to": to, "method": method, "params": params}),
        )
        .await
    }

    async fn acquire(&mut self, tab: &str, win: i64, session: Option<&str>, defer: bool) -> Value {
        self.call(
            "acquire",
            json!({"cwd": "/work", "win": win, "tab": tab, "sessionPath": session, "kind": "agent",
                   "deferStart": defer}),
        )
        .await
    }

    /// The `send` items on `channel` so far, as `(windows, data)`.
    fn sends(&self, channel: &str) -> Vec<(Vec<i64>, Value)> {
        self.items
            .iter()
            .filter(|item| item["k"] == "send" && item["channel"] == channel)
            .map(|item| {
                let wins = item["wins"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_i64)
                    .collect();
                (wins, item["data"].clone())
            })
            .collect()
    }

    fn asks(&self, q: &str) -> usize {
        self.asked.iter().filter(|(asked, _)| asked == q).count()
    }
}

fn opts() -> Value {
    json!({"layoutVersion": 1, "maxFormerTabIds": 8, "stopSessionWaitMs": 60_000})
}

#[tokio::test]
async fn the_first_tab_of_a_window_is_active_wired_and_started_and_owns_its_session() {
    let mut main = Main::start(opts()).await;
    let result = main.acquire("a", 1, Some("/s/a.jsonl"), false).await;
    assert_eq!(result, json!({"ok": true, "added": true}));
    main.acquire("b", 1, None, false).await;
    let order: Vec<&str> = main.asked.iter().map(|(q, _)| q.as_str()).collect();
    // Blocked, the sidecar and its hook first, as the TypeScript's order was.
    assert_eq!(&order[..3], ["blocked", "spawn", "acquired"]);
    // Neither is deferred, so both start (the second one hidden, in the background).
    assert_eq!(main.asks("start"), 2);
    assert_eq!(
        main.call("sessionOwner", json!({"path": "/s/a.jsonl"}))
            .await,
        json!({"tabId": "a", "winId": 1})
    );
    let tabs = main.call("tabsForWindow", json!({"win": 1})).await;
    assert_eq!(tabs[0]["active"], true);
    assert_eq!(tabs[0]["visible"], true);
    assert!(tabs[1].get("active").is_none());
    assert_eq!(tabs[1]["unstarted"], true);
    assert!(
        main.items
            .iter()
            .any(|item| item["k"] == "wireFull" && item["tab"] == "a")
    );
    assert!(
        !main
            .items
            .iter()
            .any(|item| item["k"] == "wireFull" && item["tab"] == "b")
    );
}

#[tokio::test]
async fn a_deleted_session_or_a_failed_sidecar_is_no_tab() {
    let mut main = Main::start(opts()).await;
    main.answer = Box::new(|q, item| match q {
        "blocked" => json!(item["sessionPath"] == "/s/gone.jsonl"),
        "spawn" => panic!("never asked for a blocked tab"),
        other => default_answer(other, item),
    });
    let result = main.acquire("a", 1, Some("/s/gone.jsonl"), false).await;
    assert_eq!(result, json!({"ok": false, "added": false}));
    assert_eq!(main.call("size", json!({})).await, 0);
    main.answer = Box::new(|q, item| {
        if q == "spawn" {
            // A factory that throws is an ask main answers with an error; the scripted main cannot, so it asks nothing
            // more of the tab: this checks only that a refused spawn leaves no entry.
            return json!({"status": "starting"});
        }
        default_answer(q, item)
    });
    assert_eq!(main.acquire("b", 1, None, false).await["ok"], true);
}

#[tokio::test]
async fn the_status_of_a_ready_tab_with_a_run_reads_running_and_its_end_is_announced() {
    let mut main = Main::start(opts()).await;
    main.acquire("a", 1, Some("/s/a.jsonl"), false).await;
    let feed =
        |event: &str, payload: Value| json!({"tab": "a", "event": event, "payload": payload});
    main.call(
        "feed",
        feed("status", json!({"status": "ready", "failure": null})),
    )
    .await;
    main.call("feed", feed("events", json!([{"type": "agent_start"}])))
        .await;
    let last = main.sends("TAB_STATUS").pop().unwrap();
    assert_eq!(last.0, vec![1]);
    assert_eq!(last.1["status"], "running");
    assert_eq!(last.1["runningSince"], 1_000);
    let before = main.asks("announce");
    main.call(
        "feed",
        feed(
            "events",
            json!([{"type": "agent_end", "messages": [
                {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": " done \n"}]}]}]),
        ),
    )
    .await;
    let announced = &main
        .asked
        .iter()
        .filter(|(q, _)| q == "announce")
        .nth(before)
        .unwrap()
        .1;
    assert_eq!(
        announced["activity"],
        json!({"type": "idle", "tabId": "a", "outcome": {"stopReason": "stop", "reply": "done"}})
    );
    let facts = main.call("resumeFacts", json!({})).await;
    assert_eq!(facts[0]["running"], false);
    assert_eq!(facts[0]["lastRun"]["reply"], "done");
    assert_eq!(main.sends("TAB_STATUS").pop().unwrap().1["status"], "ready");
}

#[tokio::test]
async fn a_window_that_closes_releases_its_tabs_in_the_order_they_came_and_a_viewer_leaves() {
    let mut main = Main::start(opts()).await;
    main.acquire("a", 1, None, false).await;
    main.acquire("b", 1, None, false).await;
    main.acquire("c", 2, None, false).await;
    assert_eq!(
        main.call("attachViewer", json!({"win": 1, "tab": "c"}))
            .await,
        true
    );
    // One listener per window, whatever its tabs and viewers.
    let listened: Vec<i64> = main
        .items
        .iter()
        .filter(|item| item["k"] == "listenClosed")
        .filter_map(|item| item["win"].as_i64())
        .collect();
    assert_eq!(listened, vec![1, 2]);
    main.call("windowClosed", json!({"win": 1})).await;
    let disposed: Vec<&str> = main
        .asked
        .iter()
        .filter(|(q, _)| q == "dispose")
        .filter_map(|(_, item)| item["tab"].as_str())
        .collect();
    assert_eq!(disposed, vec!["a", "b"]);
    assert_eq!(main.call("size", json!({})).await, 1);
    assert_eq!(
        main.call("windowsShowingTab", json!({"tab": "c"})).await,
        json!([2])
    );
    assert_eq!(main.call("releaseTab", json!({"tab": "a"})).await, false);
}

#[tokio::test]
async fn a_request_routes_back_to_the_tab_that_raised_it_and_the_first_answer_of_a_shared_tab_wins()
{
    let mut main = Main::start(opts()).await;
    main.acquire("a", 1, None, false).await;
    main.acquire("b", 1, None, false).await;
    main.call("attachViewer", json!({"win": 2, "tab": "a"}))
        .await;
    let request =
        json!({"type": "extension_ui_request", "id": "r1", "method": "confirm", "title": "Go?"});
    main.call(
        "feed",
        json!({"tab": "a", "event": "extensionUi",
               "payload": {"request": request, "kinds": {"blocking": true, "signIn": false, "approval": false}}}),
    )
    .await;
    // The owner and the viewer both hear it; it is open for a page that loads later, in either window.
    assert_eq!(main.sends("EXTENSION_UI").last().unwrap().0, vec![1, 2]);
    assert_eq!(
        main.call("openRequests", json!({"win": 2})).await[0]["tabId"],
        "a"
    );
    assert_eq!(
        main.call("resumeFacts", json!({})).await[0]["awaitingUi"],
        true
    );
    // The window 2 answers first (the frame goes through main's sidecar: the scripted main answers at once).
    main.call(
        "routeSideChannel",
        json!({"token": 1, "id": "r1", "frame": {"id": "r1"}, "responder": 2, "choice": "yes"}),
    )
    .await;
    let settled = |main: &Main, token: u64| {
        main.items
            .iter()
            .find(|item| item["k"] == "settle" && item["token"] == token)
            .cloned()
    };
    // `ask_later` is answered by the same loop, so settle arrives with a later call.
    for _ in 0..10 {
        main.call("size", json!({})).await;
    }
    assert_eq!(settled(&main, 1).unwrap()["value"], true);
    // The owner's card closes through a synthetic cancel; the answering window's does not.
    let cancel = main.sends("EXTENSION_UI").pop().unwrap();
    assert_eq!(cancel.0, vec![1]);
    assert_eq!(cancel.1["answeredElsewhere"], true);
    assert_eq!(cancel.1["request"]["targetId"], "r1");
    // A later answer from the other window is refused, as a second answer of the same window is not.
    main.call(
        "routeSideChannel",
        json!({"token": 2, "id": "r1", "frame": {"id": "r1"}, "responder": 1, "choice": "no"}),
    )
    .await;
    for _ in 0..10 {
        main.call("size", json!({})).await;
    }
    let refused = settled(&main, 2).unwrap();
    assert_eq!(refused["ok"], false);
    assert_eq!(refused["code"], "already_answered");
    assert_eq!(
        main.call("openRequests", json!({"win": 1})).await,
        json!([])
    );
}

#[tokio::test]
async fn a_restart_of_the_omp_takes_the_run_and_the_asks_of_its_tab_with_it() {
    let mut main = Main::start(opts()).await;
    main.acquire("a", 1, None, false).await;
    let feed =
        |event: &str, payload: Value| json!({"tab": "a", "event": event, "payload": payload});
    main.call(
        "feed",
        feed("status", json!({"status": "ready", "failure": null})),
    )
    .await;
    main.call("feed", feed("events", json!([{"type": "agent_start"}])))
        .await;
    let request = json!({"type": "extension_ui_request", "id": "r1", "method": "confirm"});
    main.call(
        "feed",
        feed("extensionUi", json!({"request": request, "kinds": {"blocking": true, "signIn": false, "approval": false}})),
    )
    .await;
    main.call(
        "feed",
        feed(
            "status",
            json!({"status": "restarting", "failure": {"message": "died"}}),
        ),
    )
    .await;
    let facts = main.call("resumeFacts", json!({})).await;
    assert_eq!(facts[0]["running"], false);
    assert_eq!(facts[0]["awaitingUi"], false);
    assert_eq!(facts[0]["exits"], 1);
    let status = main.sends("TAB_STATUS").pop().unwrap().1;
    assert_eq!(status["status"], "restarting");
    assert_eq!(status["message"], "died");
}

#[tokio::test]
async fn a_saved_layout_restores_its_tabs_and_splits_and_what_is_saved_matches_what_was_restored() {
    let mut main = Main::start(opts()).await;
    let mut snowflake = 0;
    main.answer = Box::new(move |q, item| {
        if q == "snowflake" {
            snowflake += 1;
            return json!(format!("t{snowflake}"));
        }
        default_answer(q, item)
    });
    let layout = json!({
        "version": 1, "activeIndex": 1,
        "tabs": [
            {"cwd": "/work", "kind": "agent", "sessionPath": "/s/a.jsonl"},
            {"cwd": "/work", "kind": "agent", "sessionPath": "/s/b.jsonl"},
            {"cwd": "/work", "kind": "agent", "sessionPath": "/s/c.jsonl"},
        ],
        "split": {"axis": "columns", "ratio": 0.4, "first": {"tabId": "0"}, "second": {"tabId": "1"}},
    });
    assert_eq!(
        main.call("restoreLayout", json!({"win": 1, "layout": layout}))
            .await,
        3
    );
    let tabs = main.call("tabsForWindow", json!({"win": 1})).await;
    assert_eq!(tabs[0]["tabId"], "t1");
    assert_eq!(tabs[1]["active"], true);
    assert_eq!(tabs[0]["split"]["ratio"], 0.4);
    assert!(tabs[2].get("visible").is_none());
    // Only the panes the view shows get a process.
    assert_eq!(main.asks("start"), 2);
    let saved = main.call("tabLayoutForWindow", json!({"win": 1})).await;
    assert_eq!(saved["activeIndex"], 1);
    assert_eq!(saved["split"], layout["split"]);
    assert_eq!(saved["tabs"][2]["formerIds"], json!(["t3"]));
}

#[tokio::test]
async fn a_new_core_is_seeded_with_the_tabs_main_holds() {
    let mut main = Main::start(opts()).await;
    main.call(
        "seed",
        json!({"tabs": [
            {"tab": "a", "win": 1, "device": null, "hosted": false, "kind": "agent", "status": "ready", "full": [1], "views": []},
            {"tab": "b", "win": 1, "device": "host", "hosted": false, "kind": "chat", "status": "asleep", "full": [], "views": []},
        ]}),
    )
    .await;
    assert_eq!(main.call("tabIds", json!({})).await, json!(["a", "b"]));
    assert_eq!(
        main.call("activeTabForWindow", json!({"win": 1})).await,
        "a"
    );
    let tabs = main.call("tabsForWindow", json!({"win": 1})).await;
    assert_eq!(tabs[1]["device"], "host");
    assert_eq!(tabs[1]["kind"], "chat");
    // The window's closing still releases what was seeded.
    main.call("windowClosed", json!({"win": 1})).await;
    assert_eq!(main.call("size", json!({})).await, 0);
}
