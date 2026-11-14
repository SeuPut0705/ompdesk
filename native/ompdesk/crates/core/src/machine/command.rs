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
