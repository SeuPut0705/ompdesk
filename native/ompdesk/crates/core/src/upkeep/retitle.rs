//! The one-time repair of what the old prompt-first-line titling left behind (was `src/main/ai-memory/retitle.ts`):
//! session pages filed under `<ompdesk-agent-message from="…">` or "Complete assignment thoroughly:", and the open
//! handoffs a subagent or an agent-opened session left.
//!
//! The pure parts are replayed against `retitle-captured.json`, what the TypeScript answered for the same inputs. The
//! engine (`retitle_session_pages`) reads and writes through the `Store` and asks `Facts` what `memory-prompt.ts`
//! says of each prompt, one batch per page of observations and one per project.

use std::collections::HashSet;

use serde::Serialize;

use super::facts::{Facts, PromptItem};
use super::store::Store;
use crate::aimemory::ops::{PageAt, PageRef, ProjectRef, SessionPageInput};
use crate::fs::order::{NameOrder, is_js_space, js_trim};
use crate::json::utf16_prefix;
use crate::server::Fault;

pub const SESSION_PREFIX: &str = "sessions/";
/// Prompts come 50 to a page; a session of a thousand prompts is not one this repair needs to finish naming.
pub const MAX_OBSERVATION_PAGES: usize = 20;
/// The observation kinds the repair reads.
pub const PROMPTS_ONLY: [&str; 1] = ["user-prompt"];

/// `/^(?:Started|Session focused on):\s*/`: the length of the lead-in the handoff summary starts with.
fn handoff_lead(summary: &str) -> Option<usize> {
    let rest = summary
        .strip_prefix("Started:")
        .or_else(|| summary.strip_prefix("Session focused on:"))?;
    Some(summary.len() - rest.trim_start_matches(is_js_space).len())
}

/// What `isChildHandoff` asks `isAgentPrompt` about: the summary's subject (after its lead-in) of an open handoff;
/// none for a handoff that is not open or whose summary has no lead-in, which is never a child's.
pub fn handoff_subject<'a>(state: &str, summary: &'a str) -> Option<&'a str> {
    if state != "open" {
        return None;
    }
    handoff_lead(summary).map(|lead| &summary[lead..])
}

/// A handoff a child session left: its summary's subject is an agent-written prompt. `subject_is_agent` is
/// `isAgentPrompt(subject)` for the `handoff_subject` (false when there is none).
pub fn is_child_handoff(state: &str, summary: &str, subject_is_agent: bool) -> bool {
    handoff_subject(state, summary).is_some() && subject_is_agent
}

/// `title.split(/\s+/).filter(Boolean).join(" ").toLowerCase()`.
pub fn title_key(title: &str) -> String {
    title
        .split(is_js_space)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// `sessions/<id>.md` → the session id (`path.slice(9).replace(/\.md$/, "")`).
pub fn session_id_of(path: &str) -> String {
    let mut units = 0;
    let mut rest = String::new();
    for (at, c) in path.char_indices() {
        if units >= SESSION_PREFIX.len() {
            rest.push_str(&path[at..]);
            break;
        }
        units += c.len_utf16();
        if units > SESSION_PREFIX.len() {
            // The cut fell inside a pair: JavaScript kept its low half, which a Rust string cannot hold.
            rest.push('\u{fffd}');
            rest.push_str(&path[at + c.len_utf8()..]);
            break;
        }
    }
    match rest.strip_suffix(".md") {
        Some(id) => id.to_owned(),
        None => rest,
    }
}

/// A `Map<string, string>` of old observation title → new title, in insertion order: `set` of a key that is there
/// replaces its value and keeps its place.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Renames {
    entries: Vec<(String, String)>,
}

impl Renames {
    pub fn new() -> Renames {
        Renames::default()
    }

    pub fn set(&mut self, old: &str, new: &str) {
        match self.entries.iter_mut().find(|(key, _)| key == old) {
            Some(entry) => entry.1 = new.to_owned(),
            None => self.entries.push((old.to_owned(), new.to_owned())),
        }
    }

    pub fn get(&self, old: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(key, _)| key == old)
            .map(|(_, new)| new.as_str())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The new title of a line that shows an old one, cut at the end the way the page cuts a long title.
pub fn renamed<'a>(text: &str, renames: &'a Renames) -> Option<&'a str> {
    if let Some(exact) = renames.get(text).filter(|exact| !exact.is_empty()) {
        return Some(exact);
    }
    let cut = text.strip_suffix('…').filter(|cut| !cut.is_empty())?;
    let mut matches = renames
        .entries
        .iter()
        .filter(|(old, _)| old.starts_with(cut));
    let first = matches.next()?;
    matches.next().is_none().then_some(first.1.as_str())
}

/// `/^(\d+\. )(.*)$/`: `.` stops at a line terminator, and `$` is the end of the text.
fn prompt_item(line: &str) -> Option<(&str, &str)> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || !line[digits..].starts_with(". ") {
        return None;
    }
    let (head, rest) = line.split_at(digits + 2);
    (!rest.contains(['\r', '\u{2028}', '\u{2029}'])).then_some((head, rest))
}

/// ``/^(- `user-prompt` @ \S+ — )(.*)$/``.
fn raw_prompt_item(line: &str) -> Option<(&str, &str)> {
    let after = line.strip_prefix("- `user-prompt` @ ")?;
    let token = after.find(is_js_space).unwrap_or(after.len());
    if token == 0 || !after[token..].starts_with(" — ") {
        return None;
    }
    let split = line.len() - after.len() + token + " — ".len();
    let (head, rest) = line.split_at(split);
    (!rest.contains(['\r', '\u{2028}', '\u{2029}'])).then_some((head, rest))
}

/// The page's markdown with `from` replaced by `to` where the page printed it: the leading `# heading`, and the prompt
/// lists (`## Prompts`, the `user-prompt` lines of `## Raw observations`) for every prompt whose title changed.
pub fn retitle_markdown(markdown: &str, from: &str, to: &str, renames: &Renames) -> String {
    let mut lines: Vec<String> = markdown.split('\n').map(str::to_owned).collect();
    let mut section = String::new();
    let mut headed = false;
    for line in &mut lines {
        if let Some(title) = line.strip_prefix("## ") {
            section = js_trim(title).to_owned();
            continue;
        }
        if !headed && !js_trim(line).is_empty() {
            headed = true;
            if line.strip_prefix("# ") == Some(from) {
                *line = format!("# {to}");
            }
            continue;
        }
        let item = match section.as_str() {
            "Prompts" => prompt_item(line),
            "Raw observations" => raw_prompt_item(line),
            _ => None,
        };
        if let Some((head, rest)) = item
            && let Some(next) = renamed(rest, renames).filter(|next| !next.is_empty())
        {
            *line = format!("{head}{next}");
        }
    }
    lines.join("\n")
}

/// One page the repair rewrote (a dry run: would rewrite).
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RetitleItem {
    pub workspace: String,
    pub project: String,
    pub path: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetitleReport {
    pub dry_run: bool,
    pub projects: usize,
    pub session_pages: usize,
    /// Session pages whose title names no task.
    pub junk: usize,
    /// Pages rewritten (dry run: that would be).
    pub retitled: Vec<RetitleItem>,
    /// A junk page whose session has no usable prompt: left as it is.
    pub unresolved: Vec<String>,
    /// Pages another writer changed between planning and writing: left for the next run.
    pub changed: Vec<String>,
    /// Open handoffs in all, and those a child session left (discarded; dry run: that would be).
    pub open_handoffs: usize,
    pub child_handoffs: usize,
    pub failed: Vec<String>,
}

/// What the session's prompts are called now, by the title the page used to carry for each.
struct SessionTitles {
    /// The first prompt that has a task to name: the page's new title.
    first: Option<String>,
    /// Old observation title → new title, for the lines of the page that list the prompts.
    renames: Renames,
}

async fn session_titles(
    store: &Store,
    facts: &Facts,
    project: &ProjectRef,
    session_id: &str,
) -> Result<SessionTitles, Fault> {
    let kinds: Vec<String> = PROMPTS_ONLY.iter().map(|kind| (*kind).to_owned()).collect();
    let mut titles = SessionTitles {
        first: None,
        renames: Renames::new(),
    };
    let mut offset: u64 = 0;
    for _ in 0..MAX_OBSERVATION_PAGES {
        let page = store
            .observations(project, session_id, offset, &kinds)
            .await?;
        if !page.observations.is_empty() {
            let items: Vec<PromptItem> = page
                .observations
                .iter()
                .map(|observation| PromptItem {
                    text: observation.body.clone(),
                    session_name: None,
                })
                .collect();
            let said = facts.prompts(&items).await?;
            for (observation, fact) in page.observations.iter().zip(said) {
                let Some(title) = fact.title.filter(|title| !title.is_empty()) else {
                    continue;
                };
                if titles.first.is_none() {
                    titles.first = Some(title.clone());
                }
                if !observation.title.is_empty() && observation.title != title {
                    titles.renames.set(&observation.title, &title);
                }
            }
        }
        let length = page.observations.len();
        offset += length as u64;
        let total = page.total.as_f64().unwrap_or(0.0);
        if length == 0 || offset as f64 >= total {
            break;
        }
    }
    Ok(titles)
}

/// What one junk page came to.
enum Outcome {
    Unresolved,
    Changed,
    Retitled(RetitleItem),
}

async fn retitle_page(
    store: &Store,
    facts: &Facts,
    project: &ProjectRef,
    path: &str,
    taken: &mut HashSet<String>,
    dry_run: bool,
) -> Result<Outcome, Fault> {
    let session_id = session_id_of(path);
    let titles = session_titles(store, facts, project, &session_id).await?;
    let Some(first) = titles.first else {
        return Ok(Outcome::Unresolved);
    };
    // Two sessions of one task title alike: the later ones carry their short id, as the server's own rule does.
    let to = if taken.contains(&title_key(&first)) {
        format!("{first} (session {})", utf16_prefix(&session_id, 8))
    } else {
        first
    };
    taken.insert(title_key(&to));
    let at = PageAt {
        project: project.clone(),
        path: path.to_owned(),
    };
    let page = store.page(&at).await?;
    if !dry_run {
        let input = SessionPageInput {
            session_id,
            body: retitle_markdown(&page.markdown, &page.title, &to, &titles.renames),
            expected_page_id: page.id.clone(),
            tier: Some(page.tier.clone().unwrap_or_else(|| "episodic".to_owned())),
            r#abstract: page.summary.clone().filter(|summary| !summary.is_empty()),
        };
        if let Err(fault) = store.write_session_page(&at, &input).await {
            // A SessionEnd rewrote the page since it was read: its own title stands until the next run.
            if !fault.message.to_ascii_lowercase().contains("precondition") {
                return Err(fault);
            }
            return Ok(Outcome::Changed);
        }
    }
    Ok(Outcome::Retitled(RetitleItem {
        workspace: project.workspace.clone(),
        project: project.project.clone(),
        path: path.to_owned(),
        from: page.title.clone(),
        to,
    }))
}

async fn retitle_project(
    store: &Store,
    facts: &Facts,
    order: &NameOrder,
    project: &ProjectRef,
    dry_run: bool,
    report: &mut RetitleReport,
) -> Result<(), Fault> {
    let pages = store.pages(project).await?;
    let mut sessions: Vec<usize> = (0..pages.len())
        .filter(|at| pages[*at].path.starts_with(SESSION_PREFIX))
        .collect();
    sessions.sort_by(|a, b| order.compare(&pages[*a].path, &pages[*b].path));
    report.session_pages += sessions.len();
    // One batch asks `isJunkTitle` of every title of the project.
    let junk: Vec<bool> = if pages.is_empty() {
        Vec::new()
    } else {
        let items: Vec<PromptItem> = pages
            .iter()
            .map(|page: &PageRef| PromptItem {
                text: page.title.clone(),
                session_name: None,
            })
            .collect();
        facts
            .prompts(&items)
            .await?
            .into_iter()
            .map(|fact| fact.junk)
            .collect()
    };
    let mut taken: HashSet<String> = (0..pages.len())
        .filter(|at| !junk[*at])
        .map(|at| title_key(&pages[at].title))
        .collect();
    for at in sessions.into_iter().filter(|at| junk[*at]) {
        let path = &pages[at].path;
        report.junk += 1;
        match retitle_page(store, facts, project, path, &mut taken, dry_run).await {
            Ok(Outcome::Unresolved) => report.unresolved.push(path.clone()),
            Ok(Outcome::Changed) => report.changed.push(path.clone()),
            Ok(Outcome::Retitled(item)) => report.retitled.push(item),
            Err(fault) => report.failed.push(format!("{path}: {}", fault.message)),
        }
    }
    let handoffs = store.handoffs(Some(project)).await?;
    let open: Vec<_> = handoffs
        .iter()
        .filter(|handoff| handoff.state == "open")
        .collect();
    report.open_handoffs += open.len();
    let subjects: Vec<(usize, &str)> = open
        .iter()
        .enumerate()
        .filter_map(|(at, handoff)| {
            handoff_subject(&handoff.state, &handoff.summary).map(|subject| (at, subject))
        })
        .collect();
    let agent: Vec<bool> = if subjects.is_empty() {
        Vec::new()
    } else {
        let items: Vec<PromptItem> = subjects
            .iter()
            .map(|(_, subject)| PromptItem {
                text: (*subject).to_owned(),
                session_name: None,
            })
            .collect();
        facts
            .prompts(&items)
            .await?
            .into_iter()
            .map(|fact| fact.agent)
            .collect()
    };
    for ((at, _), _) in subjects.iter().zip(agent).filter(|(_, agent)| *agent) {
        let handoff = open[*at];
        report.child_handoffs += 1;
        if dry_run {
            continue;
        }
        if let Err(fault) = store.cancel_handoff(project, &handoff.id).await {
            report
                .failed
                .push(format!("handoff {}: {}", handoff.id, fault.message));
        }
    }
    Ok(())
}

/// Retitle the junk session pages of every project and discard the child handoffs still open. `locale` is the one
/// main's `localeCompare` resolves (`Intl.Collator().resolvedOptions().locale`): it orders the session pages.
pub async fn retitle_session_pages(
    store: &Store,
    facts: &Facts,
    locale: &str,
    dry_run: bool,
) -> Result<RetitleReport, Fault> {
    let order = NameOrder::text(locale);
    let mut report = RetitleReport {
        dry_run,
        ..RetitleReport::default()
    };
    for project in store.projects().await? {
        report.projects += 1;
        let at = ProjectRef {
            workspace: project.workspace.clone(),
            project: project.project.clone(),
        };
        if let Err(fault) = retitle_project(store, facts, &order, &at, dry_run, &mut report).await {
            report.failed.push(format!(
                "{}/{}: {}",
                project.workspace, project.project, fault.message
            ));
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const WRAPPED_TITLE: &str = "<ompdesk-agent-message from=\"병렬 세션 자동 정리\">";

    fn table() -> Value {
        serde_json::from_str(&crate::json::whole_surrogates(include_str!(
            "retitle-captured.json"
        )))
        .expect("the captured table is JSON")
    }

    fn text(value: &Value) -> &str {
        value.as_str().expect("a string")
    }

    fn renames_of(pairs: &Value) -> Renames {
        let mut renames = Renames::new();
        for pair in pairs.as_array().unwrap() {
            renames.set(text(&pair[0]), text(&pair[1]));
        }
        renames
    }

    /// `isAgentPrompt` of a handoff subject, as the vitest cases need it (the stock worker answers it in production).
    fn agent(subject: &str) -> bool {
        subject.starts_with("<ompdesk-agent-message")
            || subject.starts_with("Complete assignment thoroughly:")
    }

    fn is_child(summary: &str, state: &str) -> bool {
        is_child_handoff(
            state,
            summary,
            handoff_subject(state, summary).is_some_and(agent),
        )
    }

    #[test]
    fn child_handoff_reads_the_summarys_subject_only_for_an_open_handoff() {
        assert!(is_child(
            &format!("Started: {WRAPPED_TITLE}\nTitle: x"),
            "open"
        ));
        assert!(is_child(
            "Session focused on: Complete assignment thoroughly:\n\nTitle: x",
            "open"
        ));
        assert!(!is_child("Session focused on: 고쳐줘", "open"));
        assert!(!is_child("no lead-in", "open"));
        assert!(!is_child(&format!("Started: {WRAPPED_TITLE}"), "expired"));
    }

    #[test]
    fn retitle_markdown_only_rewrites_where_the_page_prints_a_title() {
        let page = [
            format!("# {WRAPPED_TITLE}"),
            String::new(),
            "## Prompts".to_owned(),
            String::new(),
            format!("1. {WRAPPED_TITLE}"),
            String::new(),
            "## Notes".to_owned(),
            String::new(),
            format!("1. {WRAPPED_TITLE}"),
            format!("mentions {WRAPPED_TITLE} in prose"),
            String::new(),
        ]
        .join("\n");
        let mut renames = Renames::new();
        renames.set(WRAPPED_TITLE, "새 제목");
        let out = retitle_markdown(&page, WRAPPED_TITLE, "새 제목", &renames);
        assert_eq!(
            out.split('\n').collect::<Vec<_>>(),
            [
                "# 새 제목",
                "",
                "## Prompts",
                "",
                "1. 새 제목",
                "",
                "## Notes",
                "",
                &format!("1. {WRAPPED_TITLE}"),
                &format!("mentions {WRAPPED_TITLE} in prose"),
                "",
            ]
        );
    }

    #[test]
    fn retitle_markdown_matches_a_prompt_title_the_page_cut_with_an_ellipsis_when_only_one_can_be_meant()
     {
        let long = format!("{}긴 제목", "가".repeat(30));
        let cut: String = long.chars().take(20).collect();
        let mut renames = Renames::new();
        renames.set(&long, "짧은");
        let out = retitle_markdown(
            &format!("# x\n\n## Prompts\n\n1. {cut}…\n"),
            "x",
            "y",
            &renames,
        );
        assert!(out.contains("1. 짧은"));
    }

    #[test]
    fn session_ids_and_title_keys_read_as_the_typescript_read_them() {
        assert_eq!(session_id_of("sessions/abc.md"), "abc");
        assert_eq!(title_key("  Hello   World  "), "hello world");
    }

    #[test]
    fn every_captured_handoff_is_what_the_typescript_judged() {
        let table = table();
        for row in table["handoffs"].as_array().unwrap() {
            let (summary, state) = (text(&row["summary"]), text(&row["state"]));
            assert_eq!(
                handoff_subject(state, summary),
                row["subject"].as_str(),
                "{row}"
            );
            let got = is_child_handoff(state, summary, row["agent"].as_bool().unwrap());
            assert_eq!(got, row["child"].as_bool().unwrap(), "{row}");
        }
    }

    #[test]
    fn every_captured_key_and_id_is_what_the_typescript_made() {
        let table = table();
        for row in table["titleKeys"].as_array().unwrap() {
            assert_eq!(title_key(text(&row["title"])), text(&row["key"]), "{row}");
        }
        for row in table["sessionIds"].as_array().unwrap() {
            assert_eq!(session_id_of(text(&row["path"])), text(&row["id"]), "{row}");
        }
    }

    #[test]
    fn every_captured_page_is_rewritten_as_the_typescript_rewrote_it() {
        let table = table();
        for row in table["retitles"].as_array().unwrap() {
            let out = retitle_markdown(
                text(&row["markdown"]),
                text(&row["from"]),
                text(&row["to"]),
                &renames_of(&row["renames"]),
            );
            assert_eq!(out, text(&row["out"]), "{row}");
        }
    }

    #[test]
    fn every_captured_line_is_renamed_as_the_typescript_renamed_it() {
        let table = table();
        for row in table["renamed"].as_array().unwrap() {
            let renames = renames_of(&row["renames"]);
            let got = renamed(text(&row["text"]), &renames);
            // retitleMarkdown leaves a line alone for an empty answer, as it does for none.
            assert_eq!(
                got.filter(|next| !next.is_empty()),
                row["expected"].as_str(),
                "{row}"
            );
        }
    }
}
