//! The agent's own risk table for `ompdesk_app` (was `app-guard.ts`), separate from `IPC_POLICY` (which says what a
//! paired web device may do): which tier a preference, a stock setting, an omp command or a channel needs, and what is
//! never reachable. Every primitive of an action asks here, so a nested route is refused like a direct one.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

use super::settings::{self, SETTINGS};

/// What an action may do, or needs. `Never` is only ever a need.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tier {
    Read,
    Change,
    Sensitive,
    Never,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Read => "read",
            Tier::Change => "change",
            Tier::Sensitive => "sensitive",
            Tier::Never => "never",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Tier::Read => 0,
            Tier::Change => 1,
            Tier::Sensitive => 2,
            Tier::Never => 3,
        }
    }
}

/// Whether an action granted `granted` may use something that needs `needed`.
pub fn covers(granted: Tier, needed: Tier) -> bool {
    needed != Tier::Never && needed.rank() <= granted.rank()
}

/// Preferences that gate what an agent may do (its own tools, approvals, the memory and computer-use switches, the
/// sidebar blob that holds the sessions a person hid from agents) and credential-like keys. Refused even if a row
/// names them. Case-insensitive, as the pattern it was.
fn power_pref(key: &str) -> bool {
    const STARTS: [&str; 10] = [
        "agentcontrol",
        "approval",
        "autoapprove",
        "yolo",
        "pstack",
        "ecc",
        "aimemory",
        "memory",
        "computer",
        "sidebar",
    ];
    const HAS: [&str; 8] = [
        "token",
        "secret",
        "password",
        "passphrase",
        "credential",
        "apikey",
        "api-key",
        "api_key",
    ];
    let key = key.to_lowercase();
    STARTS.iter().any(|start| key.starts_with(start)) || HAS.iter().any(|word| key.contains(word))
}

/// Stock settings with the same role: approvals, secrets handling, security, memory and computer use.
pub fn power_setting(path: &str) -> bool {
    const STARTS: [&str; 11] = [
        "tools.approval",
        "secrets.",
        "security.",
        "computer",
        "memory.",
        "mnemopi",
        "hindsight",
        "autolearn",
        "pstack",
        "task.agentaccountpools",
        "providers.",
    ];
    let path = path.to_lowercase();
    STARTS.iter().any(|start| path.starts_with(start))
}

/// The agent-power switches `agent_power.set` may write while `agentControlFull` is on; `never` otherwise. Secrets
/// are never among them.
pub const FULL_CONTROL_PREFS: [&str; 6] = [
    "agentControl",
    "agentControlFull",
    "agentControlManage",
    "agentControlApprove",
    "pstack",
    "ecc",
];
pub const FULL_CONTROL_SETTINGS: [&str; 2] = ["tools.approvalMode", "computer.enabled"];

static PREF_TIER: LazyLock<HashMap<&'static str, Tier>> = LazyLock::new(|| {
    let mut tiers = HashMap::new();
    for setting in SETTINGS.iter() {
        if let Some(key) = setting.pref_key() {
            tiers.insert(key, setting.tier);
            for mirrored in setting.mirror_keys() {
                tiers.insert(*mirrored, setting.tier);
            }
        }
    }
    tiers
});

/// The tier a stored preference needs to be written; `Never` for a power switch, a secret or a key no row lists. With
/// `full` (the person's `agentControlFull`) the switches in `FULL_CONTROL_PREFS` need `Sensitive` instead.
pub fn pref_tier(key: &str, full: bool) -> Tier {
    if full && FULL_CONTROL_PREFS.contains(&key) {
        return Tier::Sensitive;
    }
    if power_pref(key) {
        return Tier::Never;
    }
    PREF_TIER.get(key).copied().unwrap_or(Tier::Never)
}

/// The tier a stock setting needs; `Never` for approvals, secrets, memory and the like, and for paths no row lists.
pub fn setting_tier(path: &str, full: bool) -> Tier {
    if full && FULL_CONTROL_SETTINGS.contains(&path) {
        return Tier::Sensitive;
    }
    if power_setting(path) {
        return Tier::Never;
    }
    match settings::by_id(path) {
        Some(row) if row.pref_key().is_none() => row.tier,
        _ => Tier::Never,
    }
}

/// What `omp_settings` may do with a stock setting path, decided from the entry the omp's own schema lists for it
/// (`None` = the schema does not list the path: refused). A credential-typed entry (the schema's `secret`) is never
/// read or written; the paths `power_setting` names keep their rule, and the two switches `FULL_CONTROL_SETTINGS`
/// names stay `agent_power.set`'s (read under full control, `Sensitive` to write). Everything else the schema lists
/// reads free and writes at `Change`, or at the tier of its Settings row.
pub fn omp_setting_tier(path: &str, entry: Option<&Value>, write: bool, full: bool) -> Tier {
    let Some(entry) = entry else {
        return Tier::Never;
    };
    if entry.get("secret") == Some(&Value::Bool(true)) {
        return Tier::Never;
    }
    if full && FULL_CONTROL_SETTINGS.contains(&path) {
        return if write { Tier::Sensitive } else { Tier::Read };
    }
    if power_setting(path) {
        return Tier::Never;
    }
    if !write {
        return Tier::Read;
    }
    match settings::by_id(path) {
        Some(row) if row.pref_key().is_none() => row.tier,
        _ => Tier::Change,
    }
}

/// Why `value` does not fit the setting the schema describes (its type, and its options for an enum); `None` when it
/// does.
pub fn setting_value_problem(entry: &Value, value: &Value) -> Option<String> {
    let name = entry.get("path").and_then(Value::as_str).unwrap_or("");
    let kind = entry.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "boolean" => (!value.is_boolean()).then(|| format!("{name} takes true or false")),
        "number" => (!value.is_number()).then(|| format!("{name} takes a number")),
        "string" => (!value.is_string()).then(|| format!("{name} takes a string")),
        "enum" => {
            let options: Vec<&Value> = entry
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| option.get("value"))
                .collect();
            if let Some(text) = value.as_str()
                && (options.is_empty()
                    || options.iter().any(|option| option.as_str() == Some(text)))
            {
                return None;
            }
            let listed: Vec<String> = options
                .iter()
                .map(|option| super::text::js_string(Some(option)))
                .collect();
            Some(format!("{name} takes one of: {}", listed.join(", ")))
        }
        "array" => (!value.is_array()).then(|| format!("{name} takes a list")),
        "record" => (!value.is_object()).then(|| format!("{name} takes an object (key to value)")),
        other => Some(format!("{name} has a type ({other}) an agent cannot write")),
    }
}

/// True when some value inside holds another command (an object with a `type`): a route no action offers.
fn nests_command(value: &Value, depth: usize) -> bool {
    if depth > 0
        && let Value::Object(map) = value
        && map.contains_key("type")
    {
        return true;
    }
    match value {
        Value::Object(map) => map.values().any(|inner| nests_command(inner, depth + 1)),
        Value::Array(items) => items.iter().any(|inner| nests_command(inner, depth + 1)),
        _ => false,
    }
}

/// The tier an omp command needs. A command another command carries, or one not listed, is `Never`.
pub fn rpc_tier(command: &Value, full: bool) -> Tier {
    if nests_command(command, 0) {
        return Tier::Never;
    }
    let Some(kind) = command.get("type").and_then(Value::as_str) else {
        return Tier::Never;
    };
    let field = |name: &str| command.get(name).and_then(Value::as_str);
    match kind {
        "get_usage"
        | "get_providers"
        | "get_model_roles"
        | "get_available_models"
        | "get_mcp_servers" => Tier::Read,
        "get_settings" => {
            let Some(paths) = command
                .get("paths")
                .and_then(Value::as_array)
                .filter(|paths| !paths.is_empty())
            else {
                return Tier::Never;
            };
            let readable = paths.iter().all(|path| {
                path.as_str().is_some_and(|path| {
                    (full && FULL_CONTROL_SETTINGS.contains(&path))
                        || (!power_setting(path)
                            && settings::by_id(path).is_some_and(|row| row.pref_key().is_none()))
                })
            });
            if readable { Tier::Read } else { Tier::Never }
        }
        "set_setting" => field("path").map_or(Tier::Never, |path| setting_tier(path, full)),
        "set_model" | "set_model_role" | "set_thinking_level" => Tier::Change,
        "login" | "mcp_add" | "mcp_reauth" => Tier::Sensitive,
        "mcp_action" => {
            if field("action") == Some("adopt") {
                Tier::Sensitive
            } else {
                Tier::Never
            }
        }
        "marketplace_action" => {
            if field("action") == Some("install") {
                Tier::Sensitive
            } else {
                Tier::Never
            }
        }
        _ => Tier::Never,
    }
}
