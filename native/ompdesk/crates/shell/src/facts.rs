//! The facts `hello`'s answer carries (PROTOCOL.md §1): everything Node's shim serves synchronously (`app.getPath`,
//! locale, displays, theme, `safeStorage`'s key…), read from the OS before CEF exists.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::migrate::safe_storage;

pub const CEF_VERSION: &str = "156.0.26";
pub const CHROME_VERSION: &str = "156.0.8078.88";

/// Where the shell and the app it hosts live.
pub struct Launch {
    pub user_data: PathBuf,
    pub exe: PathBuf,
    /// The folder holding `out/main/index.js` and `package.json`.
    pub app_dir: PathBuf,
    pub packaged: bool,
    /// `process.resourcesPath`.
    pub resources: PathBuf,
    /// The shell's own argv, exe first.
    pub argv: Vec<String>,
    /// `--lang=` among the arguments.
    pub lang: Option<String>,
}

/// The locale Chromium reports as `app.getLocale()` for an OS locale tag (`ko-KR` → `ko`, `en-AU` → `en-GB`).
pub fn chromium_locale(tag: &str) -> String {
    let tag = tag.replace('_', "-");
    const KEEP: [&str; 7] = [
        "en-US", "en-GB", "pt-BR", "pt-PT", "zh-CN", "zh-TW", "es-419",
    ];
    if let Some(kept) = KEEP.iter().find(|k| k.eq_ignore_ascii_case(&tag)) {
        return (*kept).to_string();
    }
    let mut parts = tag.split('-');
    let language = parts.next().unwrap_or("en").to_ascii_lowercase();
    let region = parts
        .last()
        .map(str::to_ascii_uppercase)
        .unwrap_or_default();
    match (language.as_str(), region.as_str()) {
        ("zh", "TW" | "HK" | "MO") => "zh-TW".into(),
        ("zh", "SG") => "zh-CN".into(),
        ("zh", _) => "zh-CN".into(),
        ("en", "AU" | "NZ" | "ZA" | "IN" | "IE") => "en-GB".into(),
        ("en", _) => "en-US".into(),
        ("es", r) if r != "ES" && !r.is_empty() => "es-419".into(),
        (other, _) => other.to_string(),
    }
}

/// `<userData>/logs`, `<userData>/Crashpad`: where Electron kept them on Windows.
fn app_paths(launch: &Launch) -> serde_json::Map<String, Value> {
    let mut paths = serde_json::Map::new();
    let put = |paths: &mut serde_json::Map<String, Value>, name: &str, p: &Path| {
        paths.insert(name.to_string(), json!(p.to_string_lossy()));
    };
    put(&mut paths, "userData", &launch.user_data);
    put(&mut paths, "sessionData", &launch.user_data);
    put(&mut paths, "exe", &launch.exe);
    put(&mut paths, "module", &launch.exe);
    put(&mut paths, "temp", &std::env::temp_dir());
    put(&mut paths, "logs", &launch.user_data.join("logs"));
    put(&mut paths, "crashDumps", &launch.user_data.join("Crashpad"));
    paths
}

#[cfg(windows)]
pub fn collect(launch: &Launch, log: &mut dyn FnMut(&str, Value)) -> Value {
    use crate::sys::system;
    let mut paths = app_paths(launch);
    for (name, path) in system::known_paths() {
        paths.insert(name.to_string(), json!(path.to_string_lossy()));
    }
    let system_locale = system::user_locale_name();
    let app_locale = chromium_locale(launch.lang.as_deref().unwrap_or(&system_locale));
    let (displays, primary) = system::displays();
    json!({
        "paths": paths,
        "exe": launch.exe.to_string_lossy(),
        "resourcesPath": launch.resources.to_string_lossy(),
        "appPath": launch.app_dir.to_string_lossy(),
        "isPackaged": launch.packaged,
        "argv": launch.argv,
        "locale": { "appLocale": app_locale, "systemLocale": system_locale, "preferredLanguages": system::preferred_languages() },
        "displays": displays,
        "primaryDisplayId": primary,
        "theme": system::theme(),
        "system": { "reducedMotion": system::reduced_motion(), "onBattery": system::on_battery(), "online": system::online() },
        "versions": { "chrome": CHROME_VERSION, "cef": CEF_VERSION, "shell": env!("CARGO_PKG_VERSION") },
        "safeStorage": safe_storage::facts(&launch.user_data, log),
    })
}

/// The OS-owned folders Electron's `app.getPath` serves on macOS (UNVERIFIED on a Mac).
#[cfg(target_os = "macos")]
pub fn collect(launch: &Launch, log: &mut dyn FnMut(&str, Value)) -> Value {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let mut paths = app_paths(launch);
    let mut put = |name: &str, p: PathBuf| {
        paths.insert(name.to_string(), json!(p.to_string_lossy()));
    };
    put("home", home.clone());
    put("appData", home.join("Library/Application Support"));
    put("desktop", home.join("Desktop"));
    put("documents", home.join("Documents"));
    put("downloads", home.join("Downloads"));
    put("music", home.join("Music"));
    put("pictures", home.join("Pictures"));
    put("videos", home.join("Movies"));
    paths.insert(
        "logs".into(),
        json!(home.join("Library/Logs/ompdesk").to_string_lossy()),
    );
    let system_locale = crate::sys_mac::system_locale();
    let app_locale = chromium_locale(launch.lang.as_deref().unwrap_or(&system_locale));
    let (displays, primary) = crate::sys_mac::displays();
    json!({
        "paths": paths,
        "exe": launch.exe.to_string_lossy(),
        "resourcesPath": launch.resources.to_string_lossy(),
        "appPath": launch.app_dir.to_string_lossy(),
        "isPackaged": launch.packaged,
        "argv": launch.argv,
        "locale": { "appLocale": app_locale, "systemLocale": system_locale, "preferredLanguages": crate::sys_mac::preferred_languages() },
        "displays": displays,
        "primaryDisplayId": primary,
        "theme": crate::sys_mac::theme(),
        "system": { "reducedMotion": crate::sys_mac::reduced_motion(), "onBattery": crate::sys_mac::on_battery(), "online": true },
        "versions": { "chrome": CHROME_VERSION, "cef": CEF_VERSION, "shell": env!("CARGO_PKG_VERSION") },
        "safeStorage": safe_storage::facts(&launch.user_data, log),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_os_locale_becomes_the_locale_chromium_reports() {
        assert_eq!(chromium_locale("ko-KR"), "ko");
        assert_eq!(chromium_locale("en-US"), "en-US");
        assert_eq!(chromium_locale("en-AU"), "en-GB");
        assert_eq!(chromium_locale("en_CA"), "en-US");
        assert_eq!(chromium_locale("pt-BR"), "pt-BR");
        assert_eq!(chromium_locale("pt-AO"), "pt");
        assert_eq!(chromium_locale("zh-Hant-TW"), "zh-TW");
        assert_eq!(chromium_locale("zh-HK"), "zh-TW");
        assert_eq!(chromium_locale("es-MX"), "es-419");
        assert_eq!(chromium_locale("es-ES"), "es");
        assert_eq!(chromium_locale("de-DE"), "de");
        assert_eq!(chromium_locale("ko"), "ko");
    }

    #[test]
    #[cfg(windows)]
    fn the_facts_name_every_path_electron_serves_and_a_key_or_why_not() {
        let dir = std::env::temp_dir().join(format!("shell-facts-{}", std::process::id()));
        let launch = Launch {
            user_data: dir.clone(),
            exe: PathBuf::from("C:/x/ompdesk-shell.exe"),
            app_dir: PathBuf::from("C:/repo"),
            packaged: false,
            resources: PathBuf::from("C:/repo/resources"),
            argv: vec!["ompdesk-shell.exe".into()],
            lang: None,
        };
        let facts = collect(&launch, &mut |_, _| {});
        for name in [
            "userData",
            "appData",
            "sessionData",
            "home",
            "temp",
            "exe",
            "module",
            "desktop",
            "documents",
            "downloads",
            "music",
            "pictures",
            "videos",
            "logs",
            "crashDumps",
        ] {
            assert!(facts["paths"][name].is_string(), "missing path {name}");
        }
        assert!(facts["displays"].as_array().is_some_and(|d| !d.is_empty()));
        assert!(
            facts["safeStorage"]["kind"] == "win-v10"
                || facts["safeStorage"]["unavailable"].is_string()
        );
        assert!(
            facts["locale"]["preferredLanguages"]
                .as_array()
                .is_some_and(|l| !l.is_empty())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
