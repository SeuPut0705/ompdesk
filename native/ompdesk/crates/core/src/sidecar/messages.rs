//! Stock `agent_end.messages` can miss part of the run the client watched (was `src/main/run-messages.ts`):
//! - agent-session.ts defers `agent_end` while the prompt is in flight and keeps only the newest one
//!   (`#pendingAgentEndEmit`), so a prompt that auto-continued (todo reminder, session_stop hook) ends with the
//!   continuation's messages alone;
//! - rpc-frame.ts `compactTerminalFrame` drops a prefix an oversized frame already delivered by `message_end` (wire
//!   `messageCount`).
//!
//! Every one of those messages arrived as a `message_end` first, in stream order.

use std::collections::HashMap;

use serde_json::Value;

/// JavaScript's truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Whether the terminal frame's copy `message` is the delivered `sent`: deeply equal, or (a copy stock touched after
/// `message_end`) the same role, time, call and custom type.
fn same(sent: &Value, message: &Value) -> bool {
    if sent == message {
        return true;
    }
    sent.get("timestamp").is_some_and(Value::is_number)
        && ["role", "timestamp", "toolCallId", "customType"]
            .iter()
            .all(|key| sent.get(key) == message.get(key))
}

/// The messages to commit for `agent_end`: everything delivered by `message_end` since the previous `agent_end`, in
/// delivery order, with the terminal frame's own copy wherever it carries one (a terminal message never delivered
/// keeps its frame position). `None` when the frame already covers the run: it is used as it is.
pub fn complete_run_messages(delivered: &[Value], terminal: &[Value]) -> Option<Vec<Value>> {
    if delivered.is_empty() {
        return None;
    }
    // Pair each terminal message with its delivery, newest first: the frame is the run's tail.
    let mut delivered_at: HashMap<usize, usize> = HashMap::new();
    let mut cursor = delivered.len() as isize - 1;
    for index in (0..terminal.len()).rev() {
        let message = &terminal[index];
        let mut candidate = cursor;
        while candidate >= 0 && truthy(message) {
            if same(&delivered[candidate as usize], message) {
                delivered_at.insert(index, candidate as usize);
                cursor = candidate - 1;
                break;
            }
            candidate -= 1;
        }
    }
    let mut messages: Vec<Value> = Vec::new();
    let mut next = 0;
    for (index, message) in terminal.iter().enumerate() {
        if let Some(&at) = delivered_at.get(&index) {
            messages.extend_from_slice(&delivered[next..at]);
            next = at + 1;
        }
        messages.push(message.clone());
    }
    messages.extend_from_slice(&delivered[next..]);
    (messages.len() != terminal.len()).then_some(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user() -> Value {
        json!({ "role": "user", "content": "Use your todo tool", "timestamp": 100 })
    }
    fn call() -> Value {
        json!({ "role": "assistant", "content": [{ "type": "toolCall", "id": "c1", "name": "todo", "arguments": {} }], "timestamp": 101 })
    }
    fn result() -> Value {
        json!({ "role": "toolResult", "toolCallId": "c1", "toolName": "todo", "content": [], "timestamp": 102 })
    }
    fn reminder() -> Value {
        json!({ "role": "custom", "customType": "todo-reminder", "content": "finish", "timestamp": 103 })
    }
    fn reply() -> Value {
        json!({ "role": "assistant", "content": [{ "type": "text", "text": "done" }], "timestamp": 104 })
    }

    #[test]
    fn returns_a_terminal_frame_that_already_covers_the_run_unchanged() {
        let terminal = [user(), call(), result()];
        assert_eq!(
            complete_run_messages(&[user(), call(), result()], &terminal),
            None
        );
        assert_eq!(complete_run_messages(&[], &terminal), None);
    }

    #[test]
    fn restores_the_run_a_deferred_continuation_agent_end_replaced() {
        assert_eq!(
            complete_run_messages(
                &[user(), call(), result(), reminder(), reply()],
                &[reminder(), reply()]
            ),
            Some(vec![user(), call(), result(), reminder(), reply()])
        );
    }

    #[test]
    fn restores_the_prefix_an_oversized_frame_dropped_and_everything_for_an_overflowed_frame() {
        assert_eq!(
            complete_run_messages(&[user(), call(), result(), reply()], &[result(), reply()]),
            Some(vec![user(), call(), result(), reply()])
        );
        assert_eq!(
            complete_run_messages(&[user(), call(), result()], &[]),
            Some(vec![user(), call(), result()])
        );
    }

    #[test]
    fn prefers_the_terminal_copy_and_keeps_delivery_order_around_messages_stock_never_delivered() {
        let mut touched = result();
        touched["details"] = json!({ "saved": true });
        let undelivered =
            json!({ "role": "custom", "customType": "note", "content": "n", "timestamp": 105 });
        let completed = complete_run_messages(
            &[user(), call(), result(), reply()],
            &[touched.clone(), undelivered.clone(), reply()],
        )
        .unwrap();
        assert_eq!(
            completed,
            [user(), call(), touched.clone(), undelivered, reply()]
        );
        assert_eq!(completed[2], touched);
    }
}
