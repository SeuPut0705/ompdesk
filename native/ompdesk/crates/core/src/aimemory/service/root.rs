//! OMPdesk's own ai-memory wiring for omp: an extension package root that the sessions OMPdesk spawns load with `-e`
//! (`<userData>/ai-memory/omp-ext/`, like `resources/omp-builtin/rea`). omp reads a package root's `index.ts` as an
//! extension, its `.mcp.json` as MCP servers and its `skills/` as skills, so the root holds exactly what
//! `ai-memory setup --agent omp` would put into omp's agent dir:
//!
//!   index.ts     `ai-memory install-hooks --agent omp --apply --config-file <root>/index.ts`
//!   .mcp.json    `ai-memory install-mcp  --client omp --apply --config-file <root>/.mcp.json`
//!   skills/      `ai-memory install-skills --target-dir <root>/skills`
//!
//! Every byte is ai-memory's own generator output, produced next to the root and swapped in only when it differs, so
//! a launch that changed nothing touches nothing (a running omp keeps its files open on Windows) and ai-memory's
//! `.bak-<timestamp>` backups never pile up inside the root. OMPdesk changes one thing: the generated MCP entry
//! (`ai-memory mcp-bridge …`) becomes the `ompdesk-memory` http entry of OMPdesk's MCP hub (main hands it over,
//! `MEMORY_HUB_ENTRY`), so no omp starts a relay or a bridge of its own. It is named `ompdesk-memory`, not the
//! generator's `ai-memory`: omp dedupes MCP servers by name and ranks the agent dir over a package root, so an
//! `ai-memory` entry the person wired there would take the name and OMPdesk's own would never mount.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};

use super::terminal::read_mcp;
use super::text::{pretty, sha256_hex};
use super::{Boxed, Failure};
use crate::disk::tree::fault as node_fault;

pub const ROOT_ENTRY: &str = "index.ts";
pub const ROOT_MCP: &str = ".mcp.json";
pub const ROOT_SKILLS: &str = "skills";
/// The root's MCP server name; the generator's own is `ai-memory`.
pub const ROOT_SERVER: &str = "ompdesk-memory";
const GENERATED_SERVER: &str = "ai-memory";
const SWAP_ATTEMPTS: u32 = 6;
const SWAP_WAIT: Duration = Duration::from_millis(250);

/// Runs `ai-memory <args>`.
pub type RunCommand<'a> = dyn Fn(Vec<String>) -> Boxed<'a, Result<Ran, Failure>> + Send + Sync + 'a;

/// What one `ai-memory <args>` came to.
pub struct Ran {
    pub ok: bool,
    pub cancelled: bool,
    pub output: String,
}

/// Every file below `dir` with a digest of its bytes, as `relative/path → sha256`.
fn digest(dir: &Path, prefix: &str, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let name = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            digest(&entry.path(), &name, out);
        } else if kind.is_file()
            && let Ok(bytes) = fs::read(entry.path())
        {
            out.insert(name, sha256_hex(&bytes));
        }
    }
}

/// The root holds all three generated parts: the extension, the memory MCP entry and at least one skill.
pub fn root_complete(root: &Path) -> bool {
    let entry = fs::metadata(root.join(ROOT_ENTRY)).is_ok_and(|meta| meta.is_file());
    let mcp = read_mcp(&root.join(ROOT_MCP)).is_some_and(|config| {
        matches!(config.get("mcpServers"), Some(Value::Object(servers)) if servers.contains_key(ROOT_SERVER))
    });
    let skills = fs::read_dir(root.join(ROOT_SKILLS)).is_ok_and(|mut names| names.next().is_some());
    entry && mcp && skills
}

/// The generated MCP entry, under OMPdesk's own server name, as the hub's memory route.
fn mount_hub(next: &Path, hub_entry: &Value) -> Result<(), Failure> {
    let file = next.join(ROOT_MCP);
    let Some(mut config) = read_mcp(&file) else {
        return Ok(());
    };
    let Some(Value::Object(servers)) = config.get("mcpServers") else {
        return Ok(());
    };
    if !servers.contains_key(GENERATED_SERVER) {
        return Ok(());
    }
    let mut mounted = Map::new();
    mounted.insert(ROOT_SERVER.to_owned(), hub_entry.clone());
    for (name, server) in servers {
        if name != GENERATED_SERVER {
            mounted.insert(name.clone(), server.clone());
        }
    }
    config.insert("mcpServers".to_owned(), Value::Object(mounted));
    fs::write(&file, pretty(&Value::Object(config)))
        .map_err(|error| Failure::step(node_fault(&error, "open", &file).message))
}

fn remove(path: &Path) -> std::io::Result<()> {
    match fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        _ => fs::remove_file(path),
    }
}

async fn replace_dir(next: &Path, root: &Path) -> Result<(), Failure> {
    let mut attempt = 1;
    loop {
        let swapped = remove(root)
            .map_err(|error| node_fault(&error, "rm", root))
            .and_then(|()| {
                fs::rename(next, root).map_err(|error| node_fault(&error, "rename", next))
            });
        match swapped {
            Ok(()) => return Ok(()),
            // Windows: an omp that just started may still hold a file of the old root for a moment.
            Err(fault) if attempt >= SWAP_ATTEMPTS => return Err(Failure::step(fault.message)),
            Err(_) => {
                attempt += 1;
                tokio::time::sleep(SWAP_WAIT).await;
            }
        }
    }
}

/// Generate the root with ai-memory's own commands and put it in place. False when a command was cancelled; a
/// failure carries the failing command's last output (`describe`) or what was left incomplete.
pub async fn generate_root<'a>(
    root: &Path,
    hub_entry: &Value,
    run: &RunCommand<'a>,
    describe: impl Fn(&str) -> String,
) -> Result<bool, Failure> {
    let next = PathBuf::from(format!("{}.next", root.to_string_lossy()));
    let generated = async {
        remove(&next).map_err(|error| Failure::step(node_fault(&error, "rm", &next).message))?;
        fs::create_dir_all(&next)
            .map_err(|error| Failure::step(node_fault(&error, "mkdir", &next).message))?;
        let at = |name: &str| next.join(name).to_string_lossy().into_owned();
        let steps: [(&str, Vec<String>); 3] = [
            (
                "install-hooks",
                vec![
                    "install-hooks".into(),
                    "--agent".into(),
                    "omp".into(),
                    "--apply".into(),
                    "--config-file".into(),
                    at(ROOT_ENTRY),
                ],
            ),
            (
                "install-mcp",
                vec![
                    "install-mcp".into(),
                    "--client".into(),
                    "omp".into(),
                    "--apply".into(),
                    "--config-file".into(),
                    at(ROOT_MCP),
                ],
            ),
            (
                "install-skills",
                vec![
                    "install-skills".into(),
                    "--target-dir".into(),
                    at(ROOT_SKILLS),
                ],
            ),
        ];
        for (name, args) in steps {
            let ran = run(args).await?;
            if ran.cancelled {
                return Ok(false);
            }
            if !ran.ok {
                let said = describe(&ran.output);
                let said = if said.is_empty() {
                    "no output".to_owned()
                } else {
                    said
                };
                return Err(Failure::step(format!("{name} failed: {said}")));
            }
        }
        // Neither command's backups nor anything else but the three parts may end up in the root.
        for entry in fs::read_dir(&next)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let name = entry.file_name();
            if ![ROOT_ENTRY, ROOT_MCP, ROOT_SKILLS].contains(&name.to_string_lossy().as_ref()) {
                let _ = remove(&entry.path());
            }
        }
        mount_hub(&next, hub_entry)?;
        if !root_complete(&next) {
            return Err(Failure::step(
                "ai-memory's generators left the extension root incomplete",
            ));
        }
        let (mut fresh, mut current) = (BTreeMap::new(), BTreeMap::new());
        digest(&next, "", &mut fresh);
        digest(root, "", &mut current);
        if fresh == current {
            return Ok(true);
        }
        if let Some(parent) = root.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| Failure::step(node_fault(&error, "mkdir", parent).message))?;
        }
        replace_dir(&next, root).await?;
        Ok(true)
    }
    .await;
    let _ = remove(&next);
    generated
}
