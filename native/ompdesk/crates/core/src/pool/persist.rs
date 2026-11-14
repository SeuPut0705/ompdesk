//! The layout a window's tabs are saved as (`tabLayoutForWindow`); restoring one is `restoreLayout` (`api.rs`).

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use super::split::{SplitNode, as_split_layout, map_split_leaves, read_remembered_splits};
use super::state::{Ctx, R};

impl Ctx {
    /// The serializable layout for the window, excluding transient run/status data. A paired device's window also
    /// names the stored sessions it views (another window owns them): after a relaunch it views them again.
    pub(super) async fn tab_layout_for_window(&self, win: i64) -> R<Value> {
        let (_, web) = self.window_facts(win).await?;
        let tabs: Vec<String> = self.with(|pool| {
            pool.entries
                .iter()
                .filter(|entry| {
                    (entry.win_id == win && !entry.owner_detached && !entry.hosted_view)
                        || (web && entry.session_file.is_some() && entry.shown_in(win))
                })
                .map(|entry| entry.tab_id.clone())
                .collect()
        });
        if tabs.is_empty() {
            return Ok(Value::Null);
        }
        let facts = self.facts(&tabs).await?;
        Ok(self.with(|pool| {
            let active = pool.active_by_window.get(&win).cloned();
            let active_index = tabs
                .iter()
                .position(|tab| Some(tab) == active.as_ref())
                .unwrap_or(0);
            let split = pool.split_by_window.get(&win).cloned();
            let remembered = Value::Array(
                pool.remembered_by_window
                    .get(&win)
                    .map(|splits| splits.iter().map(|split| split.to_value()).collect())
                    .unwrap_or_default(),
            );
            let index_of = |tab: &str| tabs.iter().position(|candidate| candidate == tab);
            let splits = read_remembered_splits(
                &remembered,
                &mut |tab| index_of(tab).map(|index| index.to_string()),
                &mut HashSet::new(),
            );
            let max_former = pool.max_former_tab_ids;
            let mut descriptors = Vec::new();
            for tab in &tabs {
                // The opener's session file, not its tab id: a relaunch gives every tab a new id.
                let opener_file = pool
                    .entry(tab)
                    .and_then(|entry| entry.opened_by.as_ref())
                    .and_then(|opener| pool.entry(opener))
                    .and_then(|opener| opener.session_file.clone())
                    .filter(|file| !file.is_empty());
                let former = {
                    let entry = pool.entry(tab).expect("a listed tab is in the pool");
                    match &entry.former {
                        Some((file, ids)) if Some(file) == entry.session_file.as_ref() => {
                            ids.clone()
                        }
                        _ => Vec::new(),
                    }
                };
                let Some(entry) = pool.entry_mut(tab) else {
                    continue;
                };
                if let Some(file) = opener_file {
                    entry.opened_by_session = Some(file);
                }
                let mut descriptor = Map::new();
                descriptor.insert("cwd".into(), facts[tab.as_str()]["cwd"].clone());
                descriptor.insert("kind".into(), Value::from(entry.kind.clone()));
                if let Some(file) = entry.session_file.as_ref().filter(|file| !file.is_empty()) {
                    descriptor.insert("sessionPath".into(), Value::from(file.clone()));
                }
                if let Some(worktree) = &entry.worktree {
                    // Ownership is this launch's only: a restored tab is an ordinary worktree tab.
                    let mut kept = Map::new();
                    for key in ["name", "branch", "baseCwd", "path"] {
                        if let Some(value) = worktree.get(key) {
                            kept.insert(key.into(), value.clone());
                        }
                    }
                    descriptor.insert("worktree".into(), Value::Object(kept));
                }
                if entry.placeholder {
                    descriptor.insert("placeholder".into(), Value::from(true));
                }
                if let Some(device) = entry.device.as_ref().filter(|device| !device.is_empty()) {
                    descriptor.insert("device".into(), Value::from(device.clone()));
                }
                // Written even when the live title is null, so a cleared title cannot survive as a stale one until
                // the tab is spawned again.
                if let Some(Some(title)) = &entry.title {
                    descriptor.insert("title".into(), Value::from(title.clone()));
                }
                if let Some(opener) = entry
                    .opened_by_session
                    .as_ref()
                    .filter(|opener| !opener.is_empty())
                {
                    descriptor.insert("openedBy".into(), Value::from(opener.clone()));
                }
                // This launch's id joins the ones before it: an agent given any of them still reaches the session.
                if entry
                    .session_file
                    .as_ref()
                    .is_some_and(|file| !file.is_empty())
                {
                    let mut ids = vec![entry.tab_id.clone()];
                    ids.extend(former);
                    ids.truncate(max_former);
                    descriptor.insert("formerIds".into(), json!(ids));
                }
                descriptors.push(Value::Object(descriptor));
            }
            let mut layout = Map::new();
            layout.insert("version".into(), Value::from(pool.layout_version));
            layout.insert("activeIndex".into(), Value::from(active_index));
            layout.insert("tabs".into(), Value::Array(descriptors));
            if let Some(split) = split {
                let mapped = map_split_leaves(&SplitNode::Split(Box::new(split)), &mut |tab| {
                    index_of(tab).map(|index| SplitNode::Leaf(index.to_string()))
                });
                if let Some(split) = as_split_layout(mapped) {
                    layout.insert("split".into(), split.to_value());
                }
            }
            if !splits.is_empty() {
                layout.insert(
                    "splits".into(),
                    Value::Array(splits.iter().map(|split| split.to_value()).collect()),
                );
            }
            Value::Object(layout)
        }))
    }
}
