use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::value::RawValue;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::oneshot;

use super::{Kind, Out, Outcome};

thread_local! {
    static PROBES: RefCell<HashMap<u64, Probe>> = RefCell::default();
}

struct Probe {
    out: Out,
    waiting: Option<oneshot::Sender<()>>,
}

pub const PROBE_KIND: Kind = Kind {
    name: "test:probe",
    open: |id, _, out| {
        PROBES.with(|probes| probes.borrow_mut().insert(id, Probe { out, waiting: None }));
        Ok(())
    },
    call: probe_call,
    close: |id| {
        PROBES.with(|probes| probes.borrow_mut().remove(&id));
    },
};

fn out_of(id: u64) -> Out {
    PROBES.with(|probes| probes.borrow()[&id].out)
}

fn probe_call(id: u64, method: &str, params: &RawValue) -> Outcome {
    let params: Value = serde_json::from_str(params.get()).unwrap_or(Value::Null);
    let out = out_of(id);
    match method {
        // Pushes its items, then answers.
        "push" => {
            out.push(&json!({"k": "n", "n": params["n"]}));
            Outcome::ok(&params["n"])
        }
        // Answers once `fire` came; its continuation tells main first.
        "wait" => {
            let (fire, fired) = oneshot::channel();
            PROBES.with(|probes| probes.borrow_mut().get_mut(&id).unwrap().waiting = Some(fire));
            Outcome::Later(Box::pin(async move {
                let _ = fired.await;
                out.push(&json!({"k": "woke"}));
                Ok(json!("woke"))
            }))
        }
        "fire" => {
            let waiting =
                PROBES.with(|probes| probes.borrow_mut().get_mut(&id).unwrap().waiting.take());
            if let Some(waiting) = waiting {
                let _ = waiting.send(());
            }
            Outcome::done()
        }
        "mark" => {
            out.push(&json!({"k": "mark"}));
            Outcome::done()
        }
        // Asks main and answers what main said.
        "ask" => Outcome::Later(Box::pin(async move {
            let answer = out.ask("probe", &json!({"x": 1})).await?;
            Ok(answer)
        })),
        _ => Outcome::fault("no_method", method.to_string()),
    }
}

struct Client {
    write: WriteHalf<DuplexStream>,
    lines: BufReader<ReadHalf<DuplexStream>>,
    /// Every frame read, in order.
    frames: Vec<Value>,
}

impl Client {
    fn start() -> Client {
        let (client, server_io) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server_io);
        tokio::spawn(crate::serve(server_read, server_write, crate::registry()));
        let (read, write) = tokio::io::split(client);
        Client {
            write,
            lines: BufReader::new(read),
            frames: Vec::new(),
        }
    }

    async fn send(&mut self, id: u64, method: &str, params: Value) {
        let line = json!({"id": id, "method": method, "params": params}).to_string() + "\n";
        self.write.write_all(line.as_bytes()).await.unwrap();
    }

    /// Reads frames until request `id` answered; its answer.
    async fn until_answer(&mut self, id: u64) -> Value {
        loop {
            if let Some(found) = self.frames.iter().find(|frame| frame["id"] == id) {
                return found.clone();
            }
            let mut line = String::new();
            assert!(
                self.lines.read_line(&mut line).await.unwrap() > 0,
                "the core ended"
            );
            self.frames.push(serde_json::from_str(&line).unwrap());
        }
    }

    /// The item kinds and values instance `to` sent so far, in order.
    fn items(&self, to: u64) -> Vec<Value> {
        self.frames
            .iter()
            .filter(|frame| frame["event"] == "hub.out" && frame["data"]["to"] == to)
            .flat_map(|frame| {
                frame["data"]["items"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .collect()
    }

    fn position(&self, predicate: impl Fn(&Value) -> bool) -> usize {
        self.frames.iter().position(predicate).expect("frame")
    }
}

#[tokio::test]
async fn an_answer_comes_after_the_items_its_request_made() {
    let mut client = Client::start();
    client
        .send(1, "hub.open", json!({"id": 9001, "kind": "test:probe"}))
        .await;
    client
        .send(
            2,
            "hub.call",
            json!({"to": 9001, "method": "push", "params": {"n": 7}}),
        )
        .await;
    let answer = client.until_answer(2).await;
    assert_eq!(answer["result"], 7);
    let item = client.position(|frame| frame["event"] == "hub.out" && frame["data"]["to"] == 9001);
    let reply = client.position(|frame| frame["id"] == 2);
    assert!(item < reply);
    assert_eq!(client.items(9001), vec![json!({"k": "n", "n": 7})]);
}

#[tokio::test]
async fn what_a_job_woke_runs_before_the_next_job() {
    let mut client = Client::start();
    client
        .send(1, "hub.open", json!({"id": 9002, "kind": "test:probe"}))
        .await;
    client
        .send(2, "hub.call", json!({"to": 9002, "method": "wait"}))
        .await;
    client
        .send(3, "hub.call", json!({"to": 9002, "method": "fire"}))
        .await;
    client
        .send(4, "hub.call", json!({"to": 9002, "method": "mark"}))
        .await;
    client.until_answer(4).await;
    client.until_answer(2).await;
    assert_eq!(
        client.items(9002),
        vec![json!({"k": "woke"}), json!({"k": "mark"})]
    );
}

#[tokio::test]
async fn an_ask_waits_for_mains_answer() {
    let mut client = Client::start();
    client
        .send(1, "hub.open", json!({"id": 9003, "kind": "test:probe"}))
        .await;
    client
        .send(2, "hub.call", json!({"to": 9003, "method": "ask"}))
        .await;
    let ask = loop {
        let items = client.items(9003);
        if let Some(ask) = items.into_iter().find(|item| item["k"] == "ask") {
            break ask;
        }
        let mut line = String::new();
        client.lines.read_line(&mut line).await.unwrap();
        client.frames.push(serde_json::from_str(&line).unwrap());
    };
    assert_eq!(ask["q"], "probe");
    assert_eq!(ask["x"], 1);
    client
        .send(3, "hub.answer", json!({"ask": ask["ask"], "value": "yes"}))
        .await;
    assert_eq!(client.until_answer(2).await["result"], "yes");
}

#[tokio::test]
async fn closing_answers_the_open_and_fails_its_asks() {
    let mut client = Client::start();
    client
        .send(1, "hub.open", json!({"id": 9004, "kind": "test:probe"}))
        .await;
    client
        .send(2, "hub.call", json!({"to": 9004, "method": "ask"}))
        .await;
    client.send(3, "hub.close", json!({"id": 9004})).await;
    assert_eq!(client.until_answer(1).await["ok"], true);
    client.until_answer(3).await;
    client
        .send(4, "hub.call", json!({"to": 9004, "method": "mark"}))
        .await;
    assert_eq!(client.until_answer(4).await["error"]["code"], "no_instance");
}
