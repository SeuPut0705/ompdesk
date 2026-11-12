//! The care requests, driven as main drives them: the TypeScript tests of `care.test.ts`, `backfill.test.ts`,
//! `curate.test.ts`, `memory-judge.test.ts` and `freshness.test.ts` as Rust tests of the same cases (their harness
//! now is a stand-in main: it answers the asks the requests list, as `core-asks.ts` does for the real ones).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

use super::{date_parse, register};
use crate::fs::disk::make_temp_dir;
use crate::server::Registry;

pub const SERVICE: &str = "care-test-1";
pub const HOUR: f64 = 60.0 * 60_000.0;
pub const DAY: f64 = 24.0 * HOUR;

/// `Date.parse` of a test's moment.
pub fn ms(iso: &str) -> f64 {
    date_parse(iso).unwrap() as f64
}

/// What a stand-in main answers an ask with.
pub enum Said {
    Value(Value),
    Error(&'static str),
    /// A test unit: it makes `calls` (`care.unitCall` members `op` and `args`) on its client, then answers.
    Unit {
        calls: Vec<Value>,
        answer: Value,
    },
    /// Answers nothing.
    Nothing,
}

/// A core over an in-process pipe, as main speaks to it.
pub struct Driver {
    /// The service name every request of this driver carries (one per driver: the services of a process share their
    /// memory, so tests that run side by side must not share a name).
    pub service: String,
    lines: BufReader<ReadHalf<DuplexStream>>,
    write: WriteHalf<DuplexStream>,
    id: u64,
    /// Every event but the asks (`upkeep.log`, ...), in order, over the driver's life.
    pub events: Vec<Value>,
    /// The `{kind, params}` of every ask, in order.
    pub asks: Vec<Value>,
    /// The answers to the `care.unitCall` requests a `Said::Unit` made, in order.
    pub unit_results: Vec<Value>,
}

impl Driver {
    pub async fn start() -> Driver {
        let (client, server) = tokio::io::duplex(1 << 22);
        let (server_read, server_write) = tokio::io::split(server);
        let mut registry = Registry::default();
        crate::upkeep::asks::register(&mut registry);
        register(&mut registry);
        tokio::spawn(crate::serve(server_read, server_write, registry));
        let (client_read, write) = tokio::io::split(client);
        static DRIVERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let service = format!(
            "{SERVICE}-{}",
            DRIVERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let mut driver = Driver {
            service,
            lines: BufReader::new(client_read),
            write,
            id: 0,
            events: Vec::new(),
            asks: Vec::new(),
            unit_results: Vec::new(),
        };
        assert_eq!(driver.next().await["event"], "ready");
        driver
    }

    async fn next(&mut self) -> Value {
        self.try_next(Duration::from_secs(120))
            .await
            .expect("the core sent nothing for 120 s")
    }

    /// The next frame, none when there is none in `wait`.
    pub async fn try_next(&mut self, wait: Duration) -> Option<Value> {
        let mut line = String::new();
        let read = tokio::time::timeout(wait, self.lines.read_line(&mut line))
            .await
            .ok()?;
        read.unwrap();
        Some(serde_json::from_str(&line).unwrap())
    }

    async fn send_frame(&mut self, frame: Value) {
        self.write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
    }

    /// Sends a request and answers its id; read its answer with `pump`.
    pub async fn send(&mut self, method: &str, params: Value) -> u64 {
        let mut params = params;
        if params.get("service").is_some() {
            params["service"] = json!(self.service);
        }
        self.id += 1;
        let id = self.id;
        self.send_frame(json!({ "id": id, "method": method, "params": params }))
            .await;
        id
    }

    /// Sends a request of its own and runs it to its answer, servicing every ask with `said`.
    pub async fn call(
        &mut self,
        method: &str,
        params: Value,
        said: &mut dyn FnMut(&Value) -> Said,
    ) -> Value {
        let id = self.send(method, params).await;
        self.pump(id, said).await
    }

    /// Reads frames until the answer of request `until`, servicing every ask with `said`.
    pub fn pump<'a>(
        &'a mut self,
        until: u64,
        said: &'a mut dyn FnMut(&Value) -> Said,
    ) -> Pin<Box<dyn Future<Output = Value> + 'a>> {
        Box::pin(async move {
            loop {
                let frame = self.next().await;
                if frame["id"] == json!(until) {
                    return frame;
                }
                if frame["event"] == "upkeep.ask" {
                    self.service(&frame["data"], said).await;
                } else if frame.get("event").is_some() {
                    self.events.push(frame);
                }
            }
        })
    }

    async fn service(&mut self, ask: &Value, said: &mut dyn FnMut(&Value) -> Said) {
        let asked = json!({ "kind": ask["kind"], "params": ask["params"] });
        self.asks.push(asked.clone());
        match said(&asked) {
            Said::Value(value) => self.answer(ask, true, value, "").await,
            Said::Error(error) => self.answer(ask, false, Value::Null, error).await,
            Said::Nothing => {}
            Said::Unit { calls, answer } => {
                for call in calls {
                    let mut params =
                        json!({ "service": self.service, "run": ask["params"]["run"] });
                    for (name, value) in call.as_object().unwrap() {
                        params[name] = value.clone();
                    }
                    let id = self.send("care.unitCall", params).await;
                    let response = self.pump(id, said).await;
                    self.unit_results.push(response);
                }
                self.answer(ask, true, answer, "").await;
            }
        }
    }

    async fn answer(&mut self, ask: &Value, ok: bool, value: Value, error: &str) {
        let params = if ok {
            json!({ "ask": ask["ask"], "ok": true, "value": value })
        } else {
            json!({ "ask": ask["ask"], "ok": false, "error": error })
        };
        self.send("upkeep.answer", params).await;
    }

    /// The runtime-log lines so far with this message.
    pub fn logs(&self, message: &str) -> Vec<Value> {
        self.events
            .iter()
            .filter(|event| {
                event["event"] == "upkeep.log" && event["data"]["message"] == json!(message)
            })
            .map(|event| event["data"]["details"].clone())
            .collect()
    }
}

/// The members every care request carries.
pub fn common(asks: &[&str], now: Option<f64>) -> Value {
    let mut params = json!({ "service": SERVICE, "asks": asks, "locale": "en-US" });
    if let Some(now) = now {
        params["now"] = json!(now);
    }
    params
}

/// `base` with the members of `extra` over it.
pub fn with(mut base: Value, extra: Value) -> Value {
    for (name, value) in extra.as_object().unwrap() {
        base[name] = value.clone();
    }
    base
}

/// A fresh folder for a test.
pub fn temp(name: &str) -> PathBuf {
    make_temp_dir(&format!("ompdesk-care-{name}-")).unwrap()
}

/// `answer` for one `client` ask: `{op, args}` of its params.
pub fn client_op(asked: &Value) -> Option<(&str, &Vec<Value>)> {
    (asked["kind"] == "client").then(|| {
        (
            asked["params"]["op"].as_str().unwrap(),
            asked["params"]["args"].as_array().unwrap(),
        )
    })
}

pub fn page_json(project: &str, path: &str, title: &str, id: &str) -> Value {
    json!({
        "workspace": "default", "project": project, "path": path, "title": title, "tier": "semantic",
        "updatedAt": null, "markdown": "", "id": id, "pinned": false, "createdAt": null, "tags": [],
    })
}

pub fn map(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

pub fn joined(base: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

pub fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

mod backfill_tests;
mod care_tests;
mod curate_tests;
mod freshness_tests;
mod judge_tests;
