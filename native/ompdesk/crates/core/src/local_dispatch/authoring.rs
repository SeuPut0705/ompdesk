use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::agentctl::service::host::node_resolve;
use crate::disk::tree;
use crate::pool::application::Sidecar;
use crate::server::Fault;

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

pub const COMMANDS: &[&str] = &["read_agent_file", "write_agent_file", "delete_agent_file", "install_agent_templates"];

/// Ordered, pre-rendered templates from the application's canonical template catalog.
#[derive(serde::Deserialize)]
pub struct Template {
    pub name: String,
    pub content: String,
}

struct Dirs {
    user: PathBuf,
    project: PathBuf,
}

impl Dirs {
    fn from_bridge(info: &Value) -> Result<Self, CommandError> {
        let path = |scope: &str| info["dirs"][scope].as_str()
            .map(|value| PathBuf::from(node_resolve(value)))
            .ok_or_else(|| CommandError::Other(format!("Missing {scope} agent directory")));
        Ok(Self { user: path("user")?, project: path("project")? })
    }

    fn scope(&self, value: Option<&Value>) -> Result<&Path, CommandError> {
        match value.and_then(Value::as_str) {
            Some("user") => Ok(&self.user),
            Some("project") => Ok(&self.project),
            _ => Err(CommandError::local("invalid_scope", "`scope` must be \"user\" or \"project\".")),
        }
    }

    fn locate(&self, value: Option<&Value>) -> Result<(PathBuf, &'static str), CommandError> {
        let file = value.and_then(Value::as_str).map(PathBuf::from)
            .filter(|file| file.is_absolute() && file.extension().is_some_and(|ext| ext == "md"))
            .ok_or_else(|| CommandError::local("path_outside", "Not an agent definition file path."))?;
        let parent = real_or_resolved(file.parent().unwrap_or(Path::new("")));
        for (scope, dir) in [("project", &self.project), ("user", &self.user)] {
            if parent == real_or_resolved(dir) { return Ok((file, scope)); }
        }
        Err(CommandError::local("path_outside", "The file is outside the user and project agent directories."))
    }
}

fn real_or_resolved(path: &Path) -> PathBuf {
    let resolved = PathBuf::from(node_resolve(&path.to_string_lossy()));
    fs::canonicalize(&resolved).unwrap_or(resolved)
}

fn io_error(path: &Path, error: std::io::Error) -> CommandError {
    CommandError::Other(format!("{}: {error}", path.display()))
}

fn error_message(error: CommandError) -> String {
    match error { CommandError::Local { message, .. } | CommandError::Other(message) => message }
}

fn checked_name(value: Option<&Value>) -> Result<&str, CommandError> {
    let name = value.and_then(Value::as_str)
        .ok_or_else(|| CommandError::local("invalid_name", "`name` must be a string."))?.trim();
    let reason = if name.is_empty() { Some("required") }
        else if name.eq_ignore_ascii_case("main") || name.eq_ignore_ascii_case("sub") { Some("reserved") }
        else if name.len() > 64 || !name.as_bytes()[0].is_ascii_alphanumeric()
            || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')) { Some("invalid") }
        else { None };
    if let Some(reason) = reason { return Err(CommandError::local("invalid_name", format!("Invalid agent name ({reason})."))); }
    Ok(name)
}

fn exclusive_write(target: &Path, content: &str) -> Result<(), CommandError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = target.parent().unwrap_or(Path::new(""));
    let (temp, mut file) = loop {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let temp = dir.join(format!(".{}.{}-{id}.tmp", target.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o644); }
        match options.open(&temp) {
            Ok(file) => break (temp, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(&temp, error)),
        }
    };
    let result = (|| {
        file.write_all(content.as_bytes()).map_err(|error| io_error(&temp, error))?;
        drop(file);
        match fs::hard_link(&temp, target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(CommandError::local("exists", format!("An agent file named {} already exists.", target.file_name().unwrap_or_default().to_string_lossy()))),
            Err(error) => Err(io_error(target, error)),
        }
    })();
    let cleanup = fs::remove_file(&temp).map_err(|error| io_error(&temp, error));
    cleanup?;
    result
}
pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(command: &RpcCommand, session: &Session<S>, templates: &[Template]) -> CommandResult {
    let info = session.bridge("get_agent_authoring", json!({})).await?;
    let dirs = Dirs::from_bridge(&info)?;
    execute(command, &dirs, templates, |content, source| async move {
        session.bridge("validate_agent_definition", json!({"content":content,"source":source})).await
    }).await.map(Some)
}
async fn execute<F, Fut>(command: &RpcCommand, dirs: &Dirs, templates: &[Template], validate: F) -> Result<Value, CommandError>
where F: Fn(String, String) -> Fut, Fut: Future<Output = Result<Value, CommandError>> {
    match command.kind.as_str() {
        "read_agent_file" => {
            let (file, scope) = dirs.locate(command.params.get("filePath"))?;
            let bytes = fs::read(&file).map_err(|error| io_error(&file, error))?;
            let content = String::from_utf8_lossy(&bytes).into_owned();
            let path = file.to_string_lossy().into_owned();
            let mut result = json!({"filePath":path,"scope":scope,"content":content});
            match validate(content, path).await {
                Ok(parsed) => result["parsed"] = parsed,
                Err(error) => result["parseError"] = json!(error_message(error)),
            }
            Ok(result)
        }
        "delete_agent_file" => {
            let (file, _) = dirs.locate(command.params.get("filePath"))?;
            fs::remove_file(&file).map_err(|error| io_error(&file, error))?;
            Ok(json!({"deleted":file.to_string_lossy()}))
        }
        "write_agent_file" => {
            let dir = dirs.scope(command.params.get("scope"))?;
            let name = checked_name(command.params.get("name"))?;
            let content = command.string("content").ok_or_else(|| CommandError::local("invalid_content", "`content` must be a string."))?;
            if content.len() > 512 * 1024 { return Err(CommandError::local("invalid_content", "The agent file is too large.")); }
            let target = dir.join(format!("{name}.md"));
            let parsed = validate(content.to_owned(), target.to_string_lossy().into_owned()).await
                .map_err(|error| CommandError::local("invalid_content", error_message(error)))?;
            if parsed["fields"]["name"].as_str() != Some(name) {
                return Err(CommandError::local("invalid_content", "The frontmatter name does not match the file name."));
            }
            if target.parent() != Some(dir) { return Err(CommandError::local("invalid_name", "Invalid agent name.")); }
            let previous = match command.params.get("replacePath") {
                None | Some(Value::Null) => None,
                value => Some(dirs.locate(value)?.0),
            };
            fs::create_dir_all(dir).map_err(|error| io_error(dir, error))?;
            if previous.as_ref().is_some_and(|file| real_or_resolved(file) == real_or_resolved(&target)) {
                tree::write_atomic_if(&target, content.as_bytes(), Some(0o644), 0o777, &|| true).map_err(CommandError::from)?;
            } else {
                exclusive_write(&target, content)?;
                if let Some(file) = previous {
                    match fs::remove_file(&file) {
                        Ok(()) => (),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                        Err(error) => return Err(io_error(&file, error)),
                    }
                }
            }
            Ok(json!({"filePath":target.to_string_lossy()}))
        }
        "install_agent_templates" => {
            let dir = dirs.scope(command.params.get("scope"))?;
            let names = command.params.get("names").and_then(Value::as_array);
            fs::create_dir_all(dir).map_err(|error| io_error(dir, error))?;
            let mut installed = Vec::new();
            let mut skipped = Vec::new();
            for template in templates {
                if names.is_some_and(|names| !names.iter().any(|name| name.as_str() == Some(template.name.as_str()))) { continue; }
                let target = dir.join(format!("{}.md", template.name));
                validate(template.content.clone(), target.to_string_lossy().into_owned()).await?;
                match exclusive_write(&target, &template.content) {
                    Ok(()) => installed.push(&template.name),
                    Err(CommandError::Local { ref code, .. }) if code == "exists" => skipped.push(&template.name),
                    Err(error) => return Err(error),
                }
            }
            Ok(json!({"dir":dir.to_string_lossy(),"installed":installed,"skipped":skipped}))
        }
        _ => Err(CommandError::Other(format!("Unknown agent authoring RPC command {}", command.kind))),
    }
}

#[cfg(test)]
#[path = "authoring_tests.rs"]
mod tests;
