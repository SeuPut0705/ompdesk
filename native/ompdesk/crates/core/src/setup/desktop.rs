use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::Path;

use super::types::{Environment, Platform, Presence};
use crate::run::{Exec, Opts, Runner};
use crate::server::Scope;

const MINIMUM: &str = "1.2.0";

fn newer(latest: &str, installed: &str) -> bool {
    crate::tailscale::version::compare(latest, installed).map_or_else(
        || latest.trim() != installed.trim(),
        |order| order == Ordering::Greater,
    )
}

fn bundled(platform: Platform, folder: &Path) -> Option<(String, String)> {
    let executable = folder.join(if platform == Platform::Win32 {
        "agent-desktop.exe"
    } else {
        "agent-desktop"
    });
    let bytes = std::fs::read(folder.join("agent-desktop.build.json")).ok()?;
    let record: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let version = record.get("version")?.as_str()?;
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3
        || !parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        || !executable.exists()
    {
        return None;
    }
    Some((
        executable.to_string_lossy().into_owned(),
        version.to_owned(),
    ))
}

/// Only the app-owned managed copy and its shipped fallback count, never a PATH/npm copy.
pub async fn detect_agent_desktop(
    platform: Platform,
    tools_dir: &Path,
    bundle: Option<&Path>,
    env: &Environment,
) -> Presence {
    if platform == Platform::Other {
        return Presence::Missing;
    }
    let exe = tools_dir
        .join("agent-desktop")
        .join(if platform == Platform::Win32 {
            "agent-desktop.exe"
        } else {
            "agent-desktop"
        });
    let path = exe.to_string_lossy().into_owned();
    let managed = if !exe.exists() {
        Presence::Missing
    } else {
        let runner = Runner {
            bin: path.clone(),
            args: Vec::new(),
            env: env.clone(),
            timeout_ms: 15_000,
            max_bytes: 1024 * 1024,
        };
        let result = Exec::new(runner, Scope::detached(), "agent_desktop")
            .run(
                &tools_dir.to_string_lossy(),
                &["--version"],
                Opts::default(),
            )
            .await;
        match result {
            Ok(output) if output.code == 0 => match crate::machine::parse_version(&output.text()) {
                Some(version) if newer(MINIMUM, &version) => Presence::Outdated {
                    version,
                    minimum: MINIMUM.to_owned(),
                    path: Some(path.clone()),
                },
                Some(version) => Presence::Present {
                    version: Some(version),
                    path: Some(path.clone()),
                    extra: BTreeMap::new(),
                },
                None => Presence::Broken {
                    detail: "agent-desktop printed no version".to_owned(),
                    path: Some(path.clone()),
                },
            },
            Ok(output) => Presence::Broken {
                detail: if output.stderr.trim().is_empty() {
                    format!("agent-desktop --version exited with code {}", output.code)
                } else {
                    output.stderr.trim().to_owned()
                },
                path: Some(path.clone()),
            },
            Err(fault) => Presence::Broken {
                detail: fault.message,
                path: Some(path.clone()),
            },
        }
    };
    let bundled = bundle.and_then(|folder| bundled(platform, folder));
    if let Presence::Present {
        version: Some(version),
        ..
    } = &managed
        && bundled
            .as_ref()
            .is_none_or(|(_, bundled)| !newer(bundled, version))
    {
        return managed;
    }
    match bundled {
        Some((path, version)) => Presence::Present {
            version: Some(version),
            path: Some(path),
            extra: BTreeMap::new(),
        },
        None => managed,
    }
}
