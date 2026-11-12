//! What the app asks the memory server, one function per question, each answering the shape the page and main's
//! upkeep read (`src/shared/ai-memory.ts`). Reads are the `/api/v1` REST routes plus `/admin/*`; writes go through
//! the server's own write path (`/admin/write-page`, `/admin/delete-page`, `/admin/restore-page`, `/admin/lint`,
//! `/admin/forget-sweep`, `/admin/write-conclusions`) or, where REST has no route, an MCP tool.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, json};

use super::client::{Client, precondition, together};
use super::value::{
    encode_path, encode_uri_component, filled, form, get, iso_now, js_length, js_order,
    js_trim_end, number, one_line, rows, text, texts,
};
use crate::fs::order::js_trim;
use crate::json::utf16_prefix;
use crate::server::Fault;

/// How many projects a merged (all projects) list reads, newest first.
const MERGE_PROJECTS: usize = 12;
const LIST_LIMIT: usize = 20;
/// Search shows more than the recent lists do.
const SEARCH_LIMIT: usize = 30;
const SESSION_LIMIT: u64 = 30;
const OBSERVATION_LIMIT: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub struct ProjectRef {
    pub workspace: String,
    pub project: String,
}

impl ProjectRef {
    fn path(&self) -> String {
        format!(
            "/api/v1/workspaces/{}/projects/{}",
            encode_uri_component(&self.workspace),
            encode_uri_component(&self.project)
        )
    }

    fn page_path(&self, page: &str) -> String {
        format!("{}/pages/{}", self.path(), encode_path(page))
    }

    /// `workspace` and `project`, the first members of a write's body.
    fn members(&self) -> Map<String, Value> {
        let mut members = Map::new();
        members.insert("workspace".to_owned(), json!(self.workspace));
        members.insert("project".to_owned(), json!(self.project));
        members
    }
}

/// A page of a project, as a request names it: `{workspace, project, path}`.
#[derive(Debug, Clone, Deserialize)]
#[serde(from = "PageAtWire")]
pub struct PageAt {
    pub project: ProjectRef,
    pub path: String,
}

#[derive(Deserialize)]
struct PageAtWire {
    workspace: String,
    project: String,
    path: String,
}

impl From<PageAtWire> for PageAt {
    fn from(wire: PageAtWire) -> PageAt {
        PageAt {
            project: ProjectRef {
                workspace: wire.workspace,
                project: wire.project,
            },
            path: wire.path,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    version: Option<String>,
    pages: Number,
    sessions: Number,
    observations: Number,
    disk_bytes: Number,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub workspace: String,
    pub project: String,
    pub(crate) pages: Number,
    pub(crate) last_updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) identity_source: Option<String>,
}

impl Project {
    fn at(&self) -> ProjectRef {
        ProjectRef {
            workspace: self.workspace.clone(),
            project: self.project.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRef {
    pub(crate) workspace: String,
    pub(crate) project: String,
    pub path: String,
    pub(crate) title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>,
    pub(crate) tier: Option<String>,
    pub(crate) updated_at: Option<String>,
}

impl PageRef {
    fn of(project: &ProjectRef, row: &Value) -> PageRef {
        PageRef {
            workspace: project.workspace.clone(),
            project: project.project.clone(),
            path: text(get(row, "path")).to_owned(),
            title: text(get(row, "title")).to_owned(),
            kind: filled(get(row, "kind")),
            tier: filled(get(row, "tier")),
            updated_at: filled(get(row, "updated_at")),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    workspace: String,
    project: String,
    path: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    tier: Option<String>,
    updated_at: Option<String>,
    snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pages: Number,
    sessions: Number,
    observations: Number,
    last_capture_at: Option<String>,
    open_handoffs: Number,
    #[serde(rename = "activity7d")]
    activity: Activity,
    health: Health,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    sessions: Number,
    observations: Number,
    pages_updated: Number,
}

#[derive(Debug, Serialize)]
struct Health {
    stale: Number,
    duplicates: Number,
    contradictions: Number,
    orphans: Number,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    id: String,
    cwd: String,
    agent: String,
    started_at: Option<String>,
    ended_at: Option<String>,
    observations: Number,
    consolidation: Option<String>,
}

impl Session {
    fn of(row: &Value) -> Session {
        Session {
            id: text(get(row, "session_id")).to_owned(),
            cwd: text(get(row, "cwd")).to_owned(),
            agent: text(get(row, "agent_kind")).to_owned(),
            started_at: filled(get(row, "started_at")),
            ended_at: filled(get(row, "ended_at")),
            observations: number(get(row, "observation_count")),
            consolidation: filled(get(get(row, "consolidation"), "state")),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Observations {
    session: Session,
    observations: Vec<Observation>,
    total: Number,
    offset: Number,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    id: String,
    kind: String,
    title: String,
    body: String,
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    enabled: bool,
    injected: bool,
    digest_bytes: Number,
    scope: Option<ProjectRef>,
    entries: Vec<ProfileEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileEntry {
    path: String,
    category: String,
    statement: String,
    applies_to: Vec<String>,
    enforced_by: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Finding {
    kind: String,
    severity: String,
    message: String,
    pages: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sweep {
    dry_run: bool,
    evaluated: Number,
    evicted: Number,
    compacted: Number,
    merged: Number,
    expired: Number,
    observations_pruned: Number,
}

/// What Restore needs of a deleted page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    workspace: String,
    project: String,
    path: String,
    title: String,
    rev: String,
    deleted_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    workspace: String,
    project: String,
    id: String,
    agent: String,
    created_at: Option<String>,
    summary: String,
    open_questions: Vec<String>,
    next_steps: Vec<String>,
    state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    workspace: String,
    project: String,
    path: String,
    title: String,
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    tier: Option<String>,
    markdown: String,
    id: String,
    pinned: bool,
    created_at: Option<String>,
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

/// A page whole, as a copy on another of the person's computers needs it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCopy {
    pub(crate) workspace: String,
    pub(crate) project: String,
    pub(crate) path: String,
    pub(crate) title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) kind: Option<String>,
    pub(crate) tier: String,
    pub(crate) body: String,
    pub(crate) tags: Vec<String>,
    pub(crate) pinned: bool,
    /// The write path's own frontmatter fields: `entities`, `abstract`, `relations`, `applies_to`, `enforced_by`.
    pub(crate) metadata: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
    pub(crate) updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Conclusions {
    pub(crate) rows: Vec<Conclusion>,
    pub(crate) next: Number,
    pub(crate) more: bool,
    pub(crate) store: String,
    pub(crate) last: Number,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conclusion {
    pub(crate) seq: Number,
    pub(crate) workspace: String,
    pub(crate) project: String,
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) origin: Option<String>,
}

/// What the Memory page's editor saves.
#[derive(Debug, Deserialize)]
pub struct WriteInput {
    body: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    pinned: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPageInput {
    session_id: String,
    body: String,
    expected_page_id: String,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    r#abstract: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInput {
    body: String,
    tier: String,
    kind: String,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteInput {
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetireInput {
    /// The moment the page expires, as `Date.toISOString()` spells it.
    #[serde(rename = "at")]
    when: String,
    #[serde(default)]
    expected_page_id: Option<String>,
    #[serde(default)]
    successor: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

/// The repository identity a project was claimed by, as the server lists it.
#[derive(Debug, Clone, Deserialize)]
pub struct Repository {
    pub(crate) identity: String,
    pub(crate) source: String,
}

impl Repository {
    fn onto(repository: Option<&Repository>, body: &mut Map<String, Value>) {
        if let Some(repository) = repository {
            body.insert("identity".to_owned(), json!(repository.identity));
            body.insert("identity_source".to_owned(), json!(repository.source));
        }
    }
}

/// A page as `writePageCopy` writes it (what `pageCopy` read, here or on another computer).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyInput {
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    pub(crate) tier: String,
    pub(crate) body: String,
    pub(crate) tags: Vec<String>,
    pub(crate) pinned: bool,
    pub(crate) metadata: Map<String, Value>,
    #[serde(default)]
    pub(crate) expires_at: Option<String>,
    #[serde(default)]
    pub(crate) repository: Option<Repository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionInput {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) at: String,
}

/// JavaScript's truthy string: present and not empty.
fn truthy(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|text| !text.is_empty())
}

/// Newest first by a time spelled as text, rows of one time in the order they came (`byNewest`).
fn newest_first<T>(rows: &mut [T], time: impl Fn(&T) -> &str) {
    rows.sort_by(|left, right| js_order(time(right), time(left)));
}

/// `Array.prototype.sort` as V8 runs it on fewer than 64 elements: the first run found and, when it descends,
/// reversed (`CountAndMakeRun`), then the rest inserted by binary search (`BinaryInsertionSort`). `negative` is
/// whether the comparator answers below zero. Only a comparator that never answers 0 needs this: for any other, a
/// stable sort gives the same order.
fn sort_as_v8<T>(items: &mut [T], negative: impl Fn(&T, &T) -> bool) {
    if items.len() < 2 {
        return;
    }
    let descending = negative(&items[1], &items[0]);
    let mut run = 2;
    while run < items.len() && negative(&items[run], &items[run - 1]) == descending {
        run += 1;
    }
    if descending {
        items[..run].reverse();
    }
    for start in run..items.len() {
        let (mut left, mut right) = (0, start);
        while left < right {
            let middle = left + (right - left) / 2;
            if negative(&items[start], &items[middle]) {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        items[left..=start].rotate_right(1);
    }
}

/// Projects newest first, as `sort((a, b) => ((a.lastUpdated ?? "") < (b.lastUpdated ?? "") ? 1 : -1))` left them:
/// that comparator never answers 0, so where projects share a time (those without pages have none) V8's steps
/// decided their order, and the list keeps it. From 64 projects on V8 merges runs, which is not followed here:
/// projects of one time then stay in the server's order.
fn projects_newest_first<T>(projects: &mut [T], time: impl Fn(&T) -> &str) {
    if projects.len() < 64 {
        sort_as_v8(projects, |left, right| {
            js_order(time(left), time(right)) != std::cmp::Ordering::Less
        });
    } else {
        newest_first(projects, time);
    }
}

/// An array's length, else the number the server wrote.
fn count(value: &Value) -> Number {
    match value.as_array() {
        Some(items) => Number::from(items.len()),
        None => number(value),
    }
}

/// The MCP arguments of a page write: where, then the body.
fn page_write(at: &PageAt, body: &str) -> Map<String, Value> {
    let mut arguments = at.project.members();
    arguments.insert("path".to_owned(), json!(at.path));
    arguments.insert("body".to_owned(), json!(body));
    arguments
}

impl Client {
    /// `/admin/status`; none when the server is down, answers an error or answers `null`.
    pub async fn status(&self) -> Option<Status> {
        let body = self.get("/admin/status").await.ok()?;
        if body.is_null() {
            return None;
        }
        let counts = get(&body, "counts");
        Some(Status {
            version: filled(get(&body, "version")),
            pages: number(get(counts, "pages_latest")),
            sessions: number(get(counts, "sessions")),
            observations: number(get(counts, "observations")),
            disk_bytes: number(get(get(&body, "storage"), "database_bytes")),
        })
    }

    /// Every project, newest first.
    pub async fn projects(&self) -> Result<Vec<Project>, Fault> {
        let body = self.get("/api/v1/projects").await?;
        let mut projects: Vec<Project> = rows(&body)
            .map(|row| {
                let identity = filled(get(row, "identity"));
                Project {
                    workspace: text(get(row, "workspace_name")).to_owned(),
                    project: text(get(row, "project_name")).to_owned(),
                    pages: number(get(row, "page_count")),
                    last_updated: filled(get(row, "last_updated")),
                    id: filled(get(row, "project_id")),
                    identity_source: identity
                        .as_ref()
                        .and_then(|_| filled(get(row, "identity_source"))),
                    identity,
                }
            })
            .collect();
        projects_newest_first(&mut projects, |project| {
            project.last_updated.as_deref().unwrap_or_default()
        });
        Ok(projects)
    }

    /// How the server resolves a project name (`/admin/project-coordinate`): `ambiguous` when the name is one
    /// project's name and another's canonical or legacy key, so every name read of it is refused.
    pub async fn name_status(&self, project: &ProjectRef) -> Result<String, Fault> {
        let path = format!(
            "/admin/project-coordinate?workspace={}&project={}",
            form(&project.workspace),
            form(&project.project)
        );
        Ok(text(get(&self.get(&path).await?, "status")).to_owned())
    }

    /// Renames by id a project no checkout ever captured into (`/admin/rename-unclaimed-project`: no repository
    /// identity, no repo path, no session, checked in the rename; else 409). The name only, no file moves;
    /// reversible. A server without the route answers 404, never an unguarded rename.
    pub async fn rename_unclaimed_project(
        &self,
        workspace: &str,
        project_id: &str,
        to: &str,
    ) -> Result<(), Fault> {
        let body = json!({ "workspace": workspace, "project_id": project_id, "to": to });
        self.post("/admin/rename-unclaimed-project", &body).await?;
        Ok(())
    }

    /// Full-text hits, in one project or all. A hit carries no tier and no time: they come from the page lists of
    /// the projects the hits sit in.
    pub async fn search(
        self: &Arc<Self>,
        query: &str,
        project: Option<&ProjectRef>,
    ) -> Result<Vec<Hit>, Fault> {
        let query = js_trim(query);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut path = format!("/api/v1/search?q={}&limit={SEARCH_LIMIT}", form(query));
        if let Some(project) = project {
            path.push_str(&format!(
                "&workspace={}&project={}",
                form(&project.workspace),
                form(&project.project)
            ));
        }
        let body = self.get(&path).await?;
        let mut hits: Vec<Hit> = rows(&body)
            .map(|row| Hit {
                workspace: text(get(row, "workspace")).to_owned(),
                project: text(get(row, "project")).to_owned(),
                path: text(get(row, "path")).to_owned(),
                title: text(get(row, "title")).to_owned(),
                kind: filled(get(row, "kind")),
                tier: None,
                updated_at: filled(get(row, "updated_at")),
                snippet: plain_snippet(text(get(row, "snippet"))),
            })
            .collect();
        let mut places: Vec<ProjectRef> = Vec::new();
        for hit in &hits {
            let place = ProjectRef {
                workspace: hit.workspace.clone(),
                project: hit.project.clone(),
            };
            if !places.contains(&place) {
                places.push(place);
            }
        }
        let lists = together(
            places
                .iter()
                .map(|place| {
                    let (client, place) = (Arc::clone(self), place.clone());
                    async move { client.pages(&place).await.unwrap_or_default() }
                })
                .collect(),
        )
        .await?;
        let mut known: HashMap<(&ProjectRef, &str), &PageRef> = HashMap::new();
        for (place, list) in places.iter().zip(&lists) {
            for page in list {
                known.insert((place, page.path.as_str()), page);
            }
        }
        for hit in &mut hits {
            let place = ProjectRef {
                workspace: hit.workspace.clone(),
                project: hit.project.clone(),
            };
            if let Some(page) = known.get(&(&place, hit.path.as_str())) {
                hit.kind = hit.kind.take().or_else(|| page.kind.clone());
                hit.tier = page.tier.clone();
                hit.updated_at = hit.updated_at.take().or_else(|| page.updated_at.clone());
            }
        }
        Ok(hits)
    }

    /// Every page of a project, newest first, with kind and tier.
    pub async fn pages(&self, project: &ProjectRef) -> Result<Vec<PageRef>, Fault> {
        let body = self.get(&format!("{}/pages", project.path())).await?;
        let mut pages: Vec<PageRef> = rows(&body).map(|row| PageRef::of(project, row)).collect();
        newest_first(&mut pages, |page| {
            page.updated_at.as_deref().unwrap_or_default()
        });
        Ok(pages)
    }

    /// Every latest page of a project, expired (retired) ones too, which the page list hides: for the sync.
    pub async fn all_pages(&self, project: &ProjectRef) -> Result<Vec<PageRef>, Fault> {
        let path = format!("{}/pages?include_expired=true", project.path());
        let body = self.get(&path).await?;
        Ok(rows(&body).map(|row| PageRef::of(project, row)).collect())
    }

    /// Counts, last capture, activity and health of one project.
    pub async fn overview(&self, project: &ProjectRef) -> Result<Overview, Fault> {
        let path = format!("{}/overview?limit=1", project.path());
        let body = self.get(&path).await?;
        let briefing = get(&body, "briefing");
        let counts = get(briefing, "counts");
        let activity = get(briefing, "activity_7d");
        let health = get(&body, "health");
        Ok(Overview {
            pages: number(get(counts, "pages_latest")),
            sessions: number(get(counts, "sessions")),
            observations: number(get(counts, "observations")),
            last_capture_at: filled(get(briefing, "last_observation_at")),
            open_handoffs: number(get(briefing, "pending_handoff_count")),
            activity: Activity {
                sessions: number(get(activity, "sessions")),
                observations: number(get(activity, "observations")),
                pages_updated: number(get(activity, "pages_updated")),
            },
            health: Health {
                stale: number(get(health, "stale")),
                duplicates: number(get(health, "duplicates")),
                contradictions: number(get(health, "contradictions")),
                orphans: number(get(health, "orphans")),
            },
        })
    }

    /// The project's sessions, newest first. The server answers at most 100 a call (api.rs
    /// `SESSION_LIST_MAX_LIMIT`), so a job that walks them all pages with `offset`.
    pub async fn sessions(
        &self,
        project: &ProjectRef,
        limit: Option<&Number>,
        offset: Option<&Number>,
    ) -> Result<Vec<Session>, Fault> {
        let limit = limit
            .cloned()
            .unwrap_or_else(|| Number::from(SESSION_LIMIT));
        let mut path = format!(
            "{}/sessions?limit={limit}&include_open=true",
            project.path()
        );
        if let Some(offset) = offset.filter(|offset| offset.as_f64() != Some(0.0)) {
            path.push_str(&format!("&offset={offset}"));
        }
        let body = self.get(&path).await?;
        Ok(rows(get(&body, "sessions")).map(Session::of).collect())
    }

    /// One session's raw observations, in capture order, read-only; `kinds` keeps only those kinds.
    pub async fn observations(
        &self,
        project: &ProjectRef,
        session_id: &str,
        offset: f64,
        kinds: &[String],
    ) -> Result<Observations, Fault> {
        let only = if kinds.is_empty() {
            String::new()
        } else {
            format!("&kinds={}", encode_uri_component(&kinds.join(",")))
        };
        // `Math.max(0, Math.floor(offset))`; the cast keeps whole numbers and holds at the type's ends.
        let offset = offset.floor().max(0.0) as u64;
        let path = format!(
            "{}/sessions/{}/observations?limit={OBSERVATION_LIMIT}&offset={offset}&body_max_chars=2000{only}",
            project.path(),
            encode_uri_component(session_id)
        );
        let body = self.get(&path).await?;
        Ok(Observations {
            session: Session::of(get(&body, "session")),
            observations: rows(get(&body, "observations"))
                .map(|row| Observation {
                    id: text(get(row, "id")).to_owned(),
                    kind: text(get(row, "kind")).to_owned(),
                    title: text(get(row, "title")).to_owned(),
                    body: text(get(row, "body")).to_owned(),
                    created_at: filled(get(row, "created_at")),
                })
                .collect(),
            total: number(get(&body, "total")),
            offset: number(get(&body, "offset")),
        })
    }

    /// The cross-project profile: whether it is injected and its entries.
    pub async fn profile(&self) -> Result<Profile, Fault> {
        let (status, list) = tokio::join!(
            self.get("/admin/profile/status"),
            self.get("/admin/profile/list")
        );
        let (status, list) = (status?, list?);
        let scope = get(&list, "scope");
        let off = &Value::String("off".to_owned());
        Ok(Profile {
            enabled: get(&status, "effective_share") != off
                && get(&status, "enabled") != off
                && get(&status, "enabled") != &Value::Bool(false),
            injected: get(&status, "inject_on_session_start") == &Value::Bool(true),
            digest_bytes: number(get(&status, "digest_bytes")),
            scope: match (
                filled(get(scope, "workspace")),
                filled(get(scope, "project")),
            ) {
                (Some(workspace), Some(project)) => Some(ProjectRef { workspace, project }),
                _ => None,
            },
            entries: rows(get(&list, "entries"))
                .map(|row| ProfileEntry {
                    path: text(get(row, "path")).to_owned(),
                    category: text(get(row, "category")).to_owned(),
                    statement: text(get(row, "statement")).to_owned(),
                    applies_to: texts(get(row, "applies_to")),
                    enforced_by: filled(get(row, "enforced_by")),
                })
                .collect(),
        })
    }

    /// The rule-based audit (no report page is written, no LLM pass).
    pub async fn lint(&self, project: &ProjectRef) -> Result<Vec<Finding>, Fault> {
        let mut body = project.members();
        body.insert("dry_run".to_owned(), json!(true));
        body.insert("no_llm".to_owned(), json!(true));
        let answer = self.post("/admin/lint", &Value::Object(body)).await?;
        Ok(rows(get(&answer, "findings"))
            .map(|row| Finding {
                kind: text(get(row, "kind")).to_owned(),
                severity: text(get(row, "severity")).to_owned(),
                message: text(get(row, "message")).to_owned(),
                pages: texts(get(row, "pages")),
            })
            .collect())
    }

    /// The retention sweep; `dry_run` reports what it would evict and changes nothing.
    pub async fn sweep(&self, project: &ProjectRef, dry_run: bool) -> Result<Sweep, Fault> {
        let mut body = project.members();
        body.insert("dry_run".to_owned(), json!(dry_run));
        let answer = self
            .post("/admin/forget-sweep", &Value::Object(body))
            .await?;
        let pruned = if dry_run {
            "observations_prunable"
        } else {
            "observations_pruned"
        };
        Ok(Sweep {
            dry_run: get(&answer, "dry_run") == &Value::Bool(true),
            evaluated: number(get(&answer, "candidates_evaluated")),
            evicted: count(get(&answer, "evicted")),
            compacted: count(get(&answer, "compacted")),
            merged: count(get(&answer, "merged")),
            expired: count(get(&answer, "expired")),
            observations_pruned: number(get(&answer, pruned)),
        })
    }

    /// Saves a page through ai-memory's write path (a new version; the old one stays in history).
    pub async fn write_page(&self, at: &PageAt, input: &WriteInput) -> Result<(), Fault> {
        let mut body = page_write(at, &input.body);
        for (name, value) in [
            ("title", &input.title),
            ("kind", &input.kind),
            ("tier", &input.tier),
        ] {
            if let Some(value) = truthy(value) {
                body.insert(name.to_owned(), json!(value));
            }
        }
        if let Some(tags) = &input.tags {
            body.insert("tags".to_owned(), json!(tags));
        }
        if let Some(pinned) = input.pinned {
            body.insert("pinned".to_owned(), json!(pinned));
        }
        self.post("/admin/write-page", &Value::Object(body)).await?;
        Ok(())
    }

    /// Rewrites a session page through `memory_write_page` with its session, the path the server offers for
    /// exactly this: it keeps the page's link to the session (`session_id`, `agent`), tells a title another page
    /// holds apart, and refuses (`precondition_failed`) when the page is no longer the version named.
    pub async fn write_session_page(
        &self,
        at: &PageAt,
        input: &SessionPageInput,
    ) -> Result<(), Fault> {
        let mut arguments = page_write(at, &input.body);
        let tier = input.tier.as_deref().unwrap_or("episodic");
        arguments.insert("tier".to_owned(), json!(tier));
        arguments.insert("session_id".to_owned(), json!(input.session_id));
        arguments.insert("expected_page_id".to_owned(), json!(input.expected_page_id));
        if let Some(summary) = truthy(&input.r#abstract) {
            arguments.insert("abstract".to_owned(), json!(summary));
        }
        self.tool("memory_write_page", arguments).await?;
        Ok(())
    }

    /// Writes a page that does not exist yet (`create_only`), recording the session it was learned in as evidence
    /// when one is given. False when something already lives at the path: the page is never overwritten.
    pub async fn create_page(&self, at: &PageAt, input: &CreateInput) -> Result<bool, Fault> {
        let mut arguments = page_write(at, &input.body);
        arguments.insert("tier".to_owned(), json!(input.tier));
        arguments.insert("kind".to_owned(), json!(input.kind));
        if let Some(session) = truthy(&input.session_id) {
            arguments.insert("session_id".to_owned(), json!(session));
        }
        arguments.insert("create_only".to_owned(), json!(true));
        match self.tool("memory_write_page", arguments).await {
            Ok(_) => Ok(true),
            Err(fault) if precondition(&fault) => Ok(false),
            Err(fault) => Err(fault),
        }
    }

    /// Deletes a page and answers what Restore needs: the checkpoint that still holds it (the one the server saved
    /// just before the delete when the tree had unsaved changes, else the newest one, read before the call).
    pub async fn delete_page(&self, at: &PageAt, input: &DeleteInput) -> Result<Deleted, Fault> {
        let head = self.head_checkpoint().await?;
        let mut body = at.project.members();
        body.insert("path".to_owned(), json!(at.path));
        let answer = self
            .post("/admin/delete-page", &Value::Object(body))
            .await?;
        let rev = filled(get(&answer, "pre_checkpoint")).unwrap_or(head);
        if rev.is_empty() {
            return Err(Fault::new(
                "memory_no_checkpoint",
                "Memory kept no checkpoint of this page",
            ));
        }
        Ok(Deleted {
            workspace: at.project.workspace.clone(),
            project: at.project.project.clone(),
            path: at.path.clone(),
            title: input.title.clone().unwrap_or_else(|| at.path.clone()),
            rev,
            deleted_at: iso_now(),
        })
    }

    /// The newest wiki checkpoint (empty before the first one): `restore_page` brings a page back as it stood there.
    pub async fn head_checkpoint(&self) -> Result<String, Fault> {
        let body = self.get("/admin/checkpoints?limit=1").await?;
        let head = rows(&body).next();
        Ok(head.map_or(String::new(), |row| text(get(row, "oid")).to_owned()))
    }

    pub async fn restore_page(&self, at: &PageAt, rev: &str) -> Result<(), Fault> {
        let mut body = at.project.members();
        body.insert("path".to_owned(), json!(at.path));
        body.insert("rev".to_owned(), json!(rev));
        self.post("/admin/restore-page", &Value::Object(body))
            .await?;
        Ok(())
    }

    /// `stale` and `wrong` also floor the page's salience and list it in the next lint (memory upkeep's flag).
    pub async fn feedback(&self, at: &PageAt, signal: &str) -> Result<(), Fault> {
        let mut arguments = at.project.members();
        arguments.insert("path".to_owned(), json!(at.path));
        arguments.insert("signal".to_owned(), json!(signal));
        self.tool("memory_feedback", arguments).await?;
        Ok(())
    }

    /// Discards an open handoff (the next session in that folder no longer starts with it).
    pub async fn cancel_handoff(&self, project: &ProjectRef, id: &str) -> Result<(), Fault> {
        let mut arguments = project.members();
        arguments.insert("handoff_id".to_owned(), json!(id));
        let result = self.tool("memory_handoff_cancel", arguments).await?;
        if get(&result, "cancelled") == &Value::Bool(false)
            && text(get(&result, "state")) != "expired"
        {
            return Err(Fault::new(
                "memory_handoff_closed",
                "The handoff is no longer open",
            ));
        }
        Ok(())
    }

    /// A project's recently changed pages, as the server orders them.
    pub async fn recent(&self, project: &ProjectRef) -> Result<Vec<PageRef>, Fault> {
        let body = self.get(&format!("{}/recent", project.path())).await?;
        Ok(rows(&body)
            .take(LIST_LIMIT)
            .map(|row| PageRef::of(project, row))
            .collect())
    }

    /// The newest projects a merged list reads.
    async fn merged_projects(&self) -> Result<Vec<ProjectRef>, Fault> {
        let projects = self.projects().await?;
        Ok(projects
            .iter()
            .take(MERGE_PROJECTS)
            .map(Project::at)
            .collect())
    }

    /// Recent pages of the most recently updated projects, merged newest first. A project that cannot be read adds
    /// nothing.
    pub async fn recent_everywhere(self: &Arc<Self>) -> Result<Vec<PageRef>, Fault> {
        let lists = together(
            self.merged_projects()
                .await?
                .into_iter()
                .map(|project| {
                    let client = Arc::clone(self);
                    async move { client.recent(&project).await.unwrap_or_default() }
                })
                .collect(),
        )
        .await?;
        let mut pages: Vec<PageRef> = lists.into_iter().flatten().collect();
        newest_first(&mut pages, |page| {
            page.updated_at.as_deref().unwrap_or_default()
        });
        pages.truncate(LIST_LIMIT);
        Ok(pages)
    }

    /// The handoffs of one project, or of the newest projects merged, newest first. A project that cannot be read
    /// adds nothing.
    pub async fn handoffs(
        self: &Arc<Self>,
        project: Option<ProjectRef>,
    ) -> Result<Vec<Handoff>, Fault> {
        let targets = match project {
            Some(project) => vec![project],
            None => self.merged_projects().await?,
        };
        let lists = together(
            targets
                .into_iter()
                .map(|target| {
                    let client = Arc::clone(self);
                    async move {
                        let path = format!("{}/handoffs", target.path());
                        let body = client.get(&path).await.unwrap_or_default();
                        rows(get(&body, "handoffs"))
                            .map(|row| Handoff {
                                workspace: target.workspace.clone(),
                                project: target.project.clone(),
                                id: text(get(row, "id")).to_owned(),
                                agent: text(get(row, "agent")).to_owned(),
                                created_at: filled(get(row, "at")),
                                summary: text(get(row, "summary")).to_owned(),
                                open_questions: texts(get(row, "open_questions")),
                                next_steps: texts(get(row, "next_steps")),
                                state: text(get(row, "state")).to_owned(),
                            })
                            .collect::<Vec<_>>()
                    }
                })
                .collect(),
        )
        .await?;
        let mut handoffs: Vec<Handoff> = lists.into_iter().flatten().collect();
        newest_first(&mut handoffs, |handoff| {
            handoff.created_at.as_deref().unwrap_or_default()
        });
        handoffs.truncate(LIST_LIMIT * 2);
        Ok(handoffs)
    }

    pub async fn page(&self, at: &PageAt) -> Result<Page, Fault> {
        let row = self.get(&at.project.page_path(&at.path)).await?;
        let frontmatter = get(&row, "frontmatter");
        Ok(Page {
            workspace: at.project.workspace.clone(),
            project: at.project.project.clone(),
            path: at.path.clone(),
            title: filled(get(&row, "title")).unwrap_or_else(|| at.path.clone()),
            updated_at: filled(get(&row, "updated_at")),
            kind: filled(get(&row, "kind")),
            tier: filled(get(&row, "tier")),
            markdown: text(get(&row, "body_markdown")).to_owned(),
            id: text(get(&row, "id")).to_owned(),
            pinned: get(&row, "pinned") == &Value::Bool(true),
            created_at: filled(get(&row, "created_at")),
            tags: texts(get(frontmatter, "tags")),
            summary: filled(get(frontmatter, "summary")),
        })
    }

    /// Takes a page out of default recall, because a newer page replaces it or it went stale: the same page again
    /// through `memory_write_page` with `expires_at` now. The server keeps that frontmatter key as the page's TTL
    /// (wiki.rs `parse_expires_at`) and hides an expired page from `memory_query`, search, recent and the page list
    /// by default, while an exact read still answers. The write replaces all metadata, so what the write path takes
    /// of the page's own goes back (title, kind, abstract, entities, relations, tags; not `summary` or profile
    /// keys), plus the tag `superseded` and a closing line naming the successor, or, when no page replaces it, the
    /// tag `retired` and the reason (the write path takes no free frontmatter key, so no `superseded_by:`).
    /// ai-memory's daily forget sweep later hard-deletes an expired page; only the wiki's git checkpoints keep it
    /// then. A pinned page is the owner's and is never retired. `changed` when the page is no longer the version
    /// `expected_page_id` names (the one the caller judged), or moved on during the write.
    pub async fn retire_page(
        &self,
        at: &PageAt,
        input: &RetireInput,
    ) -> Result<&'static str, Fault> {
        let row = self.get(&at.project.page_path(&at.path)).await?;
        let frontmatter = get(&row, "frontmatter");
        let pinned = &Value::Bool(true);
        if get(&row, "pinned") == pinned || get(frontmatter, "pinned") == pinned {
            return Ok("pinned");
        }
        let id = text(get(&row, "id"));
        if id.is_empty() || truthy(&input.expected_page_id).is_some_and(|expected| expected != id) {
            return Ok("changed");
        }
        let successor = truthy(&input.successor);
        let day = utf16_prefix(&input.when, 10);
        let note = match successor {
            Some(successor) => {
                format!("_Superseded by [[{successor}]] on {day} (memory upkeep)._")
            }
            None => format!(
                "_Retired on {day} (memory upkeep): {}._",
                one_line(input.reason.as_deref().unwrap_or("out of date"))
            ),
        };
        let body = format!(
            "{}\n\n{note}\n",
            js_trim_end(text(get(&row, "body_markdown")))
        );
        let mut arguments = page_write(at, &body);
        for (name, value) in [
            ("tier", get(&row, "tier")),
            ("title", get(frontmatter, "title")),
            ("kind", get(frontmatter, "kind")),
        ] {
            if let Some(value) = filled(value) {
                arguments.insert(name.to_owned(), json!(value));
            }
        }
        // The server refuses the whole write over metadata outside its bounds
        // (`PageWriteMetadata::into_frontmatter`): three relation kinds, 10 entities, a 1024-character abstract.
        // Anything else stays behind with the old version.
        let summary = text(get(frontmatter, "abstract"));
        if !summary.is_empty() && js_length(summary) <= 1024 {
            arguments.insert("abstract".to_owned(), json!(summary));
        }
        let mut entities = texts(get(frontmatter, "entities"));
        if !entities.is_empty() {
            entities.truncate(10);
            arguments.insert("entities".to_owned(), json!(entities));
        }
        let mut relations = Map::new();
        for kind in ["causes", "fixes", "contradicts"] {
            let targets = texts(get(get(frontmatter, "relations"), kind));
            if !targets.is_empty() {
                relations.insert(kind.to_owned(), json!(targets));
            }
        }
        if !relations.is_empty() {
            arguments.insert("relations".to_owned(), Value::Object(relations));
        }
        let mut tags: Vec<String> = Vec::new();
        let marker = if successor.is_some() {
            "superseded"
        } else {
            "retired"
        };
        for tag in texts(get(frontmatter, "tags"))
            .into_iter()
            .chain([marker.to_owned()])
        {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        arguments.insert("tags".to_owned(), json!(tags));
        arguments.insert("expires_at".to_owned(), json!(input.when));
        arguments.insert("expected_page_id".to_owned(), json!(id));
        match self.tool("memory_write_page", arguments).await {
            Ok(_) => Ok("retired"),
            Err(fault) if precondition(&fault) => Ok("changed"),
            Err(fault) => Err(fault),
        }
    }

    /// One page whole, as a copy on another of the person's computers needs it.
    pub async fn page_copy(&self, at: &PageAt) -> Result<PageCopy, Fault> {
        let row = self.get(&at.project.page_path(&at.path)).await?;
        let frontmatter = get(&row, "frontmatter");
        let mut metadata = Map::new();
        let entities = texts(get(frontmatter, "entities"));
        if !entities.is_empty() {
            metadata.insert("entities".to_owned(), json!(entities));
        }
        if let Some(summary) = filled(get(frontmatter, "abstract")) {
            metadata.insert("abstract".to_owned(), json!(summary));
        }
        let mut relations = Map::new();
        if let Some(listed) = get(frontmatter, "relations").as_object() {
            for (relation, targets) in listed {
                let targets = texts(targets);
                if !targets.is_empty() {
                    relations.insert(relation.clone(), json!(targets));
                }
            }
        }
        if !relations.is_empty() {
            metadata.insert("relations".to_owned(), Value::Object(relations));
        }
        let applies_to = texts(get(frontmatter, "applies_to"));
        if !applies_to.is_empty() {
            metadata.insert("applies_to".to_owned(), json!(applies_to));
        }
        if let Some(enforced_by) = filled(get(frontmatter, "enforced_by")) {
            metadata.insert("enforced_by".to_owned(), json!(enforced_by));
        }
        let trimmed =
            |value: &Value| Some(js_trim(text(value)).to_owned()).filter(|text| !text.is_empty());
        Ok(PageCopy {
            workspace: at.project.workspace.clone(),
            project: at.project.project.clone(),
            path: at.path.clone(),
            title: filled(get(&row, "title")).unwrap_or_else(|| at.path.clone()),
            kind: filled(get(&row, "kind")).or_else(|| filled(get(frontmatter, "kind"))),
            tier: filled(get(&row, "tier")).unwrap_or_else(|| "semantic".to_owned()),
            body: text(get(&row, "body_markdown")).to_owned(),
            tags: texts(get(frontmatter, "tags")),
            pinned: get(&row, "pinned") == &Value::Bool(true),
            metadata,
            origin: trimmed(get(frontmatter, "origin_device")),
            expires_at: trimmed(get(frontmatter, "expires_at")),
            id: filled(get(&row, "id")),
            updated_at: filled(get(&row, "updated_at")),
        })
    }

    /// Writes a copy of a page another computer holds, through the server's write path: a new version here with
    /// the same title, kind, tier, tags, pin and metadata, marked `origin_device` with the computer it came from
    /// (none: the page is this computer's own). Only over the version `expected` names (the id `page_copy` read),
    /// or, with none, only where nothing is yet; false when the page moved on meanwhile and nothing was written.
    pub async fn write_page_copy(
        &self,
        at: &PageAt,
        copy: &CopyInput,
        origin: Option<&str>,
        expected: Option<&str>,
    ) -> Result<bool, Fault> {
        let mut body = page_write(at, &copy.body);
        body.insert("title".to_owned(), json!(copy.title));
        if let Some(kind) = truthy(&copy.kind) {
            body.insert("kind".to_owned(), json!(kind));
        }
        body.insert("tier".to_owned(), json!(copy.tier));
        body.insert("tags".to_owned(), json!(copy.tags));
        body.insert("pinned".to_owned(), json!(copy.pinned));
        // As `...copy.metadata` did: a member named like one above replaces it.
        for (name, value) in &copy.metadata {
            body.insert(name.clone(), value.clone());
        }
        if let Some(origin) = origin.filter(|origin| !origin.is_empty()) {
            body.insert("origin_device".to_owned(), json!(origin));
        }
        if let Some(expires_at) = truthy(&copy.expires_at) {
            body.insert("expires_at".to_owned(), json!(expires_at));
        }
        Repository::onto(copy.repository.as_ref(), &mut body);
        match expected {
            Some(expected) => body.insert("expected_page_id".to_owned(), json!(expected)),
            None => body.insert("create_only".to_owned(), json!(true)),
        };
        match self.post("/admin/write-page", &Value::Object(body)).await {
            Ok(_) => Ok(true),
            Err(fault) if precondition(&fault) => Ok(false),
            Err(fault) => Err(fault),
        }
    }

    /// One stream of session conclusions (Stop observations with a body) in `seq` order, for the sync: `native` is
    /// what this server captured, `synced` what it holds from the person's other computers (each row names its
    /// origin). `next` is the seq of the last row returned (`after` when none); `more`: rows are left after it.
    /// `store` names the database the seqs belong to (empty from a server that does not say) and `last` is the
    /// highest seq in this stream now: a cursor is good only for the same `store` and while it is not past `last`.
    pub async fn conclusions(
        &self,
        source: &str,
        after: &Number,
        limit: &Number,
    ) -> Result<Conclusions, Fault> {
        let path = format!("/admin/conclusions?source={source}&after={after}&limit={limit}");
        let body = self.get(&path).await?;
        let stated = |name: &str| match get(&body, name) {
            Value::Number(number) => Some(number.clone()),
            _ => None,
        };
        let next = stated("next").unwrap_or_else(|| after.clone());
        Ok(Conclusions {
            rows: rows(get(&body, "conclusions"))
                .map(|row| Conclusion {
                    seq: number(get(row, "seq")),
                    workspace: text(get(row, "workspace")).to_owned(),
                    project: text(get(row, "project")).to_owned(),
                    id: text(get(row, "id")).to_owned(),
                    session_id: text(get(row, "session_id")).to_owned(),
                    title: text(get(row, "title")).to_owned(),
                    body: text(get(row, "body")).to_owned(),
                    at: text(get(row, "created_at")).to_owned(),
                    origin: filled(get(row, "origin_device")),
                })
                .collect(),
            more: get(&body, "more") == &Value::Bool(true),
            store: text(get(&body, "store")).to_owned(),
            last: stated("last").unwrap_or_else(|| next.clone()),
            next,
        })
    }

    /// Inserts conclusions captured on the computer `origin`, each only where this server holds none with that id
    /// (never overwritten): `written`, `same` (held already) or `skipped` (nothing left of it after the server's
    /// own scrubbing). Results are in the order of `items`.
    pub async fn write_conclusions(
        &self,
        project: &ProjectRef,
        origin: &str,
        items: &[ConclusionInput],
        repository: Option<&Repository>,
    ) -> Result<Vec<String>, Fault> {
        let mut body = project.members();
        Repository::onto(repository, &mut body);
        body.insert("origin_device".to_owned(), json!(origin));
        let conclusions: Vec<Value> = items
            .iter()
            .map(|item| {
                json!({
                    "id": item.id,
                    "session_id": item.session_id,
                    "title": item.title,
                    "body": item.body,
                    "created_at": item.at,
                })
            })
            .collect();
        body.insert("conclusions".to_owned(), json!(conclusions));
        let reply = self
            .post("/admin/write-conclusions", &Value::Object(body))
            .await?;
        let results: Vec<&Value> = rows(get(&reply, "results")).collect();
        (0..items.len())
            .map(|index| {
                let status = results
                    .get(index)
                    .map_or("", |row| text(get(row, "status")));
                if matches!(status, "written" | "same" | "skipped") {
                    Ok(status.to_owned())
                } else {
                    Err(Fault::new(
                        "memory_unknown_status",
                        "Memory answered an unknown conclusion status",
                    ))
                }
            })
            .collect()
    }
}

/// ai-memory marks search hits with `<mark>`; the page shows plain text.
pub fn plain_snippet(snippet: &str) -> String {
    snippet.replace("<mark>", "").replace("</mark>", "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_projects_of_one_time_as_v8_left_them() {
        let tables: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        let lists = tables["projectOrder"].as_array().unwrap();
        assert!(lists.len() >= 80);
        for list in lists {
            let mut projects: Vec<(String, &str)> = list["times"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(at, time)| (format!("p{at}"), time.as_str().unwrap_or_default()))
                .collect();
            projects_newest_first(&mut projects, |project| project.1);
            let order: Vec<Value> = projects
                .into_iter()
                .map(|project| json!(project.0))
                .collect();
            assert_eq!(Value::Array(order), list["order"], "{}", list["times"]);
        }
    }

    #[test]
    fn many_projects_are_newest_first_with_ties_in_the_server_s_order() {
        let mut projects: Vec<(usize, &str)> =
            (0..70).map(|at| (at, ["b", "a", ""][at % 3])).collect();
        projects_newest_first(&mut projects, |project| project.1);
        let expected: Vec<usize> = (0..70)
            .step_by(3)
            .chain((1..70).step_by(3))
            .chain((2..70).step_by(3))
            .collect();
        assert_eq!(
            projects
                .into_iter()
                .map(|project| project.0)
                .collect::<Vec<_>>(),
            expected
        );
    }
}
