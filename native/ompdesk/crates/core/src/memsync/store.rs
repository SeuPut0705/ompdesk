//! This computer's memory server as the sync reads and writes it: the core's own client (`aimemory`), one request per
//! question as main's `AiMemoryClient` asked it (the token is read again for each), the durable pages by key, how
//! this server names each repository's project, and a conclusion stream read from a cursor.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Number;

use super::wire::{Copy, PageWire, Source, is_durable_path, page_key};
use crate::aimemory::client::{Client, Server};
use crate::aimemory::ops::{
    ConclusionInput, Conclusions, CopyInput, PageAt, PageRef, Project, ProjectRef, Repository,
};
use crate::server::Fault;

#[derive(Clone)]
pub struct Store {
    server: Arc<Server>,
}

impl Store {
    pub fn new(server: Server) -> Store {
        Store {
            server: Arc::new(server),
        }
    }

    fn client(&self) -> Arc<Client> {
        Client::new(Server::clone(&self.server))
    }

    pub async fn projects(&self) -> Result<Vec<Project>, Fault> {
        self.client().projects().await
    }

    /// Every latest page, expired ones too: a retired page must cross as retired, never be missed and re-created.
    pub async fn all_pages(&self, project: &ProjectRef) -> Result<Vec<PageRef>, Fault> {
        self.client().all_pages(project).await
    }

    pub async fn page_copy(&self, at: &PageAt) -> Result<Copy, Fault> {
        Ok(Copy::of(self.client().page_copy(at).await?))
    }

    /// Only over the version `expected` (a `page_copy` id) or, with none, only where nothing is; false: it moved on.
    pub async fn write_page_copy(
        &self,
        page: &PageWire,
        origin: Option<&str>,
        expected: Option<&str>,
    ) -> Result<bool, Fault> {
        let copy = CopyInput {
            title: page.title.clone(),
            kind: page.kind.clone(),
            tier: page.tier.clone(),
            body: page.body.clone(),
            tags: page.tags.clone(),
            pinned: page.pinned,
            metadata: page.metadata.to_map(),
            expires_at: page.expires_at.clone(),
            repository: page.repository(),
        };
        self.client()
            .write_page_copy(
                &at(&page.workspace, &page.project, &page.path),
                &copy,
                origin,
                expected,
            )
            .await
    }

    pub async fn conclusions(
        &self,
        source: Source,
        after: u64,
        limit: u64,
    ) -> Result<Conclusions, Fault> {
        self.client()
            .conclusions(source.name(), &Number::from(after), &Number::from(limit))
            .await
    }

    /// Insert-if-absent under `origin`, a status per item in order.
    pub async fn write_conclusions(
        &self,
        project: &ProjectRef,
        origin: &str,
        items: &[ConclusionInput],
        repository: Option<&Repository>,
    ) -> Result<Vec<String>, Fault> {
        self.client()
            .write_conclusions(project, origin, items, repository)
            .await
    }
}

pub fn at(workspace: &str, project: &str, path: &str) -> PageAt {
    PageAt {
        project: ProjectRef {
            workspace: workspace.to_owned(),
            project: project.to_owned(),
        },
        path: path.to_owned(),
    }
}

/// A seq, next or last the server wrote, as a position.
pub fn position(number: &Number) -> u64 {
    number.as_u64().unwrap_or_else(|| {
        number
            .as_f64()
            .filter(|n| *n >= 0.0)
            .map_or(0, |n| n as u64)
    })
}

/// One durable page of this server.
pub struct Entry {
    pub key: String,
    pub at_ref: PageAt,
    /// The page's `updated_at` on this server ("" when it reports none).
    pub at: String,
}

/// This server's durable pages, in the order the server listed them, by key.
#[derive(Default)]
pub struct Index {
    pub entries: Vec<Entry>,
    by_key: HashMap<String, usize>,
}

impl Index {
    pub async fn read(store: &Store) -> Result<Index, Fault> {
        let mut index = Index::default();
        for project in store.projects().await? {
            let at_project = ProjectRef {
                workspace: project.workspace.clone(),
                project: project.project.clone(),
            };
            for page in store.all_pages(&at_project).await? {
                if !is_durable_path(&page.path) {
                    continue;
                }
                let key = page_key(&page.workspace, &page.project, &page.path);
                let entry = Entry {
                    key: key.clone(),
                    at_ref: at(&page.workspace, &page.project, &page.path),
                    at: page.updated_at.clone().unwrap_or_default(),
                };
                match index.by_key.get(&key) {
                    Some(&at) => index.entries[at] = entry,
                    None => {
                        index.by_key.insert(key, index.entries.len());
                        index.entries.push(entry);
                    }
                }
            }
        }
        Ok(index)
    }

    pub fn get(&self, key: &str) -> Option<&Entry> {
        self.by_key.get(key).map(|&at| &self.entries[at])
    }

    pub fn has(&self, key: &str) -> bool {
        self.by_key.contains_key(key)
    }
}

/// How this server names each repository's project. Two computers may name one repository differently (the paired
/// Windows host's path-style `seuput0705-ompdesk`, this Mac's `ompdesk`); a page or a conclusion carries its project's
/// repository identity and is filed under this computer's project for that repository. Without an identity on the
/// item, or a project here that holds it, the name stands, as before identities crossed.
#[derive(Default)]
pub struct ProjectNames {
    repository_of: HashMap<String, Repository>,
    name_of: HashMap<String, String>,
}

/// The place an item names: its workspace, project and repository identity.
pub trait Located {
    fn workspace(&self) -> &str;
    fn project(&self) -> &str;
    fn identity(&self) -> Option<&str>;
    fn set_project(&mut self, project: String);
}

impl ProjectNames {
    pub async fn read(store: &Store) -> Result<ProjectNames, Fault> {
        let mut names = ProjectNames::default();
        names.refresh(store).await?;
        Ok(names)
    }

    /// Read the server's projects again (a write may just have made a repository's project).
    pub async fn refresh(&mut self, store: &Store) -> Result<(), Fault> {
        self.repository_of.clear();
        self.name_of.clear();
        for project in store.projects().await? {
            let Some(identity) = project.identity.filter(|identity| !identity.is_empty()) else {
                continue;
            };
            self.repository_of.insert(
                format!("{}\u{0}{}", project.workspace, project.project),
                Repository {
                    identity: identity.clone(),
                    source: project.identity_source.unwrap_or_default(),
                },
            );
            self.name_of
                .entry(format!("{}\u{0}{}", project.workspace, identity))
                .or_insert(project.project);
        }
        Ok(())
    }

    /// The repository the project of that name here was claimed by.
    pub fn repository_of(&self, workspace: &str, project: &str) -> Option<&Repository> {
        self.repository_of
            .get(&format!("{workspace}\u{0}{project}"))
    }

    /// The project an item lives in here: this computer's name for its repository's project; none when the item
    /// names a repository and the project here of the same name belongs to another (the same `owner/repo` on another
    /// forge): it is never filed there. An item without an identity, or whose name holds no repository here, keeps
    /// the name.
    fn local_project(&self, item: &impl Located) -> Option<String> {
        let Some(identity) = item.identity().filter(|identity| !identity.is_empty()) else {
            return Some(item.project().to_owned());
        };
        if let Some(local) = self
            .name_of
            .get(&format!("{}\u{0}{identity}", item.workspace()))
        {
            return Some(local.clone());
        }
        match self.repository_of(item.workspace(), item.project()) {
            Some(held) if held.identity != identity => None,
            _ => Some(item.project().to_owned()),
        }
    }

    /// The item under this computer's name for its repository's project (`localize`).
    pub fn localize<T: Located>(&self, mut item: T) -> Option<T> {
        let project = self.local_project(&item)?;
        if project != item.project() {
            item.set_project(project);
        }
        Some(item)
    }

    /// Where an item written with its repository lives now. A write that made the repository's project here names it
    /// as this server does (path style: `acme-api`), not as the sender did (`team-notes`), so a repository this
    /// computer did not know is looked up again after the write.
    pub async fn landed<T: Located + Clone>(
        &mut self,
        store: &Store,
        item: &T,
    ) -> Result<T, Fault> {
        let Some(identity) = item.identity().filter(|identity| !identity.is_empty()) else {
            return Ok(item.clone());
        };
        if self
            .name_of
            .contains_key(&format!("{}\u{0}{identity}", item.workspace()))
        {
            return Ok(item.clone());
        }
        self.refresh(store).await?;
        let mut landed = item.clone();
        if let Some(project) = self.local_project(item) {
            landed.set_project(project);
        }
        Ok(landed)
    }
}

impl Located for PageWire {
    fn workspace(&self) -> &str {
        &self.workspace
    }
    fn project(&self) -> &str {
        &self.project
    }
    fn identity(&self) -> Option<&str> {
        self.identity.as_deref()
    }
    fn set_project(&mut self, project: String) {
        self.project = project;
    }
}

impl Located for super::wire::ConclusionWire {
    fn workspace(&self) -> &str {
        &self.workspace
    }
    fn project(&self) -> &str {
        &self.project
    }
    fn identity(&self) -> Option<&str> {
        self.identity.as_deref()
    }
    fn set_project(&mut self, project: String) {
        self.project = project;
    }
}

/// A page of a conclusion stream from the cursor `after`, read from the database `known`.
#[derive(Serialize)]
pub struct StreamPage {
    pub page: Conclusions,
    pub after: u64,
}

/// A page of a conclusion stream from the cursor `after`, which was read from the database `known`. Seqs restart in a
/// fresh database (delete all memory) and a restored backup rewinds them, so a cursor is good only for the store it
/// came from and while it is not past the stream's end; otherwise the page is read from 0 (`after: 0`). Offering rows
/// again is safe: a server answers `same` to a conclusion it holds.
pub async fn read_conclusions(
    store: &Store,
    source: Source,
    after: u64,
    known: Option<&str>,
    limit: u64,
) -> Result<StreamPage, Fault> {
    let page = store.conclusions(source, after, limit).await?;
    if after == 0 || (known == Some(page.store.as_str()) && after <= position(&page.last)) {
        return Ok(StreamPage { page, after });
    }
    Ok(StreamPage {
        page: store.conclusions(source, 0, limit).await?,
        after: 0,
    })
}
