//! The extensions of this computer's omp, for the updater that keeps them current (was the rules of
//! `src/main/ext-update/`): what an MCP server's configured launch is (`ext.mcpClasses`), the row each marketplace,
//! plugin, skill and MCP server gets, with the method that keeps it current or the reason it is left alone
//! (`ext.seeds`), what the file a server's command resolves to says about itself (`ext.binaryFacts`), whether an
//! update must wait for a running server (`ext.defersWhileRunning`, `ext.serverRunning`), and the newest version in a
//! registry lookup's output (`ext.pipLatest`, `ext.registryLatest`).
//!
//! Main keeps the schedule, the stock helper's inventory and upgrades, the lookups and updates it runs, and what it
//! shares with the tool CLIs and machine setup: finding a command along the spawn PATH and telling which package
//! manager owns an install. Those answer synchronously while omp is found and repaired, before this process can be
//! counted on.

mod binary;
mod latest;
mod mcp;
mod running;
mod seeds;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;

use crate::server::{Fault, Registry, Reply};

/// JavaScript's LineTerminator: what `.` does not match and `^` follows under the `m` flag.
fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The params as `T`. A mismatch says where it is and never what stood there: a server's arguments and URL, and
/// the command lines of the running processes, can carry a token.
fn params<T: DeserializeOwned>(params: &RawValue) -> Result<T, Fault> {
    serde_json::from_str(params.get()).map_err(|error| {
        Fault::new(
            "invalid_params",
            format!(
                "The parameters are not what the method takes ({:?} error at column {})",
                error.classify(),
                error.column()
            ),
        )
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassesParams {
    servers: Vec<mcp::Server>,
    /// The built-in REA's root (a server whose source is under it is the built-in).
    rea_root: Option<String>,
}

#[derive(Deserialize)]
struct DefersParams {
    /// The owner's method, as the row names it.
    method: Option<String>,
    script: bool,
}

#[derive(Deserialize)]
struct OutputParams {
    output: String,
}

pub fn register(registry: &mut Registry) {
    registry.add("ext.mcpClasses", |call| {
        Box::pin(async move {
            let params: ClassesParams = params(&call.params)?;
            let classes: Vec<_> = params
                .servers
                .iter()
                .map(|server| mcp::classify(server, params.rea_root.as_deref()))
                .collect();
            Reply::json(&classes)
        })
    });
    registry.add("ext.seeds", |call| {
        Box::pin(async move { Reply::json(&seeds::seeds(params(&call.params)?)?) })
    });
    registry.add("ext.binaryFacts", |call| {
        Box::pin(async move {
            let params: binary::Params = params(&call.params)?;
            let facts = tokio::task::spawn_blocking(move || binary::facts(&params))
                .await
                .map_err(|_| Fault::new("internal", "The file read panicked"))?;
            Reply::json(&facts)
        })
    });
    registry.add("ext.defersWhileRunning", |call| {
        Box::pin(async move {
            let params: DefersParams = params(&call.params)?;
            Reply::json(&running::defers(params.method.as_deref(), params.script))
        })
    });
    registry.add("ext.serverRunning", |call| {
        Box::pin(async move { Reply::json(&running::server_running(&params(&call.params)?)) })
    });
    registry.add("ext.pipLatest", |call| {
        Box::pin(async move {
            let params: OutputParams = params(&call.params)?;
            Reply::json(&latest::pip(&params.output)?)
        })
    });
    registry.add("ext.registryLatest", |call| {
        Box::pin(async move {
            let params: OutputParams = params(&call.params)?;
            Reply::json(&latest::registry(&params.output)?)
        })
    });
}

/// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted.
#[cfg(test)]
fn captured(table: &str) -> Vec<serde_json::Value> {
    let rows: serde_json::Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    rows[table].as_array().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_shape_tells_nothing_of_what_it_held() {
        // A server whose arguments came as one string: serde's own words would quote it.
        let text = r#"{"servers":[{"name":"s","type":"stdio","command":"npx","args":"--token=hunter2","url":null,"enabled":true,"sourcePath":null}],"reaRoot":null}"#;
        let raw = RawValue::from_string(text.into()).unwrap();
        let fault = params::<ClassesParams>(&raw).err().unwrap();
        assert_eq!(fault.code, "invalid_params");
        assert!(!fault.message.contains("hunter2"), "{}", fault.message);
        assert!(fault.message.contains("column"), "{}", fault.message);
    }
}
