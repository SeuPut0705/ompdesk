//! The host's side (was `servePull`, `servePush`, `serveConclusionPull`, `serveConclusionPush` of
//! `src/main/ai-memory/sync.ts`): a paired device's `host.memory.*` request, answered from this computer's server.
//! Main checks the request against the link's schema and whether the device may still use this computer, then hands
//! it here with `server` null while memory is off (the reply then says `memory: false` and nothing is read).

use std::collections::HashMap;

use serde::Serialize;

use super::store::{Index, ProjectNames, Store, at, position, read_conclusions};
use super::wire::{
    ConclusionCursor, ConclusionRow, ConclusionWire, Copy, Cursor, PageWire, Source,
};
use crate::aimemory::ops::{Conclusion, ConclusionInput, ProjectRef, Repository};
use crate::server::{Events, Fault};

/// Pages and body bytes one pull or push batch carries at most.
pub const BATCH_PAGES: usize = 25;
pub const BATCH_BYTES: usize = 1_000_000;
/// Conclusions one pull reply or push request carries at most (the wire's cap).
pub const CONCLUSION_BATCH: u64 = 200;

#[derive(Serialize)]
pub struct PullReply {
    memory: bool,
    pages: Vec<PageWire>,
    next: Option<Cursor>,
    more: bool,
}

#[derive(Serialize)]
pub struct PushResult {
    pub status: &'static str,
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<PageWire>,
}

#[derive(Serialize)]
pub struct PushReply {
    memory: bool,
    results: Vec<PushResult>,
}

#[derive(Serialize)]
pub struct ConclusionPullReply {
    memory: bool,
    conclusions: Vec<ConclusionWire>,
    next: ConclusionCursor,
    more: bool,
}

#[derive(Serialize)]
pub struct Status {
    pub status: &'static str,
}

#[derive(Serialize)]
pub struct ConclusionPushReply {
    memory: bool,
    results: Vec<Status>,
}

/// One page sent for the host to write, with the host's hash of it as the device last saw it.
pub struct Offer {
    pub page: PageWire,
    pub expect: Option<String>,
}

/// A conclusion before the redactor: what is written of it, the computer that captured it and its repository.
pub struct Raw {
    pub workspace: String,
    pub project: String,
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub body: String,
    pub at: String,
    pub origin: String,
    pub repository: Option<Repository>,
}

impl Raw {
    pub fn of(row: Conclusion, origin: String, repository: Option<Repository>) -> Raw {
        Raw {
            workspace: row.workspace,
            project: row.project,
            id: row.id,
            session_id: row.session_id,
            title: row.title,
            body: row.body,
            at: row.at,
            origin,
            repository,
        }
    }

    pub fn from_wire(wire: ConclusionWire, origin: String) -> Raw {
        let repository = wire.repository();
        Raw {
            workspace: wire.workspace,
            project: wire.project,
            id: wire.id,
            session_id: wire.session_id,
            title: wire.title,
            body: wire.body,
            at: wire.at,
            origin,
            repository,
        }
    }
}

/// Each conclusion as it may leave or be written (`cleanConclusion`): title and body redacted again by main's
/// redactor (an older or hostile peer may not have), then cut and checked. One ask for the lot.
pub async fn clean(events: &Events, raws: Vec<Raw>) -> Result<Vec<Option<ConclusionWire>>, Fault> {
    if raws.is_empty() {
        return Ok(Vec::new());
    }
    let texts: Vec<&str> = raws
        .iter()
        .flat_map(|raw| [raw.title.as_str(), raw.body.as_str()])
        .collect();
    let redacted = super::redact(events, &texts).await?;
    Ok(raws
        .iter()
        .zip(redacted.as_chunks::<2>().0)
        .map(|(raw, [title, body])| {
            let row = ConclusionRow {
                workspace: &raw.workspace,
                project: &raw.project,
                id: &raw.id,
                session_id: &raw.session_id,
                at: &raw.at,
            };
            ConclusionWire::clean(&row, title, body, &raw.origin, raw.repository.as_ref())
        })
        .collect())
}

/// Rows of one (workspace, project, origin), the unit the server writes in one request, in the order first met.
pub fn by_place<T>(rows: Vec<T>, place: impl Fn(&T) -> &ConclusionWire) -> Vec<Vec<T>> {
    let mut groups: Vec<Vec<T>> = Vec::new();
    let mut found: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let wire = place(&row);
        let key = format!(
            "{}\u{0}{}\u{0}{}",
            wire.workspace, wire.project, wire.origin
        );
        match found.get(&key) {
            Some(&at) => groups[at].push(row),
            None => {
                found.insert(key, groups.len());
                groups.push(vec![row]);
            }
        }
    }
    groups
}

/// What the server's write path takes of a conclusion.
pub fn input(wire: &ConclusionWire) -> ConclusionInput {
    ConclusionInput {
        id: wire.id.clone(),
        session_id: wire.session_id.clone(),
        title: wire.title.clone(),
        body: wire.body.clone(),
        at: wire.at.clone(),
    }
}

pub fn place(wire: &ConclusionWire) -> ProjectRef {
    ProjectRef {
        workspace: wire.workspace.clone(),
        project: wire.project.clone(),
    }
}

/// `host.memory.pull`: this computer's durable pages after `since`, oldest first, none of `peer`'s own copies.
pub async fn serve_pull(
    store: Option<Store>,
    self_id: &str,
    peer: &str,
    since: Option<Cursor>,
) -> Result<PullReply, Fault> {
    let Some(store) = store else {
        return Ok(PullReply {
            memory: false,
            pages: Vec::new(),
            next: since,
            more: false,
        });
    };
    let names = ProjectNames::read(&store).await?;
    let index = Index::read(&store).await?;
    let mut entries: Vec<(&super::store::Entry, Cursor)> = index
        .entries
        .iter()
        .map(|entry| {
            let cursor = Cursor {
                at: entry.at.clone(),
                key: entry.key.clone(),
            };
            (entry, cursor)
        })
        .filter(|(_, cursor)| {
            since
                .as_ref()
                .is_none_or(|since| cursor.compare(since).is_gt())
        })
        .collect();
    entries.sort_by(|(_, a), (_, b)| a.compare(b));
    let total = entries.len();
    let mut pages = Vec::new();
    let mut bytes = 0;
    let mut next = since;
    let mut examined = 0;
    for (entry, cursor) in entries {
        if pages.len() >= BATCH_PAGES || bytes >= BATCH_BYTES {
            break;
        }
        examined += 1;
        // A read that fails fails the pull: the cursor stays before this page, so the next round reads it again.
        let copy = store.page_copy(&entry.at_ref).await?;
        next = Some(cursor);
        let origin = copy
            .page
            .origin
            .clone()
            .unwrap_or_else(|| self_id.to_owned());
        // An unedited copy of the asking device's own page: it has the page already.
        if origin == peer {
            continue;
        }
        let repository = names.repository_of(
            &entry.at_ref.project.workspace,
            &entry.at_ref.project.project,
        );
        let Some(wire) = PageWire::of(&copy, &origin, &entry.at, repository) else {
            continue;
        };
        bytes += wire.body.len();
        pages.push(wire);
    }
    Ok(PullReply {
        memory: true,
        pages,
        next,
        more: examined < total,
    })
}

/// `host.memory.push`: write each page here unless this computer already holds it, or changed it since the device
/// last saw it (`conflict`, with this computer's version, so the device settles it at once).
pub async fn serve_push(
    store: Option<Store>,
    self_id: &str,
    offers: Vec<Offer>,
) -> Result<PushReply, Fault> {
    let Some(store) = store else {
        return Ok(PushReply {
            memory: false,
            results: Vec::new(),
        });
    };
    let index = Index::read(&store).await?;
    let mut names = ProjectNames::read(&store).await?;
    let mut results = Vec::with_capacity(offers.len());
    for offer in offers {
        let result = take_offer(&store, self_id, &index, &mut names, offer).await;
        results.push(result.unwrap_or(PushResult {
            status: "failed",
            hash: None,
            page: None,
        }));
    }
    Ok(PushReply {
        memory: true,
        results,
    })
}

async fn take_offer(
    store: &Store,
    self_id: &str,
    index: &Index,
    names: &mut ProjectNames,
    offer: Offer,
) -> Result<PushResult, Fault> {
    // Under this computer's name for the page's repository: the key, the write and every reply use it. A page whose
    // name here belongs to another repository is never written (`failed`: nothing changes).
    let Some(page) = names.localize(offer.page) else {
        return Ok(PushResult {
            status: "failed",
            hash: None,
            page: None,
        });
    };
    let repository = names.repository_of(&page.workspace, &page.project).cloned();
    let incoming = super::wire::page_hash(&page.content());
    let held = index.get(&page.key());
    let current = match held {
        Some(held) => Some(store.page_copy(&held.at_ref).await?),
        None => None,
    };
    let current_hash = current.as_ref().map(Copy::hash);
    if current_hash.as_deref() == Some(incoming.as_str()) {
        return Ok(PushResult {
            status: "same",
            hash: current_hash,
            page: None,
        });
    }
    if let (Some(current), Some(held)) = (&current, held)
        && current_hash != offer.expect
    {
        let origin = current.page.origin.as_deref().unwrap_or(self_id);
        return Ok(PushResult {
            status: "conflict",
            hash: current_hash,
            page: PageWire::of(current, origin, &held.at, repository.as_ref()),
        });
    }
    // Only over the version just judged: a change landing in between (a retire) is never overwritten.
    let origin = Some(page.origin.as_str()).filter(|origin| *origin != self_id);
    let expected = current
        .as_ref()
        .and_then(|current| current.page.id.as_deref());
    if !store.write_page_copy(&page, origin, expected).await? {
        let moved = store
            .page_copy(&at(&page.workspace, &page.project, &page.path))
            .await?;
        let origin = moved.page.origin.as_deref().unwrap_or(self_id);
        let updated = moved.page.updated_at.as_deref().unwrap_or_default();
        return Ok(PushResult {
            status: "conflict",
            hash: Some(moved.hash()),
            page: PageWire::of(&moved, origin, updated, repository.as_ref()),
        });
    }
    let landed = names.landed(store, &page).await?;
    let written = store
        .page_copy(&at(&landed.workspace, &landed.project, &landed.path))
        .await?;
    Ok(PushResult {
        status: "written",
        hash: Some(written.hash()),
        page: None,
    })
}

/// `host.memory.conclusions.pull`: this computer's own conclusions after `since.native`, then the ones it holds from
/// other computers after `since.synced`, at most 200 together, none that `peer` captured. Memory off: nothing read.
pub async fn serve_conclusion_pull(
    events: &Events,
    store: Option<Store>,
    self_id: &str,
    peer: &str,
    since: ConclusionCursor,
) -> Result<ConclusionPullReply, Fault> {
    let Some(store) = store else {
        return Ok(ConclusionPullReply {
            memory: false,
            conclusions: Vec::new(),
            next: since,
            more: false,
        });
    };
    let names = ProjectNames::read(&store).await?;
    let taken = |rows: Vec<Conclusion>, own: bool| -> Vec<Raw> {
        rows.into_iter()
            .filter_map(|row| {
                let origin = if own {
                    Some(self_id.to_owned())
                } else {
                    row.origin.clone()
                };
                let origin = origin.filter(|origin| !origin.is_empty() && origin != peer)?;
                let repository = names.repository_of(&row.workspace, &row.project).cloned();
                Some(Raw::of(row, origin, repository))
            })
            .collect()
    };
    let native = read_conclusions(
        &store,
        Source::Native,
        since.native,
        since.store.as_deref(),
        CONCLUSION_BATCH,
    )
    .await?;
    let store_id = native.page.store.clone();
    let mut conclusions: Vec<ConclusionWire> = clean(events, taken(native.page.rows, true))
        .await?
        .into_iter()
        .flatten()
        .collect();
    // Both streams live in one database: when it is not the one the cursor came from, neither position holds.
    let mut next = ConclusionCursor {
        native: position(&native.page.next),
        synced: if since.store.as_deref() == Some(store_id.as_str()) {
            since.synced
        } else {
            0
        },
        store: Some(store_id.clone()),
    };
    let mut more = native.page.more;
    if !more {
        let room = CONCLUSION_BATCH - conclusions.len() as u64;
        if room > 0 {
            let synced =
                read_conclusions(&store, Source::Synced, next.synced, Some(&store_id), room)
                    .await?;
            next.synced = position(&synced.page.next);
            more = synced.page.more;
            conclusions.extend(
                clean(events, taken(synced.page.rows, false))
                    .await?
                    .into_iter()
                    .flatten(),
            );
        } else {
            more = true;
        }
    }
    Ok(ConclusionPullReply {
        memory: true,
        conclusions,
        next,
        more,
    })
}

/// `host.memory.conclusions.push`: write each conclusion here under the computer that captured it, unless this
/// computer holds it already (the server answers `same`) or it is this computer's own coming back (`same`, no write).
/// A group the server refuses or fails on is `failed` for its rows only.
pub async fn serve_conclusion_push(
    events: &Events,
    store: Option<Store>,
    self_id: &str,
    rows: Vec<ConclusionWire>,
) -> Result<ConclusionPushReply, Fault> {
    let Some(store) = store else {
        return Ok(ConclusionPushReply {
            memory: false,
            results: Vec::new(),
        });
    };
    let names = ProjectNames::read(&store).await?;
    let mut results: Vec<Status> = rows.iter().map(|_| Status { status: "failed" }).collect();
    let mut indexes = Vec::new();
    let mut raws = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        if row.origin == self_id {
            results[index].status = "same";
            continue;
        }
        let origin = row.origin.clone();
        match names.localize(row) {
            Some(local) => {
                indexes.push(index);
                raws.push(Raw::from_wire(local, origin));
            }
            None => results[index].status = "skipped",
        }
    }
    let mut writable = Vec::new();
    for (index, cleaned) in indexes.into_iter().zip(clean(events, raws).await?) {
        match cleaned {
            Some(wire) => writable.push((index, wire)),
            None => results[index].status = "skipped",
        }
    }
    for group in by_place(writable, |(_, wire)| wire) {
        let first = &group[0].1;
        let items: Vec<ConclusionInput> = group.iter().map(|(_, wire)| input(wire)).collect();
        // Left `failed` when the write fails: the device offers these rows again.
        if let Ok(statuses) = store
            .write_conclusions(
                &place(first),
                &first.origin,
                &items,
                first.repository().as_ref(),
            )
            .await
        {
            for (at, (index, _)) in group.iter().enumerate() {
                results[*index].status = match statuses.get(at).map(String::as_str) {
                    Some("written") => "written",
                    Some("same") => "same",
                    Some("skipped") => "skipped",
                    _ => "failed",
                };
            }
        }
    }
    Ok(ConclusionPushReply {
        memory: true,
        results,
    })
}
