//! What the research omp is started with, what it is sent and what it prints (were `modelSetupArgs`,
//! `modelSetupInput` and `ResearchStream` of `src/main/model-setup-runner.ts`). The stream is stock RPC mode's JSON
//! lines (`rpc-types.ts`, pi-agent-core `AgentEvent`): the latest tool call for the progress line, the last assistant
//! reply, and the `prompt_result` that ends the run. A frame counts only when every field read here has the type the
//! TypeScript's zod schema asked for; anything else is skipped. Pinned by rows captured from the TypeScript
//! (`captured.json`).

use serde::Serialize;
use serde_json::{Map, Value};

use crate::fs::order::js_trim;
use crate::json::{utf16_prefix, whole_surrogates};

const PROMPT_ID: &str = "model-setup";
const EVENTS_ID: &str = "events";
/// Session events the run reads; message deltas and tool output stay in omp.
const EVENTS: [&str; 2] = ["tool_execution_start", "message_end"];
/// The longest progress detail, in UTF-16 units.
const DETAIL_UNITS: usize = 200;

/// Stock argv for the research job: no session file, research tools only, nothing user-installed loaded.
pub fn args(research_model: &str) -> [&str; 14] {
    [
        "--mode",
        "rpc",
        "--no-session",
        "--model",
        research_model,
        "--thinking",
        "auto",
        "--tools",
        "web_search,read",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-lsp",
        "--no-title",
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventFilter {
    id: &'static str,
    r#type: &'static str,
    events: [&'static str; 2],
    message_updates: &'static str,
}

#[derive(Serialize)]
struct Prompt<'a> {
    id: &'static str,
    r#type: &'static str,
    message: &'a str,
}

/// The stdin frames: only the events the run reads, then the prompt.
pub fn input(prompt: &str) -> serde_json::Result<String> {
    let filter = EventFilter {
        id: EVENTS_ID,
        r#type: "set_event_filter",
        events: EVENTS,
        message_updates: "delta",
    };
    let prompt = Prompt {
        id: PROMPT_ID,
        r#type: "prompt",
        message: prompt,
    };
    let filter = serde_json::to_string(&filter)?;
    let prompt = serde_json::to_string(&prompt)?;
    Ok(format!("{filter}\n{prompt}\n"))
}

/// The tool call the run is on, for the progress line.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Activity {
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// How the run ended, from its `prompt_result` (or the reply that failed).
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Reply(String),
    Failed(String),
}

/// A frame with a field of another type than the stream's.
struct Invalid;

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, Invalid> {
    object.get(key).and_then(Value::as_str).ok_or(Invalid)
}

/// An optional text field: absent is none, `null` or another type fails the frame.
fn optional_text<'a>(
    object: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, Invalid> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(Invalid),
    }
}

/// The stock frames the run reads.
enum Frame<'a> {
    ToolStart {
        tool: &'a str,
        args: Option<&'a Map<String, Value>>,
        intent: Option<&'a str>,
    },
    MessageEnd {
        role: &'a str,
        content: Option<&'a Value>,
        stop_reason: Option<&'a str>,
        error_message: Option<&'a str>,
    },
    Response {
        id: Option<&'a str>,
        success: bool,
        error: Option<&'a str>,
    },
    PromptResult {
        id: Option<&'a str>,
        status: &'a str,
        error: Option<&'a str>,
    },
    Other,
}

impl<'a> Frame<'a> {
    fn read(frame: &'a Map<String, Value>) -> Result<Frame<'a>, Invalid> {
        Ok(match text(frame, "type")? {
            "tool_execution_start" => Frame::ToolStart {
                tool: text(frame, "toolName")?,
                args: match frame.get("args") {
                    None => None,
                    Some(Value::Object(args)) => Some(args),
                    Some(_) => return Err(Invalid),
                },
                intent: optional_text(frame, "intent")?,
            },
            "message_end" => {
                let Some(Value::Object(message)) = frame.get("message") else {
                    return Err(Invalid);
                };
                Frame::MessageEnd {
                    role: text(message, "role")?,
                    content: match message.get("content") {
                        None => None,
                        Some(content @ (Value::String(_) | Value::Array(_))) => Some(content),
                        Some(_) => return Err(Invalid),
                    },
                    stop_reason: optional_text(message, "stopReason")?,
                    error_message: optional_text(message, "errorMessage")?,
                }
            }
            "response" => Frame::Response {
                id: optional_text(frame, "id")?,
                success: frame
                    .get("success")
                    .and_then(Value::as_bool)
                    .ok_or(Invalid)?,
                error: optional_text(frame, "error")?,
            },
            "prompt_result" => Frame::PromptResult {
                id: optional_text(frame, "id")?,
                status: text(frame, "status")?,
                error: match frame.get("error") {
                    None => None,
                    Some(Value::Object(error)) => Some(text(error, "message")?),
                    Some(_) => return Err(Invalid),
                },
            },
            _ => Frame::Other,
        })
    }
}

/// The first of the call's intent, query, url and path that says something, trimmed and cut for one line.
fn activity(tool: &str, args: Option<&Map<String, Value>>, intent: Option<&str>) -> Activity {
    let arg = |name: &str| args.and_then(|args| args.get(name)).and_then(Value::as_str);
    let detail = [intent, arg("query"), arg("url"), arg("path")]
        .into_iter()
        .flatten()
        .map(js_trim)
        .find(|detail| !detail.is_empty())
        .map(|detail| {
            if detail.encode_utf16().count() > DETAIL_UNITS {
                format!("{}…", utf16_prefix(detail, DETAIL_UNITS - 1))
            } else {
                detail.to_owned()
            }
        });
    Activity {
        tool: tool.to_owned(),
        detail,
    }
}

/// The text parts of a message's content, joined.
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_object)
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

/// Reads the run's stdout one JSON line at a time.
#[derive(Default)]
pub struct Stream {
    pub activity: Option<Activity>,
    pub outcome: Option<Outcome>,
    /// The last assistant reply that said something.
    reply: String,
    /// Why the last assistant message failed.
    failure: Option<String>,
}

impl Stream {
    /// Takes one line; whether it was a tool call, so `activity` is new. Nothing is read past the outcome.
    pub fn push(&mut self, line: &str) -> bool {
        if self.outcome.is_some() {
            return false;
        }
        let Ok(Value::Object(frame)) = serde_json::from_str(&whole_surrogates(line)) else {
            return false;
        };
        let Ok(frame) = Frame::read(&frame) else {
            return false;
        };
        match frame {
            Frame::ToolStart { tool, args, intent } => {
                self.activity = Some(activity(tool, args, intent));
                return true;
            }
            Frame::MessageEnd {
                role: "assistant",
                content,
                stop_reason,
                error_message,
            } => {
                let text = content_text(content);
                if !js_trim(&text).is_empty() {
                    self.reply = text;
                }
                self.failure = match stop_reason {
                    Some(reason @ ("error" | "aborted")) => Some(
                        error_message
                            .filter(|message| !message.is_empty())
                            .map_or_else(|| format!("Request {reason}"), str::to_owned),
                    ),
                    _ => None,
                };
            }
            Frame::Response {
                id: Some(PROMPT_ID | EVENTS_ID),
                success: false,
                error,
            } => {
                let error = error.filter(|error| !error.is_empty());
                self.outcome = Some(Outcome::Failed(
                    error
                        .unwrap_or("omp rejected the research prompt")
                        .to_owned(),
                ));
            }
            Frame::PromptResult {
                id: Some(PROMPT_ID),
                status,
                error,
            } => {
                self.outcome = Some(match (status, &self.failure) {
                    ("completed", None) if js_trim(&self.reply).is_empty() => {
                        Outcome::Failed("The research model returned no reply".to_owned())
                    }
                    ("completed", None) => Outcome::Reply(std::mem::take(&mut self.reply)),
                    (status, failure) => Outcome::Failed(
                        error
                            .filter(|message| !message.is_empty())
                            .map(str::to_owned)
                            .or_else(|| failure.clone())
                            .unwrap_or_else(|| format!("Research {status}")),
                    ),
                });
            }
            Frame::MessageEnd { .. }
            | Frame::Response { .. }
            | Frame::PromptResult { .. }
            | Frame::Other => {}
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted. Half a
    /// surrogate pair it kept reads as U+FFFD here, as everywhere in the core.
    fn captured(table: &str) -> Vec<Value> {
        let rows: Value =
            serde_json::from_str(&whole_surrogates(include_str!("captured.json"))).unwrap();
        rows[table].as_array().unwrap().clone()
    }

    #[test]
    fn reads_the_stream_as_the_typescript_did() {
        let rows = captured("stream");
        assert_eq!(rows.len(), 93);
        for row in rows {
            let name = row["name"].as_str().unwrap();
            let mut stream = Stream::default();
            let lines = row["lines"].as_array().unwrap();
            let states = row["states"].as_array().unwrap();
            for (at, (line, want)) in lines.iter().zip(states).enumerate() {
                stream.push(line.as_str().unwrap());
                let activity = serde_json::to_value(&stream.activity).unwrap();
                let outcome = match &stream.outcome {
                    None => Value::Null,
                    Some(Outcome::Reply(text)) => serde_json::json!({ "ok": true, "text": text }),
                    Some(Outcome::Failed(error)) => {
                        serde_json::json!({ "ok": false, "error": error })
                    }
                };
                assert_eq!(activity, want["activity"], "{name}, line {at}: activity");
                assert_eq!(outcome, want["outcome"], "{name}, line {at}: outcome");
            }
        }
    }

    #[test]
    fn tells_a_tool_call_and_nothing_else() {
        let mut stream = Stream::default();
        assert!(stream.push(r#"{"type":"tool_execution_start","toolName":"read"}"#));
        assert!(!stream.push(r#"{"type":"tool_execution_start","toolName":5}"#));
        assert!(
            !stream.push(r#"{"type":"message_end","message":{"role":"assistant","content":"x"}}"#)
        );
        assert!(
            !stream.push(r#"{"type":"prompt_result","id":"model-setup","status":"completed"}"#)
        );
        assert!(!stream.push(r#"{"type":"tool_execution_start","toolName":"late"}"#));
        assert_eq!(stream.activity.unwrap().tool, "read");
    }

    #[test]
    fn starts_and_prompts_omp_as_the_typescript_did() {
        for row in captured("args") {
            let want: Vec<&str> = row["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap())
                .collect();
            assert_eq!(args(row["model"].as_str().unwrap()).to_vec(), want);
        }
        let rows = captured("input");
        assert_eq!(rows.len(), 2);
        for row in rows {
            assert_eq!(
                input(row["prompt"].as_str().unwrap()).unwrap(),
                row["input"]
            );
        }
    }
}
