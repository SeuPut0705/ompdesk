//! Which ai-memory binary OMPdesk runs, and where it lives.
//!
//! The binary OMPdesk builds ships in the app (`<resources>/ai-memory-bin/`, built from `native/memory`, recorded in
//! its build record). It is never run from inside the app: the launchd unit, the Windows logon entry and omp's MCP
//! entry all record the binary's absolute path, and the app's own folder is the wrong home for that (a Windows update
//! replaces the install folder while the server still holds its .exe open; a macOS app can be moved or run from a
//! disk image). `stage_binary` therefore verifies the shipped file (its bytes are the build record's, or on macOS its
//! signature satisfies OMPdesk's requirement) and copies it once into the managed tools dir under
//! `<tools>/ai-memory/<stage key>/`: one stable folder on macOS, whose TCC grants then survive updates, and a folder
//! per build on Windows. Either way the unit `setup` renders changes with the new bytes, so ai-memory's own `setup`
//! restarts the service on them; other folders are removed afterwards.
//!
//! Only this build ever runs: no other ai-memory (PATH, `~/.local/bin`, Homebrew, the Windows script's folders) is
//! looked for or used, however new it is (the user's decision of 29 Oct 2026).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::Boxed;

/// Why a file fails OMPdesk's signing requirement, or none (macOS: codesign, or a test's answer).
pub type SignatureCheck<'a> =
    dyn Fn(String) -> Boxed<'a, Result<Option<String>, String>> + Send + Sync + 'a;
use super::unit::run_file;
use crate::disk::tree::fault as node_fault;

/// What the build recorded next to the shipped binary: its name and the SHA-256 of its bytes, and the platform it
/// was built for, which decides where it is staged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltAsset {
    pub binary: String,
    pub sha256: String,
    pub darwin: bool,
}

/// What main hands over about the builds: the binary per `<platform>-<arch>`, the record's file name, the version,
/// the macOS folder every build stages into and the signing requirement of a packaged macOS release.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Builds {
    pub binaries: serde_json::Map<String, Value>,
    pub manifest: String,
    pub version: String,
    pub mac_stage_key: String,
    pub requirement: String,
}

fn hex64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The binary this app was built with for `platform`/`arch`: none when OMPdesk builds none for it. A message for the
/// person when the folder carries no (valid) build record: a development checkout that never ran
/// `bun run build:memory` (which needs Rust), or a damaged install.
pub fn read_built_asset(
    builds: &Builds,
    bundled_dir: &Path,
    platform: &str,
    arch: &str,
) -> Result<Option<BuiltAsset>, String> {
    let Some(binary) = builds
        .binaries
        .get(&format!("{platform}-{arch}"))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    let file = bundled_dir.join(&builds.manifest);
    let shown = file.to_string_lossy();
    let record: Value = fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok())
        .ok_or_else(|| {
            format!(
                "Memory is not built ({shown} is missing). Run `bun run build:memory` (needs Rust) or reinstall OMPdesk."
            )
        })?;
    let sha = record.get("binarySha256").and_then(Value::as_str);
    match sha {
        Some(sha) if record.get("binary").and_then(Value::as_str) == Some(binary) && hex64(sha) => {
            Ok(Some(BuiltAsset {
                binary: binary.to_owned(),
                sha256: sha.to_owned(),
                darwin: platform == "darwin",
            }))
        }
        _ => Err(format!(
            "{shown} is not a build record of {binary}. Run `bun run build:memory` or reinstall OMPdesk."
        )),
    }
}

/// The SHA-256 of a file's bytes, as lowercase hex.
pub fn sha256_file(file: &Path) -> std::io::Result<String> {
    let mut hash = Sha256::new();
    let mut reader = fs::File::open(file)?;
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// `<tools>/ai-memory`: every staged version lives below it.
pub fn staging_root(tools_dir: &Path) -> PathBuf {
    tools_dir.join("ai-memory")
}

/// The folder a build stages under.
///
/// macOS: always the one folder (`macStageKey`). The service is a launchd job, so it is its own responsible process
/// for TCC, and TCC keys an unbundled program's privacy grants by its absolute path, checked against its designated
/// requirement. A path that changed with every build asked for every protected folder again after each update,
/// although the requirement never changes. The new bytes replace the old file at the same path; the unit `setup`
/// renders names the binary's SHA-256 (`native/memory` `user_service.rs`), so `setup` still restarts the server.
///
/// Windows: the version and the first 8 hex of the recorded SHA-256, because a running server keeps its .exe locked
/// and a new build cannot replace it; the logon entry then points at the new path and `setup` restarts the host.
pub fn stage_key(builds: &Builds, asset: &BuiltAsset) -> String {
    if asset.darwin {
        builds.mac_stage_key.clone()
    } else {
        format!("{}-{}", builds.version, &asset.sha256[..8])
    }
}

/// macOS: why `file` does not carry a valid signature that satisfies `requirement`
/// (`codesign --verify --strict -R=<requirement>`), or none when it does.
pub async fn code_requirement_problem(file: &str, requirement: &str) -> Option<String> {
    let requirement = format!("={requirement}");
    let args = ["--verify", "--strict", "-R", requirement.as_str(), file];
    let exit = run_file("/usr/bin/codesign", &args, None, Duration::from_secs(60)).await;
    if exit.code == 0 {
        return None;
    }
    let said = exit.stderr.trim();
    Some(if said.is_empty() {
        format!("Command failed: /usr/bin/codesign {}", args.join(" "))
    } else {
        said.to_owned()
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis())
}

/// Verify the shipped binary and copy it into `<tools>/ai-memory/<stage key>/` (atomically: a temp folder's copy
/// renamed over the binary). Answers the staged path. The shipped file is accepted when its bytes are the build
/// record's (Windows ships it unsigned; a dev build's own copy) or, with `requirement` (macOS), when its signature
/// satisfies it. A staged copy is trusted only by bytes: reused when it is the recorded one (without reading the
/// shipped file) or byte-identical to the shipped file just verified, and replaced otherwise.
pub async fn stage_binary<'a>(
    builds: &Builds,
    source: &Path,
    asset: &BuiltAsset,
    tools_dir: &Path,
    requirement: Option<&SignatureCheck<'a>>,
) -> Result<PathBuf, String> {
    let root = staging_root(tools_dir);
    let folder = root.join(stage_key(builds, asset));
    let dest = folder.join(&asset.binary);
    let staged = sha256_file(&dest).ok();
    if staged.as_deref() == Some(asset.sha256.as_str()) {
        return Ok(dest);
    }
    let Ok(actual) = sha256_file(source) else {
        return Err(format!(
            "The bundled ai-memory is missing ({}). Reinstall OMPdesk.",
            source.to_string_lossy()
        ));
    };
    if actual != asset.sha256 {
        let pinned = format!("expected {}, got {actual}", asset.sha256);
        let Some(requirement) = requirement else {
            return Err(format!(
                "The bundled ai-memory does not match its build record ({pinned}). Reinstall OMPdesk."
            ));
        };
        if let Some(problem) = requirement(source.to_string_lossy().into_owned()).await? {
            return Err(format!(
                "The bundled ai-memory is neither the built binary ({pinned}) nor signed with OMPdesk's certificate ({problem}). Reinstall OMPdesk."
            ));
        }
    }
    if staged.as_deref() == Some(actual.as_str()) {
        return Ok(dest);
    }
    let message = |error: std::io::Error, syscall: &str, path: &Path| {
        node_fault(&error, syscall, path).message
    };
    let temp = root.join(format!(".stage-{}-{}", std::process::id(), now_ms()));
    fs::create_dir_all(&temp).map_err(|error| message(error, "mkdir", &temp))?;
    let copied = (|| {
        let copy = temp.join(&asset.binary);
        fs::copy(source, &copy).map_err(|error| message(error, "copyfile", source))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&copy, fs::Permissions::from_mode(0o755))
                .map_err(|error| message(error, "chmod", &copy))?;
        }
        // One rename of the verified copy over the binary in use: the folder may be the one macOS keeps, whose binary
        // the service runs, so it is never deleted first; a failure here leaves the previous one in place.
        fs::create_dir_all(&folder).map_err(|error| message(error, "mkdir", &folder))?;
        fs::rename(&copy, &dest).map_err(|error| message(error, "rename", &copy))
    })();
    let _ = fs::remove_dir_all(&temp);
    copied?;
    for entry in fs::read_dir(&folder)
        .map_err(|error| message(error, "scandir", &folder))?
        .flatten()
    {
        if entry.file_name().to_string_lossy() != asset.binary.as_str() {
            let path = entry.path();
            let _ = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
        }
    }
    Ok(dest)
}

/// Remove staged versions other than the current one, and leftover temp folders. Best effort: on Windows the previous
/// version's .exe stays locked until its server exited, and the next launch tries again.
pub fn prune_staged(builds: &Builds, tools_dir: &Path, asset: &BuiltAsset) {
    let keep = stage_key(builds, asset);
    for entry in fs::read_dir(staging_root(tools_dir))
        .into_iter()
        .flatten()
        .flatten()
    {
        if entry.file_name().to_string_lossy() != keep.as_str() {
            let path = entry.path();
            let _ = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
        }
    }
}

/// `ai-memory 3.1.1` → `3.1.1` (`/\bai-memory\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/`).
pub fn parse_version(output: &str) -> Option<String> {
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let bytes = output.as_bytes();
    output.match_indices("ai-memory").find_map(|(at, _)| {
        if at > 0 && word(bytes[at - 1]) {
            return None;
        }
        let rest = &output[at + "ai-memory".len()..];
        let spaced = rest.trim_start_matches(crate::fs::order::is_js_space);
        if spaced.len() == rest.len() {
            return None;
        }
        let version = spaced.strip_prefix('v').unwrap_or(spaced);
        let digits = |text: &str| {
            text.find(|c: char| !c.is_ascii_digit())
                .unwrap_or(text.len())
        };
        let mut end = 0;
        for part in 0..3 {
            if part > 0 {
                if version[end..].starts_with('.') {
                    end += 1;
                } else {
                    return None;
                }
            }
            let count = digits(&version[end..]);
            if count == 0 {
                return None;
            }
            end += count;
        }
        if let Some(pre) = version[end..].strip_prefix('-') {
            let count = pre
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
                .unwrap_or(pre.len());
            if count > 0 {
                end += 1 + count;
            }
        }
        Some(version[..end].to_owned())
    })
}

/// `<bin> --version` with `env`, or none when it does not run or does not say.
pub async fn probe_version(bin: &str, env: &serde_json::Map<String, Value>) -> Option<String> {
    let exit = run_file(bin, &["--version"], Some(env), Duration::from_secs(10)).await;
    if exit.code != 0 {
        return None;
    }
    parse_version(&exit.stdout)
}
