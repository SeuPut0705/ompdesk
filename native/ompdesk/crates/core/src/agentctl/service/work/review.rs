//! The review board of the sessions an opener started: `#reviewItem`, `reviewItems`, `review`, `familyEdits` with
//! `#closedEdits`, `liveReview`, and what a session has cost (`#cost`, `#split`). Also the cut of a turn's edit calls
//! (`turnEdits` of `src/shared/turn-edits.ts`).
//!
//! The results are JSON as main hands them to the work board (`AgentReviewResult`, `FamilyEdits`).

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::super::AgentControl;
use super::super::Spend;
use super::super::fail::{Fail, R};
use super::super::host::Deadline;
use super::super::js::{one_line, trim};
use super::super::state::SessionState;
use super::super::text::{ask_title, current_step, transcript_page, waits};
use super::super::types::{ClosedChild, ControlTab, CostSplit, StoredSession};
use super::super::util::{Flight, join};
use super::super::wrap::AGENT_CARD_PREFIX;
use crate::agentctl::rules::pickup::{WorkerResult, parse_worker_result};

/// The tools that write files (stock names); a bash edit is not one of them.
const TURN_EDIT_TOOLS: [&str; 4] = ["write", "edit", "ast_edit", "apply_patch"];

/// A JavaScript number as JSON: a whole one is written without a fraction.
fn js_num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `epochMs`: a time as milliseconds, from an ISO string or a number; None when it is neither.
fn epoch_ms(value: Option<&Value>) -> Option<f64> {
    let ms = match value? {
        Value::String(text) => crate::care::date_parse(text)? as f64,
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    ms.is_finite().then_some(ms)
}

/// `isTurnPrompt`: a prompt that starts a turn; a steer joins the running one.
fn is_turn_prompt(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("user")
        && message.get("steering").and_then(Value::as_bool) != Some(true)
}

/// `turnEdits`: the newest turn of `messages` (from its last prompt, or all of them when none is there), cut to its
/// edit calls and their results.
pub fn turn_edits(messages: &[Value], cwd: &str) -> Value {
    let at = messages.iter().rposition(is_turn_prompt);
    let prompt = at.map(|at| &messages[at]);
    let turn = &messages[at.map_or(0, |at| at + 1)..];
    let mut calls: HashSet<String> = HashSet::new();
    let mut edits: Vec<Value> = Vec::new();
    for message in turn {
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("assistant")
            && let Some(content) = message.get("content").and_then(Value::as_array)
        {
            let blocks: Vec<Value> = content
                .iter()
                .filter(|block| {
                    block.get("type").and_then(Value::as_str) == Some("toolCall")
                        && block
                            .get("name")
                            .and_then(Value::as_str)
                            .is_some_and(|name| TURN_EDIT_TOOLS.contains(&name))
                })
                .cloned()
                .collect();
            if blocks.is_empty() {
                continue;
            }
            for block in &blocks {
                if let Some(id) = block.get("id").and_then(Value::as_str) {
                    calls.insert(id.to_owned());
                }
            }
            let mut edit = Map::new();
            edit.insert("role".into(), json!("assistant"));
            edit.insert("content".into(), Value::Array(blocks));
            if let Some(timestamp) = message.get("timestamp") {
                edit.insert("timestamp".into(), timestamp.clone());
            }
            edits.push(Value::Object(edit));
        } else if role == Some("toolResult")
            && message
                .get("toolCallId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && calls.contains(id))
        {
            edits.push(message.clone());
        }
    }
    let ended = turn
        .last()
        .and_then(|last| last.get("timestamp"))
        .filter(|timestamp| !timestamp.is_null())
        .or_else(|| prompt.and_then(|prompt| prompt.get("timestamp")));
    json!({
        "cwd": cwd,
        "startedAt": prompt
            .and_then(|prompt| epoch_ms(prompt.get("timestamp")))
            .map_or(Value::Null, js_num),
        "endedAt": epoch_ms(ended).map_or(Value::Null, js_num),
        "messages": edits,
    })
}

/// `isTurnEdits`: a `get_turn_edits` answer (anything else, from an older host, says nothing).
fn is_turn_edits(data: &Value) -> bool {
    data.get("messages").is_some_and(Value::is_array)
}

/// `isGitUnlanded`: a `get_git_unlanded` answer that names files.
fn is_git_unlanded(data: &Value) -> bool {
    data.get("files").is_some_and(Value::is_array)
}

/// `costSplitOf`: `get_session_spend`'s providers folded into the two kinds (a free provider costs nothing).
pub(super) fn cost_split_of(providers: &Map<String, Value>) -> CostSplit {
    let mut split = CostSplit::default();
    for row in providers.values() {
        let Some(cost) = row
            .get("cost")
            .and_then(Value::as_f64)
            .filter(|cost| cost.is_finite() && *cost > 0.0)
        else {
            continue;
        };
        match row.get("billing").and_then(Value::as_str) {
            Some("metered") => split.charged += cost,
            Some("subscription") => split.estimate += cost,
            _ => {}
        }
    }
    split
}

impl AgentControl {
    /// `#tabRow` is in `auto`; this reads a saved session's messages as the host's JSON (timestamps kept).
    async fn stored_raw(&self, row: &StoredSession) -> R<Vec<Value>> {
        Ok(self
            .host
            .port()
            .ask::<Vec<Value>, _>("storedMessages", &json!({ "session": row }))
            .await?)
    }

    /// `#reviewItem`: a child's review item, or None when nothing is left to review: an idle child whose branch
    /// landed (its tip is in the parent's branch or the upstream it tracks) with no uncommitted or untracked file,
    /// which ended well and waits on no answer. A landed child with files left over lists only those files.
    async fn review_item(&self, tab: &ControlTab, session: &SessionState) -> Option<Value> {
        // A tab restored but not started (asleep) runs nothing; one starting or restarting may still be working.
        let running = tab.busy
            || waits(tab)
            || !(tab.status.is_up() || tab.status == super::super::types::TabStatus::Asleep);
        let conflict = self.mem().conflicts.get(&tab.tab_id).cloned();
        let mut item = Map::new();
        item.insert("tabId".into(), json!(tab.tab_id));
        if let Some(path) = tab.session_path.as_deref().filter(|path| !path.is_empty()) {
            item.insert("sessionPath".into(), json!(path));
        }
        if let Some(device) = tab.device.as_deref().filter(|device| !device.is_empty()) {
            item.insert("device".into(), json!(device));
        }
        item.insert("title".into(), json!(tab.name()));
        item.insert(
            "state".into(),
            json!(if running {
                "running"
            } else if conflict.is_some() {
                "conflict"
            } else {
                "needs-review"
            }),
        );
        for key in ["commitsAhead", "files", "added", "removed", "uncommitted"] {
            item.insert(key.into(), json!(0));
        }
        item.insert(
            "answer".into(),
            json!(
                match session.last.as_deref().filter(|last| !last.is_empty()) {
                    Some(last) => one_line(last, 240),
                    None => String::new(),
                }
            ),
        );
        if running && let Some(step) = session.step.as_deref().filter(|step| !step.is_empty()) {
            item.insert("step".into(), json!(step));
        }
        if running && let Some(since) = tab.busy_since.filter(|since| *since != 0.0) {
            item.insert("runningSince".into(), js_num(since));
        }
        let failed = !running
            && (matches!(
                tab.last_run.as_ref().map(|run| run.stop_reason.as_str()),
                Some("error" | "aborted")
            ) || matches!(
                parse_worker_result(session.last.as_deref()),
                Some(WorkerResult::Problem { .. })
            ));
        if failed {
            item.insert("failed".into(), json!(true));
        }
        if let Some(conflict) = &conflict {
            item.insert("note".into(), json!(conflict.join(", ")));
        }
        for (key, value) in self.report_fields(&self.host.state(), tab) {
            item.insert(key, value);
        }
        // Its plan waits for approval, or a question card of its own waits for an answer: the opener (or the
        // person) answers it, nothing is left to review. The card's own question goes along, for the line under
        // its row.
        let card = tab
            .asks
            .iter()
            .find(|entry| !ask_title(&entry.request).starts_with(AGENT_CARD_PREFIX));
        let question = match (card, &tab.plan) {
            (Some(card), _) => trim(&ask_title(&card.request)).to_owned(),
            (None, Some(plan)) => trim(&plan.title).to_owned(),
            (None, None) => String::new(),
        };
        let waiting = tab.plan.is_some() || card.is_some();
        if waiting {
            item.insert("waiting".into(), json!(true));
            if !question.is_empty() {
                item.insert("question".into(), json!(one_line(&question, 240)));
            }
        }
        let Some(worktree) = &tab.worktree else {
            return Some(Value::Object(item));
        };
        match self
            .host
            .branch_facts(&worktree.reference(), tab.device.as_deref())
            .await
        {
            Ok(facts) => {
                let clean = facts.uncommitted == 0.0 && facts.untracked == 0.0;
                if facts.merged && clean && !running && !failed && !waiting {
                    self.mem().conflicts.remove(&tab.tab_id);
                    return None;
                }
                item.insert("branch".into(), json!(facts.branch));
                item.insert("baseBranch".into(), json!(facts.base_branch));
                item.insert("commitsAhead".into(), js_num(facts.commits_ahead));
                item.insert("files".into(), json!(facts.files.len()));
                item.insert(
                    "added".into(),
                    js_num(facts.files.iter().map(|file| file.added).sum()),
                );
                item.insert(
                    "removed".into(),
                    js_num(facts.files.iter().map(|file| file.removed).sum()),
                );
                // Untracked files are work the branch does not hold yet either.
                item.insert(
                    "uncommitted".into(),
                    js_num(facts.uncommitted + facts.untracked),
                );
                Some(Value::Object(item))
            }
            Err(_) => {
                item.insert("branch".into(), json!(worktree.branch));
                Some(Value::Object(item))
            }
        }
    }

    /// `reviewItems`: the sessions `caller_tab_id` opened that wait for the person (or still run), for the work
    /// board.
    pub async fn review_items(&self, caller_tab_id: &str) -> R<Value> {
        Ok(self
            .review(caller_tab_id)
            .await?
            .get("items")
            .cloned()
            .unwrap_or_else(|| json!([])))
    }

    /// What a session runs on and has cost so far (`usageOf`): its model, whole-journal cost and the cost's split.
    async fn usage_of(&self, tab: &ControlTab, session: Option<SessionState>) -> Value {
        let (state, cost, split) = tokio::join!(
            async {
                match session {
                    Some(session) => session,
                    None => self.session_state(tab).await,
                }
            },
            self.cost(tab),
            self.split(tab),
        );
        let mut usage = Map::new();
        if let Some(model) = state.state.as_ref().and_then(|state| state.model.as_ref()) {
            usage.insert(
                "model".into(),
                json!(format!("{}/{}", model.provider, model.id)),
            );
        }
        usage.insert("cost".into(), js_num(cost));
        if let Some(split) = split {
            usage.insert("split".into(), json!(split));
        }
        Value::Object(usage)
    }

    /// `review`: the work board's list (`review_items`) plus what every session `caller_tab_id` opened runs on and
    /// has cost, the landed ones without an item included: the family's cost counts them all.
    pub async fn review(&self, caller_tab_id: &str) -> R<Value> {
        let Some(mut tabs) = self.host.state().tabs(caller_tab_id) else {
            return Ok(json!({ "items": [], "usage": {} }));
        };
        self.name_untitled(&mut tabs).await;
        let own = self.opened_by(&self.host.state(), caller_tab_id, &tabs);
        let children: Vec<&ControlTab> = tabs
            .iter()
            .filter(|tab| own.contains(&tab.tab_id) && !tab.hidden)
            .collect();
        // The session's own journal too: the family's cost (Work tree head) is it plus all it opened.
        let caller = tabs.iter().find(|tab| tab.tab_id == caller_tab_id);
        let rows = join::all(
            children
                .iter()
                .map(|tab| {
                    join::boxed(async move {
                        let session = self.session_state(tab).await;
                        let reviewed = self.mem().reviewed.contains(&tab.tab_id);
                        let (item, usage) = tokio::join!(
                            async {
                                if reviewed {
                                    None
                                } else {
                                    self.review_item(tab, &session).await
                                }
                            },
                            self.usage_of(tab, Some(session.clone())),
                        );
                        (
                            item,
                            usage,
                            tab.session_path
                                .clone()
                                .unwrap_or_else(|| tab.tab_id.clone()),
                        )
                    })
                })
                .collect(),
        );
        let caller_usage = async {
            match caller {
                Some(caller) => {
                    let mut shown = caller.clone();
                    shown.hidden = false;
                    Some(self.usage_of(&shown, None).await)
                }
                None => None,
            }
        };
        let (rows, caller_usage) = tokio::join!(rows, caller_usage);
        let mut usage = Map::new();
        for (_, row_usage, key) in &rows {
            usage.insert(key.clone(), row_usage.clone());
        }
        if let (Some(caller), Some(caller_usage)) = (caller, caller_usage) {
            usage.insert(
                caller
                    .session_path
                    .clone()
                    .unwrap_or_else(|| caller_tab_id.to_owned()),
                caller_usage,
            );
        }
        let items: Vec<Value> = rows.into_iter().filter_map(|(item, _, _)| item).collect();
        Ok(json!({ "items": items, "usage": usage }))
    }

    /// `familyEdits`: what each session `caller_tab_id` opened changed, for its work board's "Changed" row: its
    /// newest turn's edit calls (`get_turn_edits` of its own omp, or its saved file while it is not started) and, in
    /// a worktree, what its branch has not landed (`get_git_unlanded`); with `since`, also each one closed after its
    /// work landed since then (its saved file, read once). Asked through main, so a window viewing the opener (a
    /// phone) counts children it holds no tab of. A session hidden from agents is left out.
    pub async fn family_edits(&self, caller_tab_id: &str, since: Option<f64>) -> R<Value> {
        let Some(tabs) = self.host.state().tabs(caller_tab_id) else {
            return Ok(json!({ "members": [] }));
        };
        let own = self.opened_by(&self.host.state(), caller_tab_id, &tabs);
        let ask = |tab: &ControlTab, kind: &'static str, valid: fn(&Value) -> bool| {
            let tab_id = tab.tab_id.clone();
            async move {
                self.host
                    .command(
                        &tab_id,
                        &json!({ "type": kind }),
                        Deadline::Ms(self.tuning.state_timeout_ms),
                    )
                    .await
                    .ok()
                    .filter(|response| response.success)
                    .and_then(|response| response.data)
                    .filter(valid)
            }
        };
        let open = join::all(
            tabs.iter()
                .filter(|tab| own.contains(&tab.tab_id) && !tab.hidden)
                .map(|tab| {
                    let ask = &ask;
                    join::boxed(async move {
                        let ready = tab.status.is_up();
                        let saved = tab
                            .session_path
                            .as_deref()
                            .map(|path| self.tab_row(tab, path));
                        let (edits, unlanded) = tokio::join!(
                            async {
                                if ready {
                                    ask(tab, "get_turn_edits", is_turn_edits).await
                                } else if let Some(saved) = &saved {
                                    self.stored_raw(saved)
                                        .await
                                        .ok()
                                        .map(|messages| turn_edits(&messages, &tab.cwd))
                                } else {
                                    None
                                }
                            },
                            async {
                                if tab.worktree.is_some() && ready {
                                    ask(tab, "get_git_unlanded", is_git_unlanded).await
                                } else {
                                    None
                                }
                            },
                        );
                        let mut member = Map::new();
                        member.insert(
                            "key".into(),
                            json!(
                                tab.session_path
                                    .clone()
                                    .unwrap_or_else(|| tab.tab_id.clone())
                            ),
                        );
                        member.insert("title".into(), json!(tab.name()));
                        member.insert("live".into(), json!(tab.busy || waits(tab)));
                        if let Some(device) =
                            tab.device.as_deref().filter(|device| !device.is_empty())
                        {
                            member.insert("device".into(), json!(device));
                        }
                        member.insert("edits".into(), edits.unwrap_or(Value::Null));
                        member.insert("unlanded".into(), unlanded.unwrap_or(Value::Null));
                        Value::Object(member)
                    })
                })
                .collect(),
        )
        .await;
        let caller = tabs.iter().find(|tab| tab.tab_id == caller_tab_id);
        let shown: HashSet<String> = tabs
            .iter()
            .map(|tab| {
                format!(
                    "{}\0{}",
                    tab.device.as_deref().unwrap_or(""),
                    tab.session_path.as_deref().unwrap_or("")
                )
            })
            .collect();
        let closed: Vec<ClosedChild> = match (since, caller.and_then(|c| c.session_path.as_deref()))
        {
            (Some(since), Some(path)) if !path.is_empty() => self
                .host
                .state()
                .closed_children
                .iter()
                .filter(|child| {
                    child.opened_by_session == path
                        && child.closed_at >= since
                        && !shown.contains(&format!(
                            "{}\0{}",
                            child.device.as_deref().unwrap_or(""),
                            child.path
                        ))
                })
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        let closed_members = join::all(
            closed
                .iter()
                .map(|child| join::boxed(self.closed_edits(child)))
                .collect(),
        )
        .await;
        let mut members = open;
        members.extend(closed_members);
        Ok(json!({ "members": members }))
    }

    /// `#closedEdits`: a closed child's last turn never changes: its saved file is read once, on the computer it ran
    /// on (a paired device's through its stock helper); a failed read is tried again on the next ask.
    async fn closed_edits(&self, child: &ClosedChild) -> Value {
        // Reopened and closed again, the same file holds a newer last turn: each close is its own version.
        let place = format!(
            "{}\0{}\0{}",
            child.device.as_deref().unwrap_or(""),
            child.path,
            super::super::js::number(child.closed_at)
        );
        let (turn, owner) = {
            let mut mem = self.mem();
            match mem.closed_turns.get(&place) {
                Some(known) => (known.clone(), false),
                None => {
                    let turn: Flight<Result<Value, Fail>> = Flight::new();
                    mem.closed_turns.insert(place.clone(), turn.clone());
                    (turn, true)
                }
            }
        };
        if owner {
            let guard = turn.guard();
            let row = StoredSession {
                id: child.path.clone(),
                path: child.path.clone(),
                title: child.title.clone(),
                cwd: child.cwd.clone(),
                device: child.device.clone(),
                ..StoredSession::default()
            };
            let read = self
                .stored_raw(&row)
                .await
                .map(|messages| turn_edits(&messages, &child.cwd));
            if read.is_err() {
                self.mem().closed_turns.remove(&place);
            }
            turn.settle(read);
            drop(guard);
        }
        let edits = match turn.wait().await {
            Some(Ok(edits)) => edits,
            _ => Value::Null,
        };
        let mut member = Map::new();
        member.insert("key".into(), json!(child.path));
        member.insert("title".into(), json!(child.title));
        member.insert("live".into(), json!(false));
        if let Some(device) = child.device.as_deref().filter(|device| !device.is_empty()) {
            member.insert("device".into(), json!(device));
        }
        member.insert("edits".into(), edits);
        member.insert("unlanded".into(), Value::Null);
        Value::Object(member)
    }

    /// `liveReview`: `last` (the review list last sent) with what moves inside a running child's turn read again:
    /// its step and what it has cost so far. Only the running children (of `only`, when given: those that moved on
    /// since) are read, with no git. None when none of `caller_tab_id`'s children it would read runs.
    pub async fn live_review(
        &self,
        caller_tab_id: &str,
        last: Value,
        only: Option<Vec<String>>,
    ) -> R<Option<Value>> {
        let Some(tabs) = self.host.state().tabs(caller_tab_id) else {
            return Ok(None);
        };
        let own = self.opened_by(&self.host.state(), caller_tab_id, &tabs);
        let running: Vec<&ControlTab> = tabs
            .iter()
            .filter(|tab| {
                own.contains(&tab.tab_id)
                    && !tab.hidden
                    && tab.busy
                    && only.as_ref().is_none_or(|only| only.contains(&tab.tab_id))
            })
            .collect();
        if running.is_empty() {
            return Ok(None);
        }
        let mut usage: Map<String, Value> = last
            .get("usage")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut items: Vec<Value> = last
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let reads = join::all(
            running
                .iter()
                .map(|tab| {
                    join::boxed(async move {
                        tokio::join!(
                            async {
                                self.host
                                    .command(
                                        &tab.tab_id,
                                        &json!({ "type": "get_transcript_page", "fromEnd": true, "limit": 8 }),
                                        Deadline::Ms(self.tuning.state_timeout_ms),
                                    )
                                    .await
                                    .ok()
                                    .filter(|response| response.success)
                                    .and_then(|response| response.data)
                                    .and_then(|data| transcript_page(&data))
                            },
                            self.cost(tab),
                            self.split(tab),
                        )
                    })
                })
                .collect(),
        )
        .await;
        for (tab, (page, cost, split)) in running.iter().zip(reads) {
            let key = tab
                .session_path
                .clone()
                .unwrap_or_else(|| tab.tab_id.clone());
            let mut kept = usage
                .get(&key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_else(|| {
                    let mut fresh = Map::new();
                    fresh.insert("cost".into(), json!(0));
                    fresh
                });
            kept.shift_remove("split");
            kept.insert("cost".into(), js_num(cost));
            if let Some(split) = split {
                kept.insert("split".into(), json!(split));
            }
            usage.insert(key, Value::Object(kept));
            let Some(index) = items
                .iter()
                .position(|item| item.get("tabId").and_then(Value::as_str) == Some(&tab.tab_id))
            else {
                continue;
            };
            let Some(page) = page else { continue };
            if items[index].get("state").and_then(Value::as_str) != Some("running") {
                continue;
            }
            let Some(item) = items[index].as_object_mut() else {
                continue;
            };
            item.shift_remove("step");
            if let Some(step) = current_step(&page.messages).filter(|step| !step.is_empty()) {
                item.insert("step".into(), json!(step));
            }
        }
        Ok(Some(json!({ "items": items, "usage": usage })))
    }

    /// `#cost`: what a session has cost over its whole journal (the title bar's figure). While its omp cannot say
    /// (restarting, a paired device's link down, a read past its timeout) the last figure read stands: a cost never
    /// drops to nothing.
    pub(crate) async fn cost(&self, tab: &ControlTab) -> f64 {
        if tab.hidden {
            return 0.0;
        }
        let response = if tab.status.is_up() {
            self.host
                .command(
                    &tab.tab_id,
                    &json!({ "type": "get_session_stats" }),
                    Deadline::Ms(self.tuning.state_timeout_ms),
                )
                .await
                .ok()
        } else {
            None
        };
        let Some(response) = response.filter(|response| response.success) else {
            return self
                .mem()
                .last_spend
                .get(&tab.tab_id)
                .map_or(0.0, |spend| spend.cost);
        };
        let stats = response.data;
        let history = stats
            .as_ref()
            .and_then(|stats| stats.get("history"))
            .and_then(|history| history.get("cost"))
            .filter(|cost| cost.is_number());
        let read = history
            .or_else(|| stats.as_ref().and_then(|stats| stats.get("cost")))
            .and_then(Value::as_f64);
        let cost = read
            .filter(|read| read.is_finite() && *read > 0.0)
            .unwrap_or(0.0);
        let mut mem = self.mem();
        let split = mem
            .last_spend
            .get(&tab.tab_id)
            .and_then(|spend| spend.split);
        mem.last_spend
            .insert(tab.tab_id.clone(), Spend { cost, split });
        cost
    }

    /// `#split`: the session's spend split into a metered charge and a subscription's estimate, classed by its own
    /// host (`get_session_spend`: its journal per provider, that computer's auth data); the last split read while
    /// its omp cannot say.
    pub(crate) async fn split(&self, tab: &ControlTab) -> Option<CostSplit> {
        if tab.hidden {
            return None;
        }
        let response = if tab.status.is_up() {
            self.host
                .command(
                    &tab.tab_id,
                    &json!({ "type": "get_session_spend" }),
                    Deadline::Ms(self.tuning.state_timeout_ms),
                )
                .await
                .ok()
        } else {
            None
        };
        let providers = response
            .filter(|response| response.success)
            .and_then(|response| response.data)
            .and_then(|data| data.get("providers").and_then(Value::as_object).cloned());
        let Some(providers) = providers else {
            return self
                .mem()
                .last_spend
                .get(&tab.tab_id)
                .and_then(|spend| spend.split);
        };
        let split = cost_split_of(&providers);
        let mut mem = self.mem();
        let cost = mem
            .last_spend
            .get(&tab.tab_id)
            .map_or(0.0, |spend| spend.cost);
        mem.last_spend.insert(
            tab.tab_id.clone(),
            Spend {
                cost,
                split: Some(split),
            },
        );
        Some(split)
    }
}
