//! Finding the Tailscale CLI and telling which Tailscale it belongs to (was `src/main/tailscale/locate.ts`).
//!
//! macOS, in order: the override (`OMP_GUI_TAILSCALE`, which never falls through to another install, then the pref
//! `mobileWeb.tailscaleBin`), the app's own binary (a CLI only with `TAILSCALE_BE_CLI=1`), the Standalone app's "CLI
//! integration" in `/usr/local/bin`, Homebrew's `/opt/homebrew/bin/tailscale` (on a Mac with the app it is a wrapper
//! that execs the app), then the login shell's PATH. Windows: the override, `%ProgramFiles%` and
//! `%ProgramFiles(x86)%`, then PATH. Main names the rules to apply (`platform`) and hands over what only it knows:
//! the override, the pref, the two folders and the PATH.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::fs::order::{is_js_space, js_trim};

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Win32,
}

/// Which Tailscale this is: the Mac App Store app, the Standalone app, a CLI-only daemon, or Windows.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "kebab-case")]
pub enum Variant {
    MacAppStore,
    MacStandalone,
    MacCli,
    Windows,
    Other,
}

pub const MAC_APP_BINARY: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const MAC_APP_STORE_ID: &str = "io.tailscale.ipn.macos";
const MAC_STANDALONE_ID: &str = "io.tailscale.ipn.macsys";
/// A wrapper script is a few lines; only this much of a file is read to look for the app it execs.
const WRAPPER_HEAD_BYTES: usize = 8 * 1024;

/// What a lookup reads of the machine.
pub trait World {
    /// A file the platform can start: any existing file on Windows, one this process may execute elsewhere; never a
    /// directory.
    fn is_executable(&self, file: &str) -> bool;
    /// The start of a text file; none for a binary or unreadable one.
    fn read_head(&self, file: &str) -> Option<String>;
    /// The file a link leads to; none when it leads nowhere.
    fn realpath(&self, file: &str) -> Option<String>;
}

pub struct Inputs<'a> {
    pub platform: Platform,
    /// `OMP_GUI_TAILSCALE`.
    pub forced: Option<&'a str>,
    /// Pref `mobileWeb.tailscaleBin`.
    pub pref: Option<&'a str>,
    /// `%ProgramFiles%` and `%ProgramFiles(x86)%`.
    pub program_files: [Option<&'a str>; 2],
    /// The login shell's PATH.
    pub path_env: &'a str,
}

/// The executable used for every call, and on macOS the app bundle behind it (the binary itself, or the one a
/// wrapper script execs); no bundle for a CLI-only daemon.
#[derive(Debug, PartialEq)]
pub struct Found {
    pub path: String,
    pub app: Option<String>,
}

/// The bundle of an app binary path (`…/Tailscale.app/Contents/MacOS/Tailscale`):
/// `/^(.*\.app)\/Contents\/MacOS\/[^/]+$/`, whose `.` matches no line break.
fn bundle_of_binary(file: &str) -> Option<&str> {
    let (folder, name) = file.rsplit_once('/')?;
    let bundle = folder.strip_suffix("/Contents/MacOS")?;
    let one_line = !bundle.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (!name.is_empty() && bundle.ends_with(".app") && one_line).then_some(bundle)
}

/// The app a wrapper script execs (`exec /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@"`):
/// `/(\/[^\s"'$]+\.app)\/Contents\/MacOS\/Tailscale\b/`, the first match from the left, its bundle as long as it can
/// be.
fn bundle_of_wrapper(text: &str) -> Option<&str> {
    const TAIL: &str = ".app/Contents/MacOS/Tailscale";
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices('/').find_map(|(from, _)| {
        let run = &text[from + 1..];
        let run = &run[..run
            .find(|c| is_js_space(c) || matches!(c, '"' | '\'' | '$'))
            .unwrap_or(run.len())];
        // At least one character between the slash and `.app`; the longest bundle is the last tail that ends at a
        // word's end.
        run.rmatch_indices(TAIL)
            .filter(|(at, _)| *at > 0)
            .find(|(at, _)| {
                let after = from + 1 + at + TAIL.len();
                !text[after..].starts_with(word)
            })
            .map(|(at, _)| &text[from..from + 1 + at + ".app".len()])
    })
}

/// App Store (`io.tailscale.ipn.macos`), Standalone (`io.tailscale.ipn.macsys`); any other bundle id is `other`.
pub fn mac_variant(bundle_id: Option<&str>) -> Variant {
    match bundle_id {
        Some(MAC_APP_STORE_ID) => Variant::MacAppStore,
        Some(MAC_STANDALONE_ID) => Variant::MacStandalone,
        _ => Variant::Other,
    }
}

/// `dir` and `name` as one path of `platform`. Node's `join` also normalized `dir` (`..`, doubled and forward
/// slashes); a folder is kept as it was spelled.
fn join(platform: Platform, dir: &str, name: &str) -> String {
    let separator = match platform {
        Platform::Darwin => '/',
        Platform::Win32 => '\\',
    };
    let closed = dir.ends_with('/') || (platform == Platform::Win32 && dir.ends_with('\\'));
    if closed {
        format!("{dir}{name}")
    } else {
        format!("{dir}{separator}{name}")
    }
}

/// The Tailscale CLI of this machine, or none when there is none.
pub fn find(world: &impl World, inputs: &Inputs) -> Option<Found> {
    let platform = inputs.platform;
    let classify = |file: &str| {
        let app = (platform == Platform::Darwin)
            .then(|| {
                // A broken link still runs (and fails) as itself.
                let real = world.realpath(file);
                let head = || world.read_head(file).unwrap_or_default();
                real.as_deref()
                    .and_then(bundle_of_binary)
                    .or_else(|| bundle_of_binary(file))
                    .map(str::to_owned)
                    .or_else(|| bundle_of_wrapper(&head()).map(str::to_owned))
            })
            .flatten();
        Found {
            path: file.to_owned(),
            app,
        }
    };
    fn named(text: Option<&str>) -> Option<&str> {
        text.map(js_trim).filter(|text| !text.is_empty())
    }
    // A test's (or developer's) own CLI is the only candidate: falling through would run the user's Tailscale.
    if let Some(forced) = named(inputs.forced) {
        return world.is_executable(forced).then(|| classify(forced));
    }
    if let Some(preferred) = named(inputs.pref)
        && world.is_executable(preferred)
    {
        return Some(classify(preferred));
    }
    let fixed: Vec<String> = match platform {
        Platform::Darwin => [
            MAC_APP_BINARY,
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
        ]
        .map(str::to_owned)
        .to_vec(),
        Platform::Win32 => inputs
            .program_files
            .iter()
            .flatten()
            .filter(|root| !root.is_empty())
            .map(|root| {
                join(
                    platform,
                    &join(platform, root, "Tailscale"),
                    "tailscale.exe",
                )
            })
            .collect(),
    };
    let (delimiter, name) = match platform {
        Platform::Darwin => (':', "tailscale"),
        Platform::Win32 => (';', "tailscale.exe"),
    };
    let on_path = inputs
        .path_env
        .split(delimiter)
        .filter(|dir| !dir.is_empty())
        .map(|dir| join(platform, dir, name));
    fixed
        .into_iter()
        .chain(on_path)
        .find(|file| world.is_executable(file))
        .map(|file| classify(&file))
}

#[cfg(unix)]
use crate::sys::may_execute;

/// Node's `X_OK` on Windows asks only whether the file is there.
#[cfg(not(unix))]
fn may_execute(_path: &Path) -> bool {
    true
}

/// This machine's files, read by the rules of a platform.
pub struct Machine(pub Platform);

impl World for Machine {
    fn is_executable(&self, file: &str) -> bool {
        let path = Path::new(file);
        if self.0 == Platform::Darwin && !may_execute(path) {
            return false;
        }
        match std::fs::metadata(path) {
            Ok(found) => !found.is_dir(),
            // Windows: an app execution alias is a reparse point that refuses to be opened and still runs; a link
            // that leads nowhere does not.
            Err(_) => {
                cfg!(windows)
                    && std::fs::symlink_metadata(path).is_ok_and(|found| !found.is_symlink())
            }
        }
    }

    fn read_head(&self, file: &str) -> Option<String> {
        use std::io::Read;

        let mut head = Vec::with_capacity(WRAPPER_HEAD_BYTES);
        std::fs::File::open(file)
            .ok()?
            .take(WRAPPER_HEAD_BYTES as u64)
            .read_to_end(&mut head)
            .ok()?;
        (!head.contains(&0)).then(|| String::from_utf8_lossy(&head).into_owned())
    }

    fn realpath(&self, file: &str) -> Option<String> {
        let real = std::fs::canonicalize(file).ok()?;
        Some(real.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::super::tests::captured;
    use super::*;

    /// A machine as the TypeScript's tests described one.
    #[derive(Debug, Deserialize)]
    struct Fake {
        platform: Platform,
        #[serde(default)]
        env: BTreeMap<String, String>,
        pref: Option<String>,
        #[serde(default)]
        files: Vec<String>,
        #[serde(default)]
        heads: BTreeMap<String, String>,
        #[serde(default)]
        links: BTreeMap<String, String>,
        #[serde(default)]
        bundles: BTreeMap<String, String>,
        #[serde(default)]
        path: String,
    }

    impl World for Fake {
        fn is_executable(&self, file: &str) -> bool {
            self.files.iter().any(|known| known == file)
        }

        fn read_head(&self, file: &str) -> Option<String> {
            self.heads.get(file).cloned()
        }

        fn realpath(&self, file: &str) -> Option<String> {
            Some(self.links.get(file).map_or(file, String::as_str).to_owned())
        }
    }

    #[derive(Debug, PartialEq, Deserialize)]
    struct Located {
        path: String,
        variant: Variant,
        app: Option<String>,
        env: BTreeMap<String, String>,
    }

    fn locate(fake: &Fake) -> Option<Located> {
        let env = |name: &str| fake.env.get(name).map(String::as_str);
        let inputs = Inputs {
            platform: fake.platform,
            forced: env("OMP_GUI_TAILSCALE"),
            pref: fake.pref.as_deref(),
            program_files: [env("ProgramFiles"), env("ProgramFiles(x86)")],
            path_env: &fake.path,
        };
        let found = find(fake, &inputs)?;
        let bundle = found.app.as_ref().and_then(|app| fake.bundles.get(app));
        let (variant, env) = super::super::variant_and_env(
            fake.platform,
            found.app.as_deref(),
            bundle.map(String::as_str),
        );
        Some(Located {
            path: found.path,
            variant,
            app: found.app,
            env: env
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .collect(),
        })
    }

    #[test]
    fn finds_the_cli_the_typescript_found() {
        let rows: Vec<(Fake, Option<Located>)> = captured("located");
        assert!(rows.len() > 45);
        for (at, (fake, expected)) in rows.into_iter().enumerate() {
            assert_eq!(locate(&fake), expected, "world {at}: {fake:?}");
        }
        let variants: Vec<(Option<String>, Variant)> = captured("variants");
        for (id, expected) in variants {
            assert_eq!(mac_variant(id.as_deref()), expected, "{id:?}");
        }
    }

    /// The TypeScript joined with the host's `path`, so its rows for a Mac's PATH could only be captured on one.
    #[test]
    fn searches_the_login_shell_s_path_last_on_a_mac() {
        let mut fake = Fake {
            platform: Platform::Darwin,
            env: BTreeMap::new(),
            pref: None,
            files: vec!["/opt/custom/bin/tailscale".into()],
            heads: BTreeMap::new(),
            links: BTreeMap::new(),
            bundles: BTreeMap::new(),
            path: "/usr/bin::/opt/custom/bin/".into(),
        };
        let found = locate(&fake).unwrap();
        assert_eq!(found.path, "/opt/custom/bin/tailscale");
        assert_eq!(found.variant, Variant::MacCli);
        fake.path = "/usr/bin".into();
        assert_eq!(locate(&fake), None);
        fake.files.push(MAC_APP_BINARY.into());
        fake.path = "/opt/custom/bin".into();
        assert_eq!(locate(&fake).unwrap().path, MAC_APP_BINARY);
    }

    #[test]
    fn reads_this_machine_s_files() {
        let dir = std::env::temp_dir().join(format!("ompdesk-core-locate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("tailscale");
        std::fs::write(
            &script,
            "#!/bin/sh\nexec /x/Tailscale.app/Contents/MacOS/Tailscale\n",
        )
        .unwrap();
        let binary = dir.join("binary");
        std::fs::write(&binary, b"\x7fELF\0\0").unwrap();
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let windows = Machine(Platform::Win32);
        assert!(windows.is_executable(&text(&script)));
        assert!(!windows.is_executable(&text(&dir)));
        assert!(!windows.is_executable(&text(&dir.join("missing"))));
        assert!(
            windows
                .read_head(&text(&script))
                .unwrap()
                .starts_with("#!/bin/sh")
        );
        assert_eq!(windows.read_head(&text(&binary)), None);
        assert_eq!(windows.read_head(&text(&dir.join("missing"))), None);
        assert!(windows.realpath(&text(&script)).is_some());
        assert_eq!(windows.realpath(&text(&dir.join("missing"))), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mac = Machine(Platform::Darwin);
            assert!(!mac.is_executable(&text(&script)), "no execute bit yet");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(mac.is_executable(&text(&script)));
            assert!(!mac.is_executable(&text(&dir)));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
