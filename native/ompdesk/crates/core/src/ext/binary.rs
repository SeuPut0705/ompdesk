//! What the file an MCP server's command resolves to says about itself: whether it is a script or a native binary
//! (which decides the running rule), the python its shebang names (a pip script is owned through that python's entry
//! points), and whether it sits in a pipx or `uv tool` venv, with the version that venv's `dist-info` records. Main
//! finds the file along its spawn PATH and through its links, and asks the package managers it shares with the tool
//! CLIs (npm, Bun, Homebrew, winget) about the rest.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::is_line_end;
use super::mcp::{command_name, is_python, strip_suffix_ignore_case};
use crate::fs::disk;
use crate::fs::order::{is_js_space, js_trim};

/// The platform whose install layout main reads (`CliPlatform`).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Win32,
}

#[derive(Deserialize)]
pub struct Params {
    /// The file, symlinks resolved.
    real: String,
    /// The server's `command` as configured.
    command: String,
    platform: Platform,
}

/// A venv that owns a tool.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "method", rename_all = "lowercase")]
pub enum VenvOwner {
    Pipx { name: String, venv: String },
    Uv { name: String, dir: String },
}

#[derive(Serialize)]
pub struct Facts {
    /// The command's name as a program (`C:\x\Tool.EXE` → `tool`).
    name: String,
    /// A script (shebang, `.cmd`, `.js`) an interpreter loads lazily, as opposed to a native binary. A file of
    /// neither kind counts as a script: waiting is the safe side.
    script: bool,
    owner: Option<VenvOwner>,
    /// The version the owning venv records.
    installed: Option<String>,
    /// The python the file's shebang names, as written there (a bare name is main's to look up).
    python: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Kind {
    Script,
    Native,
    Unknown,
}

/// The bytes a file starts with that tell what it is; none when it cannot be read.
fn head(path: &str) -> Option<Vec<u8>> {
    let mut head = Vec::new();
    File::open(path)
        .ok()?
        .take(256)
        .read_to_end(&mut head)
        .ok()?;
    Some(head)
}

/// A script extension or a shebang: script; Mach-O, ELF or PE magic: native; anything else: unknown.
fn file_kind(path: &str, head: Option<&[u8]>) -> Kind {
    let scripted = [".cmd", ".bat", ".ps1", ".js", ".mjs", ".cjs", ".py"]
        .iter()
        .any(|extension| strip_suffix_ignore_case(path, extension).is_some());
    if scripted {
        return Kind::Script;
    }
    match head {
        Some([b'#', b'!', ..]) => Kind::Script,
        Some([b'M', b'Z', ..]) => Kind::Native,
        // ELF, Mach-O 32/64 in both byte orders, and the universal (fat) header.
        Some(
            [0x7f, b'E', b'L', b'F', ..]
            | [0xfe, 0xed, 0xfa, 0xce | 0xcf, ..]
            | [0xce | 0xcf, 0xfa, 0xed, 0xfe, ..]
            | [0xca, 0xfe, 0xba, 0xbe, ..],
        ) => Kind::Native,
        _ => Kind::Unknown,
    }
}

/// The python a file's first line names (`#!/usr/bin/env python3` → `python3`); none for any other interpreter.
fn shebang_python(head: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(head);
    let line = text.strip_prefix("#!")?;
    let line = line
        .split_once('\n')
        .map_or(line, |(line, _)| line.strip_suffix('\r').unwrap_or(line));
    let mut tokens = js_trim(line)
        .split(is_js_space)
        .filter(|token| !token.is_empty());
    let mut program = tokens.next()?;
    if program == "env" || program.ends_with("/env") {
        program = tokens.find(|token| !token.starts_with('-') && !token.contains('='))?;
    }
    is_python(&command_name(program)).then(|| program.to_owned())
}

/// The venv `…<marker><name>/…` names: the folder and the tool. The last such marker in the path counts.
fn venv_at<'a>(path: &'a str, marker: &str) -> Option<(&'a str, &'a str)> {
    // What stands before the marker is one line.
    let line = path.find(is_line_end).unwrap_or(path.len());
    path.match_indices('/')
        .rev()
        .map(|(at, _)| at)
        .filter(|at| *at <= line)
        .find_map(|at| {
            let name_at = at + marker.len();
            let found = path.as_bytes().get(at..name_at)?;
            if !found.eq_ignore_ascii_case(marker.as_bytes()) {
                return None;
            }
            let (name, _) = path[name_at..].split_once('/')?;
            (!name.is_empty()).then(|| (&path[..name_at + name.len()], name))
        })
}

fn venv_owner(real: &str, platform: Platform) -> Option<VenvOwner> {
    let path = real.replace('\\', "/");
    let native = |dir: &str| match platform {
        Platform::Win32 => dir.replace('/', "\\"),
        Platform::Darwin => dir.to_owned(),
    };
    if let Some((venv, name)) = venv_at(&path, "/pipx/venvs/") {
        return Some(VenvOwner::Pipx {
            name: name.to_owned(),
            venv: native(venv),
        });
    }
    let (dir, name) = venv_at(&path, "/uv/tools/")?;
    Some(VenvOwner::Uv {
        name: name.to_owned(),
        dir: native(dir),
    })
}

/// PyPI's name comparison: case and runs of `-`, `_`, `.` do not tell names apart.
fn normalize_dist(name: &str) -> String {
    let mut normal = String::new();
    for c in name.to_lowercase().chars() {
        if !matches!(c, '-' | '_' | '.') {
            normal.push(c);
        } else if !normal.ends_with('-') {
            normal.push('-');
        }
    }
    normal
}

/// `<name>-<version>.dist-info`: the name (one line) and a version that starts with a digit.
fn dist_info(entry: &str) -> Option<(&str, &str)> {
    let (name, version) = entry.strip_suffix(".dist-info")?.rsplit_once('-')?;
    (!name.is_empty()
        && !name.contains(is_line_end)
        && version.starts_with(|c: char| c.is_ascii_digit()))
    .then_some((name, version))
}

/// The version a venv's `<name>-<version>.dist-info` records; none when the venv cannot be read.
fn dist_info_version(venv: &str, name: &str, platform: Platform) -> Option<String> {
    let venv = Path::new(venv);
    let libs = match platform {
        Platform::Win32 => vec![venv.join("Lib").join("site-packages")],
        Platform::Darwin => {
            let lib = venv.join("lib");
            disk::entries(&lib)
                .ok()?
                .into_iter()
                .filter(|entry| entry.name.starts_with("python"))
                .map(|entry| lib.join(entry.name).join("site-packages"))
                .collect()
        }
    };
    let wanted = normalize_dist(name);
    for lib in libs {
        for entry in disk::entries(&lib).ok()? {
            if let Some((found, version)) = dist_info(&entry.name)
                && normalize_dist(found) == wanted
            {
                return Some(version.to_owned());
            }
        }
    }
    None
}

pub fn facts(params: &Params) -> Facts {
    let head = head(&params.real);
    let owner = venv_owner(&params.real, params.platform);
    let installed = match &owner {
        Some(VenvOwner::Pipx { name, venv: dir } | VenvOwner::Uv { name, dir }) => {
            dist_info_version(dir, name, params.platform)
        }
        None => None,
    };
    Facts {
        name: command_name(&params.command),
        script: file_kind(&params.real, head.as_deref()) != Kind::Native,
        owner,
        installed,
        python: head.as_deref().and_then(shebang_python),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use serde_json::Value;

    use super::super::captured;
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect()
    }

    fn temp() -> PathBuf {
        disk::make_temp_dir("ompdesk-core-ext-").unwrap()
    }

    fn platform(value: &Value) -> Platform {
        serde_json::from_value(value.clone()).unwrap()
    }

    #[test]
    fn finds_a_venv_as_the_typescript_did() {
        for row in captured("venv") {
            let owner = venv_owner(row[0].as_str().unwrap(), platform(&row[1]));
            assert_eq!(serde_json::to_value(owner).unwrap(), row[2], "{row}");
        }
    }

    #[test]
    fn tells_scripts_from_native_binaries_as_the_typescript_did() {
        let root = temp();
        for row in captured("kind") {
            let file = root.join(row[0].as_str().unwrap());
            match row[1].as_str() {
                Some("dir") => fs::create_dir(&file).unwrap(),
                Some(hex) => fs::write(&file, bytes(hex)).unwrap(),
                None => {}
            }
            let path = file.to_string_lossy();
            let kind = match file_kind(&path, head(&path).as_deref()) {
                Kind::Script => "script",
                Kind::Native => "native",
                Kind::Unknown => "unknown",
            };
            assert_eq!(kind, row[2].as_str().unwrap(), "{row}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_a_shebang_as_the_typescript_did() {
        for row in captured("shebang") {
            let file = bytes(row[0].as_str().unwrap());
            // The first 256 bytes of the file are what is read.
            let python = shebang_python(&file[..file.len().min(256)]);
            assert_eq!(
                python.as_deref(),
                row[1].as_str(),
                "{}",
                String::from_utf8_lossy(&file)
            );
        }
    }

    #[test]
    fn reads_a_dist_info_version_as_the_typescript_did() {
        let root = temp();
        for (at, row) in captured("distInfo").into_iter().enumerate() {
            let venv = root.join(format!("venv-{at}"));
            fs::create_dir(&venv).unwrap();
            for dir in row[0]["dirs"].as_array().unwrap() {
                fs::create_dir_all(venv.join(dir.as_str().unwrap())).unwrap();
            }
            for file in row[0]["files"].as_array().unwrap() {
                let file = venv.join(file.as_str().unwrap());
                fs::create_dir_all(file.parent().unwrap()).unwrap();
                fs::write(file, "").unwrap();
            }
            let version = dist_info_version(
                &venv.to_string_lossy(),
                row[1].as_str().unwrap(),
                platform(&row[2]),
            );
            assert_eq!(version.as_deref(), row[3].as_str(), "case {at}: {row}");
        }
        // A venv that is not there records none, on either layout.
        let gone = root.join("nope").to_string_lossy().into_owned();
        assert_eq!(dist_info_version(&gone, "a", Platform::Darwin), None);
        assert_eq!(dist_info_version(&gone, "a", Platform::Win32), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_a_venv_tool_whole() {
        let root = temp();
        let venv = root.join("pipx").join("venvs").join("mcp-thing");
        let site = venv.join("lib").join("python3.12").join("site-packages");
        fs::create_dir_all(site.join("mcp_thing-0.4.0.dist-info")).unwrap();
        fs::create_dir_all(venv.join("bin")).unwrap();
        let tool = venv.join("bin").join("mcp-thing");
        fs::write(&tool, "#!/x/python3.12\n").unwrap();
        let facts = facts(&Params {
            real: tool.to_string_lossy().into_owned(),
            command: "MCP-Thing.exe".into(),
            platform: Platform::Darwin,
        });
        assert_eq!(facts.name, "mcp-thing");
        assert!(facts.script);
        assert_eq!(facts.installed.as_deref(), Some("0.4.0"));
        assert_eq!(facts.python.as_deref(), Some("/x/python3.12"));
        assert!(matches!(facts.owner, Some(VenvOwner::Pipx { name, .. }) if name == "mcp-thing"));
        fs::remove_dir_all(root).unwrap();
    }
}
