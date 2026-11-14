//! The pure rules of the `services` module (PROTOCOL.md §15.7): which files are opened and which only revealed (a
//! launcher), and the extension a saved image gets. Was `src/main/open-path.ts` and `ipc.ts`'s `SYSTEM_SAVE_IMAGE`;
//! `captured.json` holds their answers, captured from that TypeScript (`scripts/shell-port/capture-services.ts`).

use std::path::Path;

pub mod notice;
pub mod path;
pub mod reply;

use serde_json::{Value, json};

fn js_whitespace(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// Page links may open web pages or a mail draft, never an arbitrary registered application.
/// The lower-level shell backend also validates OS argument syntax.
pub fn external_url_allowed(url: &Value) -> bool {
    let Some(url) = url.as_str() else {
        return false;
    };
    if url.starts_with("https://") || url.starts_with("http://") {
        return true;
    }
    let Some(scheme) = url.get(..7) else {
        return false;
    };
    scheme.eq_ignore_ascii_case("mailto:")
        && url.len() > 7
        && !url[7..].chars().any(|c| js_whitespace(c) || c.is_control())
}

/// A fixed OS settings destination, separate from page URLs. It opens a pane, never changes a permission.
pub fn privacy_pane_url(pane: &str, macos: bool) -> Result<String, &'static str> {
    if !macos {
        return Err("Privacy & Security panes exist only on macOS.");
    }
    let suffix = match pane {
        "accessibility" => "Privacy_Accessibility",
        "screen_recording" => "Privacy_ScreenCapture",
        "input_monitoring" => "Privacy_ListenEvent",
        "automation" => "Privacy_Automation",
        "full_disk_access" => "Privacy_AllFiles",
        "files_and_folders" => "Privacy_FilesAndFolders",
        "microphone" => "Privacy_Microphone",
        "camera" => "Privacy_Camera",
        _ => return Err("Unknown Privacy & Security pane"),
    };
    Ok(format!(
        "x-apple.systempreferences:com.apple.preference.security?{suffix}"
    ))
}

/// The page's file/folder picker. A folder picker permits creating a folder but never multiple selections.
pub fn open_dialog_options(filters: &Value, options: &Value) -> Value {
    let mut result = json!({
        "properties": if options.get("directory").and_then(Value::as_bool) == Some(true) {
            vec!["openDirectory", "createDirectory"]
        } else {
            vec!["openFile", "multiSelections"]
        },
        "filters": if filters.is_null() { json!([]) } else { filters.clone() },
    });
    for key in ["title", "buttonLabel"] {
        if let Some(value) = options.get(key) {
            result[key] = value.clone();
        }
    }
    if let Some(title) = options.get("title") {
        result["message"] = title.clone();
    }
    result
}

pub fn save_dialog_options(default_path: &Value, filters: &Value) -> Value {
    json!({
        "defaultPath": if default_path.is_null() { json!("session.html") } else { default_path.clone() },
        "filters": if filters.is_null() {
            json!([{ "name": "HTML", "extensions": ["html"] }])
        } else { filters.clone() },
    })
}

/// Types that start code when opened, on any platform (a repo's `run.bat` is revealed on a Mac too). Scripts an
/// interpreter's install can claim are here too: python.org's Python Launcher runs a `.py` on open on macOS, and a file
/// a repo or the agent writes rarely carries the exec bit the POSIX check needs.
const COMMON_LAUNCHERS: &[&str] = &[
    ".app", ".command", ".sh", ".jar", ".bat", ".cmd", ".exe", ".com", ".lnk", ".url", ".py",
    ".pyw", ".pyz", ".pl", ".rb",
];

const MAC_LAUNCHERS: &[&str] = &[
    ".tool",
    ".terminal",
    ".workflow",
    ".action",
    ".saver",
    ".pkg",
    ".mpkg",
    ".dmg",
    ".scpt",
    ".scptd",
    ".applescript",
    ".webloc",
    ".inetloc",
    ".fileloc",
    ".zsh",
    ".bash",
    ".csh",
    ".ksh",
    ".fish",
    ".prefpane",
    ".appex",
    ".xpc",
];

const WINDOWS_LAUNCHERS: &[&str] = &[
    ".ps1",
    ".psm1",
    ".ps1xml",
    ".psc1",
    ".vbs",
    ".vbe",
    ".js",
    ".jse",
    ".wsf",
    ".wsh",
    ".hta",
    ".msi",
    ".msp",
    ".msc",
    ".msix",
    ".msixbundle",
    ".appx",
    ".appxbundle",
    ".appref-ms",
    ".application",
    ".gadget",
    ".reg",
    ".scr",
    ".pif",
    ".cpl",
    ".scf",
    ".diagcab",
    ".library-ms",
    ".search-ms",
    ".settingcontent-ms",
    ".website",
    ".appinstaller",
    // Compiled help runs embedded script; an Excel add-in loads native code; scriptlets run script.
    ".chm",
    ".xll",
    ".wsc",
    ".sct",
    // A theme fetches its resources from a path it names (a remote share leaks NTLM credentials).
    ".theme",
    ".themepack",
];

/// The last component of `path`, trailing separators dropped (node's `path.basename`). Windows also splits on `\`.
fn basename(path: &str, windows: bool) -> &str {
    let is_sep = |c: char| c == '/' || (windows && c == '\\');
    let trimmed = path.trim_end_matches(is_sep);
    trimmed.rsplit(is_sep).next().unwrap_or(trimmed)
}

/// node's `path.extname` of a basename: from its last dot, empty for no dot, a leading dot only, and `..`.
fn extname(base: &str) -> &str {
    if base == ".." {
        return "";
    }
    match base.rfind('.') {
        None | Some(0) => "",
        Some(at) => &base[at..],
    }
}

/// True when the name alone makes `path` a launcher. Windows ignores trailing dots and spaces (`x.exe.` still runs).
pub fn launcher_by_name(path: &str, windows: bool) -> bool {
    let base = basename(path, windows);
    let base = if windows {
        base.trim_end_matches(['.', ' '])
    } else {
        base
    };
    let extension = extname(base).to_lowercase();
    let platform = if windows {
        WINDOWS_LAUNCHERS
    } else {
        MAC_LAUNCHERS
    };
    COMMON_LAUNCHERS.contains(&extension.as_str()) || platform.contains(&extension.as_str())
}

/// True when opening `path` could run code: a launcher by name (also behind a symlink) or, on POSIX, an executable
/// regular file. A path that cannot be resolved is judged by its name alone.
pub fn is_launcher(path: &str, windows: bool) -> bool {
    if launcher_by_name(path, windows) {
        return true;
    }
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    let real_text = real.to_string_lossy();
    // `canonicalize` gives `\\?\C:\…` on Windows; node's realpath gives `C:\…`. Only the name is read here.
    if real_text != path && launcher_by_name(&real_text, windows) {
        return true;
    }
    !windows && executable_file(&real)
}

#[cfg(unix)]
fn executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|info| info.is_file() && info.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable_file(_path: &Path) -> bool {
    false
}

/// What opening a path does: open it, or reveal it in the file manager.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Opened,
    Revealed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Opened => "opened",
            Outcome::Revealed => "revealed",
        }
    }
}

/// Opens `path` in its default app, or reveals it: always for a launcher, and when no app handles the file (`open`
/// failed). `open` and `reveal` are the OS's; a launcher is never handed to `open`.
pub fn open_or_reveal(
    path: &str,
    windows: bool,
    open: impl FnOnce(&str) -> Result<(), String>,
    reveal: impl FnOnce(&str),
) -> Outcome {
    if is_launcher(path, windows) || open(path).is_err() {
        reveal(path);
        return Outcome::Revealed;
    }
    Outcome::Opened
}

/// The extension a saved image gets from its MIME type: the subtype before `+` or `;`, its first `jpeg` spelled `jpg`,
/// only ASCII letters and digits kept; `png` when nothing is left.
pub fn image_extension(mime_type: &str) -> String {
    let Some((_, subtype)) = mime_type.split_once('/') else {
        return "png".into();
    };
    let subtype = subtype.split('/').next().unwrap_or_default();
    let subtype = subtype.split(['+', ';']).next().unwrap_or_default();
    let subtype = subtype.replacen("jpeg", "jpg", 1);
    let kept: String = subtype
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if kept.is_empty() { "png".into() } else { kept }
}

/// The default name of a saved image: the page's name without folders, else `image.<extension>`.
pub fn image_default_name(default_name: &str, extension: &str) -> String {
    let base = basename(default_name, cfg!(windows));
    if base.is_empty() {
        format!("image.{extension}")
    } else {
        base.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn captured() -> Value {
        serde_json::from_str(include_str!("captured.json")).unwrap()
    }

    #[test]
    fn page_service_boundaries_match_the_typescript() {
        let captured: Value = serde_json::from_str(include_str!("boundary-captured.json")).unwrap();
        for row in captured["privacyPane"].as_array().unwrap() {
            assert_eq!(
                privacy_pane_url(row["pane"].as_str().unwrap(), true).unwrap(),
                row["url"]
            );
            assert_eq!(
                privacy_pane_url(row["pane"].as_str().unwrap(), false),
                Err("Privacy & Security panes exist only on macOS.")
            );
        }
        for row in captured["externalUrl"].as_array().unwrap() {
            assert_eq!(
                external_url_allowed(&row["url"]),
                row["allowed"].as_bool().unwrap(),
                "{row}"
            );
        }
        for row in captured["openDialog"].as_array().unwrap() {
            let input = &row["input"];
            assert_eq!(
                open_dialog_options(&input["filters"], input),
                row["options"]
            );
        }
        for row in captured["saveDialog"].as_array().unwrap() {
            let input = &row["input"];
            assert_eq!(
                save_dialog_options(&input["defaultPath"], &input["filters"]),
                row["options"]
            );
        }
    }

    #[test]
    fn launchers_by_name_match_the_typescript() {
        let rows = captured();
        let rows = rows["launcher"].as_array().unwrap();
        assert!(rows.len() > 100);
        for row in rows {
            let name = row["name"].as_str().unwrap();
            let windows = row["platform"] == "win32";
            let path = format!("/nonexistent-ompdesk-capture/dir/{name}");
            assert_eq!(
                launcher_by_name(&path, windows),
                row["launcher"].as_bool().unwrap(),
                "{name} on {}",
                row["platform"]
            );
        }
    }

    #[test]
    fn image_extensions_match_the_typescript() {
        let rows = captured();
        for row in rows["imageExtension"].as_array().unwrap() {
            let mime = row["mimeType"].as_str().unwrap();
            assert_eq!(
                image_extension(mime),
                row["extension"].as_str().unwrap(),
                "{mime:?}"
            );
        }
    }

    #[test]
    fn extname_follows_node() {
        for (base, ext) in [
            ("..exe", ".exe"),
            ("...", "."),
            ("..", ""),
            ("a..", "."),
            ("x.", "."),
            (".exe", ""),
            ("a.b.c", ".c"),
            ("README", ""),
        ] {
            assert_eq!(extname(base), ext, "{base}");
        }
        assert_eq!(basename("a/x.app/", false), "x.app");
        assert_eq!(basename("C:\\a\\run.bat", true), "run.bat");
    }

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ompdesk-services-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_directory_and_ordinary_files_stay_openable_an_app_bundle_does_not() {
        let dir = temp_dir();
        for name in ["a.txt", "a.md", "a.png", "a.js"] {
            let file = dir.join(name);
            std::fs::write(&file, "x").unwrap();
            assert!(!is_launcher(file.to_str().unwrap(), false), "{name}");
        }
        let folder = dir.join("docs");
        std::fs::create_dir(&folder).unwrap();
        assert!(!is_launcher(folder.to_str().unwrap(), false));
        let bundle = dir.join("Thing.app");
        std::fs::create_dir(&bundle).unwrap();
        assert!(is_launcher(bundle.to_str().unwrap(), false));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_executable_file_and_a_symlink_to_a_launcher_are_launchers_on_posix() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = temp_dir();
        let script = dir.join("runme");
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_launcher(script.to_str().unwrap(), false));
        let link = dir.join("notes.txt");
        symlink(&script, &link).unwrap();
        assert!(is_launcher(link.to_str().unwrap(), false));
        let real = dir.join("real.command");
        std::fs::write(&real, "x").unwrap();
        let readme = dir.join("readme.txt");
        symlink(&real, &readme).unwrap();
        assert!(is_launcher(readme.to_str().unwrap(), false));
        // The exec bit means nothing on Windows.
        assert!(!is_launcher(script.to_str().unwrap(), true));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn open_or_reveal_opens_reveals_launchers_and_falls_back_to_reveal() {
        let dir = temp_dir();
        let doc = dir.join("a.txt");
        std::fs::write(&doc, "x").unwrap();
        let doc = doc.to_str().unwrap();
        let mut revealed = Vec::new();
        assert_eq!(
            open_or_reveal(doc, false, |_| Ok(()), |p| revealed.push(p.to_string())),
            Outcome::Opened
        );
        assert!(revealed.is_empty());
        assert_eq!(
            open_or_reveal(
                doc,
                false,
                |_| Err("no application".into()),
                |p| revealed.push(p.to_string())
            ),
            Outcome::Revealed
        );
        let launcher = dir.join("run.command");
        std::fs::write(&launcher, "x").unwrap();
        let launcher = launcher.to_str().unwrap();
        let opened = std::cell::Cell::new(false);
        assert_eq!(
            open_or_reveal(
                launcher,
                false,
                |_| {
                    opened.set(true);
                    Ok(())
                },
                |p| revealed.push(p.to_string())
            ),
            Outcome::Revealed
        );
        assert!(!opened.get(), "a launcher is never opened");
        assert_eq!(revealed, vec![doc.to_string(), launcher.to_string()]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_image_is_named_by_the_page_or_by_its_extension() {
        assert_eq!(image_default_name("../a/cat.png", "png"), "cat.png");
        assert_eq!(image_default_name("", "webp"), "image.webp");
        assert_eq!(image_default_name("folder/", "jpg"), "folder");
    }
}
