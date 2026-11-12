//! What an MCP server's configured launch is, read from the config the user wrote (never changed here): the built-in
//! REA, a remote URL, a package a runner fetches itself (`npx`, `bunx`, `uvx`, `pnpm dlx`, `bun x`, `uv tool run`,
//! `pipx run`, `npm exec`), a command that runs an installed binary, or none of those (an interpreter running a
//! script, a container).
//!
//! A runner package is unpinned when its spec names no version or `@latest` (the runner resolves the newest by itself
//! at start), otherwise pinned: an exact version, a range or a dist-tag all count, because the user chose it.

use serde::{Deserialize, Serialize};

use super::is_line_end;
use crate::fs::order::{is_js_space, js_trim};

/// One server of the stock helper's inventory (`HelperMcpServer`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub name: String,
    /// `stdio`, `http` or `sse`.
    #[serde(rename = "type")]
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub enabled: bool,
    /// The config file or plugin dir the server came from.
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Runner {
    Npx,
    Bunx,
    PnpmDlx,
    BunX,
    NpmExec,
    Uvx,
    UvToolRun,
    PipxRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Ecosystem {
    Npm,
    Pypi,
}

/// The package a runner fetches.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Package {
    pub runner: Runner,
    pub ecosystem: Ecosystem,
    /// The package name without version or extras; the whole spec for a URL or path.
    pub pkg: String,
    /// The version part of the spec; none when it names none (or `latest`).
    pub version: Option<String>,
    /// The spec as written (`pkg@1.2.3`), shown as the row's detail.
    pub spec: String,
    pub pinned: bool,
    /// False for a git URL, a path or a tarball: no registry can say what is newer.
    pub checkable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum McpClass {
    Builtin,
    Remote,
    Runner(Package),
    Direct { command: String },
    Unsupported,
}

/// `C:\x\npx.cmd`, `/usr/bin/NPX` → `npx`.
pub fn command_name(command: &str) -> String {
    let base = command.rsplit(['\\', '/']).next().unwrap_or(command);
    let stem = [".cmd", ".exe", ".bat", ".ps1"]
        .iter()
        .find_map(|extension| strip_suffix_ignore_case(base, extension))
        .unwrap_or(base);
    stem.to_lowercase()
}

/// `text` without `suffix`, compared without ASCII case.
pub(super) fn strip_suffix_ignore_case<'a>(text: &'a str, suffix: &str) -> Option<&'a str> {
    let at = text.len().checked_sub(suffix.len())?;
    text.as_bytes()[at..]
        .eq_ignore_ascii_case(suffix.as_bytes())
        .then(|| &text[..at])
}

/// `python`, `python3`, `python3.12`.
pub(super) fn is_python(name: &str) -> bool {
    name.strip_prefix("python").is_some_and(|rest| {
        rest.bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    })
}

/// Programs that run something else: their own binary is never the server, so it is never "updated".
fn is_interpreter(name: &str) -> bool {
    matches!(
        name,
        "node"
            | "nodejs"
            | "deno"
            | "bun"
            | "npm"
            | "pnpm"
            | "yarn"
            | "python"
            | "py"
            | "uv"
            | "pipx"
            | "poetry"
            | "ruby"
            | "java"
            | "dotnet"
            | "php"
            | "perl"
            | "go"
            | "cargo"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "cmd"
            | "pwsh"
            | "powershell"
            | "env"
            | "docker"
            | "podman"
            | "nerdctl"
            | "wsl"
            | "ssh"
    ) || is_python(name)
}

fn runner_of<'a>(name: &str, args: &'a [String]) -> Option<(Runner, &'a [String])> {
    let first = args.first().map(String::as_str);
    let second = args.get(1).map(String::as_str);
    match name {
        "npx" => Some((Runner::Npx, args)),
        "bunx" => Some((Runner::Bunx, args)),
        "uvx" => Some((Runner::Uvx, args)),
        "pnpm" if first == Some("dlx") => Some((Runner::PnpmDlx, &args[1..])),
        "bun" if first == Some("x") => Some((Runner::BunX, &args[1..])),
        "npm" if matches!(first, Some("exec" | "x")) => Some((Runner::NpmExec, &args[1..])),
        "uv" if first == Some("tool") && second == Some("run") => {
            Some((Runner::UvToolRun, &args[2..]))
        }
        "pipx" if first == Some("run") => Some((Runner::PipxRun, &args[1..])),
        _ => None,
    }
}

struct Flags {
    /// Flags that name the package to fetch.
    package: &'static [&'static str],
    /// Flags that take a value and are not the package.
    value: &'static [&'static str],
}

const NPM_FLAGS: Flags = Flags {
    package: &["-p", "--package"],
    value: &[
        "--registry",
        "--cache",
        "--userconfig",
        "--prefix",
        "--node-options",
        "--loglevel",
        "-w",
        "--workspace",
        "--shell",
        "--otp",
        "--before",
        "--fetch-retries",
    ],
};
const BUNX_FLAGS: Flags = Flags {
    package: &["-p", "--package"],
    value: &["--registry", "--cwd", "-c", "--config", "--cache-dir"],
};
const UV_FLAGS: Flags = Flags {
    package: &["--from"],
    value: &[
        "-w",
        "--with",
        "--with-editable",
        "--with-requirements",
        "-p",
        "--python",
        "--index",
        "-i",
        "--index-url",
        "--default-index",
        "--extra-index-url",
        "-f",
        "--find-links",
        "--index-strategy",
        "-c",
        "--constraints",
        "--overrides",
        "--env-file",
        "--directory",
        "--project",
        "--config-file",
        "--cache-dir",
        "--exclude-newer",
        "--resolution",
        "--prerelease",
        "--python-platform",
        "--link-mode",
        "--keyring-provider",
        "--color",
        "--allow-insecure-host",
        "--refresh-package",
        "--reinstall-package",
        "-P",
        "--upgrade-package",
        "--no-binary-package",
        "--no-build-package",
    ],
};
const PIPX_FLAGS: Flags = Flags {
    package: &["--spec"],
    value: &[
        "--python",
        "--pip-args",
        "-i",
        "--index-url",
        "--fetch-missing-python",
    ],
};

impl Runner {
    fn flags(self) -> &'static Flags {
        match self {
            Runner::Npx | Runner::PnpmDlx | Runner::NpmExec => &NPM_FLAGS,
            Runner::Bunx | Runner::BunX => &BUNX_FLAGS,
            Runner::Uvx | Runner::UvToolRun => &UV_FLAGS,
            Runner::PipxRun => &PIPX_FLAGS,
        }
    }

    fn ecosystem(self) -> Ecosystem {
        match self {
            Runner::Uvx | Runner::UvToolRun | Runner::PipxRun => Ecosystem::Pypi,
            _ => Ecosystem::Npm,
        }
    }
}

/// The package a runner is told to fetch: the first `-p`/`--from`/`--spec` value, else the first positional. None
/// when none can be read.
fn package_arg(runner: Runner, args: &[String]) -> Option<&str> {
    let flags = runner.flags();
    let mut flagged = None;
    let mut literal = false;
    let mut rest = args.iter().map(String::as_str);
    while let Some(arg) = rest.next() {
        if !literal && arg == "--" {
            literal = true;
            continue;
        }
        if literal || !arg.starts_with('-') {
            return flagged.or(Some(arg));
        }
        let (flag, inline) = match arg.find('=') {
            Some(eq) if eq > 0 => (&arg[..eq], Some(&arg[eq + 1..])),
            _ => (arg, None),
        };
        // `npx -c "cmd"` runs a shell string: there is no package to read.
        if flag == "--call" || (flag == "-c" && matches!(runner, Runner::Npx | Runner::NpmExec)) {
            return None;
        }
        let names_package = flags.package.contains(&flag);
        if names_package || flags.value.contains(&flag) {
            let value = inline.or_else(|| rest.next());
            if names_package && flagged.is_none() {
                flagged = value;
            }
        }
    }
    flagged
}

struct Spec {
    pkg: String,
    version: Option<String>,
    checkable: bool,
}

impl Spec {
    /// A URL, a path or a tarball: the whole spec is the package and its own version.
    fn opaque(raw: &str) -> Spec {
        Spec {
            pkg: raw.to_owned(),
            version: Some(raw.to_owned()),
            checkable: false,
        }
    }
}

fn npm_spec(raw: &str) -> Spec {
    let spec = raw.strip_prefix("npm:").unwrap_or(raw);
    let elsewhere = [
        "git+",
        "git@",
        "github:",
        "gitlab:",
        "bitbucket:",
        "file:",
        "link:",
        ".",
        "/",
        "~",
    ];
    // `owner/repo`: a first character other than `@`, then a slash with something after it that is no slash.
    let mut chars = spec.chars();
    let github = chars.next().is_some_and(|first| first != '@')
        && chars
            .as_str()
            .split_once('/')
            .is_some_and(|(_, after)| after.chars().next().is_some_and(|next| next != '/'));
    if spec.contains("://") || elsewhere.iter().any(|prefix| spec.starts_with(prefix)) || github {
        return Spec::opaque(raw);
    }
    let (pkg, version) = match spec.rfind('@') {
        Some(at) if at > 0 => (&spec[..at], &spec[at + 1..]),
        _ => (spec, ""),
    };
    Spec {
        pkg: pkg.to_owned(),
        version: (!version.is_empty() && version != "latest").then(|| version.to_owned()),
        checkable: true,
    }
}

/// The version of `== 1.2.3` or `===1.2.3`: what follows the signs when it is one word.
fn exact_pin(rest: &str) -> Option<&str> {
    // Three signs first, then two: `====1` pins `=1`, `===` alone pins `=`.
    ["===", "=="].iter().find_map(|signs| {
        let version = rest.strip_prefix(signs)?.trim_start_matches(is_js_space);
        (!version.is_empty() && !version.contains(is_js_space)).then_some(version)
    })
}

fn pypi_spec(raw: &str) -> Spec {
    let elsewhere = raw.contains("://")
        || ["git+", ".", "/", "~"]
            .iter()
            .any(|prefix| raw.starts_with(prefix))
        || [".whl", ".tar.gz", ".zip"]
            .iter()
            .any(|suffix| raw.ends_with(suffix));
    if elsewhere {
        return Spec::opaque(raw);
    }
    let name_end = raw
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
        .unwrap_or(raw.len());
    let name = &raw[..name_end];
    if !name.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return Spec::opaque(raw);
    }
    // Extras (`pkg[extra]`) are not part of the name.
    let after = &raw[name_end..];
    let after = after
        .strip_prefix('[')
        .and_then(|extras| extras.split_once(']'))
        .map_or(after, |(_, after)| after);
    let rest = after.trim_start_matches(is_js_space);
    // The requirement is one line.
    if rest.contains(is_line_end) {
        return Spec::opaque(raw);
    }
    let rest = js_trim(rest);
    let pkg = name.to_owned();
    if rest.is_empty() || rest == "@latest" {
        return Spec {
            pkg,
            version: None,
            checkable: true,
        };
    }
    if let Some(version) = rest.strip_prefix('@') {
        let version = js_trim(version);
        return Spec {
            pkg,
            version: Some(version.to_owned()),
            checkable: !version.contains("://"),
        };
    }
    Spec {
        pkg,
        version: Some(exact_pin(rest).unwrap_or(rest).to_owned()),
        checkable: true,
    }
}

/// A `cmd /c npx …` wrapper (how Windows configs start `.cmd` shims) is looked through.
fn unwrap<'a>(command: &str, args: &'a [String]) -> (String, &'a [String]) {
    let name = command_name(command);
    if name == "cmd"
        && args.first().is_some_and(|flag| flag.to_lowercase() == "/c")
        && let Some(inner) = args.get(1).filter(|inner| !inner.is_empty())
    {
        return (command_name(inner), &args[2..]);
    }
    (name, args)
}

/// A path with forward slashes and no trailing one, lowercased where the disk ignores case.
fn slash(value: &str, lower: bool) -> String {
    let text = value.replace('\\', "/");
    let text = text.trim_end_matches('/');
    if lower {
        text.to_lowercase()
    } else {
        text.to_owned()
    }
}

/// The config file or plugin dir the server came from sits under the built-in REA's root.
pub fn is_builtin(source_path: Option<&str>, rea_root: Option<&str>) -> bool {
    let (Some(rea_root), Some(source_path)) = (
        rea_root.filter(|root| !root.is_empty()),
        source_path.filter(|path| !path.is_empty()),
    ) else {
        return false;
    };
    let windows = matches!(rea_root.as_bytes(), [drive, b':', b'\\' | b'/', ..] if drive.is_ascii_alphabetic());
    let root = slash(rea_root, windows);
    let source = slash(source_path, windows);
    source
        .strip_prefix(&root)
        .is_some_and(|below| below.is_empty() || below.starts_with('/'))
}

pub fn classify(server: &Server, rea_root: Option<&str>) -> McpClass {
    if is_builtin(server.source_path.as_deref(), rea_root) {
        return McpClass::Builtin;
    }
    let command = server
        .command
        .as_deref()
        .filter(|command| !command.is_empty());
    let has_url = server.url.as_deref().is_some_and(|url| !url.is_empty());
    if server.transport == "http" || server.transport == "sse" || (command.is_none() && has_url) {
        return McpClass::Remote;
    }
    let Some(command) = command else {
        return McpClass::Unsupported;
    };
    let (name, args) = unwrap(command, &server.args);
    if let Some((runner, args)) = runner_of(&name, args) {
        let Some(raw) = package_arg(runner, args).filter(|raw| !raw.is_empty()) else {
            return McpClass::Unsupported;
        };
        let ecosystem = runner.ecosystem();
        let spec = match ecosystem {
            Ecosystem::Npm => npm_spec(raw),
            Ecosystem::Pypi => pypi_spec(raw),
        };
        return McpClass::Runner(Package {
            runner,
            ecosystem,
            pkg: spec.pkg,
            pinned: spec.version.is_some(),
            version: spec.version,
            spec: raw.to_owned(),
            checkable: spec.checkable,
        });
    }
    if is_interpreter(&name) {
        return McpClass::Unsupported;
    }
    McpClass::Direct {
        command: command.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::super::captured;
    use super::*;

    #[test]
    fn names_commands_as_the_typescript_did() {
        for row in captured("commandName") {
            let command = row[0].as_str().unwrap();
            assert_eq!(
                command_name(command),
                row[1].as_str().unwrap(),
                "{command:?}"
            );
        }
    }

    #[test]
    fn finds_the_builtin_server_as_the_typescript_did() {
        for row in captured("builtin") {
            assert_eq!(
                is_builtin(row[0].as_str(), row[1].as_str()),
                row[2].as_bool().unwrap(),
                "{row}"
            );
        }
    }

    /// A captured row holds the command, its arguments and the fields that differ from the capture's plain server.
    fn server(command: &Value, args: &Value, over: &Value) -> Server {
        let mut server = json!({
            "name": "s",
            "type": "stdio",
            "command": command,
            "args": args,
            "url": null,
            "enabled": true,
            "sourcePath": "/home/u/.omp/agent/mcp.json",
            "origin": "user",
        });
        for (key, value) in over.as_object().unwrap() {
            server[key] = value.clone();
        }
        serde_json::from_value(server).unwrap()
    }

    #[test]
    fn classifies_servers_as_the_typescript_did() {
        let rows = captured("classes");
        assert!(rows.len() > 300);
        for row in rows {
            let class = classify(&server(&row[0], &row[1], &row[2]), row[3].as_str());
            assert_eq!(serde_json::to_value(class).unwrap(), row[4], "{row}");
        }
    }
}
