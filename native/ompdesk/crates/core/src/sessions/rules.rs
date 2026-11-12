//! The rules of the session index that read no disk, each as the TypeScript had it; `captured.json` holds what the
//! TypeScript answered for the same inputs.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt;

use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;

/// Session files sit at most three segments below the root: `<project>/<id>.jsonl` and a subagent's
/// `<project>/<session>/<id>.jsonl`. A subagent's own subagents, one level deeper, are not listed.
pub const SESSION_FILE_SEGMENTS: usize = 3;
/// Project and session folders, whose creation, removal or rename (stock's cwd-encoding migration) moves sessions.
const SESSION_DIR_SEGMENTS: usize = 2;

/// Whether a change of `name` (relative to the sessions root, `/` or `\` between segments) is looked at: a session
/// file at most three segments down, or a non-hidden entry at most two down (hidden ones there are stock's lock and
/// staging files). Anything else (tool output, plans) is not.
pub fn watched(name: &str) -> bool {
    let segments = name.split(['\\', '/']).count();
    let base = name.rsplit(['\\', '/']).next().unwrap_or(name);
    if base.ends_with(".jsonl") {
        segments <= SESSION_FILE_SEGMENTS
    } else {
        segments <= SESSION_DIR_SEGMENTS && !base.is_empty() && !base.starts_with('.')
    }
}

/// The rows a list keeps, given every row's session id in list order (newest first): the first row of each id, and no
/// row without one. Stock moves sessions between its old and new folder names for a cwd, and meanwhile one id is a file
/// in both; the newest copy is the session.
pub fn first_of_each_id<'a>(ids: impl IntoIterator<Item = &'a str>) -> Vec<usize> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .enumerate()
        .filter(|(_, id)| !id.is_empty() && seen.insert(*id))
        .map(|(row, _)| row)
        .collect()
}

/// The legacy chat flag in a session file's head (its first 4 096 bytes): whether the first line that is a session
/// header (`{"type":"session"}`) says `"kind":"chat"`. `None` when no line is one (a file without a header yet, a
/// header longer than the head). A GUI-only label of old OMPdesk versions; stock's listing does not carry it.
pub fn legacy_chat(head: &[u8]) -> Option<bool> {
    String::from_utf8_lossy(head).split('\n').find_map(|line| {
        let mut json = serde_json::Deserializer::from_str(line);
        let header = json.deserialize_map(Header).ok()?;
        json.end().ok()?;
        header
            .is_session
            .then_some(header.kind.is_some_and(|kind| is_text(kind, "chat")))
    })
}

/// Whether a JSON value is the string `text`, as JavaScript's `value === text` over the parsed value.
fn is_text(value: &RawValue, text: &str) -> bool {
    value.get().starts_with('"')
        && serde_json::from_str::<Cow<str>>(value.get()).is_ok_and(|parsed| parsed == text)
}

/// A line's `type` and `kind`, read only from a JSON object; of a key written twice the last one counts, as in
/// JavaScript.
struct Header;

struct HeaderFields<'a> {
    is_session: bool,
    kind: Option<&'a RawValue>,
}

impl<'de> Visitor<'de> for Header {
    type Value = HeaderFields<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = HeaderFields {
            is_session: false,
            kind: None,
        };
        while let Some(key) = map.next_key::<Cow<str>>()? {
            match key.as_ref() {
                "type" => fields.is_session = is_text(map.next_value::<&RawValue>()?, "session"),
                "kind" => fields.kind = Some(map.next_value()?),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Captured {
        watched: Vec<(String, bool)>,
        legacy: Vec<(String, Option<bool>)>,
        dedupe: Vec<(Vec<String>, Vec<usize>)>,
    }

    fn captured() -> Captured {
        serde_json::from_str(include_str!("captured.json")).unwrap()
    }

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn watches_the_names_the_typescript_watched() {
        for (name, expected) in captured().watched {
            assert_eq!(watched(&name), expected, "{name:?}");
        }
    }

    #[test]
    fn reads_the_legacy_chat_flag_as_the_typescript_did() {
        for (at, (hex, expected)) in captured().legacy.into_iter().enumerate() {
            let head = bytes(&hex);
            // `fh.read(buffer, 0, 4096, 0)`: the head is the file's first 4 096 bytes.
            let head = &head[..head.len().min(4096)];
            assert_eq!(
                legacy_chat(head),
                expected,
                "case {at}: {}",
                String::from_utf8_lossy(&head[..head.len().min(120)])
            );
        }
    }

    #[test]
    fn keeps_the_rows_the_typescript_kept() {
        for (ids, expected) in captured().dedupe {
            let kept = first_of_each_id(ids.iter().map(String::as_str));
            assert_eq!(kept, expected, "{ids:?}");
        }
    }
}
