//! Machine-wide runtime discovery and application services. Config and effects are injected by the native app,
//! never deserialized from the page. Every setup/helper/session shares this instance and its refreshed environment.

mod command;
mod paths;
mod runtime;
mod shell;

pub use command::{CommandShell, ShellContext};

pub use paths::{
    Platform, find_git_bash, find_on_path, is_compiled_omp, manifest_bun_minimum,
    update_environment,
};
pub use runtime::{Failure, MIN_OMP_VERSION, Resolution, Runtime, parse_version};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::run::{Exec, Opts, Output, Runner};
use crate::server::{Fault, Scope};

pub type Environment = BTreeMap<String, String>;
pub type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The one native shell's existing PAC resolver and persisted proxy preference.
pub trait Proxy: Send + Sync {
    fn configured(&self) -> Option<String>;
    fn system<'a>(&'a self, url: &'a str) -> Boxed<'a, Result<String, Fault>>;
}

/// Trusted launch facts, assembled by Base. Nothing in this type is page input.
pub struct Config {
    pub platform: Platform,
    pub home: PathBuf,
    pub user_data: PathBuf,
    pub tools_dir: PathBuf,
    pub agent_desktop_bundle: Option<PathBuf>,
    pub core_bin: PathBuf,
    pub agent_dir: PathBuf,
    pub inherited_env: Environment,
}

pub struct Service {
    config: Config,
    proxy: Arc<dyn Proxy>,
    environment: Mutex<Environment>,
    shell: Mutex<Option<shell::Login>>,
    runtime: Mutex<Option<Runtime>>,
    ego: Mutex<Option<PathBuf>>,
}

impl Service {
    pub fn new(config: Config, proxy: Arc<dyn Proxy>) -> Arc<Self> {
        let mut environment = paths::canonical_environment(&config.inherited_env, config.platform);
        paths::apply_managed(&mut environment, &config.tools_dir, config.platform);
        Arc::new(Self {
            config,
            proxy,
            environment: Mutex::new(environment),
            shell: Mutex::new(None),
            runtime: Mutex::new(None),
            ego: Mutex::new(None),
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }
    pub fn agent_dir(&self) -> &Path {
        &self.config.agent_dir
    }
    pub fn core_bin(&self) -> &Path {
        &self.config.core_bin
    }

    /// Inherited environment plus allowed login-shell exports and merged PATH, without proxy resolution.
    pub async fn shell_environment(&self) -> Environment {
        let mut cached = self.shell.lock().await;
        let inherited = self.environment.lock().await.clone();
        let login = if let Some(login) = cached.as_ref() {
            login
        } else {
            let login = shell::probe(self, &inherited).await;
            cached.insert(login)
        };
        shell::merge(&inherited, login, &self.config.home, self.config.platform)
    }

    /// Pref proxy wins over inherited proxies; the existing native PAC engine is consulted only otherwise.
    pub async fn environment(&self) -> Result<Environment, Fault> {
        let mut env = self.shell_environment().await;
        let configured = self
            .proxy
            .configured()
            .filter(|url| !crate::fs::order::js_trim(url).is_empty());
        let inherited = [
            "PI_PROXY",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ]
        .iter()
        .any(|name| env.get(*name).is_some_and(|v| !v.is_empty()));
        let proxy = if let Some(raw) = configured {
            let raw = crate::fs::order::js_trim(&raw);
            Some(if raw.contains("://") {
                raw.to_owned()
            } else {
                format!("http://{raw}")
            })
        } else if inherited {
            None
        } else {
            // A failed system lookup was nonfatal in resolveProxyEnvForSpawn too.
            self.proxy
                .system("https://chatgpt.com")
                .await
                .ok()
                .and_then(|pac| shell::pac_url(&pac))
        };
        if let Some(proxy) = proxy {
            for name in [
                "PI_PROXY",
                "HTTPS_PROXY",
                "HTTP_PROXY",
                "ALL_PROXY",
                "https_proxy",
                "http_proxy",
                "all_proxy",
            ] {
                env.insert(name.to_owned(), proxy.clone());
            }
        }
        paths::drop_git_selectors(&mut env);
        Ok(env)
    }

    /// Successful resolution is shared, including a lookup already in progress. Failures are retried next time.
    pub async fn resolution(&self) -> Resolution {
        let mut cached = self.runtime.lock().await;
        if let Some(runtime) = cached.as_ref() {
            return Resolution::Ready(runtime.clone());
        }
        let result = runtime::resolve(self).await;
        if let Resolution::Ready(runtime) = &result {
            *cached = Some(runtime.clone());
        }
        result
    }

    pub async fn runtime(&self) -> Result<Runtime, Fault> {
        match self.resolution().await {
            Resolution::Ready(mut runtime) => {
                // Proxy preference changes apply to the next spawn without discarding version discovery.
                runtime.env = self.environment().await?;
                paths::omp_environment(
                    &mut runtime.env,
                    &runtime.bin,
                    &self.config.home,
                    self.config.platform,
                );
                Ok(runtime)
            }
            Resolution::Failed { error, .. } => Err(Fault::new("omp_unavailable", error)),
        }
    }

    pub async fn refresh(&self) -> Result<(), Fault> {
        // The same order as resolution -> shell_environment; no refresh can publish an obsolete in-flight result.
        let mut runtime = self.runtime.lock().await;
        let mut shell = self.shell.lock().await;
        let mut env = self.environment.lock().await;
        if self.config.platform == Platform::Windows {
            paths::refresh_registry(self, &mut env).await;
        }
        paths::apply_managed(&mut env, &self.config.tools_dir, self.config.platform);
        *shell = None;
        *runtime = None;
        drop(env);
        drop(shell);
        drop(runtime);
        *self.ego.lock().await = None;
        Ok(())
    }

    pub async fn bun(&self) -> Result<Option<PathBuf>, Fault> {
        let env = self.shell_environment().await;
        let name = self.config.platform.exe("bun");
        Ok(paths::find_on_path(
            &[name.as_str()],
            env.get("PATH").map_or("", String::as_str),
            self.config.platform,
            &[paths::bun_install(&env, &self.config.home)
                .join("bin")
                .join(&name)],
            &[],
        ))
    }

    pub async fn bash(&self) -> Result<PathBuf, Fault> {
        if self.config.platform != Platform::Windows {
            return Ok(PathBuf::from("/bin/bash"));
        }
        let env = self.environment().await?;
        paths::find_git_bash(&env)
            .ok_or_else(|| Fault::new("shell_missing", "Git Bash is not installed"))
    }

    pub async fn ego_browser(&self) -> Result<Option<PathBuf>, Fault> {
        let mut cached = self.ego.lock().await;
        if let Some(bin) = cached.as_ref() {
            return Ok(Some(bin.clone()));
        }
        let env = self.shell_environment().await;
        let names = if self.config.platform == Platform::Windows {
            vec!["ego-browser.exe", "ego-browser.cmd", "ego-browser"]
        } else {
            vec!["ego-browser"]
        };
        let extra = names
            .iter()
            .map(|name| self.config.home.join(".local/bin").join(name))
            .collect::<Vec<_>>();
        let found = paths::find_on_path(
            &names,
            env.get("PATH").map_or("", String::as_str),
            self.config.platform,
            &extra,
            &[],
        );
        *cached = found.clone();
        Ok(found)
    }

    pub(crate) async fn probe(
        &self,
        bin: &Path,
        args: &[&str],
        env: &Environment,
        timeout_ms: u64,
    ) -> Result<Output, Fault> {
        Exec::new(
            Runner {
                bin: bin.to_string_lossy().into_owned(),
                args: Vec::new(),
                env: env.clone(),
                timeout_ms,
                max_bytes: 1024 * 1024,
            },
            Scope::detached(),
            "machine",
        )
        .run(&self.config.home.to_string_lossy(), args, Opts::default())
        .await
    }
}
