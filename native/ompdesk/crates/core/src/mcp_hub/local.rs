//! Local MCP command decisions around the live stock bridge. Discovery, config writes, connection state and OAuth
//! remain stock's; the native dispatcher executes these explicit bridge effects and applies the completed change.

use serde::Serialize;
use serde_json::{Value, json};

use crate::server::Fault;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Change {
    pub names: Vec<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub all: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}

impl Change {
    pub fn plan(&self) -> Value {
        json!({"reload":false,"restart":false,"reconnect":[],"mcp":self})
    }
}

pub struct BridgeRequest {
    pub method: &'static str,
    pub params: Option<Value>,
}

pub enum Step {
    Bridge(BridgeRequest),
    Complete {
        value: Value,
        change: Option<Change>,
    },
}

#[derive(Clone, Copy)]
enum Phase {
    BuiltinGuard,
    Command,
    Finished,
}

pub struct Call {
    method: &'static str,
    params: Value,
    phase: Phase,
}

impl Call {
    pub fn new(mut command: Value) -> Result<Self, Fault> {
        let method = match command.get("type").and_then(Value::as_str) {
            Some("get_mcp_servers") => "get_mcp_servers",
            Some("mcp_action") => "mcp_action",
            Some("mcp_add") => "mcp_add",
            Some("mcp_reload") => "mcp_reload",
            Some("mcp_reauth") => "mcp_reauth",
            Some("mcp_test") => "mcp_test",
            Some("mcp_reauth_cancel") => "mcp_reauth_cancel",
            _ => return Err(Fault::new("unknown_command", "Unknown MCP command")),
        };
        let object = command
            .as_object_mut()
            .ok_or_else(|| Fault::new("invalid_params", "Expected MCP command object"))?;
        object.remove("type");
        object.remove("id");
        if method == "mcp_action"
            && object
                .get("name")
                .and_then(Value::as_str)
                .is_none_or(|name| crate::fs::order::js_trim(name).is_empty())
        {
            return Err(Fault::new(
                "invalid_params",
                "MCP server name must be a non-empty string",
            ));
        }
        if method == "mcp_reauth" {
            let name = object.get("name").cloned();
            object.clear();
            if let Some(name) = name {
                object.insert("name".into(), name);
            }
        }
        Ok(Self {
            method,
            params: command,
            phase: if method == "mcp_action" {
                Phase::BuiltinGuard
            } else {
                Phase::Command
            },
        })
    }

    pub fn first(&self) -> BridgeRequest {
        match self.phase {
            Phase::BuiltinGuard => BridgeRequest {
                method: "get_mcp_servers",
                params: None,
            },
            Phase::Command | Phase::Finished => BridgeRequest {
                method: self.method,
                params: Some(self.params.clone()),
            },
        }
    }

    pub fn accept(&mut self, reply: Value) -> Result<Step, Fault> {
        match self.phase {
            Phase::BuiltinGuard => {
                let name = self.params.get("name");
                let servers = reply
                    .get("servers")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        Fault::new("bridge_invalid_reply", "MCP server list is unavailable")
                    })?;
                if servers.iter().any(|server| {
                    server.get("name") == name
                        && server.get("builtin").and_then(Value::as_str) == Some("rea")
                }) {
                    self.phase = Phase::Finished;
                    return Err(Fault::new(
                        "invalid_params",
                        "Use the built-in REA toggle; changes apply to new sessions",
                    ));
                }
                self.phase = Phase::Command;
                Ok(Step::Bridge(self.first()))
            }
            Phase::Command => {
                self.phase = Phase::Finished;
                if self.method == "mcp_reauth"
                    && let Some(busy) = reply.get("busy").and_then(Value::as_str)
                {
                    return Err(Fault::new(
                        "oauth_busy",
                        format!(
                            "MCP OAuth reauthorization already in progress for \"{busy}\". Complete or cancel it before starting another."
                        ),
                    ));
                }
                let name = self.params.get("name").and_then(Value::as_str);
                let change = match self.method {
                    "mcp_reload" => Some(Change {
                        names: vec![],
                        all: true,
                    }),
                    "mcp_action" | "mcp_add" => name.map(|name| Change {
                        names: vec![name.into()],
                        all: false,
                    }),
                    "mcp_reauth" if reply.get("ok") == Some(&Value::Bool(true)) => {
                        name.map(|name| Change {
                            names: vec![name.into()],
                            all: false,
                        })
                    }
                    _ => None,
                };
                Ok(Step::Complete {
                    value: reply,
                    change,
                })
            }
            Phase::Finished => Err(Fault::new("mcp_completed", "MCP command already completed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed(call: &mut Call, reply: Value) -> (Value, Option<Change>) {
        match call.accept(reply).unwrap() {
            Step::Complete { value, change } => (value, change),
            Step::Bridge(_) => panic!("unexpected bridge request"),
        }
    }

    #[test]
    fn builtin_action_is_refused_before_any_stock_mutation() {
        let mut call =
            Call::new(json!({"type":"mcp_action","name":"rea","action":"remove","id":"frame"}))
                .unwrap();
        assert_eq!(call.first().method, "get_mcp_servers");
        let fault = call
            .accept(json!({"servers":[{"name":"rea","builtin":"rea"}]}))
            .err()
            .unwrap();
        assert_eq!(fault.code, "invalid_params");
        assert_eq!(
            fault.message,
            "Use the built-in REA toggle; changes apply to new sessions"
        );
        assert!(Call::new(json!({"type":"mcp_action","name":"\u{feff} "})).is_err());
    }

    #[test]
    fn action_add_reload_and_successful_signin_emit_the_native_pool_plan() {
        let mut action =
            Call::new(json!({"type":"mcp_action","name":"other","action":"adopt","id":3})).unwrap();
        let Step::Bridge(request) = action.accept(json!({"servers":[]})).unwrap() else {
            panic!("expected guard then mutation");
        };
        assert_eq!(request.method, "mcp_action");
        assert_eq!(
            request.params,
            Some(json!({"name":"other","action":"adopt"}))
        );
        let warning = json!({"warning":"server could not connect"});
        let (value, change) = completed(&mut action, warning.clone());
        assert_eq!(value, warning);
        assert_eq!(
            change.unwrap().plan(),
            json!({"reload":false,"restart":false,"reconnect":[],"mcp":{"names":["other"]}})
        );
        let mut add =
            Call::new(json!({"type":"mcp_add","name":"new","config":{"url":"http://fixture"}}))
                .unwrap();
        assert_eq!(completed(&mut add, json!({})).1.unwrap().names, ["new"]);
        let mut reload = Call::new(json!({"type":"mcp_reload"})).unwrap();
        assert_eq!(
            completed(&mut reload, json!({})).1.unwrap().plan()["mcp"],
            json!({"names":[],"all":true})
        );
        let mut auth =
            Call::new(json!({"type":"mcp_reauth","name":"signed","extra":"not forwarded"}))
                .unwrap();
        assert_eq!(auth.first().params, Some(json!({"name":"signed"})));
        assert_eq!(
            completed(&mut auth, json!({"ok":true})).1.unwrap().names,
            ["signed"]
        );
    }

    #[test]
    fn busy_cancel_failed_signin_and_read_commands_never_fanout() {
        let mut auth = Call::new(json!({"type":"mcp_reauth","name":"one"})).unwrap();
        assert_eq!(
            auth.accept(json!({"busy":"other"})).err().unwrap().code,
            "oauth_busy"
        );
        for kind in [
            "get_mcp_servers",
            "mcp_test",
            "mcp_reauth_cancel",
            "mcp_reauth",
        ] {
            let mut call = Call::new(json!({"type":kind,"name":"one","id":99})).unwrap();
            assert_eq!(call.first().method, kind);
            assert_eq!(call.first().params, Some(json!({"name":"one"})));
            let response = json!({"ok":false,"cancelled":true});
            assert_eq!(completed(&mut call, response.clone()), (response, None));
        }
    }
}
