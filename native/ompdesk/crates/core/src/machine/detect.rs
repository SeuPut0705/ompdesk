use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use super::{
    Environment, Failure, Platform, REA_NODE_REQUIREMENT, Resolution, Service, paths,
    rea_node_supported, runtime,
};
use crate::fs::order::js_trim;
use crate::server::Fault;
use crate::setup::types::{Detection, Item, Platform as SetupPlatform, Presence};

fn present(path: Option<String>, version: Option<String>) -> Presence {
    Presence::Present {
        version,
        path,
        extra: BTreeMap::new(),
    }
}
fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl From<Platform> for SetupPlatform {
    fn from(platform: Platform) -> Self {
        match platform {
            Platform::Mac => Self::Darwin,
            Platform::Windows => Self::Win32,
            Platform::Other => Self::Other,
        }
    }
}

impl Service {
    async fn version_of(&self, bin: &Path, env: &Environment) -> Presence {
        match self.probe(bin, &["--version"], env, 15_000).await {
            Ok(output) if output.code == 0 => {
                present(Some(path_text(bin)), runtime::parse_version(&output.text()))
            }
            Ok(output) => Presence::Broken {
                path: Some(path_text(bin)),
                detail: js_trim(&output.stderr)
                    .split('\n')
                    .next()
                    .unwrap_or_default()
                    .to_owned(),
            },
            Err(error) => Presence::Broken {
                path: Some(path_text(bin)),
                detail: error.message,
            },
        }
    }

    async fn detect_git(&self, env: &Environment) -> Presence {
        let platform = self.config.platform;
        let path = env.get("PATH").map_or("", String::as_str);
        if platform == Platform::Windows {
            let Some(bash) = paths::find_git_bash(env) else {
                return Presence::Missing;
            };
            let Some(root) = bash.parent().and_then(Path::parent) else {
                return Presence::Missing;
            };
            let git = root.join("cmd/git.exe");
            let mut found = if git.exists() {
                self.version_of(&git, env).await
            } else {
                present(Some(path_text(root)), None)
            };
            if let Presence::Present { path, extra, .. } = &mut found {
                *path = Some(path_text(root));
                let sh = root.join("usr/bin/sh.exe");
                if sh.exists() {
                    let problem = match self
                        .probe(&sh, &["-c", "/usr/bin/true; exit"], env, 30_000)
                        .await
                    {
                        Ok(output) => git_shell_problem(
                            Some(output.code),
                            &format!("{}{}", output.text(), output.stderr),
                        ),
                        Err(error) => git_shell_problem(None, &error.message),
                    };
                    if let Some(problem) = problem {
                        extra.insert("gitShell".into(), problem);
                    }
                    let key = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\sh.exe";
                    if let Ok(output) = self
                        .probe(Path::new("reg.exe"), &["query", key, "/s"], env, 15_000)
                        .await
                        && output.code == 0
                        && crate::setup::git_aslr::git_aslr_overridden(
                            &output.text(),
                            &root.to_string_lossy(),
                        )
                    {
                        extra.insert("gitAslrOverride".into(), Value::Bool(true));
                    }
                }
            }
            return found;
        }
        if let Some(git) = paths::find_on_path(
            &["git"],
            path,
            platform,
            &[],
            &[PathBuf::from("/usr/bin/git")],
        ) {
            return self.version_of(&git, env).await;
        }
        if platform != Platform::Mac {
            return Presence::Missing;
        }
        // Never trigger Apple's CLT install dialog merely by asking whether Git exists.
        if !self
            .probe(Path::new("/usr/bin/xcode-select"), &["-p"], env, 15_000)
            .await
            .is_ok_and(|o| o.code == 0)
        {
            return Presence::Missing;
        }
        self.version_of(Path::new("/usr/bin/git"), env).await
    }

    async fn detect_tailscale(&self, env: &Environment) -> Presence {
        use crate::tailscale::locate;
        let platform = match self.config.platform {
            Platform::Mac => locate::Platform::Darwin,
            Platform::Windows => locate::Platform::Win32,
            Platform::Other => return Presence::Missing,
        };
        let found = locate::find(
            &locate::Machine(platform),
            &locate::Inputs {
                platform,
                forced: env.get("OMP_GUI_TAILSCALE").map(String::as_str),
                pref: None,
                program_files: [
                    env.get("ProgramFiles").map(String::as_str),
                    env.get("ProgramFiles(x86)").map(String::as_str),
                ],
                path_env: env.get("PATH").map_or("", String::as_str),
            },
        );
        let Some(found) = found else {
            return Presence::Missing;
        };
        let mut env = env.clone();
        if found.app.is_some() {
            env.insert("TAILSCALE_BE_CLI".into(), "1".into());
        }
        let version = self
            .probe(Path::new(&found.path), &["version"], &env, 15_000)
            .await
            .ok()
            .filter(|o| o.code == 0)
            .and_then(|o| runtime::parse_version(o.text().split('\n').next().unwrap_or_default()));
        present(Some(found.path), version)
    }

    /// One canonical machine setup observation, using the same omp resolution every session/helper sees.
    pub async fn detect(self: &Arc<Self>) -> Result<Detection, Fault> {
        if self.detected.swap(true, Ordering::SeqCst) {
            self.refresh().await?;
        }
        self.rea.lock().await.reset();
        let env = self.shell_environment().await;
        let platform = self.config.platform;
        let path = env.get("PATH").map_or("", String::as_str);
        let bun = self.bun().await?;
        let brew = (platform != Platform::Windows)
            .then(|| {
                paths::find_on_path(
                    &["brew"],
                    path,
                    platform,
                    &[
                        PathBuf::from("/opt/homebrew/bin/brew"),
                        PathBuf::from("/usr/local/bin/brew"),
                    ],
                    &[],
                )
            })
            .flatten();
        let winget = if platform == Platform::Windows {
            let extra = env
                .get("LOCALAPPDATA")
                .map(|root| Path::new(root).join("Microsoft/WindowsApps/winget.exe"))
                .into_iter()
                .collect::<Vec<_>>();
            paths::find_on_path(&["winget.exe"], path, platform, &extra, &[])
        } else {
            None
        };
        let gh_name = platform.exe("gh");
        let extra = if platform == Platform::Windows {
            Vec::new()
        } else {
            env.get("OMP_GUI_TEST_BREW_DIRS").map_or_else(
                || {
                    vec![
                        PathBuf::from("/opt/homebrew/bin/gh"),
                        PathBuf::from("/usr/local/bin/gh"),
                    ]
                },
                |value| {
                    value
                        .split(platform.separator())
                        .filter(|p| !p.is_empty())
                        .map(|p| Path::new(p).join("gh"))
                        .collect()
                },
            )
        };
        let gh = paths::find_on_path(&[&gh_name], path, platform, &extra, &[]);
        let bun_probe = async {
            match &bun {
                Some(bin) => self.version_of(bin, &env).await,
                None => Presence::Missing,
            }
        };
        let gh_probe = async {
            match &gh {
                Some(bin) => self.version_of(bin, &env).await,
                None => Presence::Missing,
            }
        };
        let (mut bun_presence, resolution, git, gh_presence, node, desktop, tailscale) = tokio::join!(
            bun_probe,
            self.resolution(),
            self.detect_git(&env),
            gh_probe,
            self.builtin_rea(true),
            crate::setup::detect_agent_desktop(
                platform.into(),
                &self.config.tools_dir,
                self.config.agent_desktop_bundle.as_deref(),
                &env
            ),
            self.detect_tailscale(&env)
        );
        let (omp_presence, omp_bin, minimum, old_bun) = match resolution {
            Resolution::Ready(runtime) => (
                present(Some(path_text(&runtime.bin)), Some(runtime.version)),
                Some(path_text(&runtime.bin)),
                runtime
                    .package_root
                    .as_deref()
                    .and_then(paths::manifest)
                    .as_ref()
                    .and_then(paths::manifest_bun_minimum),
                None,
            ),
            Resolution::Failed { reason, .. } => match reason {
                Failure::TooOld {
                    version,
                    minimum,
                    bin,
                } => (
                    Presence::Outdated {
                        version,
                        minimum,
                        path: Some(bin.clone()),
                    },
                    Some(bin.clone()),
                    paths::package_root(Path::new(&bin))
                        .as_deref()
                        .and_then(paths::manifest)
                        .as_ref()
                        .and_then(paths::manifest_bun_minimum),
                    None,
                ),
                Failure::CannotRun { bin, detail } => (
                    Presence::Broken {
                        detail,
                        path: Some(bin.clone()),
                    },
                    None,
                    paths::package_root(Path::new(&bin))
                        .as_deref()
                        .and_then(paths::manifest)
                        .as_ref()
                        .and_then(paths::manifest_bun_minimum),
                    None,
                ),
                Failure::Compiled { bin } => (
                    Presence::Broken {
                        detail: "a compiled omp, not the package OMPdesk runs".into(),
                        path: Some(bin.clone()),
                    },
                    None,
                    paths::package_root(Path::new(&bin))
                        .as_deref()
                        .and_then(paths::manifest)
                        .as_ref()
                        .and_then(paths::manifest_bun_minimum),
                    None,
                ),
                Failure::BunTooOld {
                    bin,
                    bun,
                    bun_version,
                    minimum,
                } => (
                    Presence::Broken {
                        detail: format!("needs Bun {minimum} or newer, found {bun_version}"),
                        path: Some(bin),
                    },
                    None,
                    Some(minimum),
                    Some((bun, bun_version)),
                ),
                Failure::NotFound | Failure::OverrideMissing { .. } => {
                    (Presence::Missing, None, None, None)
                }
            },
        };
        let bun_path = old_bun
            .as_ref()
            .map(|(path, _)| path.clone())
            .or_else(|| bun.as_deref().map(path_text));
        if let Some((path, version)) = old_bun {
            bun_presence = present(Some(path), Some(version));
        }
        bun_presence = bun_for_omp(bun_presence, minimum.as_deref());
        let usable_bun = matches!(
            bun_presence,
            Presence::Present { .. } | Presence::Outdated { .. }
        );
        let node_presence = if node.available {
            present(None, node.node_version)
        } else {
            match node.reason {
                Some("node-missing") => Presence::Missing,
                Some("node-version") => Presence::Outdated {
                    version: node.node_version.unwrap_or_default(),
                    minimum: REA_NODE_REQUIREMENT.into(),
                    path: None,
                },
                _ => Presence::Broken {
                    detail: node.reason.unwrap_or("node-failed").into(),
                    path: None,
                },
            }
        };
        Ok(Detection {
            presence: BTreeMap::from([
                (Item::Bun, bun_presence),
                (Item::Omp, omp_presence),
                (Item::Git, git),
                (Item::Gh, gh_presence),
                (Item::Node, node_presence),
                (Item::AgentDesktop, desktop),
                (Item::Tailscale, tailscale),
            ]),
            bun: usable_bun.then_some(bun_path).flatten(),
            omp: omp_bin,
            brew: brew.as_deref().map(path_text),
            winget: winget.as_deref().map(path_text),
        })
    }
}

fn bun_for_omp(found: Presence, minimum: Option<&str>) -> Presence {
    if let Presence::Present {
        version: Some(version),
        path,
        ..
    } = &found
        && let Some(minimum) = minimum
        && !version.is_empty()
        && runtime::is_newer(minimum, version)
    {
        return Presence::Outdated {
            version: version.clone(),
            minimum: minimum.to_owned(),
            path: path.clone(),
        };
    }
    found
}

fn git_shell_problem(code: Option<i32>, output: &str) -> Option<Value> {
    if code == Some(0) {
        return None;
    }
    if output.to_ascii_lowercase().contains("0xc0000142") {
        return Some(json!({"kind":"mandatory-aslr"}));
    }
    let detail = js_trim(output)
        .split('\n')
        .next_back()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("exit {}", code.map_or("null".into(), |v| v.to_string())));
    Some(json!({"kind":"spawn-failed", "detail":detail}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gates_bun_node_and_git_shell_without_installing_or_running_tools() {
        for version in ["22.19.0", "v24.11.0", "26.0.0", "27.1.0"] {
            assert!(rea_node_supported(version));
        }
        for version in ["22.18.9", "24.10.0", "25.0.0", "26.0.0-beta", "26.0"] {
            assert!(!rea_node_supported(version));
        }
        assert_eq!(git_shell_problem(Some(0), ""), None);
        assert_eq!(
            git_shell_problem(Some(127), "error 0xC0000142"),
            Some(json!({"kind":"mandatory-aslr"}))
        );
        assert_eq!(
            git_shell_problem(None, "first\nlast"),
            Some(json!({"kind":"spawn-failed","detail":"last"}))
        );
        let found = present(Some("bun".into()), Some("1.3.0".into()));
        assert!(matches!(
            bun_for_omp(found, Some("1.4.0")),
            Presence::Outdated { .. }
        ));
    }
}
