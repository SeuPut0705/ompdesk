//! The live Node/npx probe and the persisted spawn fast path from builtin-mcp.ts. REA stays an installed stock
//! subprocess; this cache only vouches for the exact executable identities a successful probe observed.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::{Environment, Platform, Service, paths};
use crate::fs::disk::{mtime_ms, spelled};
use crate::fs::order::js_trim;

pub const REA_NODE_REQUIREMENT: &str = "^22.19.0 || ^24.11.0 || >=26.0.0";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaState {
    pub enabled: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

pub fn rea_node_supported(version: &str) -> bool {
    let version = js_trim(version)
        .strip_prefix('v')
        .unwrap_or(js_trim(version));
    let parts = version.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || !parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let major = parts[0].parse::<u64>().unwrap_or(u64::MAX);
    let minor = parts[1].parse::<u64>().unwrap_or(u64::MAX);
    major >= 26 || (major == 22 && minor >= 19) || (major == 24 && minor >= 11)
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    node: String,
    npx: String,
    node_version: String,
}

#[derive(Clone)]
struct Probe {
    state: ReaState,
    node: Option<String>,
    npx: Option<String>,
}

struct Job {
    result: watch::Sender<Option<Probe>>,
    #[cfg(test)]
    stored: tokio::sync::Notify,
}

#[derive(Default)]
pub(super) struct Cache {
    current: Option<Arc<Job>>,
    unavailable: Option<Probe>,
    stored: Option<Option<Stored>>,
}
impl Cache {
    pub(super) fn reset(&mut self) {
        self.current = None;
        self.unavailable = None;
    }
}

fn disabled() -> ReaState {
    ReaState {
        enabled: false,
        available: false,
        node_version: None,
        reason: None,
    }
}
fn identity(bin: Option<&Path>) -> Option<String> {
    let bin = bin?;
    let real = std::fs::canonicalize(bin).ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    // Preserve the existing file's identity strings, including Node's exact mtimeMs number spelling.
    Some(format!(
        "[{},{},{},{}]",
        serde_json::to_string(&spelled(bin)).ok()?,
        serde_json::to_string(&spelled(&real)).ok()?,
        crate::control::js::number(meta.len() as f64),
        crate::control::js::number(mtime_ms(&meta))
    ))
}

fn find(env: &Environment, platform: Platform) -> (Option<PathBuf>, Option<PathBuf>) {
    let path = env.get("PATH").map_or("", String::as_str);
    let node = platform.exe("node");
    (
        paths::find_on_path(&[&node], path, platform, &[], &[]),
        paths::find_on_path(
            if platform == Platform::Windows {
                &["npx.cmd", "npx.exe"]
            } else {
                &["npx"]
            },
            path,
            platform,
            &[],
            &[],
        ),
    )
}

impl Service {
    async fn probe_rea(&self) -> Probe {
        let env = self.shell_environment().await;
        let (node, npx) = find(&env, self.config.platform);
        let mut probe = Probe {
            state: ReaState {
                enabled: true,
                available: false,
                node_version: None,
                reason: None,
            },
            node: identity(node.as_deref()),
            npx: identity(npx.as_deref()),
        };
        let Some(node) = node else {
            probe.state.reason = Some("node-missing");
            return probe;
        };
        let version = match self.probe(&node, &["--version"], &env, 10_000).await {
            Ok(output) if output.code == 0 && !output.truncated => {
                js_trim(&output.text()).to_owned()
            }
            _ => {
                probe.state.reason = Some("node-failed");
                return probe;
            }
        };
        probe.state.node_version = Some(version.clone());
        if !rea_node_supported(&version) {
            probe.state.reason = Some("node-version");
            return probe;
        }
        let Some(npx) = npx else {
            probe.state.reason = Some("npx-missing");
            return probe;
        };
        if !self
            .probe(&npx, &["--version"], &env, 10_000)
            .await
            .is_ok_and(|out| out.code == 0 && !out.truncated)
        {
            probe.state.reason = Some("npx-failed");
            return probe;
        }
        probe.state.available = true;
        probe
    }

    async fn rea_job(self: &Arc<Self>) -> Arc<Job> {
        let mut cache = self.rea.lock().await;
        if let Some(job) = &cache.current {
            return Arc::clone(job);
        }
        let job = Arc::new(Job {
            result: watch::channel(None).0,
            #[cfg(test)]
            stored: tokio::sync::Notify::new(),
        });
        cache.current = Some(Arc::clone(&job));
        let service = Arc::clone(self);
        let worker = Arc::clone(&job);
        tokio::spawn(async move {
            let probe = service.probe_rea().await;
            let mut cache = service.rea.lock().await;
            let current = cache
                .current
                .as_ref()
                .is_some_and(|job| Arc::ptr_eq(job, &worker));
            worker.result.send_replace(Some(probe.clone()));
            if current {
                if probe.state.available {
                    cache.unavailable = None;
                } else {
                    cache.current = None;
                    cache.unavailable = Some(probe.clone());
                }
                let next = match (&probe.node, &probe.npx, &probe.state.node_version) {
                    (Some(node), Some(npx), Some(version)) if probe.state.available => {
                        Some(Stored {
                            node: node.clone(),
                            npx: npx.clone(),
                            node_version: version.clone(),
                        })
                    }
                    _ => None,
                };
                let previous = cache.stored.get_or_insert_with(|| {
                    read_stored(&service.config.user_data.join("rea-runtime.json"))
                });
                if *previous != next {
                    *previous = next.clone();
                    let file = service.config.user_data.join("rea-runtime.json");
                    let _ = tokio::task::spawn_blocking(move || store(&file, next.as_ref())).await;
                }
            }
            #[cfg(test)]
            worker.stored.notify_one();
        });
        job
    }

    pub async fn builtin_rea(self: &Arc<Self>, enabled: bool) -> ReaState {
        let job = self.rea_job().await;
        let mut state = wait(&job).await.state;
        state.enabled = enabled;
        state
    }

    /// A disabled root starts no probe. Enabled spawns may take the last verified identities while the single live
    /// probe runs behind them; a replaced executable waits for that probe instead of trusting the old answer.
    pub async fn spawn_rea(self: &Arc<Self>, enabled: bool) -> ReaState {
        if !enabled {
            return disabled();
        }
        let (last, known) = {
            let mut cache = self.rea.lock().await;
            let last = cache
                .stored
                .get_or_insert_with(|| read_stored(&self.config.user_data.join("rea-runtime.json")))
                .clone();
            (last, cache.unavailable.clone())
        };
        let job = self.rea_job().await;
        if last.is_some() || known.is_some() {
            let env = self.shell_environment().await;
            let (node, npx) = find(&env, self.config.platform);
            let (node, npx) = (identity(node.as_deref()), identity(npx.as_deref()));
            if let Some(last) = last
                && node.as_deref() == Some(last.node.as_str())
                && npx.as_deref() == Some(last.npx.as_str())
                && rea_node_supported(&last.node_version)
            {
                return ReaState {
                    enabled: true,
                    available: true,
                    node_version: Some(last.node_version),
                    reason: None,
                };
            }
            if let Some(known) = known
                && node == known.node
                && npx == known.npx
            {
                return known.state;
            }
        }
        wait(&job).await.state
    }
}

async fn wait(job: &Job) -> Probe {
    let mut receiver = job.result.subscribe();
    loop {
        if let Some(probe) = receiver.borrow().as_ref() {
            return probe.clone();
        }
        let _ = receiver.changed().await;
    }
}
fn read_stored(file: &Path) -> Option<Stored> {
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}
fn store(file: &Path, value: Option<&Stored>) {
    if let Some(value) = value {
        if let Ok(bytes) = serde_json::to_vec(value) {
            let _ = crate::disk::saves::write_kept(file, &bytes, Some(0o600), 0o700);
        }
    } else {
        let _ = crate::disk::saves::remove_kept(file);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::machine::tests::service;
    use crate::models::test_rig::Fixture;

    fn environment(fixture: &Fixture) -> Environment {
        let shell = fixture.script(
            "shell",
            &format!(
                "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH={}' '__OMP_ENV_END__'",
                fixture.dir.display()
            ),
        );
        Environment::from([
            ("PATH".into(), fixture.dir.to_string_lossy().into_owned()),
            ("SHELL".into(), shell.to_string_lossy().into_owned()),
        ])
    }

    #[tokio::test]
    async fn stored_identity_returns_before_the_live_probe_and_a_changed_binary_waits() {
        let fixture = Fixture::new("rea-stored");
        fixture.script("node", "printf n >> node-probes; printf 'v26.0.0\\n'");
        fixture.script("npx", "printf '11.0.0\\n'");
        let env = environment(&fixture);
        let first = service(&fixture, env.clone());
        assert!(first.builtin_rea(true).await.available);
        let job = first.rea_job().await;
        job.stored.notified().await;
        assert!(fixture.dir.join("rea-runtime.json").exists());
        let second = service(&fixture, env.clone());
        second.shell_environment().await;
        let mut fast = std::pin::pin!(second.spawn_rea(true));
        let state = std::future::poll_fn(|cx| match fast.as_mut().poll(cx) {
            std::task::Poll::Ready(state) => std::task::Poll::Ready(state),
            std::task::Poll::Pending => {
                panic!("unchanged stored identities waited for node --version")
            }
        })
        .await;
        assert!(state.available);
        second.rea_job().await.stored.notified().await;
        fixture.script("node", "printf 'v20.0.0\\n'");
        let third = service(&fixture, env);
        third.shell_environment().await;
        let job = third.rea_job().await;
        let mut pending = std::pin::pin!(third.spawn_rea(true));
        let mut first_poll = true;
        let state = std::future::poll_fn(|cx| {
            let result = pending.as_mut().poll(cx);
            if first_poll {
                first_poll = false;
                assert!(
                    result.is_pending(),
                    "changed executable trusted the old stored version"
                );
            }
            result
        })
        .await;
        assert!(!state.available);
        assert_eq!(state.reason, Some("node-version"));
        job.stored.notified().await;
        assert!(!fixture.dir.join("rea-runtime.json").exists());
    }

    #[tokio::test]
    async fn off_never_probes_and_a_fixed_unavailable_install_is_reprobed() {
        let fixture = Fixture::new("rea-off");
        fixture.script("node", "printf n >> node-probes; printf 'v20.0.0\\n'");
        fixture.script("npx", "printf '11.0.0\\n'");
        let service = service(&fixture, environment(&fixture));
        assert!(!service.spawn_rea(false).await.enabled);
        assert!(!fixture.dir.join("node-probes").exists());
        assert_eq!(service.builtin_rea(true).await.reason, Some("node-version"));
        fixture.script("node", "printf n >> node-probes; printf 'v26.0.0\\n'");
        assert!(service.builtin_rea(true).await.available);
        assert_eq!(
            std::fs::read_to_string(fixture.dir.join("node-probes")).unwrap(),
            "nn"
        );
    }
}
