//! The work board's list for the sessions a tab opened: when it is rebuilt, what main is told of it, and the live read
//! of a running child (`#pushReview`, `#sendReview`, `#sendChildren`, `review`, `familyEdits`, `liveReview`).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use super::{Runtime, is_outside, no_review};
use crate::agentctl::service::fail::R;
use crate::agentctl::service::js::slice16;

/// How many running or waiting children the opener's prompt suggestions hear of (`MAX_NEXT_PROMPT_CHILDREN`).
const MAX_NEXT_PROMPT_CHILDREN: usize = 20;
/// A child's title is cut to this for them.
const NEXT_PROMPT_TITLE_CHARS: usize = 200;

/// `value` as JSON (a family's concrete review type, or the JSON it answers).
fn json_of<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

impl Runtime {
    /// The parent's review list changed (a child started, finished or closed): push it after a short settle.
    pub fn push_review(self: &Arc<Self>, tab: &str) {
        if is_outside(tab) {
            return;
        }
        let mut rt = self.rt();
        if let Some(pending) = rt.review_timers.remove(tab) {
            pending.abort();
        }
        let (me, id) = (self.clone(), tab.to_owned());
        let settle = Duration::from_millis(self.config.review_settle_ms);
        let timer = tokio::spawn(async move {
            tokio::time::sleep(settle).await;
            me.rt().review_timers.remove(&id);
            if let Ok(review) = me.control.review(&id).await {
                me.send_review(&id, json_of(&review));
            }
        });
        rt.review_timers.insert(tab.to_owned(), timer);
    }

    /// To every window showing the opener: its owner and a phone viewing it (main does the sending). A viewer's tab
    /// list never holds the children (they are tabs of the window that opened them), so these rows are all it knows
    /// of them: without them its work strip said nothing while the children worked.
    pub fn send_review(&self, tab: &str, review: Value) {
        // No board shows an outside caller's sessions: it lists them with ompdesk_sessions.
        if is_outside(tab) {
            return;
        }
        let items = review
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        {
            let mut rt = self.rt();
            rt.review_sent.insert(tab.to_owned(), review.to_string());
            for item in &items {
                if let Some(child) = item.get("tabId").and_then(Value::as_str) {
                    rt.listed_in.insert(child.to_owned(), tab.to_owned());
                }
            }
        }
        self.host()
            .port()
            .tell("reviewSent", &json!({ "tabId": tab, "review": review }));
        self.send_children(tab, &items);
    }

    /// The opener's prompt suggestions learn which sessions it opened still run or wait (bridge next-prompt): those run
    /// in their own tabs, so the opener's omp lists none of them as running work, and a suggestion once told the user
    /// to approve work a child was already doing.
    fn send_children(&self, tab: &str, items: &[Value]) {
        let children: Vec<Value> = items
            .iter()
            .filter(|item| {
                item.get("state").and_then(Value::as_str) == Some("running")
                    || item.get("waiting").and_then(Value::as_bool) == Some(true)
            })
            .take(MAX_NEXT_PROMPT_CHILDREN)
            .map(|item| {
                let title = slice16(
                    item.get("title").and_then(Value::as_str).unwrap_or(""),
                    0,
                    NEXT_PROMPT_TITLE_CHARS,
                );
                if item.get("waiting").and_then(Value::as_bool) == Some(true) {
                    json!({ "title": title, "waiting": true })
                } else {
                    json!({ "title": title })
                }
            })
            .collect();
        let sent = Value::Array(children.clone()).to_string();
        {
            let mut rt = self.rt();
            let last = rt
                .children_sent
                .get(tab)
                .map_or("[]", String::as_str)
                .to_owned();
            if sent == last {
                return;
            }
            rt.children_sent.insert(tab.to_owned(), sent);
        }
        self.host().port().tell(
            "nextPromptChildren",
            &json!({ "tabId": tab, "children": children }),
        );
    }

    /// The work board's opened-session rows (`review`): empty while the control tools are off.
    pub async fn review(&self, tab: &str) -> R<Value> {
        if !self.host().state().enabled {
            return Ok(no_review());
        }
        let review = json_of(&self.control.review(tab).await?);
        self.note_listed(tab, &review);
        Ok(review)
    }

    fn note_listed(&self, tab: &str, review: &Value) {
        let mut rt = self.rt();
        for item in review
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(child) = item.get("tabId").and_then(Value::as_str) {
                rt.listed_in.insert(child.to_owned(), tab.to_owned());
            }
        }
    }

    /// What the sessions this one opened changed (the work board's "Changed" row).
    pub async fn family_edits(&self, tab: &str, since: Option<f64>) -> R<Value> {
        if !self.host().state().enabled {
            return Ok(json!({ "members": [] }));
        }
        Ok(json_of(&self.control.family_edits(tab, since).await?))
    }

    /// A running child's step and cost move inside its turn, with no busy or idle edge to push them. A work board that
    /// shows the opener's children asks for them (`agent_control_review {live: true}`, only while it is mounted in a
    /// visible window); only the running children whose omp sent a step since are read, over the list last sent, and
    /// it is pushed only when they moved and no fuller list went out meanwhile. A child that did nothing costs
    /// nothing, on this computer or over a paired device's link.
    pub async fn live_review(self: &Arc<Self>, tab: &str) {
        let (sent, moved) = {
            let rt = self.rt();
            let Some(sent) = rt.review_sent.get(tab).cloned() else {
                return;
            };
            if rt.live_reviews.contains(tab)
                || rt.sweep_reviews.contains(tab)
                || rt.review_timers.contains_key(tab)
            {
                return;
            }
            let last: Value = serde_json::from_str(&sent).unwrap_or(Value::Null);
            let moved: Vec<String> = last
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|item| item.get("state").and_then(Value::as_str) == Some("running"))
                .filter_map(|item| item.get("tabId").and_then(Value::as_str))
                .filter(|child| rt.moved.contains(*child))
                .map(str::to_owned)
                .collect();
            (sent, moved)
        };
        if moved.is_empty() {
            return;
        }
        {
            let mut rt = self.rt();
            for child in &moved {
                rt.moved.remove(child);
            }
            rt.live_reviews.insert(tab.to_owned());
        }
        let last: Value = serde_json::from_str(&sent).unwrap_or(Value::Null);
        let answer = self
            .control
            .live_review(tab, last, Some(moved))
            .await
            .ok()
            .flatten();
        self.rt().live_reviews.remove(tab);
        if let Some(review) = answer {
            let review = json_of(&review);
            let current = self.rt().review_sent.get(tab).cloned();
            if current.as_deref() == Some(sent.as_str()) && sent != review.to_string() {
                self.send_review(tab, review);
            }
        }
    }
}
