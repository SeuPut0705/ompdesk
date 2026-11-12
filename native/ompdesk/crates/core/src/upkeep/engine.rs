//! What OMPdesk does for memory's quality once the server is up (was `src/main/ai-memory/upkeep.ts`'s `MemoryUpkeep`),
//! with ai-memory's own write paths and nothing else:
//!
//! 1. **Repair, once per launch** (`retitle.rs`, `names.rs`): ambiguous names renamed, session pages filed under protocol
//!    text given their task's name, the handoffs a child session left discarded. Idempotent.
//! 2. **Learn** (`distill.rs`): a conversation a person has paused (10 minutes quiet) with 6 or more new messages of
//!    theirs is read once by the cheap model, and the pages that pass the checks are created: the project's in its own
//!    project, the owner's preferences and corrections in `_global`, and none the project's rules file already states.
//!    A new page that replaces one memory holds (named by the model, `supersede.rs`) takes the old one out of default
//!    recall. At most one run per hour and six per day, one conversation per run.
//!
//! Only what a person typed is read. The timers stay in main (`upkeep.ts`): each tick and each repair is one request,
//! and what a `MemoryUpkeep` remembers between them (which conversations were seen, which wait for their person to go
//! quiet, when the names were last repaired, whether a tick runs) lives here, per `service`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::task::Poll;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use super::asks::Asker;
use super::distill::{
    DISTILL_MIN_PROMPTS, DigestPrompt, DistillKind, GLOBAL_PROJECT, KNOWN_EXCERPT_CHARS,
    KNOWN_GLOBAL_PAGES, KNOWN_PROJECT_PAGES, KnownPage, PromptObservation, TASK_TITLES, TaskTitle,
    build_digest, date_parse, distill_message, parse_proposals, person_prompts, prompt_text,
    proposal_markdown, proposal_path,
};
use super::facts::{Facts, PromptItem};
use super::model::{Message, Model, ModelResult};
use super::names::rename_ambiguous_projects;
use super::retitle::{RetitleReport, retitle_session_pages};
use super::rules_file::{read_rules_text, rules_index, rules_outline, stated_by_rules};
use super::store::{Retired, Store};
use super::supersede::page_to_replace;
use crate::aimemory::ops::{CreateInput, PageAt, PageRef, ProjectRef, RetireInput, Session};
use crate::aimemory::value::{iso, one_line};
use crate::disk::tree::write_atomic_if;
use crate::fs::order::js_trim;
use crate::json::{utf16_prefix, whole_surrogates};
use crate::server::Fault;

/// A conversation is read once its person has been quiet this long.
pub const UPKEEP_IDLE_MS: f64 = 10.0 * 60_000.0;
pub const UPKEEP_MIN_GAP_MS: f64 = 60.0 * 60_000.0;
pub const UPKEEP_DAILY_MAX: usize = 6;
pub const DAY_MS: f64 = 24.0 * 60.0 * 60_000.0;
/// Ambiguous names are looked for again from a tick at most this often (each look reads every unclaimed project's
/// name).
pub const NAME_REPAIR_GAP_MS: f64 = 60.0 * 60_000.0;
pub const SCAN_SESSIONS: u64 = 100;

/// What one service (one `MemoryUpkeep` of main) remembers between its requests.
#[derive(Default)]
pub struct Memory {
    /// Observation counts at the last look, so a session nobody wrote to since is not read again every tick.
    seen: Mutex<HashMap<String, f64>>,
    /// Sessions with enough new messages that were not quiet yet: looked at again whatever their count.
    waiting: Mutex<HashSet<String>>,
    /// When ambiguous names were last repaired; none before the first.
    names_at: Mutex<Option<f64>>,
    pub(super) running: AtomicBool,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

static SERVICES: LazyLock<Mutex<HashMap<String, Arc<Memory>>>> = LazyLock::new(Default::default);

impl Memory {
    /// The memory of `service`, made on its first request.
    pub fn of(service: &str) -> Arc<Memory> {
        Arc::clone(locked(&SERVICES).entry(service.to_owned()).or_default())
    }

    /// `upkeep.close`: the service is gone.
    pub fn forget(service: &str) {
        locked(&SERVICES).remove(service);
    }
}

/// Clears `running` when the tick ends, however it ends (an answer, an error, a cancelled request).
struct Running(Arc<Memory>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

/// The clock the TypeScript read as `now()`: the time the request carried (a test drives it), else the system's.
#[derive(Clone, Copy)]
pub struct Clock(pub Option<f64>);

impl Clock {
    pub fn now(self) -> f64 {
        self.0.unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |since| since.as_millis() as f64)
        })
    }
}

/// `upkeep.json`: which conversations were read up to which message, and when the runs were.
struct State {
    /// Per session: how many of its person prompts earlier runs have read, and when (`{done, at}`).
    sessions: Map<String, Value>,
    /// Start times (ISO) of the runs in the last day.
    runs: Vec<String>,
}

impl State {
    fn empty() -> State {
        State {
            sessions: Map::new(),
            runs: Vec::new(),
        }
    }

    /// `JSON.stringify(state)`.
    fn text(&self) -> String {
        json!({ "sessions": self.sessions, "runs": self.runs }).to_string()
    }

    /// `state.sessions[id]?.done ?? 0`, as a number the way `prompt.n > done` reads it.
    fn done(&self, id: &str) -> f64 {
        let Some(Value::Object(entry)) = self.sessions.get(id) else {
            return 0.0;
        };
        match entry.get("done") {
            None | Some(Value::Null) => 0.0,
            Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
            Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
            Some(Value::String(text)) => {
                let text = js_trim(text);
                if text.is_empty() {
                    0.0
                } else if text.chars().all(|c| "0123456789+-.eE".contains(c)) {
                    text.parse().unwrap_or(f64::NAN)
                } else {
                    f64::NAN
                }
            }
            Some(_) => f64::NAN,
        }
    }
}

/// `readState`: anything that is not the file's shape reads as an empty state.
async fn read_state(file: &Path) -> State {
    let file = file.to_owned();
    let Ok(Ok(bytes)) = tokio::task::spawn_blocking(move || std::fs::read(file)).await else {
        return State::empty();
    };
    let text = String::from_utf8_lossy(&bytes);
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&whole_surrogates(&text)) else {
        return State::empty();
    };
    State {
        sessions: match record.get("sessions") {
            Some(Value::Object(sessions)) => sessions.clone(),
            _ => Map::new(),
        },
        runs: match record.get("runs") {
            Some(Value::Array(runs)) => runs
                .iter()
                .filter_map(|run| run.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        },
    }
}

/// `writeFileAtomic(file, JSON.stringify(state))`.
async fn write_state(file: &Path, state: &State) -> Result<(), Fault> {
    let (file, text) = (file.to_owned(), state.text());
    tokio::task::spawn_blocking(move || {
        write_atomic_if(&file, text.as_bytes(), None, 0o777, &|| true)
    })
    .await
    .map_err(|error| Fault::new("internal", error.to_string()))?
    .map(drop)
}

/// A conversation worth reading.
struct Candidate {
    project: ProjectRef,
    session: Session,
    fresh: Vec<DigestPrompt>,
}

/// Runs every future at once and answers their outputs in order (`Promise.all` of futures that never fail).
async fn join_all<F: Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut futures: Vec<Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
    let mut outputs: Vec<Option<F::Output>> = futures.iter().map(|_| None).collect();
    std::future::poll_fn(|context| {
        let mut pending = false;
        for (future, output) in futures.iter_mut().zip(outputs.iter_mut()) {
            if output.is_none() {
                match future.as_mut().poll(context) {
                    Poll::Ready(value) => *output = Some(value),
                    Poll::Pending => pending = true,
                }
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
    outputs.into_iter().flatten().collect()
}

/// `Number(x.toFixed(4))`. JavaScript takes the larger of two equally near results where Rust rounds a tie to even; a
/// tie is exact only for a multiple of 1/32.
fn fixed4(value: f64) -> f64 {
    let size = value.abs();
    let scaled = size * 32.0;
    let tie = scaled.fract() == 0.0 && scaled % 2.0 == 1.0;
    let text = format!("{:.4}", if tie { size.next_up() } else { size });
    let rounded = text.parse::<f64>().unwrap_or(0.0);
    if value < 0.0 && rounded != 0.0 {
        -rounded
    } else {
        rounded
    }
}

/// `/^#[^\n]*\n/` dropped, whitespace folded, cut to `KNOWN_EXCERPT_CHARS` UTF-16 units: the start of a page's body.
fn excerpt_of(markdown: &str) -> String {
    let body = match markdown.strip_prefix('#') {
        Some(rest) => rest.find('\n').map_or(markdown, |at| &rest[at + 1..]),
        None => markdown,
    };
    utf16_prefix(&one_line(body), KNOWN_EXCERPT_CHARS)
}

pub struct Upkeep {
    pub asker: Asker,
    pub asks: Vec<String>,
    pub store: Store,
    pub facts: Facts,
    pub model: Model,
    pub locale: String,
    pub state_file: PathBuf,
    pub clock: Clock,
    pub memory: Arc<Memory>,
}

impl Upkeep {
    fn log(&self, message: &str, details: Value) {
        self.asker.log(message, details);
    }

    fn failed(&self, details: Value) {
        self.log("failed", details);
    }

    /// Ambiguous names renamed (`names.rs`), at launch and then at most once an hour from a tick: a paired computer's
    /// sync can make one while the app runs, and every read of it fails until it is renamed. Never fails.
    async fn repair_names(&self) {
        *locked(&self.memory.names_at) = Some(self.clock.now());
        match rename_ambiguous_projects(&self.store).await {
            Ok(repair) => {
                for done in &repair.renamed {
                    self.log(
                        "renamed",
                        json!({ "workspace": done.workspace, "from": done.from, "to": done.to }),
                    );
                }
                for left in &repair.refused {
                    self.failed(json!({
                        "step": "rename",
                        "project": format!("{}/{}", left.workspace, left.project),
                        "detail": left.detail,
                    }));
                }
            }
            Err(fault) => self.failed(json!({ "step": "rename", "detail": fault.message })),
        }
    }

    /// The repair: logs what it did, nothing when there was nothing to do. Never fails; answers the report, or null.
    pub async fn repair(&self) -> Value {
        // First, so every later read (retitle, learning, care, the sync) can name each project again.
        self.repair_names().await;
        match retitle_session_pages(&self.store, &self.facts, &self.locale, false).await {
            Ok(report) => {
                if !report.retitled.is_empty()
                    || report.child_handoffs > 0
                    || !report.failed.is_empty()
                    || !report.unresolved.is_empty()
                {
                    self.log("retitle", summarize(&report));
                }
                serde_json::to_value(&report).unwrap_or(Value::Null)
            }
            Err(fault) => {
                self.failed(json!({ "step": "retitle", "detail": fault.message }));
                Value::Null
            }
        }
    }

    /// One look at the conversations: at most one model call.
    pub async fn tick(&self) -> Result<Value, Fault> {
        let names_at = *locked(&self.memory.names_at);
        if names_at.is_none_or(|at| self.clock.now() - at >= NAME_REPAIR_GAP_MS) {
            self.repair_names().await;
        }
        if self.memory.running.swap(true, Ordering::SeqCst) {
            return Ok(json!({ "ran": false, "reason": "busy" }));
        }
        let _running = Running(Arc::clone(&self.memory));
        let mut state = read_state(&self.state_file).await;
        let now = self.clock.now();
        let age = |run: &str| date_parse(run).map_or(f64::NAN, |at| now - at as f64);
        let runs: Vec<String> = state
            .runs
            .iter()
            .filter(|run| age(run) < DAY_MS)
            .cloned()
            .collect();
        if runs
            .last()
            .is_some_and(|last| age(last) < UPKEEP_MIN_GAP_MS)
        {
            return Ok(json!({ "ran": false, "reason": "gap" }));
        }
        if runs.len() >= UPKEEP_DAILY_MAX {
            return Ok(json!({ "ran": false, "reason": "daily" }));
        }
        let Some(candidate) = self.pick(&state, now).await? else {
            return Ok(json!({ "ran": false, "reason": "nothing" }));
        };
        // The attempt counts against the schedule whether the model answers or not: a broken omp is not retried every tick.
        state.runs = runs;
        state.runs.push(iso(now as u64));
        write_state(&self.state_file, &state).await?;
        self.learn(candidate, &mut state, now).await
    }

    async fn pick(&self, state: &State, now: f64) -> Result<Option<Candidate>, Fault> {
        let mut best: Option<Candidate> = None;
        for project in self.store.projects().await? {
            // `_global` and the like are the profile's scope, written by the owner, never learned into.
            if project.project.starts_with('_') {
                continue;
            }
            let at = ProjectRef {
                workspace: project.workspace.clone(),
                project: project.project.clone(),
            };
            // One project the server cannot read (a name it calls ambiguous) never keeps the others from being learned.
            let sessions = match self.store.sessions(&at, Some(SCAN_SESSIONS), None).await {
                Ok(sessions) => sessions,
                Err(fault) => {
                    self.failed(json!({
                        "step": "learn-project",
                        "project": format!("{}/{}", at.workspace, at.project),
                        "detail": fault.message,
                    }));
                    continue;
                }
            };
            for session in sessions {
                let observations = session.observations.as_f64().unwrap_or(f64::NAN);
                let unchanged = locked(&self.memory.seen).get(&session.id) == Some(&observations);
                if unchanged && !locked(&self.memory.waiting).contains(&session.id) {
                    continue;
                }
                let all = self.person_prompts(&at, &session.id).await?;
                locked(&self.memory.seen).insert(session.id.clone(), observations);
                let done = state.done(&session.id);
                let fresh: Vec<DigestPrompt> = all
                    .into_iter()
                    .filter(|prompt| f64::from(prompt.n) > done)
                    .collect();
                if fresh.len() < DISTILL_MIN_PROMPTS {
                    locked(&self.memory.waiting).remove(&session.id);
                    continue;
                }
                // Enough to read: it stays on the list until a run has settled it, whether it is quiet yet or another one
                // went first.
                locked(&self.memory.waiting).insert(session.id.clone());
                let Some(last) = fresh.last().and_then(|prompt| prompt.at) else {
                    continue;
                };
                if now - (last as f64) < UPKEEP_IDLE_MS {
                    continue;
                }
                if best
                    .as_ref()
                    .is_none_or(|best| fresh.len() > best.fresh.len())
                {
                    best = Some(Candidate {
                        project: at.clone(),
                        session,
                        fresh,
                    });
                }
            }
        }
        Ok(best)
    }

    /// What a person typed in one session, in capture order; `isAgentPrompt` of every prompt asked in one batch.
    async fn person_prompts(
        &self,
        project: &ProjectRef,
        session_id: &str,
    ) -> Result<Vec<DigestPrompt>, Fault> {
        let kinds = vec!["user-prompt".to_owned()];
        let mut observations = Vec::new();
        let mut offset: u64 = 0;
        loop {
            let page = self
                .store
                .observations(project, session_id, offset, &kinds)
                .await?;
            let length = page.observations.len();
            observations.extend(page.observations);
            offset += length as u64;
            let total = page.total.as_f64().unwrap_or(0.0);
            if length == 0 || offset as f64 >= total {
                break;
            }
        }
        let asked: Vec<usize> = (0..observations.len())
            .filter(|at| {
                observations[*at].kind == "user-prompt"
                    && !prompt_text(&observations[*at].body).is_empty()
            })
            .collect();
        let mut agent = vec![false; observations.len()];
        if !asked.is_empty() {
            let items: Vec<PromptItem> = asked
                .iter()
                .map(|at| PromptItem {
                    text: prompt_text(&observations[*at].body).to_owned(),
                    session_name: None,
                })
                .collect();
            for (at, fact) in asked.iter().zip(self.facts.prompts(&items).await?) {
                agent[*at] = fact.agent;
            }
        }
        let read: Vec<PromptObservation<'_>> = observations
            .iter()
            .zip(agent)
            .map(|(observation, agent)| PromptObservation {
                kind: &observation.kind,
                body: &observation.body,
                created_at: observation.created_at.as_deref(),
                agent,
            })
            .collect();
        Ok(person_prompts(&read))
    }

    /// The durable pages memory holds, newest first, with the start of each: the project's and the owner's preferences
    /// in `_global`.
    async fn known_pages(&self, pages: &[PageRef]) -> Vec<KnownPage> {
        // `_global` exists once something wrote it; until then there is nothing to show.
        let global_at = ProjectRef {
            workspace: GLOBAL_PROJECT.workspace.to_owned(),
            project: GLOBAL_PROJECT.project.to_owned(),
        };
        let global = self.store.pages(&global_at).await.unwrap_or_default();
        let folder = format!("{}/", DistillKind::Preference.layout().folder);
        let shown: Vec<&PageRef> = pages
            .iter()
            .filter(|page| !page.path.starts_with("sessions/"))
            .take(KNOWN_PROJECT_PAGES)
            .chain(
                global
                    .iter()
                    .filter(|page| page.path.starts_with(&folder))
                    .take(KNOWN_GLOBAL_PAGES),
            )
            .collect();
        let reads = shown.iter().map(|page| async move {
            let at = PageAt {
                project: ProjectRef {
                    workspace: page.workspace.clone(),
                    project: page.project.clone(),
                },
                path: page.path.clone(),
            };
            self.store.page(&at).await.ok()
        });
        let read = join_all(reads.collect()).await;
        shown
            .iter()
            .zip(read)
            .map(|(page, read)| {
                // The H1 is the title the model already reads.
                let excerpt = read
                    .as_ref()
                    .map(|read| excerpt_of(&read.markdown))
                    .filter(|excerpt| !excerpt.is_empty());
                KnownPage {
                    path: page.path.clone(),
                    title: page.title.clone(),
                    global: page.project == GLOBAL_PROJECT.project,
                    excerpt,
                    id: read
                        .as_ref()
                        .map(|read| read.id.clone())
                        .filter(|id| !id.is_empty()),
                    pinned: read.as_ref().is_some_and(|read| read.pinned),
                }
            })
            .collect()
    }

    /// The rules files of the repository the session's folder is in; a failing ask reads as none.
    async fn rules_text(&self, cwd: &str) -> String {
        if self.asks.iter().any(|kind| kind == "rules") {
            match self.asker.ask("rules", json!({ "cwd": cwd })).await {
                Ok(Value::String(text)) => text,
                _ => String::new(),
            }
        } else {
            read_rules_text(cwd).await
        }
    }

    async fn learn(
        &self,
        candidate: Candidate,
        state: &mut State,
        now: f64,
    ) -> Result<Value, Fault> {
        let Candidate {
            project,
            session,
            fresh,
        } = candidate;
        let pages = self.store.pages(&project).await?;
        let known = self.known_pages(&pages).await;
        let session_titles: HashMap<&str, &str> = pages
            .iter()
            .filter(|page| page.path.starts_with("sessions/"))
            .map(|page| (page.path.as_str(), page.title.as_str()))
            .collect();
        let since = fresh.first().and_then(|prompt| prompt.at).unwrap_or(0) as f64;
        let tasks: Vec<String> = self
            .store
            .sessions(&project, Some(SCAN_SESSIONS), None)
            .await?
            .iter()
            .filter(|other| {
                other.id != session.id
                    && other
                        .started_at
                        .as_deref()
                        .filter(|at| !at.is_empty())
                        .and_then(date_parse)
                        .is_some_and(|at| at as f64 >= since)
            })
            .filter_map(|other| {
                session_titles
                    .get(format!("sessions/{}.md", other.id).as_str())
                    .map(|title| (*title).to_owned())
            })
            .collect();
        // The model reads the titles of the first few tasks as `unwrapPrompt` unwraps them.
        let shown_tasks = &tasks[..tasks.len().min(TASK_TITLES)];
        let bodies: Vec<String> = if shown_tasks.is_empty() {
            Vec::new()
        } else {
            let items: Vec<PromptItem> = shown_tasks
                .iter()
                .map(|title| PromptItem {
                    text: title.clone(),
                    session_name: None,
                })
                .collect();
            self.facts
                .prompts(&items)
                .await?
                .into_iter()
                .map(|fact| fact.body)
                .collect()
        };
        let titles: Vec<TaskTitle<'_>> = shown_tasks
            .iter()
            .zip(&bodies)
            .map(|(title, body)| TaskTitle { title, body })
            .collect();
        let digest = build_digest(&fresh, &titles);
        // The model sees the rules file's outline (it matches a Korean page to an English rule); `stated_by_rules` stays
        // the code backstop for what it still repeats.
        let rules_text = self.rules_text(&session.cwd).await;
        let message = distill_message(&digest, &known, &rules_outline(&rules_text));
        let result: ModelResult = match self
            .model
            .call(&Message {
                system: message.system,
                user: message.user,
            })
            .await
        {
            Ok(result) => result,
            Err(fault) => {
                self.failed(json!({
                    "step": "learn-model",
                    "session": session.id,
                    "detail": fault.message,
                }));
                return Ok(json!({ "ran": true, "failed": fault.message }));
            }
        };
        let mut parsed = parse_proposals(&result.text, &digest.prompts, &known);
        let proposals = std::mem::take(&mut parsed.proposals);
        let rules = rules_index(if proposals.is_empty() {
            ""
        } else {
            &rules_text
        });
        let mut created: Vec<String> = Vec::new();
        let mut superseded: Vec<String> = Vec::new();
        let mut retired_here: HashSet<String> = HashSet::new();
        let mut duplicates = 0;
        let mut in_rules = 0;
        for proposal in &proposals {
            if stated_by_rules(
                &rules,
                &proposal.title,
                &proposal.body,
                proposal.gist.as_deref(),
            ) {
                in_rules += 1;
                parsed.refused.push(format!(
                    "{}: the project's rules file already says it",
                    proposal.title
                ));
                continue;
            }
            let path = proposal_path(proposal.kind, &proposal.title);
            let layout = proposal.kind.layout();
            let target = if layout.global {
                ProjectRef {
                    workspace: GLOBAL_PROJECT.workspace.to_owned(),
                    project: GLOBAL_PROJECT.project.to_owned(),
                }
            } else {
                project.clone()
            };
            let label = |page: &str| {
                if layout.global {
                    format!("{}/{page}", GLOBAL_PROJECT.project)
                } else {
                    page.to_owned()
                }
            };
            let replaced = page_to_replace(proposal.kind, proposal.supersedes.as_deref(), &known);
            let written = self
                .store
                .create_page(
                    &PageAt {
                        project: target.clone(),
                        path: path.clone(),
                    },
                    &CreateInput {
                        body: proposal_markdown(
                            proposal,
                            &session.id,
                            replaced.map(|page| page.path.as_str()),
                        ),
                        tier: layout.tier.to_owned(),
                        kind: layout.kind.to_owned(),
                        session_id: (!layout.global).then(|| session.id.clone()),
                    },
                )
                .await?;
            if !written {
                duplicates += 1;
                continue;
            }
            created.push(label(&path));
            let Some(replaced) = replaced else {
                continue;
            };
            let key = label(&replaced.path);
            if !retired_here.contains(&key) {
                // Only once the new page exists, and only the version the model was shown: the old one leaves default recall.
                let retired = self
                    .store
                    .retire_page(
                        &PageAt {
                            project: target.clone(),
                            path: replaced.path.clone(),
                        },
                        &RetireInput {
                            when: iso(now as u64),
                            expected_page_id: replaced.id.clone().filter(|id| !id.is_empty()),
                            successor: Some(path.clone()),
                            reason: None,
                        },
                    )
                    .await;
                let said = match retired {
                    Ok(Retired::Retired) => None,
                    Ok(Retired::Pinned) => Some("pinned".to_owned()),
                    Ok(Retired::Changed) => Some("changed".to_owned()),
                    Err(fault) => Some(fault.message),
                };
                if let Some(said) = said {
                    parsed
                        .refused
                        .push(format!("{}: not superseded ({said})", replaced.path));
                    continue;
                }
                retired_here.insert(key.clone());
            }
            superseded.push(format!("{key} → {}", label(&path)));
        }
        // An answer that parsed (even one with no pages) settles the window; an unusable answer is read again next time.
        let understood = !proposals.is_empty()
            || parsed
                .refused
                .iter()
                .all(|line| !line.starts_with("answer is not"));
        if understood {
            let done = digest.shown.iter().copied().max().unwrap_or(0);
            state.sessions.insert(
                session.id.clone(),
                json!({ "done": done, "at": iso(now as u64) }),
            );
            write_state(&self.state_file, state).await?;
            locked(&self.memory.waiting).remove(&session.id);
        }
        let project_name = format!("{}/{}", project.workspace, project.project);
        let outcome = json!({
            "ran": true,
            "session": session.id,
            "project": project_name,
            "prompts": digest.shown.len(),
            "created": created,
            "duplicates": duplicates,
            "inRules": in_rules,
            "superseded": superseded,
            "refused": parsed.refused,
            "model": result.model,
            "inputTokens": result.input_tokens,
            "outputTokens": result.output_tokens,
            "costUsd": result.cost_usd,
        });
        self.log(
            "learn",
            json!({
                "session": session.id,
                "project": project_name,
                "prompts": digest.shown.len(),
                "created": created.len(),
                "duplicates": duplicates,
                "inRules": in_rules,
                "superseded": superseded.len(),
                "refused": parsed.refused.len(),
                "model": result.model,
                "inputTokens": result.input_tokens,
                "outputTokens": result.output_tokens,
                "costUsd": fixed4(result.cost_usd),
            }),
        );
        Ok(outcome)
    }
}

fn summarize(report: &RetitleReport) -> Value {
    json!({
        "projects": report.projects,
        "sessionPages": report.session_pages,
        "junk": report.junk,
        "retitled": report.retitled.len(),
        "unresolved": report.unresolved.len(),
        "changed": report.changed.len(),
        "openHandoffs": report.open_handoffs,
        "childHandoffsDiscarded": report.child_handoffs,
        "failed": report.failed.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::order::is_js_space;

    #[test]
    fn a_tie_rounds_up_as_to_fixed_does() {
        // 1/32 and 3/32 are exact ties at four digits: JavaScript takes the larger neighbour.
        assert_eq!(fixed4(0.03125), 0.0313);
        assert_eq!(fixed4(0.09375), 0.0938);
        assert_eq!(fixed4(0.0162), 0.0162);
        assert_eq!(fixed4(0.5), 0.5);
        assert_eq!(fixed4(0.00004), 0.0);
        assert_eq!(fixed4(-0.03125), -0.0313);
        assert_eq!(fixed4(0.0), 0.0);
    }

    #[test]
    fn the_excerpt_drops_the_heading_line_and_folds_whitespace() {
        assert_eq!(excerpt_of("# 제목\n\n본문   줄\n둘째"), "본문 줄 둘째");
        // No newline: no heading line to drop.
        assert_eq!(excerpt_of("# 제목만"), "# 제목만");
        assert_eq!(excerpt_of("본문\n# 아님"), "본문 # 아님");
        assert_eq!(excerpt_of("#\n"), "");
        let long = format!("# t\n{}", "가".repeat(300));
        assert_eq!(excerpt_of(&long).chars().count(), KNOWN_EXCERPT_CHARS);
        // The cut counts UTF-16 units: 199 + one astral pair is 201, so the pair is cut in half.
        let astral = format!("# t\n{}😀", "a".repeat(199));
        assert_eq!(excerpt_of(&astral), format!("{}\u{fffd}", "a".repeat(199)));
        // Only JavaScript's whitespace folds.
        assert_eq!(excerpt_of("x\u{3000}y\u{85}z"), "x y\u{85}z");
        assert!(is_js_space('\u{3000}'));
    }

    #[test]
    fn a_state_file_reads_as_readstate_read_it() {
        let state = |text: &str| {
            let dir = std::env::temp_dir().join(format!(
                "ompdesk-upkeep-state-{}-{}",
                std::process::id(),
                text.len()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("upkeep.json");
            std::fs::write(&file, text).unwrap();
            let read = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(read_state(&file));
            let _ = std::fs::remove_dir_all(&dir);
            read
        };
        let read = state(r#"{"sessions":{"a":{"done":3,"at":"x"}},"runs":["t",5,"u"],"other":1}"#);
        assert_eq!(read.runs, ["t", "u"]);
        assert_eq!(read.done("a"), 3.0);
        assert_eq!(read.done("b"), 0.0);
        assert_eq!(
            read.text(),
            r#"{"sessions":{"a":{"done":3,"at":"x"}},"runs":["t","u"]}"#
        );
        for malformed in [
            "",
            "nope",
            "[1]",
            "null",
            "5",
            r#"{"sessions":3,"runs":"x"}"#,
        ] {
            let read = state(malformed);
            assert!(
                read.sessions.is_empty() && read.runs.is_empty(),
                "{malformed}"
            );
            assert_eq!(read.text(), r#"{"sessions":{},"runs":[]}"#);
        }
        // `done` of another type reads as a number reads: text by its digits, true as 1, anything else not at all.
        let odd = state(
            r#"{"sessions":{"s":{"done":"4"},"t":{"done":true},"u":{"done":{}},"v":7,"w":{"done":null}}}"#,
        );
        assert_eq!(odd.done("s"), 4.0);
        assert_eq!(odd.done("t"), 1.0);
        assert!(odd.done("u").is_nan());
        assert_eq!(odd.done("v"), 0.0);
        assert_eq!(odd.done("w"), 0.0);
    }
}
