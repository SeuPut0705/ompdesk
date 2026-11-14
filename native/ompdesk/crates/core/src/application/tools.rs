use std::sync::{Arc, OnceLock};

use serde::Deserialize;
use serde_json::Value;

use crate::server::Fault;

#[derive(Clone)]
pub struct HostTools {
    pub base: Arc<[Value]>,
    pub control: Arc<[Value]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definitions {
    host_tools: Vec<Value>,
    control_tools: Vec<Value>,
}

impl HostTools {
    /// Generated from the terminal, preview and agent-control definitions by native-app-data.ts.
    pub fn bundled() -> Result<Self, Fault> {
        static TOOLS: OnceLock<Result<HostTools, Fault>> = OnceLock::new();
        TOOLS
            .get_or_init(|| {
                let tools: Definitions = serde_json::from_str(include_str!(
                    "../../assets/host-tools.json"
                ))
                .map_err(|error| Fault::new("native_tool_definitions", error.to_string()))?;
                Ok(Self {
                    base: tools.host_tools.into(),
                    control: tools.control_tools.into(),
                })
            })
            .clone()
    }
}
