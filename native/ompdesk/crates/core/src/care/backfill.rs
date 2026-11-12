//! Backfill (7d; was `src/main/ai-memory/backfill.ts`): session conclusions for the turns that ended before the server
//! captured them (it keeps a turn's last reply only from 19 Oct 2026 21:49 UTC on), read back from omp's own journals.
//! A conclusion is an assistant message that ended a run (`stopReason: "stop"`) with text, cut by the shipped
//! `conclusionExcerpt`; the stock worker finds them (`Facts::journal`: the first prompt and the turns), the rest is
//! here: which journals, which project each belongs to, which turns the server already captured itself, what to write.
//!
//! Only the server's one write path is used (`Store::write_conclusions`), into the project the server already holds
//! the session under (its id), else the one project every known session of the journal's folder belongs to; any other
//! journal is skipped and counted. The rows are written as copies from THIS computer (`origin` = its device id), which
//! lets the sync carry them to the paired computers exactly once. The id says what they are:
//! `backfill:<session id>:<message time in ms>`, so a second pass writes nothing new.
//!
//! A turn the server captured itself is never copied: per session only the turns before its first native conclusion
//! (the global start of capture for a session with none; with no native conclusion at all, ten minutes ago), and never
//! one whose text equals a native conclusion of that session.
//!
//! State (`memo.backfill`, `{v: 1, store, done}`) records the journals a pass finished, keyed by the database id the
//! server reports (a new store starts over) and by the journal's path below the sessions folder, spelled as node
//! spells it on the platform. A pass reads at most `maxJournals` journals and writes at most `maxRows` rows and goes
//! on from the state.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value, json};

use super::judge::cut_units;
use super::{Ctx, date_parse, is_cancelled, iso_of, js_round};
use crate::aimemory::ops::{ConclusionInput, ProjectRef};
use crate::aimemory::value::{js_order, one_line};
use crate::fs::order::js_trim;
use crate::json::whole_surrogates;
use crate::server::Fault;
use crate::upkeep::facts::PromptItem;

/// A journal whose eligible turns can no longer change: the cutoff came from the server's own conclusions.
const FINAL: f64 = -1.0;
const MAX_JOURNALS: usize = 300;
const MAX_ROWS: usize = 1500;
const WRITE_BATCH: usize = 200;
const NATIVE_PAGE: u64 = 500;
const MAX_NATIVE_PAGES: usize = 400;
const SESSION_PAGE: usize = 100;
const MAX_SESSION_PAGES: usize = 100;
/// With no native conclusion in the store at all: a turn this recent may still be about to get its own.
const RECENT_MS: f64 = 10.0 * 60_000.0;
const HEADER_BYTES: usize = 32 * 1024;
const MEMO_KEY: &str = "backfill";
const ADVISOR_JOURNAL: &str = "__advisor.jsonl";
const SAME_TEXT_CHARS: usize = 60;

/// What a pass did.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The database the state belongs to ("" from a server that does not say).
    pub store: String,
    /// Conversation journals found (an advisor's `__advisor.jsonl` never counts).
    pub journals: usize,
    /// Finished in an earlier pass and unchanged since: not looked at.
    pub done: usize,
    /// Looked at this pass and mapped to a project, by the session id the server holds / by the folder.
    pub mapped_by_id: usize,
    pub mapped_by_cwd: usize,
    /// Skipped: no session header, the folder none of the server's sessions use, the folder two projects' sessions use.
    pub no_header: usize,
    pub unmapped: usize,
    pub ambiguous: usize,
    /// A mapped journal stock could not read.
    pub unreadable: usize,
    /// Read but not copied: an agent wrote the first prompt and it names no task with a `Title:` line.
    pub untitled: usize,
    /// Journals read this pass, and the turns of them still to be written (not native, before the cutoff).
    pub read: usize,
    pub turns: usize,
    pub written: usize,
    pub same: usize,
    /// Rows the server kept nothing of after its own scrubbing.
    pub refused: usize,
    /// Mapped journals still waiting for a later pass (the budget ended this one).
    pub remaining: usize,
    /// The server failed a write: the pass stopped, the journal is read again next time.
    pub failed: bool,
    pub ms: f64,
}

/// What a pass is asked.
pub struct Deps<'a> {
    /// The stock sessions folder: `<cwd-slug>/<timestamp>_<id>.jsonl`, a subagent's at
    /// `<…>/<timestamp>_<id>/<n>-<Agent>.jsonl`.
    pub sessions_dir: &'a str,
    /// This computer's OMPdesk device id: the origin the copies are written under.
    pub origin: &'a str,
    pub max_journals: Option<usize>,
    pub max_rows: Option<usize>,
}

fn project_key(project: &ProjectRef) -> String {
    format!("{}\u{0}{}", project.workspace, project.project)
}

/// `id.replaceAll("-", "").toLowerCase()`.
fn session_key(id: &str) -> String {
    id.replace('-', "").to_lowercase()
}

/// `text.replace(/\s+/g, " ").trim().slice(0, 60)`.
fn text_key(text: &str) -> String {
    cut_units(&one_line(text), SAME_TEXT_CHARS)
}

/// `UUID`: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, either case.
fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

/// A conversation journal below the sessions folder.
struct Journal {
    path: PathBuf,
    /// `relative(sessionsDir, path)`, as node spells it on this platform.
    key: String,
}

/// Every conversation journal under `base` (a subfolder that cannot be read counts for none), oldest name first: the
/// full path in UTF-16 order, as `Array.prototype.sort` orders the strings.
fn journals_under(base: &Path) -> Vec<Journal> {
    fn walk(base: &Path, names: &mut Vec<String>, found: &mut Vec<Journal>) {
        let folder = names
            .iter()
            .fold(base.to_path_buf(), |path, name| path.join(name));
        let Ok(entries) = std::fs::read_dir(&folder) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                names.push(name);
                walk(base, names, found);
                names.pop();
            } else if kind.is_file() && name.ends_with(".jsonl") && name != ADVISOR_JOURNAL {
                let path = folder.join(&name);
                let key = names
                    .iter()
                    .map(String::as_str)
                    .chain([name.as_str()])
                    .collect::<Vec<_>>()
                    .join(std::path::MAIN_SEPARATOR_STR);
                found.push(Journal { path, key });
            }
        }
    }
    let mut found = Vec::new();
    walk(base, &mut Vec::new(), &mut found);
    found.sort_by(|left, right| js_order(&left.key, &right.key));
    found
}

struct Header {
    id: String,
    cwd: Option<String>,
    title: Option<String>,
}

/// The journal's `type: "session"` line (stock writes it first or just after a title line), from its first 32 KiB and
/// first 8 lines. A journal that cannot be opened has none; one that opens and fails to read fails the pass.
fn read_header(path: &Path) -> Result<Option<Header>, Fault> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return Ok(None);
    };
    let mut buffer = vec![0_u8; HEADER_BYTES];
    let read = file
        .read(&mut buffer)
        .map_err(|error| Fault::new("io", format!("read {}: {error}", path.display())))?;
    let head = String::from_utf8_lossy(&buffer[..read]);
    for line in head.split('\n').take(8) {
        let Ok(entry) = serde_json::from_str::<Value>(&whole_surrogates(line)) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_uuid(id))
        else {
            return Ok(None);
        };
        let text = |name: &str| entry.get(name).and_then(Value::as_str);
        return Ok(Some(Header {
            id: id.to_lowercase(),
            cwd: text("cwd").filter(|cwd| !cwd.is_empty()).map(str::to_owned),
            title: text("title")
                .map(js_trim)
                .filter(|title| !title.is_empty())
                .map(str::to_owned),
        }));
    }
    Ok(None)
}

/// What the server knows of its own conclusions: where its capture began and what it already holds per session.
struct Natives {
    store: String,
    /// The earliest native conclusion in the store, ms; none when it has none.
    first: Option<f64>,
    first_by_session: HashMap<String, f64>,
    texts_by_session: HashMap<String, HashSet<String>>,
}

async fn read_natives(ctx: &Ctx) -> Result<Natives, Fault> {
    let mut natives = Natives {
        store: String::new(),
        first: None,
        first_by_session: HashMap::new(),
        texts_by_session: HashMap::new(),
    };
    let mut after = 0_u64;
    for _ in 0..MAX_NATIVE_PAGES {
        let batch = ctx.store.conclusions("native", after, NATIVE_PAGE).await?;
        natives.store = batch.store;
        for row in batch.rows {
            let key = session_key(&row.session_id);
            if let Some(at) = date_parse(&row.at) {
                let at = at as f64;
                natives.first = Some(natives.first.map_or(at, |first| first.min(at)));
                let known = natives.first_by_session.entry(key.clone()).or_insert(at);
                *known = known.min(at);
            }
            natives
                .texts_by_session
                .entry(key)
                .or_default()
                .insert(text_key(&row.body));
        }
        let next = batch
            .next
            .as_u64()
            .or_else(|| batch.next.as_f64().map(|next| next as u64))
            .unwrap_or(after);
        if !batch.more || next == after {
            break;
        }
        after = next;
    }
    Ok(natives)
}

/// The sessions the server holds: the project of each id, and the projects whose sessions ran in each folder (in the
/// order each folder first showed one).
struct Sessions {
    project_by_id: HashMap<String, ProjectRef>,
    projects_by_cwd: HashMap<String, Vec<(String, ProjectRef)>>,
}

async fn read_sessions(ctx: &Ctx) -> Result<Sessions, Fault> {
    let mut sessions = Sessions {
        project_by_id: HashMap::new(),
        projects_by_cwd: HashMap::new(),
    };
    for listed in ctx.store.projects().await? {
        let project = ProjectRef {
            workspace: listed.workspace,
            project: listed.project,
        };
        for page in 0..MAX_SESSION_PAGES {
            let rows = ctx
                .store
                .sessions(
                    &project,
                    Some(SESSION_PAGE as u64),
                    Some((page * SESSION_PAGE) as u64),
                )
                .await?;
            for session in &rows {
                sessions
                    .project_by_id
                    .insert(session_key(&session.id), project.clone());
                if session.cwd.is_empty() {
                    continue;
                }
                let projects = sessions
                    .projects_by_cwd
                    .entry(session.cwd.clone())
                    .or_default();
                let key = project_key(&project);
                match projects.iter_mut().find(|(known, _)| *known == key) {
                    Some((_, known)) => *known = project.clone(),
                    None => projects.push((key, project.clone())),
                }
            }
            if rows.len() < SESSION_PAGE {
                break;
            }
        }
    }
    Ok(sessions)
}

/// `memo.backfill` as the zod schema `{v: literal(1), store: string, done: record(number)}` reads it (anything else,
/// and a state of another store, starts over; members beside these are dropped).
fn read_state(memo: &Map<String, Value>, store: &str) -> Map<String, Value> {
    let saved = memo
        .get(MEMO_KEY)
        .and_then(Value::as_object)
        .and_then(|saved| {
            let done = saved.get("done")?.as_object()?;
            (saved.get("v")?.as_f64() == Some(1.0)
                && saved.get("store")?.as_str() == Some(store)
                && done.values().all(Value::is_number))
            .then(|| done.clone())
        });
    saved.unwrap_or_default()
}

fn state_value(store: &str, done: &Map<String, Value>) -> Value {
    json!({ "v": 1, "store": store, "done": done })
}

struct Candidate {
    path: String,
    key: String,
    size: u64,
    header: Header,
    project: ProjectRef,
}

/// One pass: map the journals not finished yet, read the server's own conclusions, and write the missing turns of as
/// many journals as the budget allows. Fails only when the server cannot be asked at all; a failed write ends the
/// pass with `failed: true`. `memo` is changed in place as the pass goes, also when it fails.
pub async fn backfill_conclusions(
    ctx: &Ctx,
    deps: &Deps<'_>,
    memo: &mut Map<String, Value>,
) -> Result<Report, Fault> {
    let started = ctx.clock.now();
    let mut report = Report {
        store: ctx.store.conclusions("native", 0, 1).await?.store,
        ..Report::default()
    };
    let mut done = read_state(memo, &report.store);
    memo.insert(MEMO_KEY.to_owned(), state_value(&report.store, &done));
    let outcome = pass(ctx, deps, &mut report, &mut done, started).await;
    memo.insert(MEMO_KEY.to_owned(), state_value(&report.store, &done));
    outcome?;
    Ok(report)
}

fn finish(ctx: &Ctx, report: &mut Report, started: f64) {
    report.ms = ctx.clock.now() - started;
}

async fn pass(
    ctx: &Ctx,
    deps: &Deps<'_>,
    report: &mut Report,
    done: &mut Map<String, Value>,
    started: f64,
) -> Result<(), Fault> {
    let max_journals = deps.max_journals.unwrap_or(MAX_JOURNALS);
    let max_rows = deps.max_rows.unwrap_or(MAX_ROWS);
    let base: PathBuf = Path::new(deps.sessions_dir).components().collect();
    let found = {
        let base = base.clone();
        tokio::task::spawn_blocking(move || {
            journals_under(&base)
                .into_iter()
                .map(|journal| {
                    let size = std::fs::metadata(&journal.path).map(|meta| meta.len()).ok();
                    (journal, size)
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|error| Fault::new("internal", error.to_string()))?
    };
    report.journals = found.len();
    let mut todo: Vec<(Journal, u64)> = Vec::new();
    for (journal, size) in found {
        // A journal that cannot be stat'ed is counted but not looked at.
        let Some(size) = size else {
            continue;
        };
        let finished = done.get(&journal.key).and_then(Value::as_f64);
        if finished == Some(FINAL) || finished == Some(size as f64) {
            report.done += 1;
        } else {
            todo.push((journal, size));
        }
    }
    if todo.is_empty() {
        finish(ctx, report, started);
        return Ok(());
    }

    let sessions = read_sessions(ctx).await?;
    let mut candidates: Vec<Candidate> = Vec::new();
    for (journal, size) in todo {
        let path = journal.path.clone();
        let header = tokio::task::spawn_blocking(move || read_header(&path))
            .await
            .map_err(|error| Fault::new("internal", error.to_string()))??;
        let Some(header) = header else {
            report.no_header += 1;
            continue;
        };
        let item = |project: ProjectRef, header: Header| Candidate {
            path: journal.path.to_string_lossy().into_owned(),
            key: journal.key.clone(),
            size,
            header,
            project,
        };
        if let Some(project) = sessions.project_by_id.get(&session_key(&header.id)) {
            report.mapped_by_id += 1;
            candidates.push(item(project.clone(), header));
            continue;
        }
        let projects = header
            .cwd
            .as_ref()
            .and_then(|cwd| sessions.projects_by_cwd.get(cwd));
        match projects {
            None => report.unmapped += 1,
            Some(projects) if projects.len() > 1 => report.ambiguous += 1,
            Some(projects) => {
                report.mapped_by_cwd += 1;
                let project = projects[0].1.clone();
                candidates.push(item(project, header));
            }
        }
    }
    if candidates.is_empty() {
        finish(ctx, report, started);
        return Ok(());
    }

    let natives = read_natives(ctx).await?;
    let cutoff = natives.first.unwrap_or(started - RECENT_MS);
    let mut titles: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut attempted = 0_usize;
    for (index, candidate) in candidates.iter().enumerate() {
        if report.read >= max_journals || attempted >= max_rows {
            report.remaining = candidates.len() - index;
            break;
        }
        report.read += 1;
        let journal = match ctx.facts.journal(&candidate.path).await {
            Ok(journal) => journal,
            Err(fault) if is_cancelled(&fault) => return Err(fault),
            Err(_) => {
                report.unreadable += 1;
                done.insert(candidate.key.clone(), json!(candidate.size));
                continue;
            }
        };
        let first = journal.first_prompt.unwrap_or_default();
        let first_facts = ctx
            .facts
            .prompts(&[PromptItem {
                text: first,
                session_name: candidate.header.title.clone(),
            }])
            .await?
            .remove(0);
        if first_facts.agent && first_facts.explicit.as_deref().is_none_or(str::is_empty) {
            report.untitled += 1;
            done.insert(candidate.key.clone(), json!(FINAL as i64));
            continue;
        }
        let session_id = session_key(&candidate.header.id);
        let limit = natives
            .first_by_session
            .get(&session_id)
            .copied()
            .unwrap_or(cutoff);
        let held = natives.texts_by_session.get(&session_id);
        let turns: Vec<_> = journal
            .turns
            .into_iter()
            .filter(|turn| {
                turn.at < limit && !held.is_some_and(|held| held.contains(&text_key(&turn.body)))
            })
            .collect();
        report.turns += turns.len();
        if !turns.is_empty() {
            let title = title_of(ctx, candidate, &mut titles, &first_facts, &turns[0].body).await?;
            let items: Vec<ConclusionInput> = turns
                .iter()
                .map(|turn| ConclusionInput {
                    id: format!(
                        "backfill:{}:{}",
                        candidate.header.id,
                        js_round(turn.at) as i64
                    ),
                    session_id: candidate.header.id.clone(),
                    title: title.clone(),
                    body: turn.body.clone(),
                    at: iso_of(turn.at),
                })
                .collect();
            attempted += items.len();
            let mut failed = false;
            for batch in items.chunks(WRITE_BATCH) {
                match ctx
                    .store
                    .write_conclusions(&candidate.project, deps.origin, batch)
                    .await
                {
                    Ok(statuses) => {
                        for status in statuses {
                            match status.as_str() {
                                "written" => report.written += 1,
                                "same" => report.same += 1,
                                _ => report.refused += 1,
                            }
                        }
                    }
                    Err(fault) if is_cancelled(&fault) => return Err(fault),
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            if failed {
                report.failed = true;
                report.remaining = candidates.len() - index;
                break;
            }
        }
        let value = if natives.first.is_none() {
            json!(candidate.size)
        } else {
            json!(FINAL as i64)
        };
        done.insert(candidate.key.clone(), value);
    }
    finish(ctx, report, started);
    ctx.log(
        "care-backfill",
        json!({
            "store": report.store,
            "journals": report.journals,
            "done": report.done,
            "read": report.read,
            "mappedById": report.mapped_by_id,
            "mappedByCwd": report.mapped_by_cwd,
            "noHeader": report.no_header,
            "unmapped": report.unmapped,
            "ambiguous": report.ambiguous,
            "unreadable": report.unreadable,
            "untitled": report.untitled,
            "turns": report.turns,
            "written": report.written,
            "same": report.same,
            "refused": report.refused,
            "remaining": report.remaining,
            "failed": report.failed,
            "ms": report.ms,
        }),
    );
    Ok(())
}

/// The title the copies carry: the session page the server holds for it (unless a junk title), else the first
/// prompt's, else the first meaningful line of the first turn, else the session's id.
async fn title_of(
    ctx: &Ctx,
    candidate: &Candidate,
    titles: &mut HashMap<String, HashMap<String, String>>,
    first: &crate::upkeep::facts::PromptFacts,
    first_turn: &str,
) -> Result<String, Fault> {
    let key = project_key(&candidate.project);
    if !titles.contains_key(&key) {
        let mut by_path = HashMap::new();
        for page in ctx.store.pages(&candidate.project).await? {
            by_path.insert(page.path.clone(), page.title.clone());
        }
        titles.insert(key.clone(), by_path);
    }
    let page_title = titles[&key]
        .get(&format!("sessions/{}.md", candidate.header.id))
        .filter(|title| !title.is_empty());
    let mut asked = vec![PromptItem {
        text: first_turn.to_owned(),
        session_name: None,
    }];
    if let Some(title) = page_title {
        asked.push(PromptItem {
            text: title.clone(),
            session_name: None,
        });
    }
    let facts = ctx.facts.prompts(&asked).await?;
    if let Some(title) = page_title
        && !facts[1].junk
    {
        return Ok(title.clone());
    }
    Ok(first
        .title
        .clone()
        .or_else(|| facts[0].first_line.clone())
        .unwrap_or_else(|| format!("Session {}", candidate.header.id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_key_folds_whitespace_and_cuts_at_sixty_units() {
        assert_eq!(text_key("  a \n\t b  "), "a b");
        assert_eq!(text_key(&"x".repeat(100)).len(), 60);
        // Sixty units: the 61st is the cut, a pair split by it reads as the replacement character.
        let emoji = "😀".repeat(40);
        assert_eq!(text_key(&emoji).chars().count(), 30);
    }

    #[test]
    fn a_session_key_has_no_dashes_and_is_lower_case() {
        assert_eq!(
            session_key("01A14F00-0000-7000-8000-000000000001"),
            "01a14f00000070008000000000000001"
        );
    }

    #[test]
    fn a_uuid_is_five_hex_groups() {
        assert!(is_uuid("01a14f00-0000-7000-8000-000000000001"));
        assert!(is_uuid("01A14F00-0000-7000-8000-00000000000F"));
        assert!(!is_uuid("01a14f00-0000-7000-8000-00000000000"));
        assert!(!is_uuid("01a14f00-0000-7000-8000-00000000000g"));
        assert!(!is_uuid("01a14f0000007000800000000000000001"));
        assert!(!is_uuid("01a14f00-0000-7000-8000-000000000001\n"));
    }
}
