use std::time::Duration;

use serde_json::{Map, Value};

use crate::server::Scope;
use crate::stock::native::Service;

use super::protocol::{CommandError, CommandResult, RpcCommand};

pub const COMMANDS: &[&str] = &["history_recent", "history_search"];

/// Reads use the execution machine's one native Stock history handle, not its busy tab's omp thread.
/// The request future owns Stock's withdrawal guard: dropping a pending local call withdraws it as well.
pub async fn handle(command: &RpcCommand, stock: &Service) -> CommandResult {
    let mut params = Map::new();
    if let Some(limit) = command.params.get("limit") {
        if !limit.as_f64().is_some_and(|limit| limit.is_finite() && limit.fract() == 0.0) {
            return Err(CommandError::Other("Invalid history limit".into()));
        }
        params.insert("limit".into(), limit.clone());
    }
    if let Some(cwd) = command.params.get("cwd") {
        if !cwd.is_string() { return Err(CommandError::Other("Invalid history cwd".into())); }
        params.insert("cwd".into(), cwd.clone());
    }
    let method = match command.kind.as_str() {
        "history_recent" => "history.recent",
        "history_search" => {
            let query = command.string("query").ok_or_else(|| CommandError::Other("Invalid history query".into()))?;
            params.insert("query".into(), Value::String(query.to_owned()));
            "history.search"
        }
        name => return Err(CommandError::Other(format!("Unknown Stock command: {name}"))),
    };
    stock.request(method, &Value::Object(params), Duration::from_secs(30), Scope::detached()).await.map(Some).map_err(Into::into)
}
