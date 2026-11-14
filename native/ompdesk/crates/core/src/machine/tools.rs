//! The native process rules of local/git/exec.ts. Tool commands stay in git/gh/routines; lookup and the
//! inherited-plus-login-PATH environment are machine-wide, including macOS's developer-dir trampoline bypass.

use std::path::{Path, PathBuf};

use tokio::sync::Mutex;

use super::{Environment, Platform, Service, paths};
use crate::fs::order::js_trim;
use crate::run::Runner;
use crate::server::Fault;

#[derive(Default)]
pub(super) struct Cache {
    git: Mutex<Option<PathBuf>>,
    gh: Mutex<Option<PathBuf>>,
}

impl Service {
    async fn tool_environment(&self) -> Environment {
        let shell = self.shell_environment().await;
        let mut env = self.environment.lock().await.clone();
        env.insert(
            "PATH".into(),
            shell.get("PATH").cloned().unwrap_or_default(),
        );
        paths::drop_git_selectors(&mut env);
        env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
        env
    }

    fn tool_bin(&self, name: &str, env: &Environment) -> Option<PathBuf> {
        let platform = self.config.platform;
        let native = platform.exe(name);
        let names = if platform == Platform::Windows {
            vec![native.as_str(), name]
        } else {
            vec![name]
        };
        let extra = if platform == Platform::Mac {
            let dirs = env.get("OMP_GUI_TEST_BREW_DIRS").map_or_else(
                || vec!["/opt/homebrew/bin".to_owned(), "/usr/local/bin".to_owned()],
                |v| {
                    v.split(platform.separator())
                        .filter(|p| !p.is_empty())
                        .map(str::to_owned)
                        .collect()
                },
            );
            dirs.into_iter()
                .map(|dir| Path::new(&dir).join(name))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        paths::find_on_path(
            &names,
            env.get("PATH").map_or("", String::as_str),
            platform,
            &extra,
            &[],
        )
    }

    pub async fn git_runner(&self) -> Result<Runner, Fault> {
        let mut env = self.tool_environment().await;
        let mut cached = self.tools.git.lock().await;
        let bin = if let Some(bin) = cached.as_ref() {
            bin.clone()
        } else {
            let Some(mut bin) = self.tool_bin("git", &env) else {
                return Err(Fault::new(
                    "git_missing",
                    "git is not installed or not on PATH",
                ));
            };
            if self.config.platform == Platform::Mac && bin == Path::new("/usr/bin/git") {
                let developer =
                    if let Some(dir) = env.get("DEVELOPER_DIR").filter(|v| !v.is_empty()) {
                        Some(dir.clone())
                    } else {
                        self.probe(Path::new("/usr/bin/xcode-select"), &["-p"], &env, 5_000)
                            .await
                            .ok()
                            .filter(|o| o.code == 0)
                            .map(|o| o.text())
                    };
                if let Some(dir) = developer
                    .map(|d| js_trim(&d).to_owned())
                    .filter(|d| !d.is_empty())
                {
                    let target = Path::new(&dir).join("usr/bin/git");
                    if target.exists() {
                        bin = target;
                    }
                }
            }
            *cached = Some(bin.clone());
            bin
        };
        env.extend([
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            ("GIT_PAGER".into(), "cat".into()),
            ("LC_ALL".into(), "C".into()),
        ]);
        Ok(Runner {
            bin: bin.to_string_lossy().into_owned(),
            args: vec![
                "-c".into(),
                "core.quotepath=false".into(),
                "-c".into(),
                "color.ui=false".into(),
            ],
            env,
            timeout_ms: 60_000,
            max_bytes: 8 * 1024 * 1024,
        })
    }

    pub async fn gh_runner(&self) -> Result<Option<Runner>, Fault> {
        let mut env = self.tool_environment().await;
        let mut cached = self.tools.gh.lock().await;
        let bin = if let Some(bin) = cached.as_ref() {
            bin.clone()
        } else {
            let Some(bin) = self.tool_bin("gh", &env) else {
                return Ok(None);
            };
            *cached = Some(bin.clone());
            bin
        };
        env.extend([
            ("GH_PROMPT_DISABLED".into(), "1".into()),
            ("GH_NO_UPDATE_NOTIFIER".into(), "1".into()),
            ("NO_COLOR".into(), "1".into()),
        ]);
        Ok(Some(Runner {
            bin: bin.to_string_lossy().into_owned(),
            args: Vec::new(),
            env,
            timeout_ms: 60_000,
            max_bytes: 8 * 1024 * 1024,
        }))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::machine::tests::service;
    use crate::models::test_rig::Fixture;

    #[tokio::test]
    async fn native_tool_runners_keep_the_argv_and_inherited_environment_contract() {
        let fixture = Fixture::new("machine-tools");
        let git = fixture.script("git", "printf 'git version 2.50.0\\n'");
        let gh = fixture.script("gh", "printf 'gh version 2.70.0\\n'");
        let shell=fixture.script("shell",&format!("printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH={}' 'ONLY_SHELL=not-for-git' '__OMP_ENV_END__'",fixture.dir.display()));
        let env = Environment::from([
            ("SHELL".into(), shell.to_string_lossy().into_owned()),
            ("GIT_DIR".into(), "/foreign".into()),
            ("EXPLICIT".into(), "launch".into()),
            ("OMP_GUI_TEST_BREW_DIRS".into(), String::new()),
        ]);
        let service = service(&fixture, env);
        let git_runner = service.git_runner().await.unwrap();
        assert_eq!(git_runner.bin, git.to_string_lossy());
        assert_eq!(
            git_runner.args,
            ["-c", "core.quotepath=false", "-c", "color.ui=false"]
        );
        assert_eq!(git_runner.env["GIT_OPTIONAL_LOCKS"], "0");
        assert_eq!(git_runner.env["GIT_TERMINAL_PROMPT"], "0");
        assert_eq!(git_runner.env["LC_ALL"], "C");
        assert!(!git_runner.env.contains_key("GIT_DIR"));
        assert!(!git_runner.env.contains_key("ONLY_SHELL"));
        let gh_runner = service.gh_runner().await.unwrap().unwrap();
        assert_eq!(gh_runner.bin, gh.to_string_lossy());
        assert_eq!(gh_runner.env["GH_PROMPT_DISABLED"], "1");
        assert_eq!(gh_runner.env["GH_NO_UPDATE_NOTIFIER"], "1");
        assert_eq!(gh_runner.env["NO_COLOR"], "1");
        assert!(gh_runner.args.is_empty());
    }
}
