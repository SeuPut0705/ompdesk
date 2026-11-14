//! `wc.event preload-error` (PROTOCOL.md §4): the page script (`src/preload/shell.ts`) POSTs `{message, stack}` to
//! `/__shell/preload-error` when its body throws; this is the event's `args`, Electron's `[preloadPath, error]`.

use serde_json::{Value, json};

/// Longest message / stack kept; the page is trusted code, but the endpoint is reachable by every script of the origin.
const MAX_MESSAGE: usize = 4 * 1024;
const MAX_STACK: usize = 16 * 1024;

fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// `[preloadPath, {message, stack}]` for a report body; `None` when the body is not a report.
pub fn event_args(preload_path: &str, body: &[u8]) -> Option<Value> {
    let report: Value = serde_json::from_slice(body).ok()?;
    let message = report.get("message")?.as_str()?;
    let stack = report
        .get("stack")
        .and_then(Value::as_str)
        .unwrap_or(message);
    Some(json!([
        preload_path,
        { "message": clip(message, MAX_MESSAGE), "stack": clip(stack, MAX_STACK) }
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_becomes_the_events_args() {
        let args = event_args(
            r"C:\app\out\preload\shell.js",
            br#"{"message":"boom","stack":"Error: boom\n    at start"}"#,
        );
        assert_eq!(
            args,
            Some(json!([
                r"C:\app\out\preload\shell.js",
                { "message": "boom", "stack": "Error: boom\n    at start" }
            ]))
        );
    }

    #[test]
    fn a_missing_stack_is_the_message() {
        let args = event_args("p", br#"{"message":"only"}"#).unwrap();
        assert_eq!(args[1]["stack"], "only");
    }

    #[test]
    fn what_is_not_a_report_is_refused() {
        assert_eq!(event_args("p", b"not json"), None);
        assert_eq!(event_args("p", br#"{"stack":"x"}"#), None);
        assert_eq!(event_args("p", br#"{"message":3}"#), None);
        assert_eq!(event_args("p", b""), None);
    }

    #[test]
    fn long_text_is_clipped_on_a_character_boundary() {
        let long = "é".repeat(MAX_MESSAGE);
        let body = serde_json::to_vec(&json!({ "message": long, "stack": long })).unwrap();
        let args = event_args("p", &body).unwrap();
        let message = args[1]["message"].as_str().unwrap();
        assert!(message.ends_with('…') && message.len() <= MAX_MESSAGE + 3);
        assert!(args[1]["stack"].as_str().unwrap().len() <= MAX_STACK + 3);
    }
}
