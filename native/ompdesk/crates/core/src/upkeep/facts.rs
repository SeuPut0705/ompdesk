//! What the memory-prompt and the redactor know that the core does not copy: whether a prompt is an agent's, what a
//! page title it makes is, and what a stored conversation's journal says (the first prompt, the final replies). The
//! stock worker answers (`resources/gui-bridge/stock-helper/memory.ts`, which imports `memory-prompt.ts`), or, for a
//! test that handed in its own, main.
//!
//! A caller batches: one request carries every prompt it wants facts of.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::asks::Asker;
use crate::server::{Events, Fault};
use crate::stock::request_in_process;

/// A stock request that is not answered in this long fails, as `stockHelperRequest`'s default does.
const TIMEOUT: Duration = Duration::from_secs(30);

/// One prompt to ask about: the text exactly as the TypeScript caller passed it, and the omp session's own title
/// when it is the session's first prompt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptItem {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
}

/// What `memory-prompt.ts` says of one prompt.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptFacts {
    /// `isAgentPrompt(text)`.
    pub agent: bool,
    /// `isJunkTitle(text)`.
    pub junk: bool,
    /// `promptTitle(text, {sessionName})`.
    pub title: Option<String>,
    /// `explicitTitle(text)`.
    pub explicit: Option<String>,
    /// `unwrapPrompt(text).body`.
    pub body: String,
    /// `firstMeaningfulLine(text)`.
    pub first_line: Option<String>,
}

/// A run's final reply: when it was said (ms) and its excerpt.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Turn {
    pub at: f64,
    pub body: String,
}

/// What a stored conversation's journal gives backfill.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalFacts {
    pub first_prompt: Option<String>,
    pub turns: Vec<Turn>,
}

pub enum Facts {
    /// The stock worker of the app's helper `host`; a worker that is not running starts by asking main through
    /// `events`.
    Stock {
        host: String,
        events: Events,
    },
    Main(Asker),
}

fn another_shape(what: &str, error: &serde_json::Error) -> Fault {
    Fault::new(
        "memory_facts",
        format!("{what} answered another shape: {error}"),
    )
}

impl Facts {
    /// `Main` when `asks` lists `facts` or `journal` (a test that answers one answers both), else the stock worker
    /// of `host`.
    pub fn choose(asker: &Asker, asks: &[String], host: &str) -> Facts {
        if asks.iter().any(|kind| kind == "facts" || kind == "journal") {
            Facts::Main(asker.clone())
        } else {
            Facts::Stock {
                host: host.to_owned(),
                events: asker.events().clone(),
            }
        }
    }

    /// The facts of each item, in order.
    pub async fn prompts(&self, items: &[PromptItem]) -> Result<Vec<PromptFacts>, Fault> {
        let params = json!({ "items": items });
        let answer = match self {
            Facts::Stock { host, events } => {
                request_in_process(events, host, "memory.promptFacts", &params, TIMEOUT).await?
            }
            Facts::Main(asker) => asker.ask("facts", params).await?,
        };
        let facts: Vec<PromptFacts> =
            serde_json::from_value(answer).map_err(|error| another_shape("promptFacts", &error))?;
        if facts.len() != items.len() {
            return Err(Fault::new(
                "memory_facts",
                format!(
                    "promptFacts answered {} entries for {} prompts",
                    facts.len(),
                    items.len()
                ),
            ));
        }
        Ok(facts)
    }

    /// The first prompt and the final replies of the conversation stored at `path` (a session journal).
    pub async fn journal(&self, path: &str) -> Result<JournalFacts, Fault> {
        let answer = match self {
            Facts::Stock { host, events } => {
                request_in_process(
                    events,
                    host,
                    "memory.journal",
                    &json!({ "sessionPath": path }),
                    TIMEOUT,
                )
                .await?
            }
            Facts::Main(asker) => asker.ask("journal", json!({ "path": path })).await?,
        };
        serde_json::from_value::<JournalFacts>(answer)
            .map_err(|error| another_shape("journal", &error))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::super::asks::Asker;
    use super::super::asks::rig::{Rig, Said};
    use super::*;
    use crate::server::{Call, Reply};

    /// The worker the stock test starts: this test binary run on its one test below, which reads the worker's lines
    /// from stdin and answers them the way `memory.ts` does (by whatever it can say of a prompt without the
    /// memory-prompt: its text's first letter).
    #[test]
    fn stand_in_worker() {
        use std::io::{BufRead, Write};
        if std::env::var("OMPDESK_STAND_IN_WORKER").is_err() {
            return;
        }
        let stdout = std::io::stdout();
        for line in std::io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let id = request["id"].clone();
            let result = match request["method"].as_str().unwrap() {
                "memory.promptFacts" => {
                    let facts: Vec<Value> = request["params"]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|item| {
                            let text = item["text"].as_str().unwrap();
                            json!({
                                "agent": text.starts_with('<'), "junk": text.is_empty(),
                                "title": item["sessionName"], "explicit": null,
                                "body": text.trim(), "firstLine": text.lines().next(),
                            })
                        })
                        .collect();
                    json!(facts)
                }
                "memory.journal" => json!({
                    "firstPrompt": request["params"]["sessionPath"],
                    "turns": [{ "at": 1_700_000_000_123.0_f64, "body": "done" }],
                }),
                _ => json!(null),
            };
            let mut out = stdout.lock();
            // The harness has written "test ... " on this line already: a line of its own, as a worker's answer is.
            let _ = writeln!(out, "\n{}", json!({ "id": id, "result": result }));
            let _ = out.flush();
        }
    }

    /// A test method that asks `params.which` of the facts source the request chose.
    async fn facts(call: Call) -> Result<Reply, Fault> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            which: String,
            asks: Vec<String>,
            host: String,
            #[serde(default)]
            texts: Vec<String>,
            #[serde(default)]
            path: String,
        }
        let params: Params = call.params()?;
        let asker = Asker::new("facts-1", call.events.clone());
        let facts = Facts::choose(&asker, &params.asks, &params.host);
        match params.which.as_str() {
            "prompts" => {
                let items: Vec<PromptItem> = params
                    .texts
                    .into_iter()
                    .map(|text| PromptItem {
                        text,
                        session_name: Some("named".to_owned()),
                    })
                    .collect();
                Reply::json(&facts.prompts(&items).await?.len())
            }
            _ => {
                let journal = facts.journal(&params.path).await?;
                Reply::json(
                    &json!({ "firstPrompt": journal.first_prompt, "turns": journal.turns.len(), "at": journal.turns.first().map(|turn| turn.at) }),
                )
            }
        }
    }

    async fn rig() -> Rig {
        Rig::start(|registry| {
            registry.add("test.facts", |call| Box::pin(facts(call)));
            crate::stock::register(registry);
        })
        .await
    }

    fn one(text: &str) -> Value {
        json!({ "which": "prompts", "asks": ["facts", "journal"], "host": "h", "texts": [text] })
    }

    #[tokio::test]
    async fn main_answers_the_facts_of_a_batch_and_the_journal_of_a_path() {
        let mut rig = rig().await;
        let run = rig
            .run(
                "test.facts",
                json!({ "which": "prompts", "asks": ["facts"], "host": "h", "texts": ["a", "b"] }),
                |ask| {
                    assert_eq!(ask["kind"], "facts");
                    assert_eq!(
                        ask["params"],
                        json!({ "items": [
                            { "text": "a", "sessionName": "named" },
                            { "text": "b", "sessionName": "named" },
                        ] })
                    );
                    let fact = |body: &str| {
                        json!({
                            "agent": false, "junk": false, "title": "t", "explicit": null,
                            "body": body, "firstLine": null,
                        })
                    };
                    Said::Value(json!([fact("a"), fact("b")]))
                },
            )
            .await;
        assert_eq!(run.response["result"], 2);
        let run = rig
            .run(
                "test.facts",
                json!({ "which": "journal", "asks": ["journal"], "host": "h", "path": "C:/s/1.jsonl" }),
                |ask| {
                    assert_eq!(ask["kind"], "journal");
                    assert_eq!(ask["params"], json!({ "path": "C:/s/1.jsonl" }));
                    Said::Value(json!({
                        "firstPrompt": null,
                        "turns": [{ "at": 1_700_000_000_123.0_f64, "body": "x" }],
                    }))
                },
            )
            .await;
        assert_eq!(
            run.response["result"],
            json!({ "firstPrompt": null, "turns": 1, "at": 1_700_000_000_123.0_f64 }),
            "{}",
            run.response
        );
    }

    #[tokio::test]
    async fn a_batch_answered_with_another_count_or_shape_is_refused() {
        let mut rig = rig().await;
        let run = rig
            .run("test.facts", one("a"), |_| Said::Value(json!([])))
            .await;
        assert_eq!(run.response["error"]["code"], "memory_facts");
        let run = rig
            .run("test.facts", one("a"), |_| {
                Said::Value(json!({ "no": "list" }))
            })
            .await;
        assert_eq!(run.response["error"]["code"], "memory_facts");
        let run = rig
            .run("test.facts", one("a"), |_| Said::Error("no stock"))
            .await;
        assert_eq!(run.response["error"]["message"], "no stock");
    }

    /// The stock worker route: the core asks main to start the worker (`stock.launch`), which answers with a
    /// worker this test binary plays, and the requests go to it as lines.
    #[tokio::test]
    async fn the_stock_worker_answers_the_batch_and_the_journal() {
        let mut rig = rig().await;
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        env.insert("OMPDESK_STAND_IN_WORKER".to_owned(), "1".to_owned());
        let launch = |event: &Value| {
            if event["event"] != "stock.launch" {
                return None;
            }
            Some(json!({
                "method": "stock.launched",
                "params": {
                    "host": event["data"]["host"], "worker": event["data"]["worker"],
                    "launch": event["data"]["launch"],
                    "start": {
                        "bin": exe,
                        "args": ["--exact", "upkeep::facts::tests::stand_in_worker", "--nocapture", "--test-threads=1"],
                        "env": env,
                    },
                },
            }))
        };
        let run = rig
            .run_events(
                "test.facts",
                json!({ "which": "prompts", "asks": [], "host": "facts-test-host", "texts": ["<x>", "", "plain"] }),
                |_| Said::Nothing,
                launch,
            )
            .await;
        assert_eq!(
            run.response["result"], 3,
            "{} {:?} {:?}",
            run.response, run.events, run.replies
        );
        let run = rig
            .run_events(
                "test.facts",
                json!({ "which": "journal", "asks": [], "host": "facts-test-host", "path": "C:/s/2.jsonl" }),
                |_| Said::Nothing,
                launch,
            )
            .await;
        assert_eq!(
            run.response["result"],
            json!({ "firstPrompt": "C:/s/2.jsonl", "turns": 1, "at": 1_700_000_000_123.0_f64 })
        );
        let stopped = rig
            .run("stock.stop", json!({ "host": "facts-test-host" }), |_| {
                Said::Nothing
            })
            .await;
        assert_eq!(stopped.response["ok"], true);
    }
}
