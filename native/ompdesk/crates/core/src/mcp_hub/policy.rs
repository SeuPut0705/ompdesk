use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const OWNED_ENV: &[&str] = &[
    "OMP_GUI_BRIDGE", "OMP_GUI_REPLY_LANGUAGE", "OMP_GUI_BROWSER", "OMP_GUI_COMPUTER_USE",
    "OMP_GUI_AGENT_DESKTOP", "OMP_GUI_USER_PROFILE", "OMP_GUI_NEXT_PROMPT", "OMP_GUI_AUTO_TITLE",
    "OMP_GUI_JUDGE_ASSIST", "OMP_GUI_PROMPT_ORIGIN", "OMP_GUI_DELEGATION", "OMP_GUI_ACCOUNT_ROTATION",
    "OMP_GUI_ACCOUNT_ROTATION_STATE", "OMP_GUI_CREDIT_SPEND", "OMP_GUI_OMPDESK_ROLES", "OMP_GUI_REA_ROOT",
    "OMP_GUI_MCP_HUB", "OMP_GUI_MCP_HUB_SECRET", "OMP_GUI_MCP_AUTH", "OMP_GUI_MCP_CWD", "OMP_GUI_PSTACK", "OMP_GUI_ECC",
    "OMP_GUI_MEMORY", "OMP_GUI_SESSION_TAG", "OMP_GUI_SCRATCH", "OMPDESK_SOCKET",
    "OMPDESK_CONTROL_DIR", "OMPDESK_CONTROL_OFF",
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind {
    Agent,
    Chat,
    Schedule,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ComputerUse {
    AgentDesktop,
    Builtin,
}

/// Loaded builtin paths and preferences.
pub struct BuiltinConfig {
    pub builtin_dir: PathBuf,
    pub rea_enabled: bool,
    pub agent_control: bool,
    pub pstack: bool,
    pub ecc: bool,
    pub computer_use: ComputerUse,
}

pub struct LaunchInput {
    pub kind: LaunchKind,
    pub inherited_env: BTreeMap<String, String>,
    /// Arguments supplied by the native memory service, not by a Node policy process.
    pub memory_args: Vec<String>,
    pub memory_state_file: Option<PathBuf>,
    /// For agent/chat with REA enabled, the result of native `Service::spawn_rea(true)`.
    /// The caller must not probe REA for schedules or when the preference is off.
    pub rea_available: bool,
    /// The native machine's selected agent-desktop executable, if any. Schedules do not select one.
    pub desktop_executable: Option<PathBuf>,
}

pub struct BuiltinLaunch {
    pub args: Vec<String>,
    pub rea_root: Option<PathBuf>,
    /// The inherited environment with session and control values removed, plus extension values.
    pub env: BTreeMap<String, String>,
    pub needs_hub: bool,
}

/// Assemble stock omp root arguments. The caller overlays fresh hub credentials only when `needs_hub` is true.
pub fn assemble(config: &BuiltinConfig, input: &LaunchInput) -> BuiltinLaunch {
    let mut env = input.inherited_env.clone();
    env.retain(|key, _| !OWNED_ENV.iter().any(|owned| {
        if cfg!(windows) { key.eq_ignore_ascii_case(owned) } else { key == owned }
    }));
    let mut args = Vec::new();
    if input.kind == LaunchKind::Schedule {
        args.extend(input.memory_args.iter().cloned());
        return BuiltinLaunch { needs_hub: !args.is_empty(), args, rea_root: None, env };
    }
    if config.agent_control { root(&mut args, &config.builtin_dir); }
    let rea_root = if config.rea_enabled && input.rea_available {
        let path = config.builtin_dir.join("rea");
        root(&mut args, &path);
        env.insert("OMP_GUI_REA_ROOT".into(), path.to_string_lossy().into_owned());
        Some(path)
    } else { None };
    match config.computer_use {
        ComputerUse::Builtin => { env.insert("OMP_GUI_COMPUTER_USE".into(), "builtin".into()); }
        ComputerUse::AgentDesktop => {
            if let Some(path) = &input.desktop_executable {
                root(&mut args, &config.builtin_dir.join("agent-desktop"));
                env.insert("OMP_GUI_COMPUTER_USE".into(), "agent-desktop".into());
                env.insert("OMP_GUI_AGENT_DESKTOP".into(), path.to_string_lossy().into_owned());
            } else {
                env.insert("OMP_GUI_COMPUTER_USE".into(), "missing".into());
            }
        }
    }
    if config.pstack { root(&mut args, &config.builtin_dir.join("pstack")); }
    if config.ecc { root(&mut args, &config.builtin_dir.join("ecc")); }
    root(&mut args, &config.builtin_dir.join("formal"));
    env.insert("OMP_GUI_PSTACK".into(), if config.pstack && input.kind == LaunchKind::Agent { "1" } else { "0" }.into());
    env.insert("OMP_GUI_ECC".into(), if config.ecc && input.kind == LaunchKind::Agent { "1" } else { "0" }.into());
    if let Some(path) = &input.memory_state_file {
        env.insert("OMP_GUI_MEMORY".into(), path.to_string_lossy().into_owned());
    }
    let needs_hub = rea_root.is_some() || !input.memory_args.is_empty();
    args.extend(input.memory_args.iter().cloned());
    BuiltinLaunch { args, rea_root, env, needs_hub }
}

fn root(args: &mut Vec<String>, path: &Path) {
    args.push("-e".into());
    args.push(path.to_string_lossy().into_owned());
}


#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
