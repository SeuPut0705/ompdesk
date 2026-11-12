//! A project the memory server cannot read by name (was `src/main/ai-memory/ambiguous-names.ts`): its name is also
//! another project's canonical or legacy key, so the server refuses the name as "ambiguous". Seen on 21 Oct 2026: a
//! paired computer's sync made a plain `seuput0705-ompdesk` here, then this computer's own capture of that repository
//! made `ompdesk` with the canonical key `seuput0705-ompdesk`, and every read of the first failed.
//!
//! The server's own remedy is a rename by id. Only a project no checkout ever captured into is renamed: the listing
//! skips one a repository claimed, and the server's `/admin/rename-unclaimed-project` refuses (409) one with a folder or
//! a session, checked in the rename itself; an older server without that route answers 404 and nothing is renamed. The
//! new name is `<name>-unclaimed` (`-2`, `-3`, … when taken): names only, no file moves, reversible by renaming back.

use std::collections::HashSet;

use serde::Serialize;

use super::store::Store;
use crate::aimemory::ops::ProjectRef;
use crate::server::Fault;

/// Tries before giving up on one project: names may be taken as names or as keys the listing does not show.
const NAME_TRIES: usize = 5;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RenamedProject {
    pub workspace: String,
    pub from: String,
    pub to: String,
}

/// An ambiguous name no rename took: the server's last answer, so it is said rather than left unreadable unseen.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RefusedRename {
    pub workspace: String,
    pub project: String,
    pub detail: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct NameRepair {
    pub renamed: Vec<RenamedProject>,
    pub refused: Vec<RefusedRename>,
}

fn key(workspace: &str, project: &str) -> String {
    format!("{workspace}\u{0}{project}")
}

pub async fn rename_ambiguous_projects(store: &Store) -> Result<NameRepair, Fault> {
    let listed = store.projects().await?;
    let mut taken: HashSet<String> = listed
        .iter()
        .map(|project| key(&project.workspace, &project.project))
        .collect();
    let mut repair = NameRepair::default();
    for project in &listed {
        // `_global` and the like are reserved scopes; a project a repository claimed keeps its name.
        let id = project.id.as_deref().filter(|id| !id.is_empty());
        let claimed = project
            .identity
            .as_deref()
            .is_some_and(|identity| !identity.is_empty());
        let Some(id) = id.filter(|_| !claimed && !project.project.starts_with('_')) else {
            continue;
        };
        let at = ProjectRef {
            workspace: project.workspace.clone(),
            project: project.project.clone(),
        };
        if store.name_status(&at).await? != "ambiguous" {
            continue;
        }
        let mut detail = "no free name".to_owned();
        let mut done = false;
        for n in 1..=NAME_TRIES {
            if done {
                break;
            }
            let to = if n == 1 {
                format!("{}-unclaimed", project.project)
            } else {
                format!("{}-unclaimed-{n}", project.project)
            };
            if taken.contains(&key(&project.workspace, &to)) {
                continue;
            }
            if let Err(fault) = store
                .rename_unclaimed_project(&project.workspace, id, &to)
                .await
            {
                detail = fault.message;
                continue;
            }
            taken.insert(key(&project.workspace, &to));
            repair.renamed.push(RenamedProject {
                workspace: project.workspace.clone(),
                from: project.project.clone(),
                to,
            });
            done = true;
        }
        if !done {
            repair.refused.push(RefusedRename {
                workspace: project.workspace.clone(),
                project: project.project.clone(),
                detail,
            });
        }
    }
    Ok(repair)
}
