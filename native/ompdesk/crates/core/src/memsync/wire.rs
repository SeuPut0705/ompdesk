//! What crosses the link between two computers' memory, and the rules both sides apply to it: a page's key and
//! content hash, the bounds `src/main/remote/app-protocol.ts` puts on every field (zod's: string lengths in UTF-16
//! units, a conclusion's body in UTF-8 bytes), the cut of a conclusion, and which pages are durable. Older OMPdesks
//! compare these hashes and parse these shapes, so each is byte for byte what the TypeScript computed
//! (`captured.json`, rows taken from it before it was deleted).

use std::fmt;

use serde::Serialize;
use serde::ser::{SerializeMap, SerializeSeq};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::aimemory::ops::{PageCopy, Repository};
use crate::aimemory::value::{js_length, js_order};
use crate::fs::order::{is_js_space, js_trim};

/// A page body larger than this stays on its computer (`MEMORY_PAGE_MAX_BYTES`).
pub const PAGE_MAX_BYTES: usize = 256 * 1024;
/// A conclusion's body: the Stop excerpt's cap (`MEMORY_CONCLUSION_MAX_BYTES`), UTF-8 bytes.
pub const CONCLUSION_MAX_BYTES: usize = 2000;
/// A conclusion's title is cut to this many characters (the server's own cut).
const CONCLUSION_TITLE_CHARS: usize = 500;
/// The page folders that cross between computers (`DURABLE_MEMORY_FOLDERS`).
const DURABLE_FOLDERS: [&str; 6] = [
    "decisions",
    "_rules",
    "gotchas",
    "procedures",
    "preferences",
    "profile",
];

/// Why a frame from the other side was refused: it does not have the shape the link allows.
#[derive(Debug)]
pub struct Invalid(pub &'static str);

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid {}", self.0)
    }
}

pub fn is_durable_path(path: &str) -> bool {
    let first = path.split('/').next().unwrap_or_default();
    path.contains('/')
        && DURABLE_FOLDERS.contains(&first)
        && path.ends_with(".md")
        && !path.split('/').any(|part| matches!(part, "" | "." | ".."))
        && !path.contains('\\')
}

pub fn page_key(workspace: &str, project: &str, path: &str) -> String {
    format!("{workspace}\u{0}{project}\u{0}{path}")
}

/// `text` cut to at most `max` UTF-8 bytes, never inside a character.
pub fn cut_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The write path's own frontmatter fields of a page, in the order the link's schema names them.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entities: Option<Vec<String>>,
    #[serde(rename = "abstract", skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relations: Option<Relations>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applies_to: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enforced_by: Option<String>,
}

/// Relation → targets, in the order they were written (a JSON object).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Relations(pub Vec<(String, Vec<String>)>);

impl Serialize for Relations {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (relation, targets) in &self.0 {
            map.serialize_entry(relation, targets)?;
        }
        map.end()
    }
}

impl Metadata {
    /// The fields `pageCopy` read (a field of another shape is left out, as the link would refuse it).
    pub fn of(metadata: &Map<String, Value>) -> Metadata {
        Metadata {
            entities: metadata.get("entities").and_then(strings),
            summary: metadata.get("abstract").and_then(string),
            relations: metadata.get("relations").and_then(relations),
            applies_to: metadata.get("applies_to").and_then(strings),
            enforced_by: metadata.get("enforced_by").and_then(string),
        }
    }

    /// As the write path takes it: `...copy.metadata`.
    pub fn to_map(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        }
    }

    fn valid(&self) -> bool {
        self.entities
            .as_ref()
            .is_none_or(|items| bounded(items, 32, 200))
            && self
                .summary
                .as_ref()
                .is_none_or(|text| js_length(text) <= 4000)
            && self.relations.as_ref().is_none_or(|relations| {
                relations
                    .0
                    .iter()
                    .all(|(_, targets)| bounded(targets, 64, 1024))
            })
            && self
                .applies_to
                .as_ref()
                .is_none_or(|items| bounded(items, 32, 64))
            && self
                .enforced_by
                .as_ref()
                .is_none_or(|text| js_length(text) <= 1000)
    }
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value.as_array()?.iter().map(string).collect()
}

fn relations(value: &Value) -> Option<Relations> {
    value
        .as_object()?
        .iter()
        .map(|(relation, targets)| Some((relation.clone(), strings(targets)?)))
        .collect::<Option<Vec<_>>>()
        .map(Relations)
}

fn bounded(items: &[String], count: usize, length: usize) -> bool {
    items.len() <= count && items.iter().all(|item| js_length(item) <= length)
}

fn within(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&js_length(text))
}

/// What `pageHash` reads of a page.
pub struct Content<'a> {
    pub title: &'a str,
    pub kind: Option<&'a str>,
    pub tier: &'a str,
    pub body: &'a str,
    pub tags: &'a [String],
    pub metadata: &'a Metadata,
    pub expires_at: Option<&'a str>,
}

/// The array `pageHash` stringifies: `[title, kind, tier, body, tags sorted, entities, abstract, relations with
/// targets sorted by name, applies_to, enforced_by, expiresAt when set]`.
struct Canonical<'a>(&'a Content<'a>);

impl Serialize for Canonical<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let page = self.0;
        let meta = page.metadata;
        let mut tags: Vec<&str> = page.tags.iter().map(String::as_str).collect();
        tags.sort_by(|a, b| js_order(a, b));
        let mut relations: Vec<(&str, &[String])> = meta
            .relations
            .iter()
            .flat_map(|relations| &relations.0)
            .filter(|(_, targets)| !targets.is_empty())
            .map(|(relation, targets)| (relation.as_str(), targets.as_slice()))
            .collect();
        relations.sort_by(|(a, _), (b, _)| js_order(a, b));
        let none: &[String] = &[];
        let expires = page.expires_at.filter(|at| !at.is_empty());
        let mut seq = serializer.serialize_seq(None)?;
        seq.serialize_element(page.title)?;
        seq.serialize_element(page.kind.unwrap_or_default())?;
        seq.serialize_element(page.tier)?;
        seq.serialize_element(page.body)?;
        seq.serialize_element(&tags)?;
        seq.serialize_element(meta.entities.as_deref().unwrap_or(none))?;
        seq.serialize_element(meta.summary.as_deref().unwrap_or_default())?;
        seq.serialize_element(&relations)?;
        seq.serialize_element(meta.applies_to.as_deref().unwrap_or(none))?;
        seq.serialize_element(meta.enforced_by.as_deref().unwrap_or_default())?;
        if let Some(expires) = expires {
            seq.serialize_element(expires)?;
        }
        seq.end()
    }
}

/// What a page holds, independent of where it lives, when it changed, its pin and where it came from: SHA-256 of
/// the canonical array as `JSON.stringify` writes it, in hex. A retired page's expiry counts; a page without one
/// hashes as it did before expiry was carried.
pub fn page_hash(page: &Content<'_>) -> String {
    let canonical = serde_json::to_vec(&Canonical(page)).unwrap_or_default();
    hex(&Sha256::digest(&canonical))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A page as this computer's server holds it, with the metadata the link carries.
pub struct Copy {
    pub page: PageCopy,
    pub metadata: Metadata,
}

impl Copy {
    pub fn of(page: PageCopy) -> Copy {
        let metadata = Metadata::of(&page.metadata);
        Copy { page, metadata }
    }

    pub fn content(&self) -> Content<'_> {
        Content {
            title: &self.page.title,
            kind: self.page.kind.as_deref(),
            tier: &self.page.tier,
            body: &self.page.body,
            tags: &self.page.tags,
            metadata: &self.metadata,
            expires_at: self.page.expires_at.as_deref(),
        }
    }

    pub fn hash(&self) -> String {
        page_hash(&self.content())
    }
}

/// One durable page on the link (`MemoryPageWire`), its fields in the schema's order.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageWire {
    pub workspace: String,
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_source: Option<String>,
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub tier: String,
    pub body: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub metadata: Metadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub origin: String,
    pub updated_at: String,
    pub hash: String,
}

/// The wire's fields for a repository: the identity, and its source when it has one.
fn repository_fields(repository: Option<&Repository>) -> (Option<String>, Option<String>) {
    match repository.filter(|repository| !repository.identity.is_empty()) {
        Some(repository) => (
            Some(repository.identity.clone()),
            Some(repository.source.clone()).filter(|source| !source.is_empty()),
        ),
        None => (None, None),
    }
}

/// The repository an item on the link names, as the server's write path takes it (both halves, or none).
pub fn wire_repository(identity: Option<&str>, source: Option<&str>) -> Option<Repository> {
    match (identity, source) {
        (Some(identity), Some(source)) if !identity.is_empty() && !source.is_empty() => {
            Some(Repository {
                identity: identity.to_owned(),
                source: source.to_owned(),
            })
        }
        _ => None,
    }
}

impl PageWire {
    /// The page on the link; none when it cannot cross (too big, a field past the link's bounds).
    pub fn of(
        copy: &Copy,
        origin: &str,
        at: &str,
        repository: Option<&Repository>,
    ) -> Option<PageWire> {
        let page = &copy.page;
        if page.body.len() > PAGE_MAX_BYTES {
            return None;
        }
        let (identity, identity_source) = repository_fields(repository);
        let wire = PageWire {
            workspace: page.workspace.clone(),
            project: page.project.clone(),
            identity,
            identity_source,
            path: page.path.clone(),
            title: page.title.clone(),
            kind: page.kind.clone().filter(|kind| !kind.is_empty()),
            tier: page.tier.clone(),
            body: page.body.clone(),
            tags: page.tags.clone(),
            pinned: page.pinned,
            metadata: copy.metadata.clone(),
            expires_at: page.expires_at.clone().filter(|at| !at.is_empty()),
            origin: origin.to_owned(),
            updated_at: at.to_owned(),
            hash: copy.hash(),
        };
        wire.valid().then_some(wire)
    }

    pub fn key(&self) -> String {
        page_key(&self.workspace, &self.project, &self.path)
    }

    pub fn content(&self) -> Content<'_> {
        Content {
            title: &self.title,
            kind: self.kind.as_deref(),
            tier: &self.tier,
            body: &self.body,
            tags: &self.tags,
            metadata: &self.metadata,
            expires_at: self.expires_at.as_deref(),
        }
    }

    pub fn repository(&self) -> Option<Repository> {
        wire_repository(self.identity.as_deref(), self.identity_source.as_deref())
    }

    fn valid(&self) -> bool {
        within(&self.workspace, 1, 200)
            && within(&self.project, 1, 200)
            && self
                .identity
                .as_ref()
                .is_none_or(|text| within(text, 1, 512))
            && self
                .identity_source
                .as_ref()
                .is_none_or(|text| within(text, 1, 32))
            && within(&self.path, 1, 512)
            && is_durable_path(&self.path)
            && js_length(&self.title) <= 1000
            && self.kind.as_ref().is_none_or(|kind| js_length(kind) <= 64)
            && within(&self.tier, 1, 32)
            && js_length(&self.body) <= PAGE_MAX_BYTES
            && bounded(&self.tags, 64, 200)
            && self.metadata.valid()
            && self
                .expires_at
                .as_ref()
                .is_none_or(|at| js_length(at) <= 64)
            && within(&self.origin, 1, 200)
            && js_length(&self.updated_at) <= 64
            && self.hash.len() == 64
            && self
                .hash
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    }

    /// Reads one from the other side as `MemoryPageWire.parse` did: a missing field, `null` where none is allowed,
    /// another type or a field past its bounds refuses it.
    pub fn parse(value: &Value) -> Result<PageWire, Invalid> {
        let bad = Invalid("memory page");
        let object = value.as_object().ok_or(Invalid("memory page"))?;
        let metadata = object
            .get("metadata")
            .and_then(Value::as_object)
            .ok_or(Invalid("memory page"))?;
        let wire = PageWire {
            workspace: required(object, "workspace")?,
            project: required(object, "project")?,
            identity: optional(object, "identity")?,
            identity_source: optional(object, "identitySource")?,
            path: required(object, "path")?,
            title: required(object, "title")?,
            kind: optional(object, "kind")?,
            tier: required(object, "tier")?,
            body: required(object, "body")?,
            tags: strings(object.get("tags").unwrap_or(&Value::Null))
                .ok_or(Invalid("memory page"))?,
            pinned: object
                .get("pinned")
                .and_then(Value::as_bool)
                .ok_or(Invalid("memory page"))?,
            metadata: Metadata {
                entities: optional_with(metadata, "entities", strings)?,
                summary: optional(metadata, "abstract")?,
                relations: optional_with(metadata, "relations", relations)?,
                applies_to: optional_with(metadata, "applies_to", strings)?,
                enforced_by: optional(metadata, "enforced_by")?,
            },
            expires_at: optional(object, "expiresAt")?,
            origin: required(object, "origin")?,
            updated_at: required(object, "updatedAt")?,
            hash: required(object, "hash")?,
        };
        if wire.valid() { Ok(wire) } else { Err(bad) }
    }
}

fn required(object: &Map<String, Value>, name: &str) -> Result<String, Invalid> {
    object
        .get(name)
        .and_then(string)
        .ok_or(Invalid("memory frame"))
}

/// A field zod's `.optional()` takes: absent, or of its type (never `null`).
fn optional(object: &Map<String, Value>, name: &str) -> Result<Option<String>, Invalid> {
    optional_with(object, name, string)
}

fn optional_with<T>(
    object: &Map<String, Value>,
    name: &str,
    read: impl Fn(&Value) -> Option<T>,
) -> Result<Option<T>, Invalid> {
    match object.get(name) {
        None => Ok(None),
        Some(value) => read(value).map(Some).ok_or(Invalid("memory frame")),
    }
}

/// One session conclusion on the link (`MemoryConclusionWire`), its fields in the schema's order.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConclusionWire {
    pub workspace: String,
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_source: Option<String>,
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub body: String,
    pub at: String,
    pub origin: String,
}

/// What `cleanConclusion` reads of a row: where it lives and what it says.
pub struct ConclusionRow<'a> {
    pub workspace: &'a str,
    pub project: &'a str,
    pub id: &'a str,
    pub session_id: &'a str,
    pub at: &'a str,
}

impl ConclusionWire {
    /// A conclusion as it may leave or be written, from its title and body as the redactor left them (main's
    /// `redactDiagnosticsText`): the body cut to the excerpt cap, the title to the server's cut. None when nothing can
    /// be written of it: no text left, an id the server would refuse, a field past the wire's bounds.
    pub fn clean(
        row: &ConclusionRow<'_>,
        title: &str,
        body: &str,
        origin: &str,
        repository: Option<&Repository>,
    ) -> Option<ConclusionWire> {
        let body = cut_bytes(body, CONCLUSION_MAX_BYTES);
        if js_trim(body).is_empty() || row.id.is_empty() || row.id.chars().any(is_js_space) {
            return None;
        }
        let (identity, identity_source) = repository_fields(repository);
        let wire = ConclusionWire {
            workspace: row.workspace.to_owned(),
            project: row.project.to_owned(),
            identity,
            identity_source,
            id: row.id.to_owned(),
            session_id: row.session_id.to_owned(),
            title: title.chars().take(CONCLUSION_TITLE_CHARS).collect(),
            body: body.to_owned(),
            at: row.at.to_owned(),
            origin: origin.to_owned(),
        };
        wire.valid().then_some(wire)
    }

    pub fn repository(&self) -> Option<Repository> {
        wire_repository(self.identity.as_deref(), self.identity_source.as_deref())
    }

    fn valid(&self) -> bool {
        within(&self.workspace, 1, 200)
            && within(&self.project, 1, 200)
            && self
                .identity
                .as_ref()
                .is_none_or(|text| within(text, 1, 512))
            && self
                .identity_source
                .as_ref()
                .is_none_or(|text| within(text, 1, 32))
            && within(&self.id, 1, 128)
            && within(&self.session_id, 1, 64)
            && js_length(&self.title) <= 1000
            && self.body.len() <= CONCLUSION_MAX_BYTES
            && js_length(&self.at) <= 64
            && within(&self.origin, 1, 128)
    }

    /// Reads one from the other side as `MemoryConclusionWire.parse` did.
    pub fn parse(value: &Value) -> Result<ConclusionWire, Invalid> {
        let object = value.as_object().ok_or(Invalid("memory conclusion"))?;
        let wire = ConclusionWire {
            workspace: required(object, "workspace")?,
            project: required(object, "project")?,
            identity: optional(object, "identity")?,
            identity_source: optional(object, "identitySource")?,
            id: required(object, "id")?,
            session_id: required(object, "sessionId")?,
            title: required(object, "title")?,
            body: required(object, "body")?,
            at: required(object, "at")?,
            origin: required(object, "origin")?,
        };
        if wire.valid() {
            Ok(wire)
        } else {
            Err(Invalid("memory conclusion"))
        }
    }
}

/// Where a pull of pages goes on (`MemoryCursor`): the last page it examined, by the host's `updated_at` then key.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Cursor {
    pub at: String,
    pub key: String,
}

impl Cursor {
    pub fn parse(value: &Value) -> Result<Option<Cursor>, Invalid> {
        if value.is_null() {
            return Ok(None);
        }
        let object = value.as_object().ok_or(Invalid("memory cursor"))?;
        let cursor = Cursor {
            at: required(object, "at")?,
            key: required(object, "key")?,
        };
        if js_length(&cursor.at) <= 64 && js_length(&cursor.key) <= 1200 {
            Ok(Some(cursor))
        } else {
            Err(Invalid("memory cursor"))
        }
    }

    /// `compareCursor`: by time, then by key, as JavaScript compares strings.
    pub fn compare(&self, other: &Cursor) -> std::cmp::Ordering {
        js_order(&self.at, &other.at).then_with(|| js_order(&self.key, &other.key))
    }
}

/// Where a conclusion pull goes on (`MemoryConclusionCursor`): the two streams' positions and the database they
/// belong to.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ConclusionCursor {
    pub native: u64,
    pub synced: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store: Option<String>,
}

impl ConclusionCursor {
    pub fn parse(value: &Value) -> Result<ConclusionCursor, Invalid> {
        let object = value.as_object().ok_or(Invalid("conclusion cursor"))?;
        let cursor = ConclusionCursor {
            native: whole(object.get("native")).ok_or(Invalid("conclusion cursor"))?,
            synced: whole(object.get("synced")).ok_or(Invalid("conclusion cursor"))?,
            store: optional(object, "store")?,
        };
        if cursor
            .store
            .as_ref()
            .is_none_or(|store| js_length(store) <= 64)
        {
            Ok(cursor)
        } else {
            Err(Invalid("conclusion cursor"))
        }
    }

    pub fn get(&self, source: Source) -> u64 {
        match source {
            Source::Native => self.native,
            Source::Synced => self.synced,
        }
    }

    pub fn set(&mut self, source: Source, at: u64) {
        match source {
            Source::Native => self.native = at,
            Source::Synced => self.synced = at,
        }
    }
}

/// zod's `z.number().int().min(0)`.
pub fn whole(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_number()?;
    number.as_u64().or_else(|| {
        number
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= u64::MAX as f64)
            .map(|n| n as u64)
    })
}

/// A conclusion stream: what this computer captured, or what it holds from the other computers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Native,
    Synced,
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Source::Native => "native",
            Source::Synced => "synced",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize)]
    struct Captured {
        hashes: Vec<HashRow>,
        cuts: Vec<CutRow>,
        durable: Vec<DurableRow>,
        wires: Vec<WireRow>,
        conclusions: Vec<ConclusionCase>,
        keys: Vec<KeyRow>,
    }

    #[derive(Deserialize)]
    struct HashRow {
        copy: Value,
        hash: String,
    }

    #[derive(Deserialize)]
    struct CutRow {
        text: String,
        max: usize,
        out: String,
    }

    #[derive(Deserialize)]
    struct DurableRow {
        path: String,
        durable: bool,
    }

    #[derive(Deserialize)]
    struct WireRow {
        copy: Value,
        origin: String,
        at: String,
        repository: Option<Value>,
        wire: Option<Value>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ConclusionCase {
        row: Value,
        origin: String,
        repository: Option<Value>,
        redacted_title: String,
        redacted_body: String,
        wire: Option<Value>,
    }

    #[derive(Deserialize)]
    struct KeyRow {
        r#ref: Value,
        key: String,
    }

    fn captured() -> Captured {
        serde_json::from_str(include_str!("captured.json")).unwrap()
    }

    fn text(value: &Value, name: &str) -> String {
        value[name].as_str().unwrap_or_default().to_owned()
    }

    /// A captured copy as `pageCopy` answered it; a big body is written as a repeat.
    fn copy(value: &Value) -> Copy {
        let body = match &value["body"] {
            Value::String(body) => body.clone(),
            repeat => {
                let unit = repeat["repeat"].as_str().unwrap();
                let count = repeat["count"].as_u64().unwrap() as usize;
                format!("{}{}", unit.repeat(count), text(repeat, "tail"))
            }
        };
        let page = PageCopy {
            workspace: text(value, "workspace"),
            project: text(value, "project"),
            path: text(value, "path"),
            title: text(value, "title"),
            kind: value["kind"].as_str().map(str::to_owned),
            tier: text(value, "tier"),
            body,
            tags: strings(&value["tags"]).unwrap(),
            pinned: value["pinned"].as_bool().unwrap(),
            metadata: value["metadata"].as_object().cloned().unwrap(),
            origin: value["origin"].as_str().map(str::to_owned),
            expires_at: value["expiresAt"].as_str().map(str::to_owned),
            id: value["id"].as_str().map(str::to_owned),
            updated_at: value["updatedAt"].as_str().map(str::to_owned),
        };
        Copy::of(page)
    }

    fn repository(value: &Option<Value>) -> Option<Repository> {
        value.as_ref().map(|value| Repository {
            identity: text(value, "identity"),
            source: text(value, "source"),
        })
    }

    #[test]
    fn page_hashes_are_the_typescripts() {
        let rows = captured().hashes;
        assert_eq!(rows.len(), 47);
        for row in rows {
            assert_eq!(copy(&row.copy).hash(), row.hash, "{}", row.copy);
        }
    }

    #[test]
    fn hashes_what_a_page_holds_not_where_it_came_from_or_when() {
        let page = |extra: Value| {
            let mut value = json!({
                "workspace": "default", "project": "app", "path": "decisions/a.md", "title": "decisions/a.md",
                "kind": "decision", "tier": "semantic", "body": "body", "tags": [], "pinned": false, "metadata": {},
            });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            copy(&value).hash()
        };
        let plain = page(json!({}));
        let copied = json!({"origin": "win", "updatedAt": "2026-10-19T00:00:00Z", "pinned": true, "id": "v3"});
        assert_eq!(page(copied), plain);
        assert_ne!(page(json!({"body": "other"})), plain);
        assert_eq!(
            page(json!({"tags": ["b", "a"]})),
            page(json!({"tags": ["a", "b"]}))
        );
    }

    #[test]
    fn a_cut_keeps_whole_characters_as_the_typescript_did() {
        for row in captured().cuts {
            assert_eq!(cut_bytes(&row.text, row.max), row.out, "{:?}", row.text);
        }
    }

    #[test]
    fn durable_paths_are_the_typescripts() {
        for row in captured().durable {
            assert_eq!(is_durable_path(&row.path), row.durable, "{}", row.path);
        }
    }

    #[test]
    fn page_keys_are_the_typescripts() {
        for row in captured().keys {
            let key = page_key(
                &text(&row.r#ref, "workspace"),
                &text(&row.r#ref, "project"),
                &text(&row.r#ref, "path"),
            );
            assert_eq!(key, row.key);
        }
    }

    #[test]
    fn a_page_crosses_the_link_as_the_typescript_sent_it() {
        let rows = captured().wires;
        assert_eq!(rows.len(), 44);
        for row in rows {
            let copy = copy(&row.copy);
            let wire = PageWire::of(
                &copy,
                &row.origin,
                &row.at,
                repository(&row.repository).as_ref(),
            );
            match (&wire, &row.wire) {
                (None, None) => {}
                (Some(wire), Some(expected)) => {
                    let mut sent = serde_json::to_value(wire).unwrap();
                    if expected["body"].is_null() {
                        sent["body"] = Value::Null;
                    }
                    // Byte for byte, key order included.
                    assert_eq!(sent.to_string(), expected.to_string(), "{}", row.copy);
                    let parsed = PageWire::parse(&serde_json::to_value(wire).unwrap()).unwrap();
                    assert_eq!(&parsed, wire);
                }
                _ => panic!(
                    "{} → {:?}, expected {:?}",
                    row.copy,
                    wire.is_some(),
                    row.wire
                ),
            }
        }
    }

    #[test]
    fn a_conclusion_is_cleaned_as_the_typescript_cleaned_it() {
        let rows = captured().conclusions;
        assert_eq!(rows.len(), 28);
        for case in rows {
            let row = ConclusionRow {
                workspace: case.row["workspace"].as_str().unwrap(),
                project: case.row["project"].as_str().unwrap(),
                id: case.row["id"].as_str().unwrap(),
                session_id: case.row["sessionId"].as_str().unwrap(),
                at: case.row["at"].as_str().unwrap(),
            };
            let wire = ConclusionWire::clean(
                &row,
                &case.redacted_title,
                &case.redacted_body,
                &case.origin,
                repository(&case.repository).as_ref(),
            );
            let sent = wire
                .as_ref()
                .map(|wire| serde_json::to_value(wire).unwrap());
            assert_eq!(
                sent.as_ref().map(Value::to_string),
                case.wire.as_ref().map(Value::to_string),
                "{}",
                case.row
            );
            if let Some(wire) = wire {
                assert_eq!(ConclusionWire::parse(&sent.unwrap()).unwrap(), wire);
            }
        }
    }

    #[test]
    fn a_frame_that_zod_refused_is_refused() {
        let page = json!({
            "workspace": "default", "project": "app", "path": "decisions/a.md", "title": "A", "tier": "semantic",
            "body": "b", "tags": [], "pinned": false, "metadata": {}, "origin": "mac", "updatedAt": "t",
            "hash": "0".repeat(64),
        });
        assert!(PageWire::parse(&page).is_ok());
        for (field, value) in [
            ("kind", Value::Null),
            ("identity", json!("")),
            ("hash", json!("A".repeat(64))),
            ("path", json!("sessions/a.md")),
            ("pinned", json!(0)),
            ("tags", json!([1])),
            ("metadata", json!({"entities": null})),
        ] {
            let mut bad = page.clone();
            bad[field] = value;
            assert!(PageWire::parse(&bad).is_err(), "{field}");
        }
        let mut missing = page.clone();
        missing.as_object_mut().unwrap().remove("updatedAt");
        assert!(PageWire::parse(&missing).is_err());
        let mut extra = page;
        extra["unknown"] = json!(1);
        assert!(PageWire::parse(&extra).is_ok());

        assert_eq!(
            ConclusionCursor::parse(&json!({"native": 4.0, "synced": 0})).unwrap(),
            ConclusionCursor {
                native: 4,
                synced: 0,
                store: None
            }
        );
        assert!(ConclusionCursor::parse(&json!({"native": 1.5, "synced": 0})).is_err());
        assert!(ConclusionCursor::parse(&json!({"native": -1, "synced": 0})).is_err());
        assert!(
            ConclusionCursor::parse(&json!({"native": 1, "synced": 0, "store": null})).is_err()
        );
    }
}
