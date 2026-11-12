//! The device's side (was `MemorySync` of `src/main/ai-memory/sync.ts`): one round with a host it is connected to,
//! pages and then conclusions, each pulled and then pushed, over main's link (`super::request`, the link seam).
//!
//! Identity: (workspace, project, path). Content: `page_hash` of what the write path stores. A page's two copies are
//! "in agreement" at a pair of hashes (`base`: this computer's, the host's), recorded whenever a round made them so;
//! a side whose hash still equals its half of the pair has not changed since. That keeps a round idempotent even when
//! a server normalizes what it stores (entities lowercased, a body scrubbed), and a copy received from a peer is never
//! sent back as new. A copy also carries `origin_device` (the computer it came from) until someone edits it, and an
//! unedited copy never goes back to that computer. When both sides changed, the one changed last wins (each page's
//! `updated_at`), logged as `conflict`.

use std::collections::HashSet;
use std::time::Instant;

use serde::Serialize;
use serde_json::{Map, Number, Value, json};

use super::host::{BATCH_BYTES, BATCH_PAGES, CONCLUSION_BATCH, Raw, by_place, clean, input, place};
use super::state::{HostState, IdentityPass};
use super::store::{Index, ProjectNames, Store, at, position, read_conclusions};
use super::wire::{ConclusionCursor, ConclusionWire, Cursor, Invalid, PageWire, Source};
use super::{Instance, Link};
use crate::aimemory::value::js_order;
use crate::server::Fault;

/// One round pulls at most this many batches; the next round goes on from the cursor.
const MAX_PULL_BATCHES: usize = 40;
/// Agreement pairs kept per host (a person has hundreds of durable pages, not thousands).
const BASE_LIMIT: usize = 10_000;
const MAX_CONCLUSION_BATCHES: usize = 40;
/// A host whose whole pass carried no repository identity (an older OMPdesk) is passed again this much later.
const IDENTITY_PASS_RETRY_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;

pub const PULL: &str = "host.memory.pull";
pub const PUSH: &str = "host.memory.push";
pub const CONCLUSIONS_PULL: &str = "host.memory.conclusions.pull";
pub const CONCLUSIONS_PUSH: &str = "host.memory.conclusions.push";

#[derive(Debug, Clone, Default, Serialize)]
pub struct Report {
    pulled: u64,
    pushed: u64,
    conflicts: u64,
    /// Session conclusions written here (pulled) and written on the host (pushed) this round.
    conclusions: ConclusionCounts,
}

#[derive(Debug, Clone, Default, Serialize)]
struct ConclusionCounts {
    pulled: u64,
    pushed: u64,
}

/// Why a round stopped early.
enum Stop {
    /// Memory is off on the host: nothing more is read or written this round.
    Off,
    Failed(Fault),
}

impl From<Fault> for Stop {
    fn from(fault: Fault) -> Stop {
        Stop::Failed(fault)
    }
}

impl From<Invalid> for Stop {
    fn from(invalid: Invalid) -> Stop {
        Stop::Failed(Fault::new("invalid_reply", invalid.to_string()))
    }
}

/// What main says at the start of a round: this computer's server (none while memory is off), its device id and
/// its clock.
pub struct Here {
    pub store: Store,
    pub self_id: String,
    pub now: Number,
}

struct Round<'a> {
    instance: &'a Instance,
    link: Link<'a>,
    host: &'a str,
    store: Store,
    self_id: String,
    report: Report,
}

/// One round with `host`: pages, then conclusions, each pull then push. None when nothing ran (memory off here or
/// there, an older host).
pub async fn round(instance: &Instance, host: &str, here: Here) -> Option<Report> {
    let started = Instant::now();
    let mut state = instance.host_state(host).await;
    let mut round = Round {
        instance,
        link: instance.link(host),
        host,
        store: here.store,
        self_id: here.self_id,
        report: Report::default(),
    };
    start_identity_pass(&mut state, &here.now);
    let mut step = "pull";
    let ran = async {
        round.pull(&mut state).await?;
        step = "push";
        round.push(&mut state).await?;
        step = "conclusions";
        round.conclusions(&mut state).await?;
        round.end_identity_pass(&mut state);
        Ok::<(), Stop>(())
    }
    .await;
    let mut answer = true;
    if let Err(stop) = ran {
        match stop {
            Stop::Off => answer = false,
            Stop::Failed(fault) => {
                let unsupported = fault.code == "unsupported";
                // Pages are done by now: a host or server that cannot do conclusions costs only them.
                if step == "conclusions" && unsupported {
                    instance.conclusions_unsupported(host);
                    round
                        .link
                        .log("conclusions-unsupported", json!({ "host": host }));
                } else if unsupported {
                    instance.unsupported(host);
                    round.link.log("unsupported", json!({ "host": host }));
                    answer = false;
                } else {
                    round.link.log(
                        "failed",
                        json!({ "host": host, "step": step, "error": fault.message }),
                    );
                    answer = step == "conclusions";
                }
            }
        }
    }
    state.trim(BASE_LIMIT);
    instance.put_host_state(host, state);
    instance.save().await;
    if !answer {
        return None;
    }
    let report = round.report;
    let total = report.pulled
        + report.pushed
        + report.conflicts
        + report.conclusions.pulled
        + report.conclusions.pushed;
    if total > 0 {
        let mut details = Map::new();
        details.insert("host".to_owned(), json!(host));
        if let Ok(Value::Object(counts)) = serde_json::to_value(&report) {
            details.extend(counts);
        }
        details.insert("ms".to_owned(), json!(started.elapsed().as_millis() as u64));
        round.link.log("round", Value::Object(details));
    }
    Some(report)
}

/// Starts the whole pass when it is due: every cursor back to the start. Items synced before identities crossed
/// were filed by name, some into a plain project a repair later renamed aside, and the cursors had passed them for
/// good; the pass offers and pulls everything again, identities file each item into its repository's project, and
/// what is already there answers `same`. Done once a pass that saw an identity ends; a host that sends none is tried
/// again a week later.
fn start_identity_pass(state: &mut HostState, now: &Number) {
    if let Some(pass) = &state.identity_pass {
        let since = now.as_f64().unwrap_or_default() - pass.at.as_f64().unwrap_or_default();
        if pass.done || pass.running || since < IDENTITY_PASS_RETRY_MS {
            return;
        }
    }
    state.identity_pass = Some(IdentityPass {
        at: now.clone(),
        done: false,
        running: true,
        seen: false,
        pages: false,
        conclusions: false,
    });
    state.pull = None;
    state.push = String::new();
    state.conclusions = ConclusionCursor::default();
    state.conclusions_sent = ConclusionCursor::default();
}

fn saw_identity(state: &mut HostState, identity: Option<&str>) {
    if identity.is_some_and(|identity| !identity.is_empty())
        && let Some(pass) = &mut state.identity_pass
    {
        pass.seen = true;
    }
}

/// A reply's object, or why it is not one.
fn object<'v>(value: &'v Value, what: &'static str) -> Result<&'v Map<String, Value>, Invalid> {
    value.as_object().ok_or(Invalid(what))
}

fn flag(object: &Map<String, Value>, name: &str, what: &'static str) -> Result<bool, Invalid> {
    object
        .get(name)
        .and_then(Value::as_bool)
        .ok_or(Invalid(what))
}

fn items<'v>(
    object: &'v Map<String, Value>,
    name: &str,
    what: &'static str,
) -> Result<&'v Vec<Value>, Invalid> {
    object
        .get(name)
        .and_then(Value::as_array)
        .ok_or(Invalid(what))
}

/// A hash on the link (`MemoryHash`) or null.
fn hash(value: Option<&Value>, what: &'static str) -> Result<Option<String>, Invalid> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(hash))
            if hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Ok(Some(hash.clone()))
        }
        _ => Err(Invalid(what)),
    }
}

impl Round<'_> {
    async fn pull(&mut self, state: &mut HostState) -> Result<(), Stop> {
        const WHAT: &str = "memory pull reply";
        for _ in 0..MAX_PULL_BATCHES {
            let reply = self
                .link
                .request(PULL, json!({ "since": state.pull }))
                .await?;
            let reply = object(&reply, WHAT)?;
            let memory = flag(reply, "memory", WHAT)?;
            let pages = items(reply, "pages", WHAT)?
                .iter()
                .map(PageWire::parse)
                .collect::<Result<Vec<_>, _>>()?;
            let next = Cursor::parse(reply.get("next").ok_or(Invalid(WHAT))?)?;
            let more = flag(reply, "more", WHAT)?;
            if !memory {
                return Err(Stop::Off);
            }
            let local = Index::read(&self.store).await?;
            let mut names = ProjectNames::read(&self.store).await?;
            for page in pages {
                // Filed under this computer's name for its repository; a name here that belongs to another
                // repository takes nothing. The cursor stays in the host's own keys.
                saw_identity(state, page.identity.as_deref());
                let cursor = Cursor {
                    at: page.updated_at.clone(),
                    key: page.key(),
                };
                if let Some(here) = names.localize(page) {
                    self.take(state, here, &local, &mut names).await?;
                }
                state.pull = Some(cursor);
            }
            if next.is_some() {
                state.pull = next;
            }
            if !more {
                if let Some(pass) = state.identity_pass.as_mut().filter(|pass| pass.running) {
                    pass.pages = true;
                }
                return Ok(());
            }
        }
        Ok(())
    }

    /// Settle one of the host's pages here.
    async fn take(
        &mut self,
        state: &mut HostState,
        page: PageWire,
        local: &Index,
        names: &mut ProjectNames,
    ) -> Result<(), Fault> {
        let key = page.key();
        let base = state
            .base(&key)
            .map(|(mine, theirs)| (mine.to_owned(), theirs.to_owned()));
        state.saw(&key, &page.hash);
        // The host's copy has not changed since the two agreed: anything changed here goes out with the push.
        if base
            .as_ref()
            .is_some_and(|(_, theirs)| *theirs == page.hash)
        {
            return Ok(());
        }
        let Some(held) = local.get(&key) else {
            return self.write(state, page, None, names).await;
        };
        let copy = self.store.page_copy(&held.at_ref).await?;
        let mine = copy.hash();
        if mine == page.hash {
            state.agree(&key, &mine, &page.hash);
            state.unpend(&key);
            return Ok(());
        }
        // Changed only there.
        if base.as_ref().is_some_and(|(base, _)| *base == mine) {
            return self.write(state, page, copy.page.id, names).await;
        }
        // Changed on both (or first met with different content): the one changed last wins.
        self.report.conflicts += 1;
        let theirs = js_order(&page.updated_at, &held.at).is_gt();
        self.link.log(
            "conflict",
            json!({
                "host": self.host,
                "workspace": page.workspace,
                "project": page.project,
                "path": page.path,
                "winner": if theirs { "host" } else { "here" },
                "hereAt": held.at,
                "hostAt": page.updated_at,
            }),
        );
        if theirs {
            return self.write(state, page, copy.page.id, names).await;
        }
        state.pend(&key);
        Ok(())
    }

    /// Write the host's page here over the version just judged (`expected`; none: none was here). When this page
    /// changed in between (a retire, an edit), nothing is written: that change is newer and goes out with the push.
    async fn write(
        &mut self,
        state: &mut HostState,
        page: PageWire,
        expected: Option<String>,
        names: &mut ProjectNames,
    ) -> Result<(), Fault> {
        let key = page.key();
        let origin = Some(page.origin.as_str()).filter(|origin| *origin != self.self_id);
        if !self
            .store
            .write_page_copy(&page, origin, expected.as_deref())
            .await?
        {
            return Ok(());
        }
        // Keyed where it landed: a repository new here gets the project name this server gives it.
        let landed = names.landed(&self.store, &page).await?;
        let landed_key = landed.key();
        let mine = self
            .store
            .page_copy(&at(&landed.workspace, &landed.project, &landed.path))
            .await?
            .hash();
        state.agree(&landed_key, &mine, &page.hash);
        state.saw(&landed_key, &page.hash);
        state.unpend(&key);
        self.report.pulled += 1;
        Ok(())
    }

    async fn push(&mut self, state: &mut HostState) -> Result<(), Stop> {
        let local = Index::read(&self.store).await?;
        let mut names = ProjectNames::read(&self.store).await?;
        let pending: HashSet<String> = state.pending.iter().cloned().collect();
        let mut candidates: Vec<&super::store::Entry> = local
            .entries
            .iter()
            .filter(|entry| {
                js_order(&entry.at, &state.push).is_gt() || pending.contains(&entry.key)
            })
            .collect();
        candidates.sort_by(|a, b| js_order(&a.at, &b.at));
        let mut newest = state.push.clone();
        let mut batch: Vec<Sent> = Vec::new();
        let mut bytes = 0;
        for entry in candidates {
            if js_order(&entry.at, &newest).is_gt() {
                newest.clone_from(&entry.at);
            }
            // The push time moves on past it: offer it again next round whatever its time.
            let Ok(copy) = self.store.page_copy(&entry.at_ref).await else {
                state.pend(&entry.key);
                continue;
            };
            let hash = copy.hash();
            // Unchanged since the two agreed, or an unedited copy of the host's own page: nothing to tell it.
            if state.base(&entry.key).is_some_and(|(mine, _)| mine == hash)
                || copy.page.origin.as_deref() == Some(self.host)
            {
                state.unpend(&entry.key);
                continue;
            }
            let origin = copy.page.origin.as_deref().unwrap_or(&self.self_id);
            let repository = names.repository_of(
                &entry.at_ref.project.workspace,
                &entry.at_ref.project.project,
            );
            let Some(page) = PageWire::of(&copy, origin, &entry.at, repository) else {
                continue;
            };
            bytes += page.body.len();
            batch.push(Sent {
                key: entry.key.clone(),
                hash,
                expect: state.remote(&entry.key).map(str::to_owned),
                page,
            });
            if batch.len() >= BATCH_PAGES || bytes >= BATCH_BYTES {
                self.flush(state, std::mem::take(&mut batch), &mut names)
                    .await?;
                bytes = 0;
            }
        }
        self.flush(state, batch, &mut names).await?;
        state.push = newest;
        // A page deleted here since it was left pending has nothing more to offer.
        state.pending.retain(|key| local.has(key));
        Ok(())
    }

    async fn flush(
        &mut self,
        state: &mut HostState,
        sent: Vec<Sent>,
        names: &mut ProjectNames,
    ) -> Result<(), Stop> {
        const WHAT: &str = "memory push reply";
        if sent.is_empty() {
            return Ok(());
        }
        let offers: Vec<Value> = sent
            .iter()
            .map(|entry| json!({ "page": entry.page, "expect": entry.expect }))
            .collect();
        let reply = self.link.request(PUSH, json!({ "pages": offers })).await?;
        let reply = object(&reply, WHAT)?;
        let memory = flag(reply, "memory", WHAT)?;
        let mut results = Vec::new();
        for result in items(reply, "results", WHAT)? {
            let result = object(result, WHAT)?;
            let status = match result.get("status").and_then(Value::as_str) {
                Some(status @ ("written" | "same" | "conflict" | "failed")) => status.to_owned(),
                _ => return Err(Invalid(WHAT).into()),
            };
            let page = match result.get("page") {
                None => None,
                Some(page) => Some(PageWire::parse(page)?),
            };
            results.push((status, hash(result.get("hash"), WHAT)?, page));
        }
        if !memory {
            return Err(Stop::Off);
        }
        let mut results = results.into_iter();
        for entry in sent {
            match results.next() {
                Some((status, Some(theirs), _)) if status == "written" || status == "same" => {
                    state.agree(&entry.key, &entry.hash, &theirs);
                    state.saw(&entry.key, &theirs);
                    state.unpend(&entry.key);
                    if status == "written" {
                        self.report.pushed += 1;
                    }
                }
                Some((status, _, Some(page))) if status == "conflict" => {
                    if let Some(here) = names.localize(page) {
                        let local = Index::read(&self.store).await?;
                        self.take(state, here, &local, names).await?;
                    }
                }
                _ => state.pend(&entry.key),
            }
        }
        Ok(())
    }

    /// Conclusions, after the pages: the host's first, then this computer's two streams.
    async fn conclusions(&mut self, state: &mut HostState) -> Result<(), Stop> {
        if self.instance.conclusions_unsupported_for(self.host) {
            return Ok(());
        }
        self.pull_conclusions(state).await?;
        self.push_conclusions(state).await
    }

    async fn pull_conclusions(&mut self, state: &mut HostState) -> Result<(), Stop> {
        const WHAT: &str = "memory conclusion pull reply";
        for _ in 0..MAX_CONCLUSION_BATCHES {
            let since = serde_json::to_value(&state.conclusions).unwrap_or_default();
            let reply = self
                .link
                .request(CONCLUSIONS_PULL, json!({ "since": since }))
                .await?;
            let reply = object(&reply, WHAT)?;
            let memory = flag(reply, "memory", WHAT)?;
            let rows = items(reply, "conclusions", WHAT)?;
            if rows.len() > CONCLUSION_BATCH as usize {
                return Err(Invalid(WHAT).into());
            }
            let rows = rows
                .iter()
                .map(ConclusionWire::parse)
                .collect::<Result<Vec<_>, _>>()?;
            let next = ConclusionCursor::parse(reply.get("next").ok_or(Invalid(WHAT))?)?;
            let more = flag(reply, "more", WHAT)?;
            if !memory {
                return Err(Stop::Off);
            }
            // This computer's own coming back is never written; whatever the host says, nothing unredacted is.
            let names = ProjectNames::read(&self.store).await?;
            let mut raws = Vec::new();
            for row in rows {
                saw_identity(state, row.identity.as_deref());
                if row.origin == self.self_id {
                    continue;
                }
                let origin = row.origin.clone();
                if let Some(here) = names.localize(row) {
                    raws.push(Raw::from_wire(here, origin));
                }
            }
            let cleaned: Vec<ConclusionWire> = clean(&self.link.events, raws)
                .await?
                .into_iter()
                .flatten()
                .collect();
            // A group that fails stops the round before the cursor moves: the batch is read again, the written rows
            // answer `same`.
            for group in by_place(cleaned, |wire| wire) {
                let first = &group[0];
                let items: Vec<_> = group.iter().map(input).collect();
                let statuses = self
                    .store
                    .write_conclusions(
                        &place(first),
                        &first.origin,
                        &items,
                        first.repository().as_ref(),
                    )
                    .await?;
                self.report.conclusions.pulled += statuses
                    .iter()
                    .filter(|status| *status == "written")
                    .count() as u64;
            }
            state.conclusions = next;
            if !more {
                if let Some(pass) = state.identity_pass.as_mut().filter(|pass| pass.running) {
                    pass.conclusions = true;
                }
                return Ok(());
            }
        }
        Ok(())
    }

    /// Offer the host what it lacks of this computer's streams; the cursor stops at the first row it did not take.
    async fn push_conclusions(&mut self, state: &mut HostState) -> Result<(), Stop> {
        const WHAT: &str = "memory conclusion push reply";
        let names = ProjectNames::read(&self.store).await?;
        for source in [Source::Native, Source::Synced] {
            for _ in 0..MAX_CONCLUSION_BATCHES {
                let sent = &mut state.conclusions_sent;
                let read = read_conclusions(
                    &self.store,
                    source,
                    sent.get(source),
                    sent.store.as_deref(),
                    CONCLUSION_BATCH,
                )
                .await?;
                let page = read.page;
                if sent.store.as_deref() != Some(page.store.as_str()) {
                    *sent = ConclusionCursor {
                        native: 0,
                        synced: 0,
                        store: Some(page.store.clone()),
                    };
                } else {
                    sent.set(source, read.after);
                }
                // The host's own conclusions never go back to it, and a computer's neither (`origin`).
                let mut seqs = Vec::with_capacity(page.rows.len());
                let mut offered = Vec::new();
                let mut raws = Vec::new();
                for row in page.rows {
                    seqs.push(position(&row.seq));
                    let origin = match source {
                        Source::Native => Some(self.self_id.clone()),
                        Source::Synced => row.origin.clone(),
                    };
                    let Some(origin) =
                        origin.filter(|origin| !origin.is_empty() && origin != self.host)
                    else {
                        offered.push(false);
                        continue;
                    };
                    offered.push(true);
                    let repository = names.repository_of(&row.workspace, &row.project).cloned();
                    raws.push(Raw::of(row, origin, repository));
                }
                let mut cleaned = clean(&self.link.events, raws).await?.into_iter();
                let wires: Vec<Option<ConclusionWire>> = offered
                    .iter()
                    .map(|&offered| {
                        if offered {
                            cleaned.next().flatten()
                        } else {
                            None
                        }
                    })
                    .collect();
                let sending: Vec<&ConclusionWire> = wires.iter().flatten().collect();
                let mut statuses: Vec<String> = Vec::new();
                if !sending.is_empty() {
                    let reply = self
                        .link
                        .request(CONCLUSIONS_PUSH, json!({ "conclusions": sending }))
                        .await?;
                    let reply = object(&reply, WHAT)?;
                    let memory = flag(reply, "memory", WHAT)?;
                    for result in items(reply, "results", WHAT)? {
                        match object(result, WHAT)?.get("status").and_then(Value::as_str) {
                            Some(status @ ("written" | "same" | "skipped" | "failed")) => {
                                statuses.push(status.to_owned());
                            }
                            _ => return Err(Invalid(WHAT).into()),
                        }
                    }
                    if !memory {
                        return Err(Stop::Off);
                    }
                    self.report.conclusions.pushed += statuses
                        .iter()
                        .filter(|status| *status == "written")
                        .count() as u64;
                }
                let mut answered = statuses.iter();
                let mut reached = read.after;
                let mut stalled = false;
                for (wire, seq) in wires.iter().zip(&seqs) {
                    if wire.is_some() && answered.next().is_none_or(|status| status == "failed") {
                        stalled = true;
                        break;
                    }
                    reached = *seq;
                }
                let at = if stalled {
                    reached
                } else {
                    position(&page.next)
                };
                state.conclusions_sent.set(source, at);
                if stalled || !page.more {
                    break;
                }
            }
        }
        Ok(())
    }

    /// Ends a pass whose pulls both reached the host's end; done for good once it saw a repository identity.
    fn end_identity_pass(&self, state: &mut HostState) {
        let Some(pass) = state.identity_pass.as_mut() else {
            return;
        };
        if !pass.running
            || !pass.pages
            || !(pass.conclusions || self.instance.conclusions_unsupported_for(self.host))
        {
            return;
        }
        pass.running = false;
        pass.done = pass.seen;
        let seen = pass.seen;
        self.link
            .log("identity-pass", json!({ "host": self.host, "seen": seen }));
    }
}

/// A page offered in a push batch.
struct Sent {
    key: String,
    hash: String,
    expect: Option<String>,
    page: PageWire,
}
