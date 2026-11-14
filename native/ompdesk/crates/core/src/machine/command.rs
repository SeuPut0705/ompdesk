use std::path::PathBuf;

use super::{Environment, Platform, Service, paths};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandShell {
    Bash(PathBuf),
    WindowsCmd(PathBuf),
    PosixSh(PathBuf),
}

pub struct ShellContext {
    pub env: Environment,
    pub shell: CommandShell,
    pub supervisor: PathBuf,
}

fn choose(env: &Environment, platform: Platform) -> CommandShell {
    if platform == Platform::Windows {
        return paths::find_git_bash(env).map_or_else(
            || {
                CommandShell::WindowsCmd(
                    env.get("COMSPEC")
                        .or_else(|| env.get("ComSpec"))
                        .map_or_else(|| PathBuf::from("cmd.exe"), PathBuf::from),
                )
            },
            CommandShell::Bash,
        );
    }
    paths::find_on_path(
        &["bash"],
        env.get("PATH").map_or("", String::as_str),
        platform,
        &[PathBuf::from("/bin/bash")],
        &[],
    )
    .map_or_else(
        || CommandShell::PosixSh(PathBuf::from("/bin/sh")),
        CommandShell::Bash,
    )
}

impl Service {
    /// Exact landShell environment from autopilot.ts: inherited values win over login exports, git selectors are
    /// removed, and system/PAC proxies are not introduced. The caller owns command argv and the native supervisor.
    pub async fn command_shell(&self) -> ShellContext {
        let mut env = self.shell_environment().await;
        paths::drop_git_selectors(&mut env);
        let shell = choose(&env, self.config.platform);
        ShellContext {
            env,
            shell,
            supervisor: self.config.core_bin.clone(),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::machine::tests::service;
    use crate::models::test_rig::Fixture;

    #[tokio::test]
    async fn selects_the_shell_from_the_same_trusted_environment_without_adding_pac() {
        let fixture = Fixture::new("command-shell");
        let bash = fixture.script("bash", "exit 0");
        let shell = fixture.script(
            "shell",
            &format!(
                "printf '%s\\n' '__OMP_ENV_BEGIN__' 'PATH={}' 'TOKEN=exported' '__OMP_ENV_END__'",
                fixture.dir.display()
            ),
        );
        let service = service(
            &fixture,
            Environment::from([
                ("SHELL".into(), shell.to_string_lossy().into_owned()),
                ("GIT_DIR".into(), "/foreign".into()),
            ]),
        );
        let context = service.command_shell().await;
        assert_eq!(context.shell, CommandShell::Bash(bash));
        assert_eq!(context.env["TOKEN"], "exported");
        assert!(!context.env.contains_key("GIT_DIR"));
        assert!(!context.env.contains_key("HTTPS_PROXY"));
        assert_eq!(context.supervisor, fixture.dir.join("ompdesk-core"));
        assert_eq!(
            choose(
                &Environment::from([("ComSpec".into(), "custom-cmd.exe".into())]),
                Platform::Windows
            ),
            CommandShell::WindowsCmd(PathBuf::from("custom-cmd.exe"))
        );
        assert_eq!(
            choose(&Environment::new(), Platform::Windows),
            CommandShell::WindowsCmd(PathBuf::from("cmd.exe"))
        );
    }
}
