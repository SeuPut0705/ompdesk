//! The omp Browser Relay extension of one browser: whether a profile of the browser loaded its own copy (a loaded
//! unpacked extension records its folder in the profile's preferences), and writing that copy, bound to the browser's
//! own relay port. Stock's `omp browser-relay install` writes the extension; Chrome forbids installing it for the
//! user.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::fs::error::{Codes, NodeError};
use crate::run::{Exec, Opts, Runner};
use crate::server::{Fault, Scope};

use super::Id;

/// The files that name the port the extension dials; stock's asset declares it as `DEFAULT_PORT`.
const PORT_FILES: [&str; 2] = ["background.js", "options.js"];

/// How long stock's install may take.
const INSTALL_TIMEOUT_MS: u64 = 30_000;

/// What omp's output is kept up to (the TypeScript kept all of it; only its words in a failure are read).
const OMP_OUTPUT_KEPT: usize = 4 * 1024 * 1024;

/// Where `id`'s own copy of the extension lives, and where Chrome's profile records loading it from. One copy per
/// browser, each bound to its own port: another browser's copy never counts for this one.
pub fn extension_dir(home: &str, id: Id) -> PathBuf {
    Path::new(home)
        .join(".omp")
        .join("browser-relay")
        .join(format!("extension-{}", id.name()))
}

/// A file's text as node's `readFile(file, "utf8")` gives it, empty when it cannot be read.
fn read_text(file: &Path) -> String {
    std::fs::read(file)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// The profile folders a user data folder's `Local State` lists (`profile.info_cache`'s keys), else `Default`.
fn profile_names(local_state: &str) -> Vec<String> {
    let listed = serde_json::from_str::<Value>(local_state)
        .ok()
        .and_then(|state| {
            let cache = state.get("profile")?.get("info_cache")?;
            // `Object.keys` of an array lists its indexes; of a string or a number, nothing that counts here.
            let names: Vec<String> = match cache {
                Value::Object(map) => map.keys().cloned().collect(),
                Value::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
                _ => return None,
            };
            (!names.is_empty()).then_some(names)
        });
    listed.unwrap_or_else(|| vec!["Default".to_owned()])
}

/// `text` holds `dir` as a whole path: not as the start of `…/extension-chromium` when `dir` is `…/extension-chrome`.
/// Windows paths are JSON-escaped in the preferences files, so the escaped spelling counts too.
pub fn names_folder(text: &str, dir: &str) -> bool {
    let escaped = serde_json::to_string(dir).unwrap_or_default();
    let escaped = &escaped[1..escaped.len() - 1];
    [dir, escaped].into_iter().any(|needle| {
        let Some(step) = needle.chars().next().map(char::len_utf8) else {
            return true;
        };
        let mut from = 0;
        while let Some(found) = text[from..].find(needle) {
            let at = from + found;
            // JavaScript's `/[\w-]/` over the next UTF-16 unit: ASCII letters, digits, `_` and `-`.
            match text[at + needle.len()..].chars().next() {
                Some(next) if next.is_ascii_alphanumeric() || next == '_' || next == '-' => {}
                _ => return true,
            }
            from = at + step;
        }
        false
    })
}

/// Does a profile of the user data folder `data_dir` name the extension folder `dir`?
pub fn loaded_in(data_dir: &str, dir: &str) -> bool {
    let data = Path::new(data_dir);
    for profile in profile_names(&read_text(&data.join("Local State"))) {
        for file in ["Preferences", "Secure Preferences"] {
            if names_folder(&read_text(&data.join(&profile).join(file)), dir) {
                return true;
            }
        }
    }
    false
}

/// `source` with its one `DEFAULT_PORT` declaration set to `port`, as
/// `source.replace(/\b((?:var|const|let) DEFAULT_PORT = )\d+;/g, "$1<port>;")` did; a fault when stock's asset no
/// longer has exactly one.
pub fn bind_port(source: &str, port: u16, file: &str) -> Result<String, Fault> {
    let mut found = Vec::new();
    for (at, _) in source.char_indices() {
        // `\b` before the keyword: the previous UTF-16 unit is no ASCII word character.
        let word_before = source[..at]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        if word_before {
            continue;
        }
        let rest = &source[at..];
        let Some(head) = ["var ", "const ", "let "]
            .into_iter()
            .find_map(|keyword| rest.strip_prefix(keyword))
            .and_then(|after| after.strip_prefix("DEFAULT_PORT = "))
        else {
            continue;
        };
        let digits = head.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && head.as_bytes().get(digits) == Some(&b';') {
            // Where the digits start, and where their `;` ends.
            let digits_at = at + rest.len() - head.len();
            found.push((digits_at, digits_at + digits + 1));
        }
    }
    let [(digits_at, end)] = found[..] else {
        return Err(Fault::new(
            "relay_changed",
            format!(
                "omp's relay extension changed: {file} has no single DEFAULT_PORT to bind to port {port}"
            ),
        ));
    };
    Ok(format!("{}{port};{}", &source[..digits_at], &source[end..]))
}

/// How main runs omp: its binary (a `.cmd` shim goes through cmd.exe, as std runs one) and its whole environment
/// (`ompRunEnv`: main's, the spawn PATH with omp's own folders, telemetry off).
#[derive(Deserialize)]
pub struct Omp {
    bin: String,
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallParams {
    omp: Omp,
    id: Id,
    home: String,
    /// The browser's own relay port.
    port: u16,
}

/// A file system call's failure as node's `fs.promises` reported it.
fn node(error: &std::io::Error, syscall: &str, path: &Path) -> Fault {
    NodeError::new(error, syscall, Some(&path.to_string_lossy())).fault(Codes::None)
}

/// `fs.rm(path, { recursive: true, force: true })`.
fn remove(path: &Path) -> Result<(), Fault> {
    let removed = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => Err(error),
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
    };
    match removed {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(node(&error, "rm", path)),
        _ => Ok(()),
    }
}

/// Writes `id`'s own copy of the extension, bound to its own port, and answers its folder. Stock writes the copy to a
/// staging folder; it is bound there and only then put in place, so a stock asset this cannot bind never leaves an
/// unbound extension behind.
pub async fn install(params: InstallParams, scope: Scope) -> Result<String, Fault> {
    let dir = extension_dir(&params.home, params.id);
    let mut staging = dir.clone().into_os_string();
    staging.push(".new");
    let staging = PathBuf::from(staging);
    blocking({
        let staging = staging.clone();
        move || remove(&staging)
    })
    .await?;
    let installed = match stock(params.omp, scope, &staging).await {
        Ok(()) => {
            blocking({
                let (dir, staging) = (dir.clone(), staging.clone());
                move || place(params.port, &dir, &staging)
            })
            .await
        }
        Err(fault) => Err(fault),
    };
    // As the TypeScript's `finally`: a failed clean-up is the answer, whatever came before.
    blocking(move || remove(&staging)).await?;
    installed?;
    Ok(dir.to_string_lossy().into_owned())
}

/// File work on tokio's blocking pool.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Fault::new("internal", "The relay extension's file work panicked"))?
}

/// Stock's `omp browser-relay install --dir <staging>`.
async fn stock(omp: Omp, scope: Scope, staging: &Path) -> Result<(), Fault> {
    let runner = Runner {
        bin: omp.bin,
        args: Vec::new(),
        env: omp.env,
        timeout_ms: INSTALL_TIMEOUT_MS,
        max_bytes: OMP_OUTPUT_KEPT,
    };
    let staging = staging.to_string_lossy();
    let ended = Exec::new(runner, scope, "omp")
        .run_kept(
            ".",
            &["browser-relay", "install", "--dir", &staging],
            Opts::default(),
        )
        .await?;
    if ended.timed_out {
        return Err(Fault::new(
            "omp_timeout",
            format!("omp browser-relay timed out after {INSTALL_TIMEOUT_MS}ms"),
        ));
    }
    let output = ended.output;
    if output.code == 0 {
        return Ok(());
    }
    let stderr = output.stderr.trim();
    let stdout = output.text();
    let message = if !stderr.is_empty() {
        stderr.to_owned()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_owned()
    } else {
        format!("omp browser-relay install exited {}", output.code)
    };
    Err(Fault::new("omp_exit", message))
}

/// Binds the staged copy to `port` and puts its files over the copy in `dir`.
fn place(port: u16, dir: &Path, staging: &Path) -> Result<(), Fault> {
    for file in PORT_FILES {
        let path = staging.join(file);
        let source = std::fs::read(&path).map_err(|error| node(&error, "open", &path))?;
        let bound = bind_port(&String::from_utf8_lossy(&source), port, file)?;
        std::fs::write(&path, bound).map_err(|error| node(&error, "open", &path))?;
    }
    // Files go over the old copy one by one: a browser holding it open must not make a folder swap fail.
    std::fs::create_dir_all(dir).map_err(|error| node(&error, "mkdir", dir))?;
    for entry in std::fs::read_dir(staging).map_err(|error| node(&error, "scandir", staging))? {
        let entry = entry.map_err(|error| node(&error, "scandir", staging))?;
        let (from, to) = (entry.path(), dir.join(entry.file_name()));
        std::fs::copy(&from, &to).map_err(|error| {
            NodeError::with_dest(
                &error,
                "copyfile",
                Some(&from.to_string_lossy()),
                Some(&to.to_string_lossy()),
            )
            .fault(Codes::None)
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured(table: &str) -> Vec<Value> {
        let rows: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        rows[table].as_array().unwrap().clone()
    }

    #[test]
    fn binds_the_port_as_the_typescript_did() {
        for row in captured("bind") {
            let source = row["source"].as_str().unwrap();
            let port = u16::try_from(row["port"].as_u64().unwrap()).unwrap();
            let file = row["file"].as_str().unwrap();
            match bind_port(source, port, file) {
                Ok(bound) => assert_eq!(Some(bound.as_str()), row["ok"].as_str(), "{source:?}"),
                Err(fault) => assert_eq!(
                    Some(fault.message.as_str()),
                    row["error"].as_str(),
                    "{source:?}"
                ),
            }
        }
    }

    #[test]
    fn reads_the_profiles_as_the_typescript_did() {
        for (index, row) in captured("relay").into_iter().enumerate() {
            let data =
                std::env::temp_dir().join(format!("ompdesk-relay-{}-{index}", std::process::id()));
            let _ = std::fs::remove_dir_all(&data);
            std::fs::create_dir_all(&data).unwrap();
            if let Some(state) = row["localState"].as_str() {
                std::fs::write(data.join("Local State"), state).unwrap();
            }
            for (name, text) in row["files"].as_object().unwrap() {
                let file = data.join(name);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, text.as_str().unwrap()).unwrap();
            }
            let loaded = loaded_in(&data.to_string_lossy(), row["dir"].as_str().unwrap());
            std::fs::remove_dir_all(&data).unwrap();
            assert_eq!(Some(loaded), row["loaded"].as_bool(), "row {index}: {row}");
        }
    }
}
