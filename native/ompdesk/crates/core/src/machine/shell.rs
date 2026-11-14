use std::path::{Path, PathBuf};

use super::{Environment, Platform, Service, paths};
use crate::fs::order::js_trim;

const BEGIN: &str = "__OMP_ENV_BEGIN__";
const END: &str = "__OMP_ENV_END__";
const DENIED: &[&str] = &["HOME", "LOGNAME", "OLDPWD", "PWD", "SHELL", "SHLVL", "TMPDIR", "USER", "_", "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "PI_PROXY", "all_proxy", "http_proxy", "https_proxy", "no_proxy"];

#[derive(Default)]
pub(super) struct Login { env: Environment, path: Option<String>, editor: Option<String> }

pub(super) fn parse(output: &str) -> Login {
    let (Some(begin), Some(end)) = (output.find(BEGIN), output.rfind(END)) else { return Login::default() };
    if end < begin + BEGIN.len() { return Login::default(); }
    let env: Environment = output[begin + BEGIN.len()..end].split('\n').filter_map(|line| {
        let (key, value) = line.split_once('=')?;
        (!key.is_empty()).then(|| (key.to_owned(), value.to_owned()))
    }).collect();
    let path = env.get("PATH").map(|v| js_trim(v)).filter(|s| !s.is_empty()).map(str::to_owned);
    let editor = ["VISUAL", "EDITOR"].into_iter().filter_map(|k| env.get(k)).map(|v| js_trim(v)).find(|v| !v.is_empty()).map(str::to_owned);
    Login { env, path, editor }
}

pub(super) async fn probe(service: &Service, env: &Environment) -> Login {
    if service.config().platform == Platform::Windows { return Login::default(); }
    let shell = env.get("SHELL").filter(|v| !v.is_empty()).map_or("/bin/zsh", String::as_str);
    let script = format!("command printf '%s\\n' '{BEGIN}'; command env; command printf '%s\\n' '{END}'");
    match service.probe(Path::new(shell), &["-ilc", &script], env, 4_000).await {
        Ok(output) if output.code == 0 && !output.truncated => parse(&output.text()),
        _ => Login::default(),
    }
}

fn fallback(env: &Environment, home: &Path, platform: Platform) -> Vec<PathBuf> {
    if platform == Platform::Windows {
        let local = env.get("LOCALAPPDATA").filter(|v| !v.is_empty()).map_or_else(|| home.join("AppData/Local"), PathBuf::from);
        let roaming = env.get("APPDATA").filter(|v| !v.is_empty()).map_or_else(|| home.join("AppData/Roaming"), PathBuf::from);
        return vec![home.join(".bun/bin"), home.join(".cargo/bin"), home.join(".local/bin"), local.join("Programs/bun"), roaming.join("npm"), local.join("Microsoft/WindowsApps")].into_iter().filter(|p| p.exists()).collect();
    }
    let mut dirs = vec![home.join(".local/bin"), home.join(".bun/bin"), home.join("bin"), home.join(".cargo/bin"), home.join(".volta/bin"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    let nvm = home.join(".nvm/versions/node");
    if let Ok(read) = std::fs::read_dir(&nvm) {
        let mut names = read.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.starts_with('v')).collect::<Vec<_>>();
        names.sort_by(|a,b| crate::tailscale::version::compare(a,b).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(newest) = names.last() { dirs.push(nvm.join(newest).join("bin")); }
    }
    dirs.into_iter().filter(|p| p.exists()).collect()
}

pub(super) fn merge(inherited: &Environment, login: &Login, home: &Path, platform: Platform) -> Environment {
    let mut result = inherited.clone();
    for (key, value) in &login.env {
        if key != "PATH" && !DENIED.contains(&key.as_str()) && !inherited.contains_key(key) { result.insert(key.clone(), value.clone()); }
    }
    let extra = login.path.as_ref().map_or_else(|| fallback(inherited, home, platform).iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(), |p| p.split(platform.separator()).filter(|p| !p.is_empty()).map(str::to_owned).collect());
    // spawnPath uses exact-string Set identity, unlike managed/registry PATH merging on Windows.
    let mut entries = Vec::new();
    for value in inherited.get("PATH").into_iter().flat_map(|p| p.split(platform.separator())).map(str::to_owned).chain(extra).filter(|p| !p.is_empty()) {
        if !entries.contains(&value) { entries.push(value); }
    }
    result.insert("PATH".into(), entries.join(&platform.separator().to_string()));
    paths::drop_git_selectors(&mut result);
    result
}

pub(super) fn pac_url(pac: &str) -> Option<String> {
    let mut first = pac.split(';').next()?.split_whitespace();
    let scheme = match first.next()? { "PROXY" => "http", "HTTPS" => "https", "SOCKS" | "SOCKS5" => "socks5", _ => return None };
    Some(format!("{scheme}://{}", first.next()?))
}

impl Service {
    pub async fn editor(&self) -> Option<String> {
        let env = self.environment.lock().await;
        if let Some(editor) = ["VISUAL", "EDITOR"].iter().filter_map(|k| env.get(*k)).map(|v| js_trim(v)).find(|v| !v.is_empty()) { return Some(editor.to_owned()); }
        drop(env);
        if self.config.platform == Platform::Windows { return Some("notepad".into()); }
        self.shell_environment().await;
        self.shell.lock().await.as_ref().and_then(|login| login.editor.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlays_only_missing_exports_and_never_identity_or_proxies() {
        let login = parse("rc chatter\n__OMP_ENV_BEGIN__\nHOME=/wrong\nTOKEN=shell\nEXPLICIT=shell\nHTTPS_PROXY=http://wrong\nPATH=/shell:/first\nVISUAL=vim\n__OMP_ENV_END__\nnoise");
        let env = Environment::from([("HOME".into(), "/real".into()), ("EXPLICIT".into(), "launch".into()), ("PATH".into(), "/first".into()), ("GIT_DIR".into(), "/foreign".into())]);
        let merged = merge(&env, &login, Path::new("/not-used"), Platform::Mac);
        assert_eq!(merged["HOME"], "/real");
        assert_eq!(merged["TOKEN"], "shell");
        assert_eq!(merged["EXPLICIT"], "launch");
        assert_eq!(merged["PATH"], "/first:/shell");
        assert!(!merged.contains_key("HTTPS_PROXY"));
        assert!(!merged.contains_key("GIT_DIR"));
        assert_eq!(login.editor.as_deref(), Some("vim"));
        assert_eq!(pac_url("DIRECT; PROXY later:80"), None);
        assert_eq!(pac_url("SOCKS5 localhost:90; DIRECT").as_deref(), Some("socks5://localhost:90"));
    }
}
