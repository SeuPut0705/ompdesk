use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{Environment, Service};
use crate::fs::order::js_trim;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Other
        }
    }
    pub fn separator(self) -> char {
        if self == Self::Windows { ';' } else { ':' }
    }
    pub fn exe(self, name: &str) -> String {
        if self == Self::Windows {
            format!("{name}.exe")
        } else {
            name.to_owned()
        }
    }
}

pub fn executable(file: &Path, platform: Platform) -> bool {
    #[cfg(unix)]
    if platform != Platform::Windows && !crate::sys::may_execute(file) {
        return false;
    }
    match std::fs::metadata(file) {
        Ok(meta) => !meta.is_dir(),
        Err(_) if platform == Platform::Windows => {
            std::fs::symlink_metadata(file).is_ok_and(|meta| !meta.is_dir() && !meta.is_symlink())
        }
        Err(_) => false,
    }
}

pub(super) fn canonical_environment(input: &Environment, platform: Platform) -> Environment {
    if platform != Platform::Windows {
        return input.clone();
    }
    let mut result = Environment::new();
    let mut seen = BTreeSet::new();
    for (key, value) in input {
        let upper = key.to_ascii_uppercase();
        if !seen.insert(upper.clone()) {
            continue;
        }
        let key = match upper.as_str() {
            "PROGRAMFILES" => "ProgramFiles",
            "PROGRAMFILES(X86)" => "ProgramFiles(x86)",
            other => other,
        };
        result.insert(key.to_owned(), value.clone());
    }
    result
}

pub fn find_on_path(
    names: &[&str],
    path: &str,
    platform: Platform,
    extra: &[PathBuf],
    exclude: &[PathBuf],
) -> Option<PathBuf> {
    path.split(platform.separator())
        .filter(|p| !p.is_empty())
        .flat_map(|p| names.iter().map(move |name| Path::new(p).join(name)))
        .chain(extra.iter().cloned())
        .find(|file| !exclude.contains(file) && executable(file, platform))
}

pub fn bun_install(env: &Environment, home: &Path) -> PathBuf {
    env.get("BUN_INSTALL")
        .filter(|v| !v.is_empty())
        .map_or_else(|| home.join(".bun"), PathBuf::from)
}

pub fn merge_paths(base: &str, additions: &[String], platform: Platform) -> String {
    let mut entries = base
        .split(platform.separator())
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let key = |s: &str| {
        if platform == Platform::Windows {
            s.trim_end_matches(['/', '\\']).to_lowercase()
        } else {
            s.to_owned()
        }
    };
    let mut seen: BTreeSet<_> = entries.iter().map(|s| key(s)).collect();
    for value in additions
        .iter()
        .flat_map(|v| v.split(platform.separator()))
        .filter(|p| !p.is_empty())
    {
        if seen.insert(key(value)) {
            entries.push(value.to_owned());
        }
    }
    entries.join(&platform.separator().to_string())
}

pub fn apply_managed(env: &mut Environment, tools: &Path, platform: Platform) {
    let dirs = if platform == Platform::Windows {
        vec![tools.join("git/cmd"), tools.join("agent-desktop")]
    } else {
        vec![
            tools.join("node/bin"),
            tools.join("gh/bin"),
            tools.join("agent-desktop"),
        ]
    };
    let additions = dirs
        .iter()
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let path = merge_paths(
        env.get("PATH").map_or("", String::as_str),
        &additions,
        platform,
    );
    env.insert("PATH".into(), path);
    let git = tools.join("git");
    if platform == Platform::Windows
        && env.get("GIT_INSTALL_ROOT").is_none_or(|v| v.is_empty())
        && git.join("bin/bash.exe").exists()
    {
        env.insert(
            "GIT_INSTALL_ROOT".into(),
            git.to_string_lossy().into_owned(),
        );
    }
}

pub fn find_git_bash(env: &Environment) -> Option<PathBuf> {
    let root = |name: &str, suffix: &str| {
        env.get(name)
            .filter(|v| !v.is_empty())
            .map(|v| Path::new(v).join(suffix))
    };
    let roots = [
        root("ProgramFiles", "Git"),
        root("ProgramFiles(x86)", "Git"),
        root("LOCALAPPDATA", "Programs/Git"),
        root("GIT_INSTALL_ROOT", ""),
        root("SCOOP", "apps/git/current"),
        root("USERPROFILE", "scoop/apps/git/current"),
    ];
    roots
        .into_iter()
        .flatten()
        .map(|p| p.join("bin/bash.exe"))
        .find(|p| p.exists())
        .or_else(|| {
            env.get("PATH")
                .into_iter()
                .flat_map(|p| p.split(';'))
                .filter(|p| !p.is_empty())
                .find_map(|dir| {
                    let dir = Path::new(dir);
                    let bash = dir.parent()?.join("bin/bash.exe");
                    (dir.join("git.exe").exists() && bash.exists()).then_some(bash)
                })
        })
}

pub fn omp_path(
    bin: &Path,
    base: &str,
    env: &Environment,
    home: &Path,
    platform: Platform,
) -> String {
    let mut entries = base
        .split(platform.separator())
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for dir in [
        bin.parent().unwrap_or(Path::new(".")).to_path_buf(),
        bun_install(env, home).join("bin"),
    ] {
        let dir = dir.to_string_lossy().into_owned();
        if !entries.contains(&dir) {
            entries.push(dir);
        }
    }
    entries.join(&platform.separator().to_string())
}

pub fn omp_environment(env: &mut Environment, bin: &Path, home: &Path, platform: Platform) {
    env.insert(
        "PATH".into(),
        omp_path(
            bin,
            env.get("PATH").map_or("", String::as_str),
            env,
            home,
            platform,
        ),
    );
    env.insert("OTEL_SDK_DISABLED".into(), "true".into());
}

pub fn update_environment(
    bin: &Path,
    base: &Environment,
    home: &Path,
    platform: Platform,
) -> Environment {
    let own = bin.parent().unwrap_or(Path::new("."));
    let own_text = own.to_string_lossy();
    let mut paths = vec![own_text.to_string()];
    paths.extend(
        base.get("PATH")
            .into_iter()
            .flat_map(|v| v.split(platform.separator()))
            .filter(|p| !p.is_empty() && *p != own_text)
            .map(str::to_owned),
    );
    let path = omp_path(
        bin,
        &paths.join(&platform.separator().to_string()),
        base,
        home,
        platform,
    );
    let mut result = base.clone();
    result.insert("PATH".into(), path);
    if let Some(root) = own.parent()
        && root
            .join("install/global/node_modules/@oh-my-pi/pi-coding-agent/package.json")
            .exists()
    {
        result.insert("BUN_INSTALL".into(), root.to_string_lossy().into_owned());
    }
    result
}

pub fn is_compiled_omp(file: &Path, platform: Platform) -> bool {
    let mut head = [0u8; 4096];
    let Ok(mut file) = std::fs::File::open(file) else {
        return false;
    };
    let Ok(read) = file.read(&mut head) else {
        return false;
    };
    if read < 4 {
        return false;
    }
    if platform == Platform::Windows {
        if &head[..2] != b"MZ" || read < 0x40 {
            return false;
        }
        let pe = u32::from_le_bytes(head[0x3c..0x40].try_into().unwrap_or_default()) as usize;
        if pe.checked_add(24).is_none_or(|end| end > read) || &head[pe..pe + 4] != b"PE\0\0" {
            return false;
        }
        let sections = u16::from_le_bytes([head[pe + 6], head[pe + 7]]) as usize;
        let table = pe + 24 + u16::from_le_bytes([head[pe + 20], head[pe + 21]]) as usize;
        for index in 0..sections {
            let at = table + index * 40;
            if at + 40 > read {
                break;
            }
            if &head[at..at + 8] == b".bun\0\0\0\0" {
                return true;
            }
        }
        false
    } else {
        &head[..4] == b"\x7fELF"
            || matches!(
                u32::from_be_bytes(head[..4].try_into().unwrap_or_default()),
                0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe | 0xcafebabe
            )
    }
}

pub fn manifest_bun_minimum(manifest: &Value) -> Option<String> {
    let range = js_trim(manifest.get("engines")?.get("bun")?.as_str()?);
    let range = js_trim(range.strip_prefix(">=")?);
    let version = range.strip_prefix('v').unwrap_or(range);
    let parts = version.split('.').collect::<Vec<_>>();
    (parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
    .then(|| version.to_owned())
}

pub fn package_root(bin: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(real) = std::fs::canonicalize(bin)
        && let Some(root) = real.parent().and_then(Path::parent)
    {
        candidates.push(root.to_path_buf());
    }
    let dir = bin.parent()?;
    candidates.extend([
        dir.join("../install/global/node_modules/@oh-my-pi/pi-coding-agent"),
        dir.join("node_modules/@oh-my-pi/pi-coding-agent"),
        dir.join("../lib/node_modules/@oh-my-pi/pi-coding-agent"),
    ]);
    candidates
        .into_iter()
        .find(|root| manifest(root).is_some_and(|m| m["name"] == "@oh-my-pi/pi-coding-agent"))
}

pub fn manifest(root: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(root.join("package.json")).ok()?).ok()
}

pub fn drop_git_selectors(env: &mut Environment) {
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_PREFIX",
    ] {
        env.remove(name);
    }
}

fn registry_value(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        let name = words.next()?;
        let kind = words.next()?;
        if !name.eq_ignore_ascii_case("Path") || !matches!(kind, "REG_SZ" | "REG_EXPAND_SZ") {
            return None;
        }
        Some(js_trim(line.split_once(kind)?.1))
    })
}

fn expand(value: &str, env: &Environment) -> String {
    let mut result = String::new();
    let mut tail = value;
    while let Some(start) = tail.find('%') {
        result.push_str(&tail[..start]);
        let Some(end) = tail[start + 1..].find('%').map(|i| start + 1 + i) else {
            result.push_str(&tail[start..]);
            return result;
        };
        let key = &tail[start + 1..end];
        if !key.is_empty() && !key.contains(';') {
            result.push_str(
                env.iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(key))
                    .map_or(&tail[start..=end], |(_, v)| v),
            );
        } else {
            result.push_str(&tail[start..=end]);
        }
        tail = &tail[end + 1..];
    }
    result.push_str(tail);
    result
}

pub async fn refresh_registry(service: &Service, env: &mut Environment) {
    let mut additions = Vec::new();
    for key in [
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        "HKCU\\Environment",
    ] {
        if let Ok(output) = service
            .probe(
                Path::new("reg.exe"),
                &["query", key, "/v", "Path"],
                env,
                10_000,
            )
            .await
            && output.code == 0
            && let Some(path) = registry_value(&output.text())
        {
            additions.push(expand(path, env));
        }
    }
    env.insert(
        "PATH".into(),
        merge_paths(
            env.get("PATH").map_or("", String::as_str),
            &additions,
            Platform::Windows,
        ),
    );
}
