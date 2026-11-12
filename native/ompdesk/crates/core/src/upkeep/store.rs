//! The ai-memory operations the upkeep and the care use, in process (`Http`: the `aimemory` operations over the
//! server main named) or asked of main (`Main`: the TypeScript client object a test handed in, called as the
//! TypeScript called it).
//!
//! `Main` asks `client` `{op, args}`: `op` is the `AiMemoryClient` method's own name and `args` its arguments, in
//! order, in the TypeScript shapes (camelCase members; `retirePage`'s `at` an ISO string main turns back into a
//! `Date`). A trailing argument the caller left out is left out of `args`, so a fake's default parameter applies as
//! it did. What main answers is what the method resolved to, read as the shape the TypeScript client answers.
//! A failure is a `Fault` with the message the TypeScript caller read from `error.message`.

use std::sync::Arc;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Number, Value, json};

use super::asks::Asker;
use crate::aimemory::client::{Client, Server};
use crate::aimemory::ops::{
    ConclusionInput, Conclusions, CreateInput, Handoff, Observations, Page, PageAt, PageRef,
    Project, ProjectRef, RetireInput, Session, SessionPageInput,
};
use crate::server::Fault;

/// What `retire_page` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Retired {
    Retired,
    Pinned,
    Changed,
}

pub enum Store {
    Http(Arc<Client>),
    Main(Asker),
}

/// The members of a `ProjectRef & {path}` as the TypeScript client takes them.
fn at_args(at: &PageAt) -> Value {
    json!({ "workspace": at.project.workspace, "project": at.project.project, "path": at.path })
}

/// `input` (an input shape of `aimemory::ops`) as the TypeScript client takes it: its members beside the page's
/// `workspace`, `project` and `path`.
fn with_at<T: serde::Serialize>(at: &PageAt, input: &T) -> Value {
    let mut members = match serde_json::to_value(input) {
        Ok(Value::Object(members)) => members,
        _ => serde_json::Map::new(),
    };
    let Value::Object(page) = at_args(at) else {
        return Value::Null;
    };
    for (name, value) in page {
        members.insert(name, value);
    }
    Value::Object(members)
}

impl Store {
    /// The store over the server main named (`url`, `dataDir`), for a request that asks no `client`.
    pub fn http(server: Server) -> Store {
        Store::Http(Client::new(server))
    }

    /// `Main` when `asks` lists `client` (main answers a test's fake), else `Http` over `server`.
    pub fn choose(asker: &Asker, asks: &[String], server: Server) -> Store {
        if asks.iter().any(|kind| kind == "client") {
            Store::Main(asker.clone())
        } else {
            Store::http(server)
        }
    }

    /// Asks main to call `op(...args)` and reads its answer as `T`.
    async fn main<T: DeserializeOwned>(
        asker: &Asker,
        op: &str,
        args: Vec<Value>,
    ) -> Result<T, Fault> {
        let value = asker
            .ask("client", json!({ "op": op, "args": args }))
            .await?;
        serde_json::from_value(value).map_err(|error| {
            Fault::new(
                "memory_main",
                format!("{op} answered another shape than the client's: {error}"),
            )
        })
    }

    pub async fn projects(&self) -> Result<Vec<Project>, Fault> {
        match self {
            Store::Http(client) => client.projects().await,
            Store::Main(asker) => Store::main(asker, "projects", vec![]).await,
        }
    }

    pub async fn sessions(
        &self,
        project: &ProjectRef,
        limit: Option<u64>,
        offset: Option<u64>,
    ) -> Result<Vec<Session>, Fault> {
        match self {
            Store::Http(client) => {
                let (limit, offset) = (limit.map(Number::from), offset.map(Number::from));
                client
                    .sessions(project, limit.as_ref(), offset.as_ref())
                    .await
            }
            Store::Main(asker) => {
                let mut args = vec![json!(project)];
                // A middle argument left out is `undefined` in the TypeScript call: only a trailing one is dropped.
                if limit.is_some() || offset.is_some() {
                    args.push(json!(limit));
                }
                if offset.is_some() {
                    args.push(json!(offset));
                }
                Store::main(asker, "sessions", args).await
            }
        }
    }

    pub async fn observations(
        &self,
        project: &ProjectRef,
        session_id: &str,
        offset: u64,
        kinds: &[String],
    ) -> Result<Observations, Fault> {
        match self {
            Store::Http(client) => {
                client
                    .observations(project, session_id, offset as f64, kinds)
                    .await
            }
            Store::Main(asker) => {
                let mut args = vec![json!(project), json!(session_id), json!(offset)];
                if !kinds.is_empty() {
                    args.push(json!(kinds));
                }
                Store::main(asker, "observations", args).await
            }
        }
    }

    pub async fn pages(&self, project: &ProjectRef) -> Result<Vec<PageRef>, Fault> {
        match self {
            Store::Http(client) => client.pages(project).await,
            Store::Main(asker) => Store::main(asker, "pages", vec![json!(project)]).await,
        }
    }

    pub async fn page(&self, at: &PageAt) -> Result<Page, Fault> {
        match self {
            Store::Http(client) => client.page(at).await,
            Store::Main(asker) => Store::main(asker, "page", vec![at_args(at)]).await,
        }
    }

    pub async fn write_session_page(
        &self,
        at: &PageAt,
        input: &SessionPageInput,
    ) -> Result<(), Fault> {
        match self {
            Store::Http(client) => client.write_session_page(at, input).await,
            Store::Main(asker) => {
                Store::main::<Value>(asker, "writeSessionPage", vec![with_at(at, input)])
                    .await
                    .map(drop)
            }
        }
    }

    /// The handoffs of one project, or of the newest projects merged.
    pub async fn handoffs(&self, project: Option<&ProjectRef>) -> Result<Vec<Handoff>, Fault> {
        match self {
            Store::Http(client) => client.handoffs(project.cloned()).await,
            Store::Main(asker) => {
                let args = project.map(|project| json!(project)).into_iter().collect();
                Store::main(asker, "handoffs", args).await
            }
        }
    }

    pub async fn cancel_handoff(&self, project: &ProjectRef, id: &str) -> Result<(), Fault> {
        match self {
            Store::Http(client) => client.cancel_handoff(project, id).await,
            Store::Main(asker) => {
                Store::main::<Value>(asker, "cancelHandoff", vec![json!(project), json!(id)])
                    .await
                    .map(drop)
            }
        }
    }

    pub async fn name_status(&self, project: &ProjectRef) -> Result<String, Fault> {
        match self {
            Store::Http(client) => client.name_status(project).await,
            Store::Main(asker) => Store::main(asker, "nameStatus", vec![json!(project)]).await,
        }
    }

    pub async fn rename_unclaimed_project(
        &self,
        workspace: &str,
        project_id: &str,
        to: &str,
    ) -> Result<(), Fault> {
        match self {
            Store::Http(client) => {
                client
                    .rename_unclaimed_project(workspace, project_id, to)
                    .await
            }
            Store::Main(asker) => Store::main::<Value>(
                asker,
                "renameUnclaimedProject",
                vec![json!(workspace), json!(project_id), json!(to)],
            )
            .await
            .map(drop),
        }
    }

    /// False when something already lives at the path.
    pub async fn create_page(&self, at: &PageAt, input: &CreateInput) -> Result<bool, Fault> {
        match self {
            Store::Http(client) => client.create_page(at, input).await,
            Store::Main(asker) => Store::main(asker, "createPage", vec![with_at(at, input)]).await,
        }
    }

    pub async fn retire_page(&self, at: &PageAt, input: &RetireInput) -> Result<Retired, Fault> {
        match self {
            Store::Http(client) => Ok(match client.retire_page(at, input).await? {
                "retired" => Retired::Retired,
                "pinned" => Retired::Pinned,
                _ => Retired::Changed,
            }),
            Store::Main(asker) => Store::main(asker, "retirePage", vec![with_at(at, input)]).await,
        }
    }

    pub async fn conclusions(
        &self,
        source: &str,
        after: u64,
        limit: u64,
    ) -> Result<Conclusions, Fault> {
        match self {
            Store::Http(client) => {
                client
                    .conclusions(source, &Number::from(after), &Number::from(limit))
                    .await
            }
            Store::Main(asker) => {
                Store::main(
                    asker,
                    "conclusions",
                    vec![json!(source), json!(after), json!(limit)],
                )
                .await
            }
        }
    }

    /// `written`, `same` or `skipped` for each item, in the items' order.
    pub async fn write_conclusions(
        &self,
        project: &ProjectRef,
        origin: &str,
        items: &[ConclusionInput],
    ) -> Result<Vec<String>, Fault> {
        match self {
            Store::Http(client) => client.write_conclusions(project, origin, items, None).await,
            Store::Main(asker) => {
                Store::main(
                    asker,
                    "writeConclusions",
                    vec![json!(project), json!(origin), json!(items)],
                )
                .await
            }
        }
    }

    /// The newest wiki checkpoint (empty before the first one).
    pub async fn head_checkpoint(&self) -> Result<String, Fault> {
        match self {
            Store::Http(client) => client.head_checkpoint().await,
            Store::Main(asker) => Store::main(asker, "headCheckpoint", vec![]).await,
        }
    }

    pub async fn restore_page(&self, at: &PageAt, rev: &str) -> Result<(), Fault> {
        match self {
            Store::Http(client) => client.restore_page(at, rev).await,
            Store::Main(asker) => {
                Store::main::<Value>(asker, "restorePage", vec![at_args(at), json!(rev)])
                    .await
                    .map(drop)
            }
        }
    }

    pub async fn feedback(&self, at: &PageAt, signal: &str) -> Result<(), Fault> {
        match self {
            Store::Http(client) => client.feedback(at, signal).await,
            Store::Main(asker) => {
                Store::main::<Value>(asker, "feedback", vec![at_args(at), json!(signal)])
                    .await
                    .map(drop)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::asks::rig::{Rig, Said};
    use super::*;
    use crate::aimemory::tests::{data_dir, fake};
    use crate::server::{Call, Reply};

    fn project() -> Value {
        json!({ "workspace": "w", "project": "p" })
    }

    fn at(path: &str) -> Value {
        json!({ "workspace": "w", "project": "p", "path": path })
    }

    fn session() -> Value {
        json!({
            "id": "s1", "cwd": "/c", "agent": "omp", "startedAt": "2026-01-01T00:00:00Z", "endedAt": null,
            "observations": 6, "consolidation": null,
        })
    }

    /// A test method that calls `params.op` of a `Store::Main`, its arguments in the shapes of this module's types.
    async fn driving(call: Call) -> Result<Reply, Fault> {
        #[derive(Deserialize)]
        struct Params {
            op: String,
            #[serde(default)]
            args: Vec<Value>,
        }
        let Params { op, args } = call.params()?;
        let store = Store::Main(Asker::new("store-1", call.events.clone()));
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        let project = |index: usize| serde_json::from_value::<ProjectRef>(arg(index)).unwrap();
        let page = |index: usize| serde_json::from_value::<PageAt>(arg(index)).unwrap();
        let text = |index: usize| arg(index).as_str().unwrap_or_default().to_owned();
        let value = match op.as_str() {
            "projects" => json!(store.projects().await?),
            "sessions" => json!(
                store
                    .sessions(&project(0), arg(1).as_u64(), arg(2).as_u64())
                    .await?
            ),
            "observations" => {
                let kinds: Vec<String> = serde_json::from_value(arg(3)).unwrap_or_default();
                json!(
                    store
                        .observations(&project(0), &text(1), arg(2).as_u64().unwrap(), &kinds)
                        .await?
                )
            }
            "pages" => json!(store.pages(&project(0)).await?),
            "page" => json!(store.page(&page(0)).await?),
            "write_session_page" => {
                let input = serde_json::from_value(arg(1)).unwrap();
                json!(store.write_session_page(&page(0), &input).await?)
            }
            "handoffs" => {
                let project = arg(0).is_object().then(|| project(0));
                json!(store.handoffs(project.as_ref()).await?)
            }
            "cancel_handoff" => json!(store.cancel_handoff(&project(0), &text(1)).await?),
            "name_status" => json!(store.name_status(&project(0)).await?),
            "rename_unclaimed_project" => json!(
                store
                    .rename_unclaimed_project(&text(0), &text(1), &text(2))
                    .await?
            ),
            "create_page" => {
                let input = serde_json::from_value(arg(1)).unwrap();
                json!(store.create_page(&page(0), &input).await?)
            }
            "retire_page" => {
                let input = serde_json::from_value(arg(1)).unwrap();
                json!(store.retire_page(&page(0), &input).await?)
            }
            "conclusions" => json!(
                store
                    .conclusions(&text(0), arg(1).as_u64().unwrap(), arg(2).as_u64().unwrap())
                    .await?
            ),
            "write_conclusions" => {
                let items: Vec<_> = serde_json::from_value(arg(2)).unwrap();
                json!(
                    store
                        .write_conclusions(&project(0), &text(1), &items)
                        .await?
                )
            }
            "head_checkpoint" => json!(store.head_checkpoint().await?),
            "restore_page" => json!(store.restore_page(&page(0), &text(1)).await?),
            "feedback" => json!(store.feedback(&page(0), &text(1)).await?),
            // Which store a request's `asks` choose.
            "is_main" => {
                let asks: Vec<String> = serde_json::from_value(arg(0)).unwrap();
                let asker = Asker::new("store-1", call.events.clone());
                json!(matches!(
                    Store::choose(&asker, &asks, Server::default()),
                    Store::Main(_)
                ))
            }
            other => panic!("{other}"),
        };
        Reply::json(&value)
    }

    async fn rig() -> Rig {
        Rig::start(|registry| registry.add("test.store", |call| Box::pin(driving(call)))).await
    }

    /// One op through `Main`: the core asks `client` `{op: method, args: asked}`, main answers `answer`, the call
    /// gives `expected` (the answer read as a Rust shape and written again).
    async fn through_main(
        rig: &mut Rig,
        op: &str,
        args: Value,
        method: &str,
        asked: Value,
        answer: Value,
        expected: Value,
    ) {
        let run = rig
            .run("test.store", json!({ "op": op, "args": args }), |ask| {
                assert_eq!(ask["kind"], "client", "{op}");
                assert_eq!(
                    ask["params"],
                    json!({ "op": method, "args": asked }),
                    "{op}"
                );
                Said::Value(answer.clone())
            })
            .await;
        assert_eq!(run.response["ok"], true, "{op}: {}", run.response);
        assert_eq!(run.response["result"], expected, "{op}");
    }

    #[tokio::test]
    async fn every_op_asks_the_clients_method_with_its_arguments_and_reads_its_shape() {
        let mut rig = rig().await;
        let rig = &mut rig;
        let projects = json!([
            { "workspace": "w", "project": "p", "pages": 3, "lastUpdated": "2026-01-01T00:00:00Z", "id": "i-1" },
            { "workspace": "w", "project": "q", "pages": 0, "lastUpdated": null, "identity": "github.com/a/b", "identitySource": "origin" },
        ]);
        through_main(
            rig,
            "projects",
            json!([]),
            "projects",
            json!([]),
            projects.clone(),
            projects,
        )
        .await;
        // `limit` and `offset` are positional; one left out at the end is left out of the call (a fake's default
        // applies), one in the middle is `null`.
        let sessions = json!([session()]);
        through_main(
            rig,
            "sessions",
            json!([project()]),
            "sessions",
            json!([project()]),
            sessions.clone(),
            sessions.clone(),
        )
        .await;
        through_main(
            rig,
            "sessions",
            json!([project(), 100]),
            "sessions",
            json!([project(), 100]),
            sessions.clone(),
            sessions.clone(),
        )
        .await;
        through_main(
            rig,
            "sessions",
            json!([project(), 100, 200]),
            "sessions",
            json!([project(), 100, 200]),
            sessions.clone(),
            sessions.clone(),
        )
        .await;
        through_main(
            rig,
            "sessions",
            json!([project(), null, 5]),
            "sessions",
            json!([project(), null, 5]),
            sessions.clone(),
            sessions.clone(),
        )
        .await;
        let observations = json!({
            "session": session(),
            "observations": [{ "id": "o1", "kind": "user-prompt", "title": "t", "body": "b", "createdAt": null }],
            "total": 1, "offset": 0,
        });
        through_main(
            rig,
            "observations",
            json!([project(), "s1", 0, ["user-prompt"]]),
            "observations",
            json!([project(), "s1", 0, ["user-prompt"]]),
            observations.clone(),
            observations.clone(),
        )
        .await;
        through_main(
            rig,
            "observations",
            json!([project(), "s1", 50]),
            "observations",
            json!([project(), "s1", 50]),
            observations.clone(),
            observations,
        )
        .await;
        let refs = json!([
            { "workspace": "w", "project": "p", "path": "decisions/a.md", "title": "A", "kind": "decision", "tier": "semantic", "updatedAt": "2026-01-02T00:00:00Z" },
            { "workspace": "w", "project": "p", "path": "x.md", "title": "X", "tier": null, "updatedAt": null },
        ]);
        through_main(
            rig,
            "pages",
            json!([project()]),
            "pages",
            json!([project()]),
            refs.clone(),
            refs,
        )
        .await;
        let page = json!({
            "workspace": "w", "project": "p", "path": "sessions/a.md", "title": "T", "updatedAt": null, "kind": "session",
            "tier": "episodic", "markdown": "# T\n", "id": "page-1", "pinned": false, "createdAt": "2026-01-01T00:00:00Z",
            "tags": ["a"], "summary": "6 observations",
        });
        through_main(
            rig,
            "page",
            json!([at("sessions/a.md")]),
            "page",
            json!([at("sessions/a.md")]),
            page.clone(),
            page,
        )
        .await;
        let session_page = json!({ "path": "sessions/a.md", "sessionId": "s1", "body": "b", "expectedPageId": "page-1", "tier": "episodic", "abstract": "t" });
        let asked = json!([{
            "workspace": "w", "project": "p", "path": "sessions/a.md", "sessionId": "s1", "body": "b",
            "expectedPageId": "page-1", "tier": "episodic", "abstract": "t",
        }]);
        through_main(
            rig,
            "write_session_page",
            json!([at("sessions/a.md"), session_page]),
            "writeSessionPage",
            asked.clone(),
            Value::Null,
            Value::Null,
        )
        .await;
        // An optional member left out is left out, not null.
        let bare = json!({ "path": "sessions/a.md", "sessionId": "s1", "body": "b", "expectedPageId": "page-1" });
        let asked = json!([{
            "workspace": "w", "project": "p", "path": "sessions/a.md", "sessionId": "s1", "body": "b", "expectedPageId": "page-1",
        }]);
        through_main(
            rig,
            "write_session_page",
            json!([at("sessions/a.md"), bare]),
            "writeSessionPage",
            asked,
            Value::Null,
            Value::Null,
        )
        .await;
        let handoffs = json!([{
            "workspace": "w", "project": "p", "id": "h1", "agent": "omp", "createdAt": null, "summary": "s",
            "openQuestions": [], "nextSteps": ["n"], "state": "open",
        }]);
        through_main(
            rig,
            "handoffs",
            json!([]),
            "handoffs",
            json!([]),
            handoffs.clone(),
            handoffs.clone(),
        )
        .await;
        through_main(
            rig,
            "handoffs",
            json!([project()]),
            "handoffs",
            json!([project()]),
            handoffs.clone(),
            handoffs,
        )
        .await;
        through_main(
            rig,
            "cancel_handoff",
            json!([project(), "h1"]),
            "cancelHandoff",
            json!([project(), "h1"]),
            Value::Null,
            Value::Null,
        )
        .await;
        through_main(
            rig,
            "name_status",
            json!([project()]),
            "nameStatus",
            json!([project()]),
            json!("ambiguous"),
            json!("ambiguous"),
        )
        .await;
        through_main(
            rig,
            "rename_unclaimed_project",
            json!(["w", "id-1", "p-unclaimed"]),
            "renameUnclaimedProject",
            json!(["w", "id-1", "p-unclaimed"]),
            Value::Null,
            Value::Null,
        )
        .await;
        let create = json!({ "path": "decisions/a.md", "body": "b", "tier": "semantic", "kind": "decision", "sessionId": "s1" });
        let asked = json!([{ "workspace": "w", "project": "p", "path": "decisions/a.md", "body": "b", "tier": "semantic", "kind": "decision", "sessionId": "s1" }]);
        through_main(
            rig,
            "create_page",
            json!([at("decisions/a.md"), create]),
            "createPage",
            asked.clone(),
            json!(true),
            json!(true),
        )
        .await;
        through_main(
            rig,
            "create_page",
            json!([at("decisions/a.md"), create]),
            "createPage",
            asked,
            json!(false),
            json!(false),
        )
        .await;
        let retire = json!({ "at": "2026-11-12T01:02:03.004Z", "expectedPageId": "page-1", "successor": "decisions/b.md", "reason": "gone" });
        let asked = json!([{
            "workspace": "w", "project": "p", "path": "decisions/a.md", "at": "2026-11-12T01:02:03.004Z",
            "expectedPageId": "page-1", "successor": "decisions/b.md", "reason": "gone",
        }]);
        for word in ["retired", "pinned", "changed"] {
            through_main(
                rig,
                "retire_page",
                json!([at("decisions/a.md"), retire]),
                "retirePage",
                asked.clone(),
                json!(word),
                json!(word),
            )
            .await;
        }
        let only_at = json!([{ "workspace": "w", "project": "p", "path": "decisions/a.md", "at": "2026-11-12T01:02:03.004Z" }]);
        through_main(
            rig,
            "retire_page",
            json!([at("decisions/a.md"), { "at": "2026-11-12T01:02:03.004Z" }]),
            "retirePage",
            only_at,
            json!("retired"),
            json!("retired"),
        )
        .await;
        let conclusions = json!({
            "rows": [{ "seq": 7, "workspace": "w", "project": "p", "id": "c1", "sessionId": "s1", "title": "t", "body": "b", "at": "2026-01-01T00:00:00Z" },
                     { "seq": 8, "workspace": "w", "project": "p", "id": "c2", "sessionId": "s1", "title": "t", "body": "b", "at": "2026-01-01T00:00:01Z", "origin": "dev-2" }],
            "next": 8, "more": false, "store": "db-1", "last": 8,
        });
        through_main(
            rig,
            "conclusions",
            json!(["synced", 6, 100]),
            "conclusions",
            json!(["synced", 6, 100]),
            conclusions.clone(),
            conclusions,
        )
        .await;
        let items = json!([{ "id": "c1", "sessionId": "s1", "title": "t", "body": "b", "at": "2026-01-01T00:00:00Z" }]);
        through_main(
            rig,
            "write_conclusions",
            json!([project(), "dev-1", items]),
            "writeConclusions",
            json!([project(), "dev-1", items]),
            json!(["written", "same", "skipped"]),
            json!(["written", "same", "skipped"]),
        )
        .await;
        through_main(
            rig,
            "head_checkpoint",
            json!([]),
            "headCheckpoint",
            json!([]),
            json!("abc123"),
            json!("abc123"),
        )
        .await;
        through_main(
            rig,
            "restore_page",
            json!([at("a.md"), "abc123"]),
            "restorePage",
            json!([at("a.md"), "abc123"]),
            Value::Null,
            Value::Null,
        )
        .await;
        through_main(
            rig,
            "feedback",
            json!([at("a.md"), "stale"]),
            "feedback",
            json!([at("a.md"), "stale"]),
            Value::Null,
            Value::Null,
        )
        .await;
    }

    #[tokio::test]
    async fn the_client_ask_chooses_main_and_nothing_chooses_the_server() {
        let mut rig = rig().await;
        for (asks, main) in [
            (json!(["client", "facts"]), true),
            (json!(["client"]), true),
            (json!(["facts", "journal", "model"]), false),
            (json!([]), false),
        ] {
            let run = rig
                .run(
                    "test.store",
                    json!({ "op": "is_main", "args": [asks] }),
                    |_| Said::Nothing,
                )
                .await;
            assert_eq!(run.response["result"], main, "{asks}");
        }
    }

    #[tokio::test]
    async fn a_refusal_is_main_s_message_and_another_shape_is_refused_by_name() {
        let mut rig = rig().await;
        let run = rig
            .run("test.store", json!({ "op": "create_page", "args": [at("a.md"), { "body": "b", "tier": "t", "kind": "k" }] }), |_| {
                Said::Error("memory_write_page: precondition_failed")
            })
            .await;
        assert_eq!(run.response["error"]["code"], "memory_main");
        assert_eq!(
            run.response["error"]["message"],
            "memory_write_page: precondition_failed"
        );
        let run = rig
            .run(
                "test.store",
                json!({ "op": "projects", "args": [] }),
                |_| Said::Value(json!({ "no": "list" })),
            )
            .await;
        assert_eq!(run.response["error"]["code"], "memory_main");
        assert!(
            run.response["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("projects answered another shape"),
            "{}",
            run.response
        );
    }

    /// The same calls through `Http`, over a fake of the server (`aimemory`'s test helper): what the TypeScript
    /// caller got from `AiMemoryClient` is what the core's own operations give.
    #[tokio::test]
    async fn the_http_store_calls_the_operations_in_process() {
        let server = fake(json!({
            "GET /api/v1/projects": { "json": [
                { "workspace_name": "w", "project_name": "old", "page_count": 1, "last_updated": "2026-01-01T00:00:00Z" },
                { "workspace_name": "w", "project_name": "new", "page_count": 4, "last_updated": "2026-03-01T00:00:00Z", "project_id": "id-1" },
            ] },
            "GET /api/v1/workspaces/w/projects/p/sessions?limit=30&include_open=true": { "json": { "sessions": [
                { "session_id": "s1", "cwd": "/a/b", "agent_kind": "omp", "started_at": "t0", "ended_at": null, "observation_count": 60 },
            ] } },
            "GET /api/v1/workspaces/w/projects/p/sessions?limit=5&include_open=true&offset=10": { "json": { "sessions": [] } },
            "GET /admin/project-coordinate?workspace=w&project=p": { "json": { "status": "ambiguous" } },
            "GET /admin/checkpoints?limit=1": { "json": [{ "oid": "head1" }] },
        }))
        .await;
        let dir = data_dir(Some("secret-token\n"));
        let store = Store::http(Server {
            url: Some(server.url.clone()),
            data_dir: Some(dir.to_string_lossy().into_owned()),
        });
        let project = ProjectRef {
            workspace: "w".to_owned(),
            project: "p".to_owned(),
        };
        let projects = store.projects().await.unwrap();
        assert_eq!(
            projects
                .iter()
                .map(|project| project.project.as_str())
                .collect::<Vec<_>>(),
            ["new", "old"]
        );
        let sessions = store.sessions(&project, None, None).await.unwrap();
        assert_eq!(
            (sessions[0].id.as_str(), sessions[0].observations.as_u64()),
            ("s1", Some(60))
        );
        assert!(
            store
                .sessions(&project, Some(5), Some(10))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.name_status(&project).await.unwrap(), "ambiguous");
        assert_eq!(store.head_checkpoint().await.unwrap(), "head1");
        {
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 5);
            assert!(
                requests
                    .iter()
                    .all(|request| request["authorization"] == "Bearer secret-token")
            );
        }
        // A refusal in the server's words, as `AiMemoryClient` threw it.
        let down = Store::http(Server::default());
        assert_eq!(
            down.projects().await.unwrap_err().message,
            "Memory is not running"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
