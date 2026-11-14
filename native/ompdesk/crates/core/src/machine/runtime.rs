use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{Environment, Platform, Service, paths};
use crate::fs::order::js_trim;

pub const MIN_OMP_VERSION: &str = "18.18.9";
const INSTALL_HINT: &str = "OMPdesk's machine setup installs the omp package on its own.";

#[derive(Clone, Debug)]
pub struct Runtime {
    pub bin: PathBuf,
    pub version: String,
    pub package_root: Option<PathBuf>,
    pub env: Environment,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Failure {
    NotFound,
    OverrideMissing {
        path: String,
    },
    CannotRun {
        bin: String,
        detail: String,
    },
    TooOld {
        version: String,
        minimum: String,
        bin: String,
    },
    Compiled {
        bin: String,
    },
    BunTooOld {
        bin: String,
        bun: String,
        bun_version: String,
        minimum: String,
    },
}

#[derive(Clone, Debug)]
pub enum Resolution {
    Ready(Runtime),
    Failed { error: String, reason: Failure },
}

fn failed(error: String, reason: Failure) -> Resolution {
    Resolution::Failed { error, reason }
}

/// First digit triplet anywhere, as parseOmpVersion's unanchored regex reads it.
pub fn parse_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if !bytes[start].is_ascii_digit() {
            continue;
        }
        let mut at = start;
        let mut valid = true;
        for part in 0..3 {
            let first = at;
            while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if first == at {
                valid = false;
                break;
            }
            if part < 2 {
                if bytes.get(at) != Some(&b'.') {
                    valid = false;
                    break;
                }
                at += 1;
            }
        }
        if valid {
            return Some(text[start..at].to_owned());
        }
    }
    None
}

pub fn is_newer(latest: &str, installed: &str) -> bool {
    crate::tailscale::version::compare(latest, installed).map_or_else(
        || js_trim(latest) != js_trim(installed),
        |order| order.is_gt(),
    )
}

fn installed_version(bin: &Path) -> Option<String> {
    let real = std::fs::canonicalize(bin).ok()?;
    let root = real.parent()?.parent()?;
    let manifest = paths::manifest(root)?;
    (manifest["name"] == "@oh-my-pi/pi-coding-agent").then_some(())?;
    parse_version(manifest["version"].as_str()?)
}

pub(super) async fn resolve(service: &Service) -> Resolution {
    let config = service.config();
    let env = service.shell_environment().await;
    let path = env.get("PATH").map_or("", String::as_str);
    let override_bin = env.get("OMP_GUI_OMP").filter(|v| !v.is_empty());
    let mut candidates = Vec::new();
    if let Some(bin) = override_bin {
        let bin = PathBuf::from(bin);
        if bin.exists() {
            candidates.push(bin);
        }
    } else {
        let names: &[&str] = if config.platform == Platform::Windows {
            &["omp.exe", "omp.cmd"]
        } else {
            &["omp"]
        };
        candidates.extend(
            path.split(config.platform.separator())
                .filter(|p| !p.is_empty())
                .flat_map(|p| names.iter().map(move |n| Path::new(p).join(n))),
        );
        if config.platform == Platform::Windows {
            candidates.push(
                env.get("USERPROFILE")
                    .filter(|p| !p.is_empty())
                    .map_or_else(|| config.home.clone(), PathBuf::from)
                    .join(".bun/bin/omp.exe"),
            );
        } else {
            candidates.extend([
                config.home.join(".bun/bin/omp"),
                PathBuf::from("/opt/homebrew/bin/omp"),
                PathBuf::from("/usr/local/bin/omp"),
            ]);
        }
        candidates.retain(|p| paths::executable(p, config.platform));
    }
    let mut compiled = None;
    let bin = candidates.into_iter().find(|p| {
        if paths::is_compiled_omp(p, config.platform) {
            if compiled.is_none() {
                compiled = Some(p.clone());
            }
            false
        } else {
            true
        }
    });
    let Some(bin) = bin else {
        return if let Some(compiled) = compiled {
            let bin = compiled.to_string_lossy().into_owned();
            failed(
                format!(
                    "omp at {bin} is a compiled build, which OMPdesk cannot load its bridge into. {INSTALL_HINT}"
                ),
                Failure::Compiled { bin },
            )
        } else if let Some(path) = override_bin {
            failed(
                format!("OMP_GUI_OMP points at a missing file ({path})."),
                Failure::OverrideMissing { path: path.clone() },
            )
        } else {
            failed(format!("omp not found. {INSTALL_HINT}"), Failure::NotFound)
        };
    };
    let package_root = paths::package_root(&bin);
    let minimum = package_root
        .as_deref()
        .and_then(paths::manifest)
        .as_ref()
        .and_then(paths::manifest_bun_minimum);
    let mut run_env = env.clone();
    paths::omp_environment(&mut run_env, &bin, &config.home, config.platform);
    if let Some(minimum) = minimum {
        let name = config.platform.exe("bun");
        if let Some(bun) = paths::find_on_path(
            &[&name],
            run_env.get("PATH").map_or("", String::as_str),
            config.platform,
            &[],
            &[],
        ) && let Ok(output) = service.probe(&bun, &["--version"], &env, 15_000).await
            && output.code == 0
            && let Some(bun_version) = parse_version(&output.text())
            && is_newer(&minimum, &bun_version)
        {
            let bin = bin.to_string_lossy().into_owned();
            let bun = bun.to_string_lossy().into_owned();
            return failed(
                format!(
                    "omp at {bin} needs Bun {minimum} or newer, but {bun} is {bun_version}. OMPdesk's machine setup upgrades Bun on its own."
                ),
                Failure::BunTooOld {
                    bin,
                    bun,
                    bun_version,
                    minimum,
                },
            );
        }
    }
    let version = match installed_version(&bin) {
        Some(version) => version,
        None => {
            let output = match service.probe(&bin, &["--version"], &run_env, 15_000).await {
                Ok(output) => output,
                Err(error) => {
                    let bin = bin.to_string_lossy().into_owned();
                    let detail = error.message;
                    return failed(
                        format!("omp at {bin} could not run: {detail}"),
                        Failure::CannotRun { bin, detail },
                    );
                }
            };
            match (output.code == 0)
                .then(|| parse_version(&output.text()))
                .flatten()
            {
                Some(version) => version,
                None => {
                    let detail = if output.stderr.is_empty() {
                        output.text()
                    } else {
                        output.stderr
                    };
                    let detail = js_trim(&detail)
                        .split('\n')
                        .next()
                        .unwrap_or_default()
                        .to_owned();
                    let bin = bin.to_string_lossy().into_owned();
                    let said = if detail.is_empty() {
                        String::new()
                    } else {
                        format!(": {detail}")
                    };
                    return failed(
                        format!("omp at {bin} failed `omp --version`{said}. {INSTALL_HINT}"),
                        Failure::CannotRun { bin, detail },
                    );
                }
            }
        }
    };
    if is_newer(MIN_OMP_VERSION, &version) {
        return failed(
            format!(
                "omp {version} is too old; this GUI needs omp {MIN_OMP_VERSION} or newer. OMPdesk updates it on its own."
            ),
            Failure::TooOld {
                version,
                minimum: MIN_OMP_VERSION.into(),
                bin: bin.to_string_lossy().into_owned(),
            },
        );
    }
    Resolution::Ready(Runtime {
        bin,
        version,
        package_root,
        env: run_env,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_the_stock_version_and_manifest_gate_without_running_omp() {
        assert_eq!(parse_version("omp/18.20.1 beta"), Some("18.20.1".into()));
        assert_eq!(parse_version("none"), None);
        for (range, expected) in [
            (">=1.4.0", Some("1.4.0")),
            ("  >= v1.3.2  ", Some("1.3.2")),
            ("^1.4.0", None),
            (">=1.4", None),
            (">=1.4.0-beta", None),
        ] {
            assert_eq!(
                paths::manifest_bun_minimum(&serde_json::json!({"engines":{"bun":range}}))
                    .as_deref(),
                expected
            );
        }
        assert!(is_newer("18.18.9", "18.18.8"));
        assert!(!is_newer("18.18.9", "18.20.0"));
    }
}
