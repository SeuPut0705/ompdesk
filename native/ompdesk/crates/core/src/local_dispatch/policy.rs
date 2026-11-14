use serde_json::{Map, Value, json};

use crate::agentctl::service::wrap::parse_agent_message;

use super::protocol::RpcCommand;

pub fn persons_prompt(command: &RpcCommand) -> bool {
    matches!(command.kind.as_str(), "prompt" | "steer" | "follow_up")
        && command.string("message").is_some_and(|message| parse_agent_message(message).is_none())
}

pub fn is_stop(kind: &str) -> bool {
    matches!(kind, "abort" | "abort_and_prompt" | "abort_and_restore_queue")
}

pub fn moves_tab(kind: &str) -> bool {
    matches!(kind, "new_session" | "switch_session" | "switch_leaf" | "fork" | "branch")
}

/// Facts supplied by the admitted native caller and the original source. Never deserialized from command args.
#[derive(Default)]
pub struct StopSite<'a> {
    pub tab: &'a str,
    pub session: Option<&'a str>,
    pub window: Option<i64>,
    pub web_device: Option<&'a str>,
    pub peer: Option<&'a str>,
    pub host: Option<&'a str>,
    pub channel: Option<&'a str>,
}

/// The outgoing stock frame and, for Stop, the same runtime-log details as turn-stop-log.ts. The caller writes the
/// log through the application's existing sink before sending the frame. Origin is only attribution, not authority.
pub fn dispatched_command(mut command: RpcCommand, site: StopSite<'_>) -> (RpcCommand, Option<Value>) {
    if !is_stop(&command.kind) { return (command, None); }
    let origin = command.params.get("origin");
    let agent = origin.and_then(|origin|origin.get("agentControl")).and_then(Value::as_str).filter(|value|!value.is_empty());
    let surface = origin.and_then(|origin|origin.get("surface")).and_then(Value::as_str).filter(|value|!value.is_empty());
    let by = if site.peer.is_some() { "desktop-device" } else if agent.is_some() { "agent-control" } else if site.web_device.is_some() { "web-device" } else { "window" };
    let mut details = Map::new();
    details.insert("command".into(), json!(command.kind));
    details.insert("tab".into(), json!(site.tab));
    details.insert("by".into(), json!(by));
    if let Some(session) = site.session.filter(|session|!session.is_empty()) { details.insert("session".into(), json!(session.rsplit(['/', '\\']).next().unwrap_or(session))); }
    if let Some(surface) = surface { details.insert("surface".into(), json!(surface)); }
    if site.peer.is_none() { if let Some(window) = site.window { details.insert("window".into(), json!(window)); } }
    if let Some(device) = site.peer.or(site.web_device) { details.insert("device".into(), json!(device)); }
    if let Some(agent) = agent { details.insert("caller".into(), json!(agent)); }
    if let Some(host) = site.host { details.insert("host".into(), json!(host)); }
    if surface.is_none() && agent.is_none() { if let Some(channel) = site.channel { details.insert("channel".into(), json!(channel)); } }
    if site.host.is_none() { command.params.remove("origin"); }
    (command, Some(Value::Object(details)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentctl::service::wrap::wrap_agent_message;

    #[test]
    fn only_a_persons_own_message_marks_the_tab_as_prompted() {
        for kind in ["prompt", "steer", "follow_up"] {
            let command: RpcCommand = serde_json::from_value(json!({"type":kind,"message":"Please continue"})).unwrap();
            assert!(persons_prompt(&command));
            let mut wrapped = command.clone();
            wrapped.params.insert("message".into(), json!(wrap_agent_message("Please continue", "Child", None)));
            assert!(!persons_prompt(&wrapped));
        }
        let retry: RpcCommand = serde_json::from_value(json!({"type":"retry","message":"Please continue"})).unwrap();
        assert!(!persons_prompt(&retry));
    }

    #[test]
    fn local_stop_strips_origin_after_logging_but_a_paired_host_receives_it() {
        let command: RpcCommand = serde_json::from_value(json!({"type":"abort_and_restore_queue","id":"window-1","origin":{"surface":"composer"}})).unwrap();
        let (local, details) = dispatched_command(command.clone(), StopSite {tab:"tab",session:Some("C:\\private\\session.jsonl"),window:Some(-4),web_device:Some("phone"),channel:Some("rpc:command"),..StopSite::default()});
        assert!(local.params.get("origin").is_none());
        assert_eq!(details.unwrap(), json!({"command":"abort_and_restore_queue","tab":"tab","by":"web-device","session":"session.jsonl","surface":"composer","window":-4,"device":"phone"}));
        let (remote, details) = dispatched_command(command.clone(), StopSite {tab:"tab",peer:Some("desktop"),host:Some("host"),..StopSite::default()});
        assert_eq!(remote.params["origin"], command.params["origin"]);
        assert_eq!(details.unwrap()["by"], "desktop-device");
    }
}
