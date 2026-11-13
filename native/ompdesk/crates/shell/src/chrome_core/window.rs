//! The app windows' rules (were `src/main/window.ts`, `window-bounds.ts`, `window-chrome.ts`'s options, `window-show.ts`
//! and `renderer-recovery.ts`): geometry, chrome, first show, what a close does, renderer recovery and the run
//! progress. `modules/chrome/window.rs` carries them out; `captured/window.json` holds the TypeScript's answers.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Only the top strip matters: it carries the title bar the person drags by.
const GRAB_BAND_HEIGHT: f64 = 28.0;
const MIN_GRAB_WIDTH: f64 = 60.0;

fn intersects(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/// Enough of the window's title bar sits on some display to reach it.
pub fn is_reachable(rect: &Rect, work_areas: &[Rect]) -> bool {
    let band = Rect {
        height: GRAB_BAND_HEIGHT,
        ..*rect
    };
    work_areas.iter().any(|area| {
        let width = (band.x + band.width).min(area.x + area.width) - band.x.max(area.x);
        let height = (band.y + band.height).min(area.y + area.height) - band.y.max(area.y);
        width >= MIN_GRAB_WIDTH && height > 0.0 && intersects(&band, area)
    })
}

/// JavaScript's `Math.round` (halves go up, toward +∞).
fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// `rect` where it was when its title bar is on a screen, else centred on the first work area (never resized beyond
/// it: a window stretched across two monitors comes back that way when both are attached again).
pub fn restore_within_displays(rect: Rect, work_areas: &[Rect]) -> Rect {
    let Some(area) = work_areas.first() else {
        return rect;
    };
    if is_reachable(&rect, work_areas) {
        return rect;
    }
    let width = rect.width.min((area.width - 40.0).max(1.0));
    let height = rect.height.min((area.height - 40.0).max(1.0));
    Rect {
        x: js_round(area.x + (area.width - width) / 2.0),
        y: js_round(area.y + (area.height - height) / 2.0),
        width,
        height,
    }
}

pub const TOP_BAR_HEIGHT: i64 = 48;
pub const DEFAULT_WIDTH: f64 = 1400.0;
pub const DEFAULT_HEIGHT: f64 = 900.0;
pub const MIN_WIDTH: i64 = 800;
pub const MIN_HEIGHT: i64 = 600;
/// Each window opened while others are open moves this far down and right: they all share one saved geometry.
pub const CASCADE_STEP: f64 = 28.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Other,
}

impl Platform {
    pub fn parse(name: &str) -> Self {
        match name {
            "darwin" => Self::Mac,
            "win32" => Self::Windows,
            _ => Self::Other,
        }
    }

    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

/// Windows 11 22H2 (build 22621) is the first build the Mica material draws on. `release` is `os.release()`.
pub fn mica_supported(platform: Platform, release: &str) -> bool {
    platform == Platform::Windows
        && release
            .split('.')
            .nth(2)
            .map_or(Some(0.0), |build| build.trim().parse::<f64>().ok())
            .is_some_and(|build| build >= 22621.0)
}

/// The frameless chrome: macOS hidden-inset traffic lights in the 48 px top bar, Windows the caption buttons over it
/// in the theme's first colours (the page pushes its own later) and Mica when asked.
pub fn chrome_options(platform: Platform, dark: bool, mica: bool) -> Value {
    match platform {
        Platform::Mac => {
            json!({ "titleBarStyle": "hiddenInset", "trafficLightPosition": { "x": 18, "y": 17 } })
        }
        Platform::Windows => {
            let (color, symbol) = if dark {
                ("#19191c", "#ededf0")
            } else {
                ("#ffffff", "#1b1b1f")
            };
            let mut options = json!({
                "titleBarStyle": "hidden",
                "titleBarOverlay": { "color": color, "symbolColor": symbol, "height": TOP_BAR_HEIGHT },
            });
            if mica {
                options["backgroundMaterial"] = json!("mica");
            }
            options
        }
        Platform::Other => json!({}),
    }
}

/// `<userData>/window-state.json` (electron-store's `{"windowState": …}`), the one geometry every window shares.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_maximized: Option<bool>,
}

impl Default for Saved {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            is_maximized: None,
        }
    }
}

/// The saved geometry in the store's text; anything unreadable is no saved geometry, as electron-store's default.
pub fn parse_saved(text: Option<&str>) -> Saved {
    text.and_then(|t| serde_json::from_str::<Value>(t).ok())
        .and_then(|v| v.get("windowState").cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// The geometry as JSON spells it (whole numbers without a fraction, as `JSON.stringify` writes them).
pub fn saved_value(saved: &Saved) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(x) = saved.x {
        out.insert("x".into(), whole(x));
    }
    if let Some(y) = saved.y {
        out.insert("y".into(), whole(y));
    }
    out.insert("width".into(), whole(saved.width));
    out.insert("height".into(), whole(saved.height));
    if let Some(maximized) = saved.is_maximized {
        out.insert("isMaximized".into(), json!(maximized));
    }
    Value::Object(out)
}

/// The store after a close saved `saved` (electron-store keeps the file's other keys and indents with a tab).
pub fn store_text(previous: Option<&str>, saved: &Saved) -> String {
    let mut root = previous
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    root["windowState"] = saved_value(saved);
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    root.serialize(&mut serializer).expect("JSON serialises");
    String::from_utf8(out).expect("JSON is UTF-8")
}

/// What a new window looks like before it shows.
pub struct Opening {
    /// `BrowserWindowConstructorOptions` as `win.create` carried them.
    pub options: Value,
    pub maximize: bool,
    /// The window has the Mica backdrop (the page is loaded with `mica=1`).
    pub mica: bool,
}

pub struct OpenFacts<'a> {
    pub saved: Saved,
    /// App windows already open (each moves the next one `CASCADE_STEP` further).
    pub open: usize,
    /// The primary display's work area first, then every display's.
    pub work_areas: &'a [Rect],
    pub platform: Platform,
    pub dark: bool,
    pub mica_supported: bool,
    /// `OMP_GUI_HEADLESS=1`: a hosted runner has no display, and macOS would hold a window to the default screen.
    pub headless: bool,
    /// The window icon file (not on macOS, which draws it from the bundle).
    pub icon: Option<&'a str>,
}

fn whole(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

pub fn opening(facts: &OpenFacts) -> Opening {
    let saved = facts.saved;
    let offset = facts.open as f64 * CASCADE_STEP;
    let maximized = saved.is_maximized == Some(true);
    // Mica only for a window that first shows restored: a Mica window shown maximized stays blank for good.
    let mica = facts.mica_supported && !maximized;
    let mut options = serde_json::Map::new();
    match (saved.x, saved.y) {
        (Some(x), Some(y)) => {
            let rect = restore_within_displays(
                Rect {
                    x: x + offset,
                    y: y + offset,
                    width: saved.width,
                    height: saved.height,
                },
                facts.work_areas,
            );
            options.insert("x".into(), whole(rect.x));
            options.insert("y".into(), whole(rect.y));
            options.insert("width".into(), whole(rect.width));
            options.insert("height".into(), whole(rect.height));
        }
        _ => {
            options.insert("width".into(), whole(saved.width));
            options.insert("height".into(), whole(saved.height));
        }
    }
    options.insert("minWidth".into(), json!(MIN_WIDTH));
    options.insert("minHeight".into(), json!(MIN_HEIGHT));
    options.insert("show".into(), json!(false));
    options.insert("enableLargerThanScreen".into(), json!(facts.headless));
    options.insert(
        "autoHideMenuBar".into(),
        json!(facts.platform == Platform::Windows),
    );
    if facts.platform != Platform::Mac
        && let Some(icon) = facts.icon
    {
        options.insert("icon".into(), json!(icon));
    }
    if let Value::Object(chrome) = chrome_options(facts.platform, facts.dark, mica) {
        options.extend(chrome);
    }
    options.insert(
        "webPreferences".into(),
        json!({ "contextIsolation": true, "nodeIntegration": false, "sandbox": true, "spellcheck": true, "session": "app" }),
    );
    Opening {
        options: Value::Object(options),
        maximize: maximized,
        mica,
    }
}

/// The lowest slot no open window holds (the page keys its per-window state on it).
pub fn free_slot(taken: &[u32]) -> u32 {
    (0..).find(|slot| !taken.contains(slot)).unwrap_or(0)
}

/// The page's address: `app://ompdesk/index.html?slot=n[&mica=1]`, the dev server's when `dev_url` is set, the style
/// guide's hash under `OMP_GUI_STYLEGUIDE=1`.
pub fn page_url(dev_url: Option<&str>, slot: u32, mica: bool, styleguide: bool) -> String {
    let base = dev_url.unwrap_or("app://ompdesk/index.html");
    let (head, hash) = base
        .split_once('#')
        .map_or((base, None), |(h, f)| (h, Some(f)));
    let (path, query) = head.split_once('?').unwrap_or((head, ""));
    let mut pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (k.to_string(), v.to_string())
        })
        .collect();
    let mut set = |key: &str, value: &str| match pairs.iter_mut().find(|(k, _)| k == key) {
        Some(pair) => pair.1 = value.to_string(),
        None => pairs.push((key.to_string(), value.to_string())),
    };
    set("slot", &slot.to_string());
    if mica {
        set("mica", "1");
    }
    let query: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let mut url = format!("{path}?{}", query.join("&"));
    match (styleguide, hash) {
        (true, _) => url.push_str("#/styleguide"),
        (false, Some(hash)) => {
            url.push('#');
            url.push_str(hash);
        }
        (false, None) => {}
    }
    url
}

/// How a window first shows (`launchPresence` of an update's relaunch, else in front); None: it stays hidden.
pub fn first_show(presence: Option<&str>, headless: bool) -> Option<&'static str> {
    match presence {
        Some("hidden") => None,
        Some("minimized") => Some("minimize"),
        Some("behind") => Some("showInactive"),
        _ if headless => Some("showInactive"),
        _ => Some("show"),
    }
}

/// What closing the last shown window does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LastClose {
    Close,
    Hide,
    Quit,
}

impl LastClose {
    pub fn name(self) -> &'static str {
        match self {
            Self::Close => "close",
            Self::Hide => "hide",
            Self::Quit => "quit",
        }
    }
}

/// An approved quit lets every window close; macOS hides it (the Dock brings it back); elsewhere close to tray hides
/// it, else the app quits with it (asked first like any quit).
pub fn last_window_close(
    platform: Platform,
    quit_approved: bool,
    close_to_tray: bool,
) -> LastClose {
    if quit_approved {
        LastClose::Close
    } else if platform == Platform::Mac || close_to_tray {
        LastClose::Hide
    } else {
        LastClose::Quit
    }
}

/// What a close of a window does, the other windows considered.
pub fn on_close(other_visible: bool, last: LastClose) -> LastClose {
    if other_visible {
        LastClose::Close
    } else {
        last
    }
}

pub const RENDERER_RECOVERY_COOLDOWN_MS: f64 = 30_000.0;

/// Reload a real crash, never a boot crash in a tight loop.
pub fn should_reload_renderer(reason: &str, last_recovery_at: f64, now: f64) -> bool {
    reason != "clean-exit" && now - last_recovery_at >= RENDERER_RECOVERY_COOLDOWN_MS
}

/// What identifies the renderer's entry file on disk, as `fs.statSync` would tell it apart from a replaced one.
#[derive(Clone, Debug, PartialEq)]
pub struct Identity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub modified_at: f64,
}

/// A packaged app never reloads renderer files an update replaced after launch.
pub fn resources_changed(launch: Option<&Identity>, current: Option<&Identity>) -> bool {
    match (launch, current) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(a), Some(b)) => a != b,
    }
}

/// Which renderer failures replace the whole process when the resources were swapped underneath it.
pub enum Failure {
    LoadFailure { main_frame: bool },
    ProcessGone { reloadable: bool },
}

pub fn should_restart_for_changed_resources(failure: &Failure) -> bool {
    match failure {
        Failure::LoadFailure { main_frame } => *main_frame,
        Failure::ProcessGone { reloadable } => *reloadable,
    }
}

/// The run progress on the Dock badge and every window's progress bar.
pub fn run_progress(state: &str) -> (&'static str, f64) {
    match state {
        "working" => ("●", 0.5),
        "waiting" => ("!", 0.75),
        _ => ("", -1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chrome_core::captured;

    fn rect(v: &Value) -> Rect {
        serde_json::from_value(v.clone()).expect("rect")
    }

    fn rects(v: &Value) -> Vec<Rect> {
        serde_json::from_value(v.clone()).expect("rects")
    }

    #[test]
    fn restores_geometry_as_the_typescript_did() {
        for step in captured::of("window", "src/main/window-bounds.ts#restoreWithinDisplays") {
            let got = restore_within_displays(
                rect(&step.input["rect"]),
                &rects(&step.input["workAreas"]),
            );
            assert_eq!(got, rect(&step.output), "{step:?}");
        }
        for step in captured::of("window", "src/main/window-bounds.ts#isReachable") {
            let got = is_reachable(&rect(&step.input["rect"]), &rects(&step.input["workAreas"]));
            assert_eq!(json!(got), step.output, "{step:?}");
        }
    }

    #[test]
    fn chrome_and_mica_as_the_typescript_did() {
        for step in captured::of("window", "src/main/window-chrome.ts#windowChromeOptions") {
            let platform = Platform::parse(step.input["platform"].as_str().unwrap());
            let got = chrome_options(
                platform,
                step.input["dark"].as_bool().unwrap(),
                step.input["mica"].as_bool().unwrap(),
            );
            assert_eq!(got, step.output, "{step:?}");
        }
        for step in captured::of("window", "src/main/window-chrome.ts#micaSupported") {
            let platform = Platform::parse(step.input["platform"].as_str().unwrap());
            let got = mica_supported(platform, step.input["release"].as_str().unwrap());
            assert_eq!(json!(got), step.output, "{step:?}");
        }
    }

    #[test]
    fn renderer_recovery_as_the_typescript_did() {
        for step in captured::of(
            "window",
            "src/main/renderer-recovery.ts#shouldReloadRenderer",
        ) {
            let got = should_reload_renderer(
                step.input["reason"].as_str().unwrap(),
                step.input["lastRecoveryAt"].as_f64().unwrap(),
                step.input["now"].as_f64().unwrap(),
            );
            assert_eq!(json!(got), step.output, "{step:?}");
        }
        let identity = |v: &Value| {
            (!v.is_null()).then(|| Identity {
                device: v["device"].as_u64().unwrap(),
                inode: v["inode"].as_u64().unwrap(),
                size: v["size"].as_u64().unwrap(),
                modified_at: v["modifiedAt"].as_f64().unwrap(),
            })
        };
        for step in captured::of(
            "window",
            "src/main/renderer-recovery.ts#applicationResourcesChanged",
        ) {
            let (a, b) = (
                identity(&step.input["launch"]),
                identity(&step.input["current"]),
            );
            let got = resources_changed(a.as_ref(), b.as_ref());
            assert_eq!(json!(got), step.output, "{step:?}");
        }
        for step in captured::of(
            "window",
            "src/main/renderer-recovery.ts#shouldRestartForChangedResources",
        ) {
            let failure = match step.input["kind"].as_str().unwrap() {
                "load-failure" => Failure::LoadFailure {
                    main_frame: step.input["mainFrame"].as_bool().unwrap(),
                },
                "process-gone" => Failure::ProcessGone {
                    reloadable: step.input["reloadable"].as_bool().unwrap(),
                },
                // A console error and an in-place navigation never restart: the shell does not ask.
                _ => {
                    assert_eq!(step.output, json!(false));
                    continue;
                }
            };
            assert_eq!(
                json!(should_restart_for_changed_resources(&failure)),
                step.output,
                "{step:?}"
            );
        }
    }

    #[test]
    fn last_window_close_as_the_typescript_did() {
        for step in captured::of("window", "src/main/quit-guard.ts#lastWindowCloseAction") {
            let got = last_window_close(
                Platform::parse(step.input["platform"].as_str().unwrap()),
                step.input["quitApproved"].as_bool().unwrap(),
                step.input["closeToTray"].as_bool().unwrap(),
            );
            assert_eq!(json!(got.name()), step.output, "{step:?}");
        }
    }

    #[test]
    fn creates_windows_as_the_typescript_did() {
        let areas = [Rect {
            x: 0.0,
            y: 25.0,
            width: 1920.0,
            height: 1055.0,
        }];
        for step in captured::of("window", "src/main/window.ts#createWindow") {
            let saved = if step.input["saved"].is_null() {
                Saved::default()
            } else {
                serde_json::from_value(step.input["saved"].clone()).unwrap()
            };
            let frames = step.output["frames"].as_array().unwrap();
            let create = frames.iter().find(|f| f["method"] == "win.create").unwrap();
            let open = step.input["before"].as_u64().unwrap() as usize;
            let got = opening(&OpenFacts {
                saved,
                open,
                // The capture's fake shell: one display, its work area twice (primary first, then all).
                work_areas: &[areas[0], areas[0]],
                platform: Platform::parse(step.input["platform"].as_str().unwrap()),
                dark: false,
                mica_supported: false,
                headless: false,
                icon: None,
            });
            assert_eq!(got.options, create["params"]["options"], "{step:?}");
            let maximized = frames
                .iter()
                .any(|f| f["method"] == "win.op" && f["params"]["op"] == "maximize");
            assert_eq!(got.maximize, maximized, "{step:?}");
            let load = frames
                .iter()
                .find(|f| f["method"] == "wc.op" && f["params"]["op"] == "loadURL")
                .unwrap();
            let slot = step.output["record"]["slot"].as_u64().unwrap() as u32;
            assert_eq!(
                json!(page_url(None, slot, got.mica, false)),
                load["params"]["args"]["url"],
                "{step:?}"
            );
        }
    }

    #[test]
    fn first_show_as_the_typescript_did() {
        for step in captured::of("window", "src/main/window.ts#showOnFirstPaint") {
            let ops: Vec<&Value> = step
                .output
                .as_array()
                .unwrap()
                .iter()
                .map(|f| &f["params"]["op"])
                .collect();
            let got = first_show(step.input["presence"].as_str(), false);
            assert_eq!(ops.len(), usize::from(got.is_some()), "{step:?}");
            if let Some(op) = got {
                assert_eq!(ops[0], &json!(op), "{step:?}");
            }
        }
    }

    #[test]
    fn close_as_the_typescript_did() {
        for step in captured::of("window", "src/main/window.ts#close") {
            let last = match step.input["action"].as_str().unwrap() {
                "close" => LastClose::Close,
                "hide" => LastClose::Hide,
                _ => LastClose::Quit,
            };
            let got = on_close(step.input["otherVisible"].as_bool().unwrap(), last);
            let prevented = step.output["answer"]["prevent"].as_bool().unwrap();
            assert_eq!(got != LastClose::Close, prevented, "{step:?}");
            let hid = step.output["frames"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["params"]["op"] == "hide");
            assert_eq!(got == LastClose::Hide, hid, "{step:?}");
            let saved = &step.output["saved"]["windowState"];
            assert_eq!(
                saved_value(&serde_json::from_value::<Saved>(saved.clone()).unwrap()),
                *saved
            );
        }
    }

    #[test]
    fn run_progress_as_the_typescript_did() {
        for step in captured::of("window", "src/main/window.ts#setRunProgress") {
            let (badge, value) = run_progress(step.input["state"].as_str().unwrap());
            let frames = step.output.as_array().unwrap();
            assert_eq!(frames[0]["params"]["text"], json!(badge));
            for frame in &frames[1..] {
                assert_eq!(frame["params"]["args"]["value"], json!(value));
            }
        }
    }

    #[test]
    fn the_store_keeps_its_other_keys_and_a_tab_indent() {
        let text = store_text(
            Some("{\"other\":1}"),
            &Saved {
                x: Some(1.0),
                y: Some(2.0),
                width: 3.0,
                height: 4.0,
                is_maximized: Some(false),
            },
        );
        assert_eq!(
            text,
            "{\n\t\"other\": 1,\n\t\"windowState\": {\n\t\t\"x\": 1,\n\t\t\"y\": 2,\n\t\t\"width\": 3,\n\t\t\"height\": 4,\n\t\t\"isMaximized\": false\n\t}\n}"
        );
        assert_eq!(parse_saved(Some(&text)).width, 3.0);
        assert_eq!(parse_saved(Some("nonsense")), Saved::default());
    }
}
