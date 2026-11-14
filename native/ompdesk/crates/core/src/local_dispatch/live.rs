use serde_json::{Map, Value, json};

use crate::control::js::string_of_value;
use crate::pool::application::Sidecar;
use crate::server::Fault;

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &[
    "transcribe_audio", "synthesize_speech", "stt_prepare", "debug",
    "browser_relay_start", "browser_relay_stop", "get_security_dashboard",
    "get_security_scan", "security_start", "security_cancel", "security_set_disposition",
    "security_validate", "get_ssh_hosts", "ssh_manage", "ssh_test",
    "autopilot_bridge", "get_autopilot", "set_autopilot",
];

const AUTOPILOT_METHODS: &[&str] = &[
    "modes.autopilot_arm", "modes.autopilot_status", "modes.autopilot_configure",
    "modes.autopilot_note", "modes.autopilot_dismiss", "modes.autopilot_set_state",
    "modes.autopilot_ship_action", "modes.autopilot_mark_reverted",
    "modes.autopilot_take_ship_requests", "modes.autopilot_cycle_amend",
    "modes.autopilot_disarm", "modes.autopilot_guide",
];

pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(command: &RpcCommand, session: &Session<S>) -> CommandResult {
    let result = match command.kind.as_str() {
        "security_validate" => {
            let mut params = Map::new();
            for key in ["scanId", "findingId"] {
                if let Some(value) = command.params.get(key) {
                    params.insert(key.to_owned(), value.clone());
                }
            }
            let response = session.bridge("security_validation_prompt", Value::Object(params)).await?;
            let mut prompt = json!({"type":"prompt", "streamingBehavior":"followUp"});
            if let Some(message) = response.get("prompt") {
                prompt["message"] = message.clone();
            }
            session.stock(prompt).await?;
            json!({"accepted":true})
        }
        "autopilot_bridge" => {
            let method = command.string("method").filter(|method| AUTOPILOT_METHODS.contains(method))
                .ok_or_else(|| CommandError::local("invalid_method", format!("{} is not an autopilot method.", command.params.get("method").map(string_of_value).unwrap_or_else(|| "undefined".to_owned()))))?;
            session.bridge_optional(method, command.params.get("params").cloned()).await?
        }
        // These are the host-without-coordinator fallbacks. The admitted local application dispatcher handles
        // get/set_autopilot through the real coordinator before invoking this source binding (ipc.ts parity).
        "get_autopilot" => session.bridge("modes.autopilot_status", json!({})).await?,
        "set_autopilot" => return Err(CommandError::local("autopilot_local_only", "Autopilot is controlled from the OMPdesk window on this computer.")),
        name => {
            let method = match name {
                "browser_relay_start" => "browser.relay_start",
                "browser_relay_stop" => "browser.relay_stop",
                "get_security_dashboard" => "security_dashboard",
                "get_security_scan" => "security_scan",
                "get_ssh_hosts" => "ssh_hosts",
                "transcribe_audio" | "synthesize_speech" | "stt_prepare" | "debug" |
                "security_start" | "security_cancel" | "security_set_disposition" |
                "ssh_manage" | "ssh_test" => name,
                _ => return Err(CommandError::Other(format!("Unknown live bridge command: {name}"))),
            };
            session.forward(method, command).await?
        }
    };
    Ok(Some(result))
}
