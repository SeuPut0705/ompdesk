//! The running rule for an MCP server's own package. npm and Bun replace the whole package dir (new directory inode;
//! a later `require` reads the new version's file, files only the old version had are gone), Homebrew removes the old
//! keg, and pipx, `uv tool` and pip rewrite site-packages in place: a script (shebang, an interpreter loading its
//! modules lazily) that runs while that happens can load a file of the other version or find it missing, so its
//! update waits. A native binary (Mach-O/ELF/PE) keeps running from its old inode and updates at once. Main lists the
//! processes (`ps`, macOS only) and hands their command lines in.

use serde::Deserialize;

use super::mcp::command_name;
use crate::fs::order::{is_js_space, js_trim};

/// An update by `method` of a file of this kind must wait while the server runs: the owners whose update replaces
/// files a running script loads lazily.
pub fn defers(method: Option<&str>, script: bool) -> bool {
    script
        && matches!(
            method,
            Some("npm" | "bun" | "brew" | "brew-cask" | "pipx" | "uv" | "pip")
        )
}

#[derive(Deserialize)]
pub struct Params {
    /// `ps` command lines, one process a line.
    commands: String,
    /// The server's `command` as configured.
    command: String,
    binary: Binary,
}

/// What main found of the command's binary (`McpBinary`): where it is and who owns it.
#[derive(Deserialize)]
struct Binary {
    path: String,
    real: String,
    owner: Option<Owner>,
}

#[derive(Deserialize)]
struct Owner {
    method: String,
    name: Option<String>,
    root: Option<String>,
    venv: Option<String>,
    dir: Option<String>,
}

/// `needle` appears in `text` as a whole path: not the tail of a longer one, not the head of a longer name.
fn mentions(text: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(found) = text[from..].find(needle) {
        let at = from + found;
        let before = text[..at].chars().next_back();
        let after = text[at + needle.len()..].chars().next();
        if before.is_none_or(|c| is_js_space(c) || matches!(c, '=' | '"' | '\'' | ':'))
            && after.is_none_or(|c| is_js_space(c) || matches!(c, '/' | '"' | '\''))
        {
            return true;
        }
        from = at + text[at..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Whether a process of this server runs: its executable, its package dir, or its command name as the program.
pub fn server_running(params: &Params) -> bool {
    let Params {
        commands,
        command,
        binary,
    } = params;
    let name = command_name(command);
    // The directory, or the keg, an update of this owner replaces.
    let (dir, fragment) = match &binary.owner {
        Some(owner) => match owner.method.as_str() {
            "npm" | "bun" => (owner.root.as_deref(), None),
            "pipx" => (owner.venv.as_deref(), None),
            "uv" => (owner.dir.as_deref(), None),
            "brew" => (
                None,
                owner.name.as_ref().map(|name| format!("/Cellar/{name}/")),
            ),
            "brew-cask" => (
                None,
                owner.name.as_ref().map(|name| format!("/Caskroom/{name}/")),
            ),
            _ => (None, None),
        },
        None => (None, None),
    };
    let paths: Vec<&str> = [Some(binary.real.as_str()), Some(binary.path.as_str()), dir]
        .into_iter()
        .flatten()
        .filter(|path| !path.is_empty())
        .collect();
    commands.split('\n').any(|line| {
        let text = js_trim(line);
        let Some(first) = text
            .split(is_js_space)
            .next()
            .filter(|first| !first.is_empty())
        else {
            return false;
        };
        first == command
            || command_name(first) == name
            || paths.iter().any(|path| mentions(text, path))
            || fragment
                .as_ref()
                .is_some_and(|fragment| text.contains(fragment.as_str()))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::captured;
    use super::*;

    #[test]
    fn defers_as_the_typescript_did() {
        for row in captured("defers") {
            assert_eq!(
                defers(row[0].as_str(), row[1].as_bool().unwrap()),
                row[2].as_bool().unwrap(),
                "{row}"
            );
        }
    }

    #[test]
    fn finds_a_running_server_as_the_typescript_did() {
        for row in captured("running") {
            let params: Params = serde_json::from_value(
                json!({ "commands": row[0], "command": row[1], "binary": row[2] }),
            )
            .unwrap();
            assert_eq!(server_running(&params), row[3].as_bool().unwrap(), "{row}");
        }
    }
}
