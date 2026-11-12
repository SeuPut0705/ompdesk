//! What main reads of a tab's frames (native-rust ledger, "Slim lane stream"). omp's `message_update` carries the whole
//! partial message twice, so main's parse of a reply grew with its square. The lane slims the stream as a host slims it
//! for a device ([`crate::remote::events::slim`]): the first update of each message whole, every later one reduced, and
//! the request bookkeeping left out of an update. Main rebuilds whole events with the link's decoder
//! (`createLinkEventDecoder`, `src/main/sidecar.ts` `#onFrame`) before anything there reads them. A subagent's event
//! stays as omp wrote it: the decoder cannot rebuild its snapshot, and a device older than `slimEvents` gets it whole.
//!
//! The decoder rebuilds a reduced update only on the whole one of its message, so a reduced update never goes where
//! main may lack that whole one: the slimmer starts over at the message's `message_end` and at `agent_end` (as the
//! decoder forgets its base), and when the lane tears its omp down (`Lane::cleanup`), which every command main fences
//! a frame out on (`restart`, `kill`, `sleep`, `dispose`) does first. A new lane (a new core) starts with a new one.

use std::borrow::Cow;

use serde_json::Value;

use crate::remote::events::js;
use crate::remote::events::slim::{Slimmer, without_frame_bookkeeping};

#[derive(Debug, Default)]
pub struct Stream {
    slim: Slimmer,
}

impl Stream {
    /// The next update of every message goes whole.
    pub fn reset(&mut self) {
        self.slim.reset();
    }

    /// The frame as main gets it: omp's line as it wrote it, or the slimmed frame's JSON text.
    pub fn frame(&mut self, raw: Vec<u8>, ty: Option<&str>) -> Vec<u8> {
        match ty {
            Some("message_update") => {
                let Ok(frame) = serde_json::from_slice::<Value>(&raw) else {
                    return raw;
                };
                let trimmed = without_frame_bookkeeping(&frame);
                let changed = trimmed.is_some();
                let frame = trimmed.unwrap_or(frame);
                match self.slim.slim(std::slice::from_ref(&frame)) {
                    Cow::Owned(slimmed) => slimmed
                        .first()
                        .map_or(raw, |slimmed| js::stringify(slimmed).into_bytes()),
                    Cow::Borrowed(_) if changed => js::stringify(&frame).into_bytes(),
                    Cow::Borrowed(_) => raw,
                }
            }
            Some("message_end" | "agent_end") => {
                self.slim.reset();
                raw
            }
            _ => raw,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::Stream;

    fn update(timestamp: u64, kind: &str, text: &str) -> Value {
        let message = json!({
            "role": "assistant", "content": [{ "type": "text", "text": text }], "api": "x", "timestamp": timestamp,
            "usage": { "input": 1 }, "inputTransformations": ["big"],
        });
        json!({
            "type": "message_update", "message": message,
            "assistantMessageEvent": { "type": kind, "contentIndex": 0, "delta": "b", "partial": message },
        })
    }

    fn pass(stream: &mut Stream, frame: &Value) -> Value {
        let ty = frame["type"].as_str();
        serde_json::from_slice(&stream.frame(frame.to_string().into_bytes(), ty)).unwrap()
    }

    #[test]
    fn the_first_update_of_a_message_goes_whole_without_bookkeeping_and_the_rest_reduced() {
        let mut stream = Stream::default();
        let first = pass(&mut stream, &update(7, "text_start", "a"));
        assert_eq!(
            first["message"]["content"],
            json!([{ "type": "text", "text": "a" }])
        );
        assert_eq!(first["message"]["api"], "x");
        assert!(first["message"].get("inputTransformations").is_none());
        assert!(
            first["assistantMessageEvent"]["partial"]
                .get("inputTransformations")
                .is_none()
        );
        let next = pass(&mut stream, &update(7, "text_delta", "ab"));
        assert_eq!(
            next,
            json!({
                "type": "message_update",
                "message": { "role": "assistant", "timestamp": 7, "usage": { "input": 1 } },
                "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "b" },
            })
        );
    }

    #[test]
    fn a_frame_with_nothing_to_slim_crosses_as_omp_wrote_it() {
        let mut stream = Stream::default();
        let raw = br#"{ "type": "message_update", "message": {"role":"assistant","content":[],"timestamp":1}, "assistantMessageEvent": {"type":"start","contentIndex":0} }"#;
        assert_eq!(stream.frame(raw.to_vec(), Some("message_update")), raw);
        let raw = br#"{ "type": "tool_execution_update", "toolCallId": "t" }"#;
        assert_eq!(
            stream.frame(raw.to_vec(), Some("tool_execution_update")),
            raw
        );
    }

    #[test]
    fn a_message_end_agent_end_or_reset_sends_the_next_update_whole_again() {
        for end in [
            Some(json!({ "type": "message_end", "message": {} })),
            Some(json!({ "type": "agent_end", "messages": [] })),
            None,
        ] {
            let mut stream = Stream::default();
            pass(&mut stream, &update(7, "text_start", "a"));
            match &end {
                Some(end) => {
                    pass(&mut stream, end);
                }
                None => stream.reset(),
            }
            let again = pass(&mut stream, &update(7, "text_delta", "ab"));
            assert_eq!(again["message"]["content"][0]["text"], "ab", "{end:?}");
        }
    }

    #[test]
    fn a_subagent_event_crosses_as_omp_wrote_it_and_leaves_the_tabs_slimmer_alone() {
        let mut stream = Stream::default();
        pass(&mut stream, &update(3, "text_start", "a"));
        let frame = json!({ "type": "subagent_event", "payload": { "id": "0-Explore", "event": update(3, "text_delta", "ab") } });
        let raw = frame.to_string().into_bytes();
        assert_eq!(stream.frame(raw.clone(), Some("subagent_event")), raw);
        let own = pass(&mut stream, &update(3, "text_delta", "ab"));
        assert!(own["message"].get("content").is_none());
    }
}
