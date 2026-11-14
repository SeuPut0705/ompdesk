use std::path::Path;

use serde_json::{Value, json};

use crate::run::{Exec, Opts, Output};
use crate::server::Fault;

const REQUEST_ID: &str = "gui-rename";
const ARGS: [&str; 8] = [
    "--mode", "rpc", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title",
];

/// The caller holds Base's canonical session admission/operation lease until this supervised omp exits. The stock
/// RPC writes its title slot, title_change and title index; native code never edits a stock journal itself.
pub(crate) async fn rename(
    exec: Exec,
    scratch: &Path,
    session: &Path,
    name: &str,
) -> Result<(), Fault> {
    if session.extension().is_none_or(|extension| extension != "jsonl") {
        return Err(Fault::new("session_rename", "Invalid session path"));
    }
    tokio::fs::metadata(session)
        .await
        .map_err(|_| Fault::new("session_rename", "Session file not found"))?;
    let mut input = serde_json::to_vec(&json!({"id":REQUEST_ID,"type":"set_session_name","name":name}))
        .map_err(|error| Fault::new("json", error.to_string()))?;
    input.push(b'\n');
    let cwd = scratch.to_string_lossy();
    let session = session.to_string_lossy();
    let mut args = Vec::with_capacity(ARGS.len() + 4);
    args.extend(ARGS);
    args.extend(["--session", session.as_ref()]);
    let opts = Opts {
        timeout_ms: Some(30_000),
        env: &[("PI_NOTIFICATIONS", "off")],
        input: Some(&input),
        ..Opts::default()
    };
    let mut output = exec.run(&cwd, &args, opts).await?;
    let mut response = rename_response(&output);
    if response.is_none() && model_restore_failure(&output.stderr) {
        args.extend(["--model", "@default"]);
        output = exec.run(&cwd, &args, opts).await?;
        response = rename_response(&output);
    }
    match response {
        Some(Ok(())) => Ok(()),
        Some(Err(message)) => Err(Fault::new("session_rename", message)),
        None => {
            let detail = output.stderr.trim().lines().next().unwrap_or_default();
            let message = if detail.is_empty() {
                "omp could not open the session to rename it".to_owned()
            } else {
                format!("omp could not open the session to rename it: {detail}")
            };
            Err(Fault::new("session_rename", message))
        }
    }
}

fn rename_response(output: &Output) -> Option<Result<(), String>> {
    output.stdout.split(|byte| *byte == b'\n').find_map(|line| {
        let frame: Value = serde_json::from_slice(line).ok()?;
        if frame["type"] != "response" || frame["id"] != REQUEST_ID {
            return None;
        }
        Some(if frame["success"] == true {
            Ok(())
        } else {
            Err(frame["error"].as_str().unwrap_or("Session rename failed").to_owned())
        })
    })
}

/// Native counterpart of src/shared/model-restore.ts::parseModelRestoreFailure, which the React page still uses.
fn model_restore_failure(text: &str) -> bool {
    text.split("Could not restore model ").skip(1).find_map(|rest| {
        let end = rest.find(|character: char| {
            !(character.is_ascii_alphanumeric() || "_.:@/+-".contains(character))
        }).unwrap_or(rest.len());
        (end != 0).then(|| !rest[..end].trim_end_matches(['.', ':']).is_empty())
    }).unwrap_or(false)
}
