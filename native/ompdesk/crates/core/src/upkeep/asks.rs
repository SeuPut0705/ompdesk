//! What the core asks main (`src/main/ai-memory/core-asks.ts` answers): the memory client's methods, the prompt facts,
//! the model, and the runtime-log lines.
//!
//! The event `upkeep.ask` `{service, ask, kind, params}` goes to main, which answers with the request `upkeep.answer`
//! `{ask, ok: true, value}` or `{ask, ok: false, error}`. An ask has no timeout of its own: the request that asks
//! bounds it, and dropping the asking future (the request was cancelled) forgets the ask, so an answer that comes
//! later finds nothing and is answered `null`. The event `upkeep.log` `{service, message, details}` is one runtime-log
//! line; it is sent before the answer of the request it belongs to, so main logs the lines in the order the
//! TypeScript did.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::server::{Call, Events, Fault, Registry, Reply};

/// What main answered: the value, or its refusal's message.
type Answered = Result<Value, String>;

/// The asks waiting for main, by number. One sequence for the process, so no two asks share a number.
static WAITING: LazyLock<Mutex<HashMap<u64, oneshot::Sender<Answered>>>> =
    LazyLock::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn waiting() -> MutexGuard<'static, HashMap<u64, oneshot::Sender<Answered>>> {
    WAITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Forgets an ask when the future that waits for it ends, answered or dropped.
struct Forget(u64);

impl Drop for Forget {
    fn drop(&mut self) {
        waiting().remove(&self.0);
    }
}

#[derive(Serialize)]
struct Ask<'a> {
    service: &'a str,
    ask: u64,
    kind: &'a str,
    params: &'a Value,
}

#[derive(Serialize)]
struct Log<'a> {
    service: &'a str,
    message: &'a str,
    details: &'a Value,
}

/// What one service asks of main, over the connection its request came in on.
#[derive(Clone)]
pub struct Asker {
    service: String,
    events: Events,
}

impl Asker {
    pub fn new(service: impl Into<String>, events: Events) -> Asker {
        Asker {
            service: service.into(),
            events,
        }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    pub fn events(&self) -> &Events {
        &self.events
    }

    /// Asks main for `kind` and waits for its answer. A refusal is a fault whose message is exactly main's `error`
    /// (the TypeScript callers read `error.message`), code `memory_main`.
    pub async fn ask(&self, kind: &str, params: Value) -> Result<Value, Fault> {
        let number = NEXT.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        // Registered before main hears of it, so an answer never finds nothing.
        waiting().insert(number, answer);
        let _forget = Forget(number);
        self.events.send(
            "upkeep.ask",
            &Ask {
                service: &self.service,
                ask: number,
                kind,
                params: &params,
            },
        );
        match answered.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(Fault::new("memory_main", message)),
            Err(_) => Err(Fault::cancelled()),
        }
    }

    /// One runtime-log line for main to write. `details` holds strings, numbers, booleans and nulls.
    pub fn log(&self, message: &str, details: Value) {
        self.events.send(
            "upkeep.log",
            &Log {
                service: &self.service,
                message,
                details: &details,
            },
        );
    }
}

#[derive(Deserialize)]
struct Answer {
    ask: u64,
    ok: bool,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    error: Option<String>,
}

/// `upkeep.answer`: hands main's answer to the request that asked. An ask nobody waits for any more (its request
/// was cancelled) is dropped.
async fn answer(call: Call) -> Result<Reply, Fault> {
    let Answer {
        ask,
        ok,
        value,
        error,
    } = call.params()?;
    let waiter = waiting().remove(&ask);
    if let Some(waiter) = waiter {
        let _ = waiter.send(if ok {
            Ok(value)
        } else {
            Err(error.unwrap_or_default())
        });
    }
    Reply::json(&Value::Null)
}

pub fn register(registry: &mut Registry) {
    registry.add("upkeep.answer", |call| Box::pin(answer(call)));
}

/// The core over an in-process pipe, as main speaks to it, for the tests of this module and its siblings.
#[cfg(test)]
pub(crate) mod rig {
    use std::time::Duration;

    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

    use crate::server::Registry;

    /// What a test answers an ask or another event with.
    pub enum Said {
        Value(Value),
        Error(&'static str),
        /// Withdraws the request that asked (the `cancel` frame), answers nothing.
        Cancel,
        /// Says nothing at all.
        Nothing,
    }

    /// What `Rig::run` saw until the request answered.
    pub struct Run {
        pub response: Value,
        /// Every event but the asks (`upkeep.log`, `stock.launch`, ...), in order.
        pub events: Vec<Value>,
        /// The `{kind, params}` of each ask, in order.
        pub asks: Vec<Value>,
        /// The answers to the requests the rig sent for the test (`upkeep.answer`, what an event was answered with).
        pub replies: Vec<Value>,
    }

    pub struct Rig {
        lines: BufReader<ReadHalf<DuplexStream>>,
        write: WriteHalf<DuplexStream>,
        id: u64,
    }

    impl Rig {
        /// A core serving what `register` adds (and `upkeep.answer`), after its `ready`.
        pub async fn start(register: impl FnOnce(&mut Registry)) -> Rig {
            let (client, server) = tokio::io::duplex(1 << 20);
            let (server_read, server_write) = tokio::io::split(server);
            let mut registry = Registry::default();
            super::register(&mut registry);
            register(&mut registry);
            tokio::spawn(crate::serve(server_read, server_write, registry));
            let (client_read, write) = tokio::io::split(client);
            let mut rig = Rig {
                lines: BufReader::new(client_read),
                write,
                id: 0,
            };
            assert_eq!(rig.next().await["event"], "ready");
            rig
        }

        async fn next(&mut self) -> Value {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(60), self.lines.read_line(&mut line))
                .await
                .expect("the core sent nothing for 60 s")
                .unwrap();
            serde_json::from_str(&line).unwrap()
        }

        async fn send(&mut self, frame: Value) {
            self.write
                .write_all(format!("{frame}\n").as_bytes())
                .await
                .unwrap();
        }

        /// Sends the request and answers each ask (`upkeep.ask`: `said` gets its `{kind, params}`) until the
        /// request's own answer comes. Other events are only collected.
        pub async fn run(
            &mut self,
            method: &str,
            params: Value,
            said: impl FnMut(&Value) -> Said,
        ) -> Run {
            self.run_events(method, params, said, |_| None).await
        }

        /// `run`, and `on_event` answers any other event with a request `{method, params}` of its own, as main
        /// answers `stock.launch` with `stock.launched`.
        pub async fn run_events(
            &mut self,
            method: &str,
            params: Value,
            mut said: impl FnMut(&Value) -> Said,
            mut on_event: impl FnMut(&Value) -> Option<Value>,
        ) -> Run {
            self.id += 1;
            let id = self.id;
            self.send(json!({ "id": id, "method": method, "params": params }))
                .await;
            let mut run = Run {
                response: Value::Null,
                events: Vec::new(),
                asks: Vec::new(),
                replies: Vec::new(),
            };
            loop {
                let frame = self.next().await;
                if frame["id"] == json!(id) {
                    run.response = frame;
                    return run;
                }
                if frame["event"] == "upkeep.ask" {
                    let data = &frame["data"];
                    run.asks
                        .push(json!({ "ask": data["ask"], "kind": data["kind"], "params": data["params"] }));
                    let ask = data["ask"].clone();
                    match said(&json!({ "kind": data["kind"], "params": data["params"] })) {
                        Said::Value(value) => {
                            self.reply(json!({ "ask": ask, "ok": true, "value": value }))
                                .await
                        }
                        Said::Error(error) => {
                            self.reply(json!({ "ask": ask, "ok": false, "error": error }))
                                .await
                        }
                        Said::Cancel => self.send(json!({ "cancel": id })).await,
                        Said::Nothing => {}
                    }
                } else if frame.get("event").is_some() {
                    if let Some(request) = on_event(&frame) {
                        self.id += 1;
                        let sent = json!({
                            "id": self.id,
                            "method": request["method"],
                            "params": request["params"],
                        });
                        self.send(sent).await;
                    }
                    run.events.push(frame);
                } else {
                    run.replies.push(frame);
                }
            }
        }

        async fn reply(&mut self, params: Value) {
            self.id += 1;
            let frame = json!({ "id": self.id, "method": "upkeep.answer", "params": params });
            self.send(frame).await;
        }

        /// Sends `upkeep.answer` as main would, on its own: the late answer of an ask nobody waits for.
        pub async fn late_answer(&mut self, ask: u64) -> Value {
            self.id += 1;
            let id = self.id;
            self.send(json!({
                "id": id, "method": "upkeep.answer",
                "params": { "ask": ask, "ok": true, "value": 1 },
            }))
            .await;
            loop {
                let frame = self.next().await;
                if frame["id"] == json!(id) {
                    return frame;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::rig::{Rig, Said};
    use super::*;

    /// A test method that asks main for `params.kind` and answers what it got: `{ok: value}` or `{error: message}`.
    async fn asking(call: Call) -> Result<Reply, Fault> {
        #[derive(Deserialize)]
        struct Params {
            kind: String,
            params: Value,
        }
        let Params { kind, params } = call.params()?;
        let asker = Asker::new("service-1", call.events.clone());
        asker.log(
            "before",
            json!({ "n": 1, "ok": true, "none": null, "s": "x" }),
        );
        tokio::select! {
            answer = asker.ask(&kind, params) => Reply::json(&answer?),
            () = call.scope.on_cancel() => Err(Fault::cancelled()),
        }
    }

    async fn rig() -> Rig {
        Rig::start(|registry| registry.add("test.ask", |call| Box::pin(asking(call)))).await
    }

    #[tokio::test]
    async fn an_answered_ask_gives_main_s_value_and_a_log_line_goes_first() {
        let mut rig = rig().await;
        let run = rig
            .run(
                "test.ask",
                json!({ "kind": "model", "params": { "a": [1, "b"] } }),
                |ask| {
                    assert_eq!(ask["kind"], "model");
                    assert_eq!(ask["params"], json!({ "a": [1, "b"] }));
                    Said::Value(json!({ "text": "ok" }))
                },
            )
            .await;
        assert_eq!(run.response["ok"], true);
        assert_eq!(run.response["result"], json!({ "text": "ok" }));
        assert_eq!(run.events.len(), 1);
        assert_eq!(run.events[0]["event"], "upkeep.log");
        assert_eq!(
            run.events[0]["data"],
            json!({
                "service": "service-1", "message": "before",
                "details": { "n": 1, "ok": true, "none": null, "s": "x" },
            })
        );
        assert_eq!(run.asks.len(), 1);
    }

    #[tokio::test]
    async fn a_refused_ask_fails_with_main_s_message_and_the_memory_main_code() {
        let mut rig = rig().await;
        let run = rig
            .run(
                "test.ask",
                json!({ "kind": "client", "params": {} }),
                |_| Said::Error("memory_write_page: precondition_failed"),
            )
            .await;
        assert_eq!(run.response["ok"], false);
        assert_eq!(run.response["error"]["code"], "memory_main");
        assert_eq!(
            run.response["error"]["message"],
            "memory_write_page: precondition_failed"
        );
    }

    #[tokio::test]
    async fn a_cancelled_ask_is_dropped_and_a_late_answer_finds_nothing() {
        let mut rig = rig().await;
        let run = rig
            .run("test.ask", json!({ "kind": "model", "params": {} }), |_| {
                Said::Cancel
            })
            .await;
        assert_eq!(run.response["ok"], false);
        assert_eq!(run.response["error"]["code"], "cancelled");
        let ask = run.asks[0]["ask"].as_u64().unwrap();
        assert!(!waiting().contains_key(&ask));
        let late = rig.late_answer(ask).await;
        assert_eq!(late["ok"], true);
        assert_eq!(late["result"], Value::Null);
    }

    #[tokio::test]
    async fn an_answer_for_an_ask_never_made_is_answered_null() {
        let mut rig = rig().await;
        let late = rig.late_answer(987_654_321).await;
        assert_eq!(late["ok"], true);
        assert_eq!(late["result"], Value::Null);
    }
}
