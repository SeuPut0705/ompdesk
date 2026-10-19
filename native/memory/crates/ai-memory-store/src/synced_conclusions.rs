//! Session conclusions copied between a person's computers (V84).
//!
//! A conclusion is a `Stop` observation with a body: the last assistant answer
//! of a turn. The computer that captured it offers it to its paired computers,
//! which store a copy in `synced_conclusions` so `memory_query
//! {conclusions:true}` there answers it too. Raw observations never cross, so
//! the copies live apart from `observations` and feed nothing but that search.
//!
//! Three things happen here: a batch is validated and scrubbed before anything
//! is written ([`SyncedConclusionBatch::prepare`]), written insert-if-absent
//! ([`write_synced_conclusions`]), and listed for the next computer to pull
//! ([`list_conclusions`]), the local `Stop`s and the synced copies as two
//! streams so a copy is never offered back to the computer it came from.

use std::str::FromStr;

use ai_memory_core::{
    ObservationId, ObservationKind, ProjectId, Sanitizer, SessionId, WorkspaceId,
    truncate_utf8_bytes,
};
use jiff::Timestamp;
use rusqlite::{Connection, OptionalExtension, Statement, params, params_from_iter, types::Value};
use serde::Serialize;

use crate::error::{StoreError, StoreResult};
use crate::reader::{CONCLUSION_SNIPPET_TOKENS, ConclusionHit};

/// Longest conclusion body a copy keeps, in UTF-8 bytes. The capture side cuts
/// the excerpt to the same size.
pub const SYNCED_CONCLUSION_BODY_MAX_BYTES: usize = 2000;
/// Longest title a copy keeps, in characters.
pub const SYNCED_CONCLUSION_TITLE_MAX_CHARS: usize = 500;
/// Most conclusions one write accepts.
pub const SYNCED_CONCLUSION_BATCH_MAX: usize = 500;
/// Longest origin device name or origin id, in characters.
pub const SYNCED_CONCLUSION_ORIGIN_MAX_CHARS: usize = 128;
/// Most rows one listing page returns.
pub const CONCLUSION_PAGE_MAX: usize = 500;

/// One conclusion as the caller sent it, not yet checked.
#[derive(Debug, Clone)]
pub struct IncomingConclusion {
    /// The id the conclusion has on the computer it came from.
    pub id: String,
    /// Session of that computer, as a UUID.
    pub session_id: String,
    /// Title shown with the hit.
    pub title: String,
    /// The conclusion text.
    pub body: String,
    /// When the conclusion was captured, RFC 3339.
    pub created_at: String,
}

/// Why a batch was refused. Nothing was written.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ConclusionBatchError(String);

#[derive(Debug, Clone)]
struct PreparedConclusion {
    origin_id: String,
    session_id: SessionId,
    title: String,
    body: String,
    created_us: i64,
}

/// A write that passed every check: the origin named, every item parsed, text
/// scrubbed with the server's sanitizer and cut to its bounds. Holding one is
/// the proof, so the store write cannot be handed an unchecked request.
#[derive(Debug, Clone)]
pub struct SyncedConclusionBatch {
    origin_device: String,
    items: Vec<PreparedConclusion>,
}

impl SyncedConclusionBatch {
    /// Validate the whole request, then scrub and cap each item. The text is
    /// scrubbed before it is cut, so a secret straddling the cap is redacted
    /// instead of left as an unmatchable prefix.
    ///
    /// # Errors
    /// [`ConclusionBatchError`] naming the first problem: an empty or oversized
    /// batch, a bad origin device, or an item with a bad id, session id or time.
    pub fn prepare(
        origin_device: &str,
        incoming: Vec<IncomingConclusion>,
        sanitizer: &Sanitizer,
    ) -> Result<Self, ConclusionBatchError> {
        let origin_device = origin_device.trim();
        check_origin_field("origin_device", origin_device)?;
        if incoming.is_empty() || incoming.len() > SYNCED_CONCLUSION_BATCH_MAX {
            return Err(ConclusionBatchError(format!(
                "conclusions must hold 1 to {SYNCED_CONCLUSION_BATCH_MAX} items, got {}",
                incoming.len()
            )));
        }
        let mut items = Vec::with_capacity(incoming.len());
        for (index, item) in incoming.into_iter().enumerate() {
            let fail = |what: String| ConclusionBatchError(format!("conclusions[{index}]: {what}"));
            check_origin_field("id", &item.id).map_err(|e| fail(e.0))?;
            if item.id.chars().any(char::is_whitespace) {
                return Err(fail("id must not contain whitespace".into()));
            }
            let session_id = SessionId::from_str(&item.session_id)
                .map_err(|_| fail("session_id is not a session id".into()))?;
            let created_us = item
                .created_at
                .parse::<Timestamp>()
                .map_err(|_| fail("created_at is not an RFC 3339 time".into()))?
                .as_microsecond();
            items.push(PreparedConclusion {
                origin_id: item.id,
                session_id,
                title: sanitizer
                    .scrub(&item.title)
                    .chars()
                    .take(SYNCED_CONCLUSION_TITLE_MAX_CHARS)
                    .collect(),
                body: truncate_utf8_bytes(
                    &sanitizer.scrub(&item.body),
                    SYNCED_CONCLUSION_BODY_MAX_BYTES,
                ),
                created_us,
            });
        }
        Ok(Self {
            origin_device: origin_device.to_owned(),
            items,
        })
    }
}

fn check_origin_field(name: &str, value: &str) -> Result<(), ConclusionBatchError> {
    if value.is_empty() {
        return Err(ConclusionBatchError(format!("{name} must not be empty")));
    }
    if value.chars().count() > SYNCED_CONCLUSION_ORIGIN_MAX_CHARS {
        return Err(ConclusionBatchError(format!(
            "{name} is longer than {SYNCED_CONCLUSION_ORIGIN_MAX_CHARS} characters"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(ConclusionBatchError(format!(
            "{name} must not contain control characters"
        )));
    }
    Ok(())
}

/// What a write did with one item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConclusionWriteStatus {
    /// Stored as a new row.
    Written,
    /// A row with this origin id already exists; it was left as it is.
    Same,
    /// The text was empty once scrubbed; nothing to keep.
    Skipped,
}

/// Insert a batch, insert-if-absent per `(workspace, project, origin id)`, in
/// one transaction. A stored row is never updated.
pub(crate) fn write_synced_conclusions(
    conn: &mut Connection,
    workspace_id: WorkspaceId,
    project_id: ProjectId,
    batch: &SyncedConclusionBatch,
) -> StoreResult<Vec<ConclusionWriteStatus>> {
    let tx = conn.transaction()?;
    let received = Timestamp::now().as_microsecond();
    let mut statuses = Vec::with_capacity(batch.items.len());
    {
        let mut insert = tx.prepare(
            "INSERT INTO synced_conclusions \
                 (workspace_id, project_id, origin_device, origin_id, session_id, \
                  title, body, created_at, received_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
             ON CONFLICT(workspace_id, project_id, origin_id) DO NOTHING",
        )?;
        for item in &batch.items {
            if item.body.trim().is_empty() {
                statuses.push(ConclusionWriteStatus::Skipped);
                continue;
            }
            let inserted = insert.execute(params![
                workspace_id.as_bytes(),
                project_id.as_bytes(),
                batch.origin_device,
                item.origin_id,
                item.session_id.as_bytes(),
                item.title,
                item.body,
                item.created_us,
                received,
            ])?;
            statuses.push(if inserted == 1 {
                ConclusionWriteStatus::Written
            } else {
                ConclusionWriteStatus::Same
            });
        }
    }
    tx.commit()?;
    Ok(statuses)
}

/// Delete the project's copies captured before `cutoff_us`. Retention follows
/// the receiver's own observation prune: a copy outlives it by no more than
/// a local `Stop` would.
pub(crate) fn prune_before(
    conn: &Connection,
    workspace_id: WorkspaceId,
    project_id: ProjectId,
    cutoff_us: i64,
) -> StoreResult<usize> {
    Ok(conn.execute(
        "DELETE FROM synced_conclusions \
         WHERE workspace_id = ?1 AND project_id = ?2 AND created_at < ?3",
        params![workspace_id.as_bytes(), project_id.as_bytes(), cutoff_us],
    )?)
}

/// Delete the project's copies that belong to one session.
pub(crate) fn delete_for_session(
    conn: &Connection,
    workspace_id: WorkspaceId,
    project_id: ProjectId,
    session_id: SessionId,
) -> StoreResult<usize> {
    Ok(conn.execute(
        "DELETE FROM synced_conclusions \
         WHERE workspace_id = ?1 AND project_id = ?2 AND session_id = ?3",
        params![
            workspace_id.as_bytes(),
            project_id.as_bytes(),
            session_id.as_bytes()
        ],
    )?)
}

/// Which stream a listing reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConclusionSource {
    /// `Stop` observations with a body, captured on this computer.
    Native,
    /// Copies received from another computer.
    Synced,
}

/// One conclusion in a listing.
#[derive(Debug, Clone, Serialize)]
pub struct ConclusionRecord {
    /// Position in its stream: the `native_conclusions` log number for native,
    /// the copy's row for synced. Ascending, and never reused.
    pub seq: i64,
    /// Workspace name.
    pub workspace: String,
    /// Project name.
    pub project: String,
    /// The observation id (native) or the origin id (synced).
    pub id: String,
    /// The session the conclusion closed.
    pub session_id: SessionId,
    /// Session page title, else first prompt title, else the session id.
    pub title: String,
    /// The conclusion text as stored.
    pub body: String,
    /// RFC 3339 capture time.
    pub created_at: String,
    /// The computer a copy came from; absent for native rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_device: Option<String>,
}

/// One page of a listing.
#[derive(Debug, Clone, Serialize)]
pub struct ConclusionPage {
    /// Rows after the cursor, ascending by `seq`.
    pub conclusions: Vec<ConclusionRecord>,
    /// `seq` of the last row returned, or the cursor itself when there is none.
    pub next: i64,
    /// Whether more rows follow `next`.
    pub more: bool,
    /// The highest `seq` the stream holds now, 0 when it is empty.
    pub last: i64,
    /// Who this database is. A different value than a puller saved means its
    /// cursors belong to another database (a fresh one restarts at 1).
    pub store: String,
}

fn rfc3339(micros: i64) -> String {
    Timestamp::from_microsecond(micros)
        .map(|ts| ts.to_string())
        .unwrap_or_default()
}

/// Titles of conclusions, by the one rule every surface shares: the session's
/// latest page title, else its first prompt's title, else the session id.
pub(crate) struct ConclusionTitles<'conn> {
    page: Statement<'conn>,
    prompt: Statement<'conn>,
}

impl<'conn> ConclusionTitles<'conn> {
    pub(crate) fn new(conn: &'conn Connection) -> StoreResult<Self> {
        Ok(Self {
            page: conn.prepare(
                "SELECT title FROM pages \
                 WHERE workspace_id = ?1 AND project_id = ?2 AND path = ?3 AND is_latest = 1",
            )?,
            prompt: conn.prepare(&format!(
                "SELECT title FROM observations \
                 WHERE session_id = ?1 AND kind = '{prompt}' AND title <> '' \
                 ORDER BY created_at, rowid LIMIT 1",
                prompt = ObservationKind::UserPrompt.as_str(),
            ))?,
        })
    }

    pub(crate) fn title(
        &mut self,
        workspace_id: WorkspaceId,
        project_id: ProjectId,
        session_id: SessionId,
    ) -> StoreResult<String> {
        let page: Option<String> = self
            .page
            .query_row(
                params![
                    workspace_id.as_bytes(),
                    project_id.as_bytes(),
                    format!("sessions/{session_id}.md")
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(title) = page.filter(|title| !title.is_empty()) {
            return Ok(title);
        }
        Ok(self
            .prompt
            .query_row(params![session_id.as_bytes()], |row| row.get(0))
            .optional()?
            .unwrap_or_else(|| session_id.to_string()))
    }
}

/// One page of a conclusion stream after `after`, at most `limit` rows.
pub(crate) fn list_conclusions(
    conn: &Connection,
    source: ConclusionSource,
    after: i64,
    limit: usize,
) -> StoreResult<ConclusionPage> {
    let fetch = i64::try_from(limit.saturating_add(1)).unwrap_or(i64::MAX);
    // One snapshot, so `last` is never behind the rows listed with it.
    let tx = conn.unchecked_transaction()?;
    let (mut conclusions, last_sql) = match source {
        ConclusionSource::Native => (
            list_native(&tx, after, fetch)?,
            "SELECT COALESCE(MAX(seq), 0) FROM native_conclusions",
        ),
        ConclusionSource::Synced => (
            list_synced(&tx, after, fetch)?,
            "SELECT COALESCE(MAX(id), 0) FROM synced_conclusions",
        ),
    };
    let last: i64 = tx.query_row(last_sql, [], |row| row.get(0))?;
    let store: String = tx.query_row("SELECT id FROM store_identity", [], |row| row.get(0))?;
    tx.finish()?;
    let more = conclusions.len() > limit;
    conclusions.truncate(limit);
    let next = conclusions.last().map_or(after, |row| row.seq);
    Ok(ConclusionPage {
        conclusions,
        next,
        more,
        last,
        store,
    })
}

fn list_native(conn: &Connection, after: i64, fetch: i64) -> StoreResult<Vec<ConclusionRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT n.seq, w.name, p.name, o.id, o.session_id, o.workspace_id, o.project_id, \
                o.body, o.created_at \
         FROM native_conclusions n \
         JOIN observations o ON o.id = n.observation_id \
         JOIN workspaces w ON w.id = o.workspace_id \
         JOIN projects p ON p.id = o.project_id \
         WHERE n.seq > ?1 AND o.kind = '{stop}' AND trim(o.body) <> '' \
         ORDER BY n.seq LIMIT ?2",
        stop = ObservationKind::Stop.as_str(),
    ))?;
    let rows = stmt
        .query_map(params![after, fetch], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, Vec<u8>>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut titles = ConclusionTitles::new(conn)?;
    rows.into_iter()
        .map(
            |(seq, workspace, project, id, session, ws_id, proj_id, body, created_us)|
             -> StoreResult<ConclusionRecord> {
                let session_id = SessionId::from_slice(&session)?;
                Ok(ConclusionRecord {
                    seq,
                    workspace,
                    project,
                    id: ObservationId::from_slice(&id)?.to_string(),
                    session_id,
                    title: titles.title(
                        WorkspaceId::from_slice(&ws_id)?,
                        ProjectId::from_slice(&proj_id)?,
                        session_id,
                    )?,
                    body,
                    created_at: rfc3339(created_us),
                    origin_device: None,
                })
            },
        )
        .collect()
}

fn list_synced(conn: &Connection, after: i64, fetch: i64) -> StoreResult<Vec<ConclusionRecord>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, w.name, p.name, c.origin_id, c.session_id, c.title, c.body, \
                c.created_at, c.origin_device \
         FROM synced_conclusions c \
         JOIN workspaces w ON w.id = c.workspace_id \
         JOIN projects p ON p.id = c.project_id \
         WHERE c.id > ?1 ORDER BY c.id LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![after, fetch], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(
            |(seq, workspace, project, id, session, title, body, created_us, origin)|
             -> StoreResult<ConclusionRecord> {
                Ok(ConclusionRecord {
                    seq,
                    workspace,
                    project,
                    id,
                    session_id: SessionId::from_slice(&session)?,
                    title,
                    body,
                    created_at: rfc3339(created_us),
                    origin_device: Some(origin),
                })
            },
        )
        .collect::<StoreResult<Vec<_>>>()
}

/// Best-matching synced conclusion per session of one project, best first, at
/// most `limit`; `fts_query` is the prepared query page search uses. A synced
/// row has no actor, so it is visible to every owner filter, like an
/// unattributed session.
pub(crate) fn search_synced(
    conn: &Connection,
    workspace_id: WorkspaceId,
    project_id: ProjectId,
    fts_query: &str,
    limit: usize,
) -> StoreResult<Vec<ConclusionHit>> {
    // Window and snippet cannot share a statement: the window keeps each
    // session's best row, the excerpt is a point lookup per survivor.
    let mut stmt = conn.prepare(
        "SELECT id, session_id, title, created_at, rank FROM ( \
             SELECT c.id AS id, c.session_id AS session_id, c.title AS title, \
                    c.created_at AS created_at, synced_conclusions_fts.rank AS rank, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY c.session_id \
                        ORDER BY synced_conclusions_fts.rank) AS rn \
             FROM synced_conclusions_fts \
             CROSS JOIN synced_conclusions c ON c.id = synced_conclusions_fts.rowid \
             WHERE synced_conclusions_fts MATCH ?1 \
               AND c.workspace_id = ?2 \
               AND c.project_id = ?3 \
         ) WHERE rn = 1 ORDER BY rank LIMIT ?4",
    )?;
    let rows = stmt
        .query_map(
            params_from_iter([
                Value::Text(fts_query.to_owned()),
                Value::Blob(workspace_id.as_bytes().to_vec()),
                Value::Blob(project_id.as_bytes().to_vec()),
                Value::Integer(i64::try_from(limit).unwrap_or(i64::MAX)),
            ]),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, f64>(4)?,
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut excerpt_of = conn.prepare(&format!(
        "SELECT snippet(synced_conclusions_fts, 1, '<mark>', '</mark>', '…', \
                        {CONCLUSION_SNIPPET_TOKENS}) \
         FROM synced_conclusions_fts WHERE synced_conclusions_fts MATCH ?1 AND rowid = ?2"
    ))?;
    rows.into_iter()
        .map(
            |(row_id, session, title, created_us, rank)| -> StoreResult<ConclusionHit> {
                Ok(ConclusionHit {
                    session_id: SessionId::from_slice(&session)?,
                    title,
                    excerpt: excerpt_of.query_row(params![fts_query, row_id], |row| row.get(0))?,
                    created_at: rfc3339(created_us),
                    rank,
                })
            },
        )
        .collect::<Result<Vec<_>, StoreError>>()
}

/// Merge native and synced hits: best rank first, one per session (its best),
/// at most `limit`.
pub(crate) fn merge_conclusion_hits(
    mut hits: Vec<ConclusionHit>,
    limit: usize,
) -> Vec<ConclusionHit> {
    hits.sort_by(|a, b| a.rank.total_cmp(&b.rank));
    let mut seen = std::collections::HashSet::new();
    hits.retain(|hit| seen.insert(hit.session_id));
    hits.truncate(limit);
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn incoming(id: &str) -> IncomingConclusion {
        IncomingConclusion {
            id: id.into(),
            session_id: SessionId::new().to_string(),
            title: "title".into(),
            body: "body".into(),
            created_at: "2026-10-19T10:00:00Z".into(),
        }
    }

    #[test]
    fn prepare_scrubs_before_it_cuts() {
        let secret = format!("sk-{}", "a".repeat(40));
        let mut item = incoming("one");
        item.body = format!(
            "{}{secret}",
            "x".repeat(SYNCED_CONCLUSION_BODY_MAX_BYTES - 10)
        );
        let batch = SyncedConclusionBatch::prepare("mac", vec![item], &Sanitizer::builtin())
            .expect("valid");
        let body = &batch.items[0].body;
        assert!(
            body.len() <= SYNCED_CONCLUSION_BODY_MAX_BYTES,
            "{}",
            body.len()
        );
        assert!(
            !body.contains("sk-a"),
            "an unmatchable prefix of the secret survived"
        );
    }

    #[test]
    fn prepare_names_the_first_bad_item() {
        let mut bad = incoming("two");
        bad.session_id = "nope".into();
        let err = SyncedConclusionBatch::prepare(
            "mac",
            vec![incoming("one"), bad],
            &Sanitizer::builtin(),
        )
        .unwrap_err();
        assert!(
            err.to_string().starts_with("conclusions[1]: session_id"),
            "{err}"
        );
    }
}
