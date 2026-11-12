//! The stock helper's inventory of what this computer's omp has installed → one row seed per marketplace, plugin,
//! skill group and MCP server, with the method that keeps it current or the reason it is left alone. The one thing it
//! cannot know, which binary a direct MCP command resolves to, comes in as `binaries` (main resolves it along its
//! spawn PATH).
//!
//! Row keys are opaque handles, stable across scans: `marketplace:<name>`, `plugin:<id>:<scope>[:<project>]`,
//! `skill:<id>:<scope>[:<project>]`, `skill:plugin`, `skill:local`, `mcp:<name>`. A project is a short hash of its
//! folder that main hands in (`projects`), so no path is in a key; `detail` shows `user` or the folder's name.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Number;

use super::mcp::{self, McpClass, Runner, Server, command_name};
use crate::fs::order::{NameOrder, js_trim};
use crate::server::Fault;

/// The server name the built-in REA has in stock's MCP manager.
const BUILTIN_MCP_NAME: &str = "rea";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    inventory: Inventory,
    /// The built-in REA's root (a server whose source is under it is the built-in).
    rea_root: Option<String>,
    /// The built-in REA is on in this app: it is listed even though stock never reports it (it is an extension root).
    rea_enabled: bool,
    /// The REA version this OMPdesk release ships.
    rea_version: String,
    /// The row kinds in display order (`EXTENSION_KINDS`, which the page shares).
    kinds: Vec<String>,
    /// The locale main's `localeCompare` resolves.
    locale: String,
    /// Each project folder with its key (`projectHash`).
    projects: Vec<(String, String)>,
    /// The resolved binary of each direct MCP command, by server name; null when it resolves to nothing.
    binaries: Vec<(String, Option<Binary>)>,
}

/// The stock helper's `HelperInventory`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Inventory {
    marketplaces: Vec<Marketplace>,
    plugins: Vec<Plugin>,
    registry_skills: Vec<Skill>,
    /// Skills a plugin provides.
    plugin_skills: Option<Number>,
    /// Skills from plain local files with no source recorded.
    local_skills: Option<Number>,
    mcp_servers: Vec<Server>,
}

#[derive(Deserialize)]
struct Marketplace {
    name: String,
    source: String,
}

#[derive(Deserialize)]
struct Plugin {
    channel: String,
    id: String,
    scope: String,
    cwd: Option<String>,
    installed: Option<String>,
}

#[derive(Deserialize)]
struct Skill {
    id: String,
    scope: String,
    cwd: Option<String>,
    range: Option<String>,
    installed: Option<String>,
}

/// What main found of a direct command's binary (`McpBinary`); only what a row shows is read.
#[derive(Deserialize)]
struct Binary {
    owner: Option<Owner>,
    skip: Option<String>,
    installed: Option<String>,
}

#[derive(Deserialize)]
struct Owner {
    method: String,
    name: Option<String>,
}

/// The fields of a row that classification decides; main adds the live ones (latest, phase, last…).
#[derive(Serialize)]
struct Row {
    key: String,
    kind: &'static str,
    name: String,
    detail: Option<String>,
    count: Option<Number>,
    installed: Option<String>,
    method: Option<Cow<'static, str>>,
    skip: Option<Cow<'static, str>>,
}

#[derive(Serialize)]
struct Selector {
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    id: String,
    scope: String,
    cwd: Option<String>,
}

/// What a check or update of the row acts on.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Target {
    None,
    Marketplace {
        name: String,
    },
    Plugin {
        selector: Selector,
    },
    Skill {
        selector: Selector,
    },
    /// A pinned runner package: checked against its registry, never changed.
    Runner {
        runner: McpClass,
    },
    /// A direct command's binary, updated by its owner; main joins the binary it resolved.
    Binary {
        command: String,
    },
}

#[derive(Serialize)]
pub struct Seed {
    row: Row,
    target: Target,
}

const MARKETPLACE: &str = "marketplace";
const PLUGIN: &str = "plugin";
const SKILL: &str = "skill";
const MCP: &str = "mcp";

/// An exact version (`1.2.3`, `v1.2.3-beta.1`), as opposed to a range or a dist-tag.
pub fn is_exact_version(spec: &str) -> bool {
    fn digits(text: &str) -> Option<&str> {
        let rest = text.trim_start_matches(|c: char| c.is_ascii_digit());
        (rest.len() < text.len()).then_some(rest)
    }
    /// `-beta.1` or `+build.5` after `sign`.
    fn tag(text: &str, sign: char) -> Option<&str> {
        let rest = text
            .strip_prefix(sign)?
            .trim_start_matches(|c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
        (rest.len() + 1 < text.len()).then_some(rest)
    }
    let spec = js_trim(spec);
    let spec = spec.strip_prefix('v').unwrap_or(spec);
    let core = || {
        let minor = digits(spec)?.strip_prefix('.')?;
        let patch = digits(minor)?.strip_prefix('.')?;
        digits(patch)
    };
    let Some(rest) = core() else {
        return false;
    };
    let rest = tag(rest, '-').unwrap_or(rest);
    tag(rest, '+').unwrap_or(rest).is_empty()
}

struct Projects(HashMap<String, String>);

impl Projects {
    /// `user`, or `project:<key>` for a project's folder.
    fn scope_key(&self, scope: &str, cwd: Option<&str>) -> Result<String, Fault> {
        let Some(cwd) = cwd.filter(|cwd| scope == "project" && !cwd.is_empty()) else {
            return Ok(scope.to_owned());
        };
        let key = self
            .0
            .get(cwd)
            .ok_or_else(|| Fault::new("invalid_params", "A project folder came without its key"))?;
        Ok(format!("{scope}:{key}"))
    }
}

/// `user`, or the project folder's name.
fn scope_detail(scope: &str, cwd: Option<&str>) -> String {
    let Some(cwd) = cwd.filter(|cwd| scope != "user" && !cwd.is_empty()) else {
        return "user".to_owned();
    };
    let name = cwd
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default();
    if name.is_empty() { cwd } else { name }.to_owned()
}

fn runner_method(runner: Runner) -> &'static str {
    match runner {
        Runner::Npx | Runner::PnpmDlx | Runner::NpmExec => "npm",
        Runner::Bunx | Runner::BunX => "bun",
        Runner::Uvx | Runner::UvToolRun => "uv",
        Runner::PipxRun => "pipx",
    }
}

fn plugin_method(channel: &str) -> Option<&'static str> {
    match channel {
        "marketplace" => Some("marketplace"),
        "npm" => Some("npm-plugin"),
        "git" => Some("git-plugin"),
        _ => None,
    }
}

fn mcp_row(name: &str) -> Row {
    Row {
        key: format!("mcp:{name}"),
        kind: MCP,
        name: name.to_owned(),
        detail: None,
        count: None,
        installed: None,
        method: None,
        skip: None,
    }
}

fn mcp_seed(
    server: Server,
    rea_root: Option<&str>,
    rea_version: &str,
    binaries: &HashMap<String, Option<Binary>>,
) -> Seed {
    let mut row = mcp_row(&server.name);
    let target = match mcp::classify(&server, rea_root) {
        McpClass::Builtin => {
            row.installed = Some(rea_version.to_owned());
            row.skip = Some("builtin".into());
            Target::None
        }
        // The URL can carry a token: it is never shown.
        McpClass::Remote => {
            row.skip = Some("remote".into());
            Target::None
        }
        McpClass::Unsupported => {
            row.detail = server
                .command
                .as_deref()
                .filter(|command| !command.is_empty())
                .map(command_name);
            row.skip = Some("unknown-install".into());
            Target::None
        }
        McpClass::Runner(package) => {
            row.detail = Some(package.spec.clone());
            if !package.pinned {
                row.skip = Some("follows-latest".into());
                Target::None
            } else {
                row.installed = package
                    .version
                    .clone()
                    .filter(|version| !version.is_empty() && is_exact_version(version));
                row.method = Some(runner_method(package.runner).into());
                row.skip = Some("pinned".into());
                if server.enabled && package.checkable {
                    Target::Runner {
                        runner: McpClass::Runner(package),
                    }
                } else {
                    Target::None
                }
            }
        }
        McpClass::Direct { command } => {
            let name = command_name(&command);
            match binaries.get(&server.name).and_then(Option::as_ref) {
                None => {
                    row.detail = Some(name);
                    row.skip = Some("unknown-install".into());
                    Target::None
                }
                Some(binary) => {
                    row.installed = binary.installed.clone();
                    match &binary.owner {
                        None => {
                            row.detail = Some(name);
                            row.skip = Some(
                                binary
                                    .skip
                                    .clone()
                                    .map_or("unknown-install".into(), Cow::Owned),
                            );
                            Target::None
                        }
                        Some(owner) => {
                            row.detail = Some(owner.name.clone().unwrap_or(name));
                            row.method = Some(owner.method.clone().into());
                            if server.enabled {
                                Target::Binary { command }
                            } else {
                                Target::None
                            }
                        }
                    }
                }
            }
        }
    };
    Seed { row, target }
}

/// A grouped row: skills that have no version of their own.
fn skill_group(name: &'static str, count: Number, skip: &'static str) -> Seed {
    Seed {
        row: Row {
            key: format!("skill:{name}"),
            kind: SKILL,
            name: name.to_owned(),
            detail: None,
            count: Some(count),
            installed: None,
            method: None,
            skip: Some(skip.into()),
        },
        target: Target::None,
    }
}

fn positive(count: Option<Number>) -> Option<Number> {
    count.filter(|count| count.as_f64().is_some_and(|count| count > 0.0))
}

pub fn seeds(params: Params) -> Result<Vec<Seed>, Fault> {
    let Params {
        inventory,
        rea_root,
        rea_enabled,
        rea_version,
        kinds,
        locale,
        projects,
        binaries,
    } = params;
    let projects = Projects(projects.into_iter().collect());
    let binaries: HashMap<_, _> = binaries.into_iter().collect();
    let mut seeds = Vec::new();

    for marketplace in inventory.marketplaces {
        seeds.push(Seed {
            row: Row {
                key: format!("marketplace:{}", marketplace.name),
                kind: MARKETPLACE,
                name: marketplace.name.clone(),
                detail: Some(marketplace.source),
                count: None,
                installed: None,
                method: Some("catalog".into()),
                skip: None,
            },
            target: Target::Marketplace {
                name: marketplace.name,
            },
        });
    }

    for plugin in inventory.plugins {
        let cwd = plugin.cwd.as_deref();
        let linked = plugin.channel == "linked";
        seeds.push(Seed {
            row: Row {
                key: format!(
                    "plugin:{}:{}",
                    plugin.id,
                    projects.scope_key(&plugin.scope, cwd)?
                ),
                kind: PLUGIN,
                name: plugin.id.clone(),
                detail: Some(scope_detail(&plugin.scope, cwd)),
                count: None,
                installed: plugin.installed,
                method: if linked {
                    None
                } else {
                    plugin_method(&plugin.channel).map(Cow::Borrowed)
                },
                skip: linked.then_some("linked".into()),
            },
            target: if linked {
                Target::None
            } else {
                Target::Plugin {
                    selector: Selector {
                        channel: Some(plugin.channel),
                        id: plugin.id,
                        scope: plugin.scope,
                        cwd: plugin.cwd,
                    },
                }
            },
        });
    }

    for skill in inventory.registry_skills {
        let cwd = skill.cwd.as_deref();
        // An exact manifest range is the user's pin; the check still shows a newer version.
        let pinned = skill
            .range
            .as_deref()
            .is_some_and(|range| !range.is_empty() && is_exact_version(range));
        seeds.push(Seed {
            row: Row {
                key: format!(
                    "skill:{}:{}",
                    skill.id,
                    projects.scope_key(&skill.scope, cwd)?
                ),
                kind: SKILL,
                name: skill.id.clone(),
                detail: Some(scope_detail(&skill.scope, cwd)),
                count: None,
                installed: skill.installed,
                method: Some("registry".into()),
                skip: pinned.then_some("pinned".into()),
            },
            target: Target::Skill {
                selector: Selector {
                    channel: None,
                    id: skill.id,
                    scope: skill.scope,
                    cwd: skill.cwd,
                },
            },
        });
    }
    if let Some(count) = positive(inventory.plugin_skills) {
        seeds.push(skill_group("plugin", count, "follows-plugin"));
    }
    if let Some(count) = positive(inventory.local_skills) {
        seeds.push(skill_group("local", count, "local"));
    }

    let mut builtin_listed = false;
    for server in inventory.mcp_servers {
        builtin_listed |= server.name == BUILTIN_MCP_NAME;
        seeds.push(mcp_seed(
            server,
            rea_root.as_deref(),
            &rea_version,
            &binaries,
        ));
    }
    if rea_enabled && !builtin_listed {
        let mut row = mcp_row(BUILTIN_MCP_NAME);
        row.installed = Some(rea_version);
        row.skip = Some("builtin".into());
        seeds.push(Seed {
            row,
            target: Target::None,
        });
    }

    // The first seed of a key stands; then kinds in display order, names and keys as `localeCompare` orders them.
    let mut seen = HashSet::new();
    seeds.retain(|seed| seen.insert(seed.row.key.clone()));
    let order = NameOrder::text(&locale);
    let rank = |kind: &str| kinds.iter().position(|listed| listed == kind);
    seeds.sort_by(|a, b| {
        rank(a.row.kind)
            .cmp(&rank(b.row.kind))
            .then_with(|| order.compare(&a.row.name, &b.row.name))
            .then_with(|| order.compare(&a.row.key, &b.row.key))
    });
    Ok(seeds)
}

#[cfg(test)]
mod tests {
    use super::super::captured;
    use super::*;

    #[test]
    fn tells_exact_versions_as_the_typescript_did() {
        for row in captured("exact") {
            let spec = row[0].as_str().unwrap();
            assert_eq!(
                is_exact_version(spec),
                row[1].as_bool().unwrap(),
                "{spec:?}"
            );
        }
    }

    #[test]
    fn seeds_rows_as_the_typescript_did() {
        for (at, row) in captured("seeds").into_iter().enumerate() {
            let params: Params = serde_json::from_value(row[0].clone()).unwrap();
            let seeds = seeds(params).unwrap();
            assert_eq!(serde_json::to_value(seeds).unwrap(), row[1], "case {at}");
        }
    }

    /// What `names.sort(new Intl.Collator(locale).compare)` gave in node 24, per locale.
    #[test]
    fn orders_names_as_locale_compare_did() {
        for row in captured("order") {
            let order = NameOrder::text(row[0].as_str().unwrap());
            let mut names: Vec<&str> = row[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect();
            names.sort_by(|a, b| order.compare(a, b));
            let expected: Vec<&str> = row[2]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect();
            assert_eq!(names, expected, "{}", row[0]);
        }
    }

    #[test]
    fn refuses_a_project_folder_without_its_key() {
        let params: Params = serde_json::from_value(serde_json::json!({
            "inventory": {
                "marketplaces": [],
                "plugins": [{ "channel": "npm", "id": "p", "scope": "project", "cwd": "/w", "installed": null }],
                "registrySkills": [],
                "pluginSkills": 0,
                "localSkills": 0,
                "mcpServers": [],
            },
            "reaRoot": null,
            "reaEnabled": false,
            "reaVersion": "1.0.0",
            "kinds": [],
            "locale": "en-US",
            "projects": [],
            "binaries": [],
        }))
        .unwrap();
        assert_eq!(seeds(params).err().unwrap().code, "invalid_params");
    }
}
