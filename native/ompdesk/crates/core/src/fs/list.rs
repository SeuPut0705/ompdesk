//! `fs.list` (the Files panel's tree and the `@` list) and `fs.listDirs` (a paired device's folder picker).

use std::path::PathBuf;

use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use super::disk::{self, Kind};
use super::error::{Codes, IO};
use super::ignore::Ignore;
use super::order::{NameOrder, js_trim};
use crate::server::{Fault, Reply};

const LIST_DEFAULT_DEPTH: f64 = 8.0;
const LIST_MAX_DEPTH: f64 = 16.0;
/// The folder picker's bound: one level, so a huge folder cannot flood the link; its name filter reaches past it.
const LIST_DIRS_MAX_ENTRIES: usize = 2000;

/// Files one listing returns: `default` without a `maxEntries`, never more than `max`.
#[derive(Deserialize)]
pub struct FileCaps {
    default: f64,
    max: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    /// The workspace root (its `.gitignore` applies).
    root: String,
    /// The folder to walk, `root` joined with `prefix`, resolved and confined by main.
    dir: String,
    /// `dir` relative to `root`, `/`-separated, without leading or trailing `/`.
    prefix: String,
    max_depth: Option<Value>,
    max_entries: Option<Value>,
    caps: FileCaps,
    locale: String,
}

struct Node {
    name: String,
    path: String,
    dir: bool,
    children: Vec<usize>,
}

/// The tree as `FsTreeEntry[]`, serialized from the walk's arena without copying it.
struct Tree<'a> {
    nodes: &'a [Node],
    ids: &'a [usize],
}

impl Serialize for Tree<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.ids.iter().map(|&id| TreeEntry {
            nodes: self.nodes,
            node: &self.nodes[id],
        }))
    }
}

struct TreeEntry<'a> {
    nodes: &'a [Node],
    node: &'a Node,
}

impl Serialize for TreeEntry<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let node = self.node;
        let mut map = serializer.serialize_map(Some(if node.dir { 4 } else { 3 }))?;
        map.serialize_entry("name", &node.name)?;
        map.serialize_entry("path", &node.path)?;
        map.serialize_entry("kind", if node.dir { "dir" } else { "file" })?;
        if node.dir {
            map.serialize_entry(
                "children",
                &Tree {
                    nodes: self.nodes,
                    ids: &node.children,
                },
            )?;
        }
        map.end()
    }
}

#[derive(Serialize)]
struct Listing<'a> {
    entries: Tree<'a>,
    truncated: bool,
}

/// The workspace tree under `dir`: gitignore-aware, depth- and file-capped.
pub fn list(params: &ListParams) -> Result<Reply, Fault> {
    let mut ignore = Ignore::load(std::path::Path::new(&params.root));
    let max_depth = super::clamp_int(
        params.max_depth.as_ref(),
        1.0,
        LIST_MAX_DEPTH,
        LIST_DEFAULT_DEPTH,
    ) as usize;
    let max_files = super::clamp_int(
        params.max_entries.as_ref(),
        1.0,
        params.caps.max,
        params.caps.default,
    ) as usize;
    let stat = disk::stat(&params.dir).map_err(|error| error.fault(Codes::None))?;
    if !stat.is_dir() {
        return Err(Fault::new("not_a_directory", "Not a directory"));
    }
    let order = NameOrder::new(&params.locale);
    let mut walk = Walk {
        nodes: Vec::new(),
        max_files,
        file_count: 0,
        truncated: false,
    };
    let top = walk.run(&params.dir, &params.prefix, max_depth, &mut ignore, &order);
    Reply::json(&Listing {
        entries: Tree {
            nodes: &walk.nodes,
            ids: &top,
        },
        truncated: walk.truncated,
    })
}

struct Walk {
    nodes: Vec<Node>,
    max_files: usize,
    file_count: usize,
    truncated: bool,
}

/// A folder the next level reads, and where its children go (`None`: the top).
struct Pending {
    abs: PathBuf,
    rel: String,
    parent: Option<usize>,
}

impl Walk {
    /// Breadth-first: folders first, then files, each in name order. Level by level, so when the file cap stops the
    /// walk it is the deepest files that are missing, never every file of a folder that merely sorts late; every
    /// folder seen is in the tree, with the children the walk got to.
    fn run(
        &mut self,
        dir: &str,
        prefix: &str,
        max_depth: usize,
        ignore: &mut Ignore,
        order: &NameOrder,
    ) -> Vec<usize> {
        let mut top = Vec::new();
        let mut level = vec![Pending {
            abs: PathBuf::from(dir),
            rel: prefix.to_owned(),
            parent: None,
        }];
        let mut depth = 0;
        while !level.is_empty() && !self.truncated {
            let mut next = Vec::new();
            for folder in level {
                if self.truncated {
                    break;
                }
                // An unreadable folder (permissions) is skipped; the walk goes on.
                let Ok(mut entries) = disk::entries(&folder.abs) else {
                    continue;
                };
                entries.retain(|entry| entry.kind != Kind::Link);
                entries.sort_by(|a, b| order.compare(&a.name, &b.name));
                let mut files = Vec::new();
                for entry in entries {
                    let is_dir = match entry.kind {
                        Kind::Dir => true,
                        Kind::File => false,
                        _ => continue,
                    };
                    let rel = if folder.rel.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{}/{}", folder.rel, entry.name)
                    };
                    if ignore.is_ignored(&rel, is_dir) {
                        continue;
                    }
                    if is_dir {
                        let id = self.push(entry.name, rel.clone(), true);
                        self.attach(folder.parent, &mut top, id);
                        if depth < max_depth {
                            next.push(Pending {
                                abs: folder.abs.join(&entry.raw),
                                rel,
                                parent: Some(id),
                            });
                        }
                    } else if self.file_count >= self.max_files {
                        self.truncated = true;
                        break;
                    } else {
                        self.file_count += 1;
                        files.push(self.push(entry.name, rel, false));
                    }
                }
                for id in files {
                    self.attach(folder.parent, &mut top, id);
                }
            }
            level = next;
            depth += 1;
        }
        top
    }

    fn push(&mut self, name: String, path: String, dir: bool) -> usize {
        self.nodes.push(Node {
            name,
            path,
            dir,
            children: Vec::new(),
        });
        self.nodes.len() - 1
    }

    fn attach(&mut self, parent: Option<usize>, top: &mut Vec<usize>, id: usize) {
        match parent {
            Some(parent) => self.nodes[parent].children.push(id),
            None => top.push(id),
        }
    }
}

#[derive(Deserialize)]
pub struct ListDirsParams {
    /// The absolute folder, resolved by main.
    dir: String,
    query: Option<Value>,
    locale: String,
}

#[derive(Serialize)]
struct DirNames {
    names: Vec<String>,
    truncated: bool,
}

/// One level of subfolders of `dir`, hidden ones skipped, those whose name contains `query` (trimmed,
/// case-insensitive by `toLocaleLowerCase`) when one is given, in name order, at most 2000.
pub fn list_dirs(params: &ListDirsParams) -> Result<Reply, Fault> {
    let order = NameOrder::new(&params.locale);
    let needle = match &params.query {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(query)) => order.lowercase(js_trim(query)),
        Some(_) => {
            return Err(Fault::new(
                "invalid_params",
                "query?.trim is not a function",
            ));
        }
    };
    let entries = disk::read_dir(&params.dir).map_err(|error| match error.code {
        "ENOTDIR" => Fault::new("not_a_directory", "Not a directory"),
        "ENOENT" => Fault::new("file_not_found", "Directory not found"),
        // Windows answers a file listed as a folder with ERROR_DIRECTORY, which libuv's scandir reported as ENOTDIR.
        _ if std::fs::metadata(&params.dir).is_ok_and(|meta| !meta.is_dir()) => {
            Fault::new("not_a_directory", "Not a directory")
        }
        _ => Fault::new(IO, error.message),
    })?;
    let mut names: Vec<String> = entries
        .into_iter()
        .filter(|entry| {
            entry.kind == Kind::Dir
                && !entry.name.starts_with('.')
                && (needle.is_empty() || order.lowercase(&entry.name).contains(&needle))
        })
        .map(|entry| entry.name)
        .collect();
    names.sort_by(|a, b| order.compare(a, b));
    let truncated = names.len() > LIST_DIRS_MAX_ENTRIES;
    names.truncate(LIST_DIRS_MAX_ENTRIES);
    Reply::json(&DirNames { names, truncated })
}
