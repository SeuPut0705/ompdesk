use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::server::Fault;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RpcCommand {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(flatten)]
    pub params: Map<String, Value>,
}

impl RpcCommand {
    pub fn fields(&self) -> Value {
        Value::Object(self.params.clone())
    }

    pub fn string(&self, key: &str) -> Option<&str> {
        self.params.get(key).and_then(Value::as_str)
    }

    pub fn is_true(&self, key: &str) -> bool {
        self.params.get(key) == Some(&Value::Bool(true))
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct RpcResponse {
    #[serde(rename = "type")]
    frame_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default, deserialize_with = "present_data", skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn present_data<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// Only the explicit local error variant exposes a code in a local RPC response. A core/bridge error's internal
/// code is not a LocalCommandError (`src/main/local/index.ts` runLocalCommand).
#[derive(Clone, Debug, PartialEq)]
pub enum CommandError {
    Local { message: String, code: String },
    Other(String),
}

impl CommandError {
    pub fn local(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Local { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local { message, .. } | Self::Other(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for CommandError {}

impl From<Fault> for CommandError {
    fn from(fault: Fault) -> Self {
        Self::Other(fault.message)
    }
}

pub type CommandResult = Result<Option<Value>, CommandError>;

impl RpcResponse {
    pub fn local(command: &RpcCommand, result: CommandResult) -> Self {
        let mut response = Self {
            frame_type: "response".into(),
            id: command.id.clone(),
            command: command.kind.clone(),
            success: result.is_ok(),
            data: None,
            error: None,
            code: None,
        };
        match result {
            Ok(data) => response.data = data,
            Err(CommandError::Local { message, code }) => {
                response.error = Some(message);
                response.code = Some(code);
            }
            Err(CommandError::Other(message)) => response.error = Some(message),
        }
        response
    }

    pub fn with_id(mut self, id: Option<String>) -> Self {
        self.id = id;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_errors_expose_only_explicit_local_codes_and_keep_null_distinct_from_absent() {
        let command: RpcCommand = serde_json::from_value(json!({"type":"plan_approval","id":"page-4"})).unwrap();
        assert_eq!(serde_json::to_value(RpcResponse::local(&command, Ok(Some(Value::Null)))).unwrap(),
            json!({"id":"page-4","type":"response","command":"plan_approval","success":true,"data":null}));
        assert_eq!(serde_json::to_value(RpcResponse::local(&command, Ok(None))).unwrap(),
            json!({"id":"page-4","type":"response","command":"plan_approval","success":true}));
        assert_eq!(serde_json::to_value(RpcResponse::local(&command,
            Err(Fault::new("bridge_fault", "Not connected").into()))).unwrap(),
            json!({"id":"page-4","type":"response","command":"plan_approval","success":false,"error":"Not connected"}));
        assert_eq!(serde_json::to_value(RpcResponse::local(&command,
            Err(CommandError::local("being_answered", "An agent is answering this plan right now")))).unwrap(),
            json!({"id":"page-4","type":"response","command":"plan_approval","success":false,
                "error":"An agent is answering this plan right now","code":"being_answered"}));
    }
}
