//! Deep links and launch paths (was `src/main/deep-link.ts` and `launch-argv.ts`'s `parseLaunchArgv`): what a launch's
//! arguments ask for, how an `omp://` URL reads, how a path is resolved and matched against the windows' folders, and
//! the plan (which window is spawned, shown and sent a link) the module executes. No CEF in here.

use std::path::Path;

use serde_json::{Value, json};
use url::Url;

/// The URL scheme OMPdesk registers.
pub const PROTOCOL: &str = "omp";

/// What a launch's arguments ask for.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum LaunchRequest {
    Url(String),
    Path(String),
    Focus,
}

/// A real folder (`isExistingDirectory`: a symlink to one counts).
pub fn is_existing_directory(path: &str) -> bool {
    Path::new(path).is_dir()
}

/// A deep link wins over everything; otherwise the first argument naming a real directory is the workspace to open,
/// and anything left means "just raise the app". Flags are skipped so the shell's own switches never look like a path.
pub fn parse_launch_argv(
    argv: &[String],
    protocol: &str,
    directory_exists: impl Fn(&str) -> bool,
) -> LaunchRequest {
    let prefix = format!("{protocol}://");
    if let Some(url) = argv.iter().find(|arg| arg.starts_with(&prefix)) {
        return LaunchRequest::Url(url.clone());
    }
    argv.iter()
        .filter(|arg| !arg.starts_with('-'))
        .find(|arg| directory_exists(arg))
        .map_or(LaunchRequest::Focus, |path| {
            LaunchRequest::Path(path.clone())
        })
}

/// What a link asks the page to do (`DeepLinkPayload`, `src/shared/ipc-types.ts`).
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Link {
    NewSession,
    SwitchSession(String),
}

impl Link {
    pub fn to_json(&self) -> Value {
        match self {
            Link::NewSession => json!({ "action": "new-session" }),
            Link::SwitchSession(id) => json!({ "action": "switch-session", "sessionId": id }),
        }
    }
}

/// What reading a URL gave.
#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    /// Not a URL at all: nothing happens, no window is touched.
    Invalid,
    /// A URL that is no link of ours (`omp://foo`, `omp://session/`): the window still comes forward.
    Unknown,
    Link(Link),
}

/// `omp://new` and `omp://session/<id>`; the scheme is not looked at, as before. The URL standard puts the first
/// segment of a `scheme://` URL into the host: `omp://new` is host `new`, `omp://session/<id>` host `session` and path
/// `/<id>`; query and fragment never reach the id.
pub fn parse_link(url: &str) -> Parsed {
    let Ok(parsed) = Url::parse(url) else {
        return Parsed::Invalid;
    };
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    match host.as_str() {
        "new" => Parsed::Link(Link::NewSession),
        "session" => {
            let id = parsed.path().trim_matches('/');
            if id.is_empty() {
                Parsed::Unknown
            } else {
                Parsed::Link(Link::SwitchSession(id.to_string()))
            }
        }
        _ => Parsed::Unknown,
    }
}

/// Which of node's `path` flavours a path follows (the shell resolves what Node's `path.resolve` resolved).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Flavor {
    Posix,
    Win32,
}

impl Flavor {
    pub const HOST: Flavor = if cfg!(windows) {
        Flavor::Win32
    } else {
        Flavor::Posix
    };
}

fn separator(flavor: Flavor, c: char) -> bool {
    c == '/' || (flavor == Flavor::Win32 && c == '\\')
}

/// `path.isAbsolute`.
pub fn is_absolute(flavor: Flavor, path: &str) -> bool {
    let chars: Vec<char> = path.chars().take(3).collect();
    match flavor {
        Flavor::Posix => chars.first() == Some(&'/'),
        Flavor::Win32 => {
            chars.first().is_some_and(|c| separator(flavor, *c))
                || (chars.len() > 2
                    && chars[0].is_ascii_alphabetic()
                    && chars[1] == ':'
                    && separator(flavor, chars[2]))
        }
    }
}

/// `path.resolve(path)` of an absolute path (no other argument, so the process folder never joins in, but for a
/// Windows path rooted without a drive, which takes `drive`, the process's own).
pub fn resolve(flavor: Flavor, path: &str, drive: char) -> String {
    let chars: Vec<char> = path.chars().collect();
    let (device, tail_from) = match flavor {
        Flavor::Posix => (String::new(), 0),
        Flavor::Win32 => win32_root(&chars, drive),
    };
    let sep = if flavor == Flavor::Win32 { '\\' } else { '/' };
    let mut segments: Vec<String> = Vec::new();
    let mut segment = String::new();
    let flush = |segment: &mut String, segments: &mut Vec<String>| {
        match segment.as_str() {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            _ => segments.push(std::mem::take(segment)),
        }
        segment.clear();
    };
    for c in &chars[tail_from..] {
        if separator(flavor, *c) {
            flush(&mut segment, &mut segments);
        } else {
            segment.push(*c);
        }
    }
    flush(&mut segment, &mut segments);
    format!("{device}{sep}{}", segments.join(&sep.to_string()))
}

/// The root of a Windows path: `X:`, `\\server\share`, or the process's drive for a path rooted without one; and where
/// the rest of the path starts.
fn win32_root(chars: &[char], drive: char) -> (String, usize) {
    let is_sep = |i: usize| chars.get(i).is_some_and(|c| separator(Flavor::Win32, *c));
    if is_sep(0) && is_sep(1) {
        // `\\server\share`: both parts non-empty; else the path is rooted at `\` and `\\x` is just `\x`.
        let mut i = 2;
        let server_from = i;
        while i < chars.len() && !is_sep(i) {
            i += 1;
        }
        if i < chars.len() && i != server_from {
            let server: String = chars[server_from..i].iter().collect();
            while is_sep(i) {
                i += 1;
            }
            let share_from = i;
            while i < chars.len() && !is_sep(i) {
                i += 1;
            }
            if i > share_from {
                let share: String = chars[share_from..i].iter().collect();
                return (format!("\\\\{server}\\{share}"), i);
            }
        }
        return (format!("{drive}:"), 1);
    }
    if is_sep(0) {
        return (format!("{drive}:"), 1);
    }
    let letter: String = chars[..2].iter().collect();
    (letter, 2)
}

/// What `open-file` and a second launch's folder ask of the windows.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenPath {
    /// Relative paths resolve against the launcher's folder, never the workspace the person pointed at: refused.
    Ignore,
    /// The window (its position among the app windows) already showing the folder.
    Show(usize),
    Spawn(String),
}

/// Brings the window already showing this workspace forward, or opens it in a new one.
pub fn open_path(
    flavor: Flavor,
    path: &str,
    drive: char,
    window_cwds: &[Option<String>],
) -> OpenPath {
    if !is_absolute(flavor, path) {
        return OpenPath::Ignore;
    }
    let target = resolve(flavor, path, drive);
    match window_cwds
        .iter()
        .position(|cwd| cwd.as_deref() == Some(target.as_str()))
    {
        Some(index) => OpenPath::Show(index),
        None => OpenPath::Spawn(target),
    }
}

/// One arrival the shell handles.
pub enum Arrival<'a> {
    OpenUrl(&'a str),
    OpenFile(&'a str),
    /// A refused second launch: its whole argv (the first is that launch's executable).
    SecondInstance(&'a [String]),
}

/// The windows as the plan sees them, oldest first.
pub struct Windows<'a> {
    pub cwds: &'a [Option<String>],
    /// The window user actions go to (`getTargetWindow`): its position.
    pub target: Option<usize>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Shown {
    Window(usize),
    /// The window the plan spawns first.
    Spawned,
}

/// What an arrival does: the window it spawns (`Some(None)`: the default one), the one it shows, the link it delivers
/// to that window once its page loaded.
#[derive(Debug, PartialEq, Eq, Default)]
pub struct Plan {
    pub spawn: Option<Option<String>>,
    pub show: Option<Shown>,
    pub deliver: Option<Link>,
}

pub fn plan(arrival: &Arrival, windows: &Windows, flavor: Flavor, drive: char) -> Plan {
    match arrival {
        Arrival::OpenUrl(url) => link_plan(url, !windows.cwds.is_empty()),
        Arrival::OpenFile(path) => path_plan(flavor, path, drive, windows),
        Arrival::SecondInstance(argv) => {
            let request = parse_launch_argv(argv.get(1..).unwrap_or_default(), PROTOCOL, |p| {
                is_existing_directory(p)
            });
            match request {
                LaunchRequest::Url(url) => link_plan(&url, !windows.cwds.is_empty()),
                LaunchRequest::Path(path) => path_plan(flavor, &path, drive, windows),
                LaunchRequest::Focus => Plan {
                    show: windows.target.map(Shown::Window),
                    ..Plan::default()
                },
            }
        }
    }
}

fn link_plan(url: &str, has_main: bool) -> Plan {
    let link = match parse_link(url) {
        Parsed::Invalid => return Plan::default(),
        Parsed::Unknown => None,
        Parsed::Link(link) => Some(link),
    };
    let (spawn, show) = if has_main {
        (None, Shown::Window(0))
    } else {
        (Some(None), Shown::Spawned)
    };
    Plan {
        spawn,
        show: Some(show),
        deliver: link,
    }
}

fn path_plan(flavor: Flavor, path: &str, drive: char, windows: &Windows) -> Plan {
    match open_path(flavor, path, drive, windows.cwds) {
        OpenPath::Ignore => Plan::default(),
        OpenPath::Show(index) => Plan {
            show: Some(Shown::Window(index)),
            ..Plan::default()
        },
        OpenPath::Spawn(target) => Plan {
            spawn: Some(Some(target)),
            ..Plan::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chrome_core::captured::{of, steps};

    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // The cases of `launch-argv.test.ts`.
    #[test]
    fn a_deep_link_wins_over_a_directory_in_the_same_argv() {
        let exists = |p: &str| p == "/workspace/app" || p == "/Applications/omp.app";
        assert_eq!(
            parse_launch_argv(
                &argv(&[
                    "/Applications/omp.app",
                    "omp://session/abc",
                    "/workspace/app"
                ]),
                "omp",
                exists
            ),
            LaunchRequest::Url("omp://session/abc".into())
        );
    }

    #[test]
    fn the_first_argument_naming_a_real_directory_is_the_workspace() {
        let exists = |p: &str| p == "/workspace/app" || p == "/Applications/omp.app";
        assert_eq!(
            parse_launch_argv(
                &argv(&["electron-bin", "/workspace/app", "/nope"]),
                "omp",
                exists
            ),
            LaunchRequest::Path("/workspace/app".into())
        );
    }

    #[test]
    fn switches_never_masquerade_as_paths() {
        let exists = |p: &str| p == "/workspace/app";
        assert_eq!(
            parse_launch_argv(
                &argv(&["--class=App", "--no-sandbox", "/workspace/app"]),
                "omp",
                exists
            ),
            LaunchRequest::Path("/workspace/app".into())
        );
        assert_eq!(
            parse_launch_argv(&argv(&["--flag", "./relative", "/missing"]), "omp", exists),
            LaunchRequest::Focus
        );
        assert_eq!(
            parse_launch_argv(&argv(&["/tmp/not-a-directory"]), "omp", |_| false),
            LaunchRequest::Focus
        );
    }

    #[test]
    fn replays_the_captured_launch_arguments() {
        for step in of("deeplink", "src/main/launch-argv.ts#parseLaunchArgv") {
            let dirs = strings(&step.input["directories"]);
            let got = parse_launch_argv(&strings(&step.input["argv"]), "omp", |p| {
                dirs.iter().any(|d| d == p)
            });
            let want = match step.output["kind"].as_str().unwrap() {
                "url" => LaunchRequest::Url(step.output["url"].as_str().unwrap().into()),
                "path" => LaunchRequest::Path(step.output["path"].as_str().unwrap().into()),
                _ => LaunchRequest::Focus,
            };
            assert_eq!(got, want, "{:?}", step.input);
        }
    }

    #[test]
    fn replays_node_path_rules() {
        for step in of("deeplink", "node:path#posix.isAbsolute+resolve") {
            let path = step.input["path"].as_str().unwrap();
            assert_eq!(
                is_absolute(Flavor::Posix, path),
                step.output["absolute"].as_bool().unwrap(),
                "{path:?}"
            );
            if let Some(want) = step.output["resolved"].as_str() {
                assert_eq!(resolve(Flavor::Posix, path, 'C'), want, "{path:?}");
            }
        }
        for step in of("deeplink", "node:path#win32.isAbsolute+resolve") {
            let path = step.input["path"].as_str().unwrap();
            assert_eq!(
                is_absolute(Flavor::Win32, path),
                step.output["absolute"].as_bool().unwrap(),
                "{path:?}"
            );
            if let Some(want) = step.output["resolved"].as_str() {
                // Captured on a machine whose drive was not a letter: a root without a drive carries none.
                if want.starts_with('\\') && !want.starts_with("\\\\") {
                    continue;
                }
                assert_eq!(resolve(Flavor::Win32, path, 'C'), want, "{path:?}");
            }
        }
    }

    #[test]
    fn a_windows_path_rooted_without_a_drive_takes_the_processes() {
        assert_eq!(resolve(Flavor::Win32, "\\a\\..\\b", 'D'), "D:\\b");
        assert_eq!(resolve(Flavor::Win32, "/a", 'C'), "C:\\a");
        assert_eq!(resolve(Flavor::Win32, "\\\\srv", 'E'), "E:\\srv");
    }

    #[test]
    fn reads_the_links_it_knows_and_nothing_else() {
        assert_eq!(parse_link("omp://new"), Parsed::Link(Link::NewSession));
        assert_eq!(
            parse_link("omp://session/abc/"),
            Parsed::Link(Link::SwitchSession("abc".into()))
        );
        assert_eq!(parse_link("omp://session/"), Parsed::Unknown);
        assert_eq!(parse_link("omp://foo"), Parsed::Unknown);
        assert_eq!(parse_link("not a url"), Parsed::Invalid);
    }

    /// The windows a captured world holds.
    fn world(world: &Value, folder: &str) -> Vec<Option<String>> {
        world["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| Some(w["cwd"].as_str().unwrap().replace("<folder>", folder)))
            .collect()
    }

    /// What a captured step records of a plan: the spawned folders, the shown windows and the links sent.
    fn outcome(plan: &Plan) -> Value {
        let spawned: Vec<Value> = plan
            .spawn
            .iter()
            .map(|cwd| cwd.as_deref().map_or(Value::Null, Value::from))
            .collect();
        let shown = |s: &Shown| match s {
            Shown::Window(i) => json!(i),
            Shown::Spawned => json!("spawned"),
        };
        let sent: Vec<Value> = match (&plan.deliver, &plan.show) {
            (Some(link), Some(show)) => {
                vec![json!({ "win": shown(show), "payload": link.to_json() })]
            }
            _ => vec![],
        };
        json!({
            "spawned": spawned,
            "shown": plan.show.iter().map(shown).collect::<Vec<_>>(),
            "sent": sent,
        })
    }

    fn compare(step: &crate::chrome_core::captured::Step, plan: &Plan, folder: &str) {
        let mut want = step.output.clone();
        for cwd in want["spawned"].as_array_mut().unwrap() {
            if let Some(text) = cwd.as_str() {
                *cwd = json!(text.replace("<folder>", folder));
            }
        }
        // `when` (now or after the page loaded) is the module's, and the raw window calls are the old API's.
        for sent in want["sent"].as_array_mut().unwrap() {
            sent.as_object_mut().unwrap().remove("when");
        }
        want.as_object_mut().unwrap().remove("calls");
        assert_eq!(outcome(plan), want, "{:?}", step.input);
    }

    #[test]
    fn replays_open_url_and_open_file() {
        for step in steps("deeplink") {
            let kind = step.function.as_str();
            if kind != "src/main/deep-link.ts#open-url" && kind != "src/main/deep-link.ts#open-file"
            {
                continue;
            }
            let cwds = world(&step.input["world"], "");
            let target = step.input["world"]["target"].as_u64().map(|t| t as usize);
            let windows = Windows {
                cwds: &cwds,
                target,
            };
            let plan = if kind.ends_with("open-url") {
                plan(
                    &Arrival::OpenUrl(step.input["url"].as_str().unwrap()),
                    &windows,
                    Flavor::Posix,
                    'C',
                )
            } else {
                plan(
                    &Arrival::OpenFile(step.input["path"].as_str().unwrap()),
                    &windows,
                    Flavor::Posix,
                    'C',
                )
            };
            compare(&step, &plan, "");
        }
    }

    #[test]
    fn replays_second_launches() {
        // A real folder stands in for the one the capture made: the plan asks the file system whether a path exists.
        let folder = env!("CARGO_MANIFEST_DIR");
        for step in of("deeplink", "src/main/deep-link.ts#second-instance") {
            let argv: Vec<String> = strings(&step.input["argv"])
                .into_iter()
                .map(|a| a.replace("<folder>", folder))
                .collect();
            let resolved = resolve(Flavor::HOST, folder, 'C');
            let cwds = world(&step.input["world"], &resolved);
            let target = step.input["world"]["target"].as_u64().map(|t| t as usize);
            let windows = Windows {
                cwds: &cwds,
                target,
            };
            let plan = plan(&Arrival::SecondInstance(&argv), &windows, Flavor::HOST, 'C');
            compare(&step, &plan, &resolved);
        }
    }
}
