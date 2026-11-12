//! Candidate (a): the whole app window in CEF (Views framework, frameless, Alloy style).
#![windows_subsystem = "windows"]

#[cfg(windows)]
mod caption;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
#[path = "../../shared/mac_app.rs"]
mod mac_app;
mod scheme;
mod selftest;

use cef::*;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    fs::File,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

pub const CEF_VERSION: &str = "156.4.0+156.0.26";
pub const DEEP_LINK_SCHEME: &str = "ompdesk-proto://";

// ---------------------------------------------------------------- config + log

pub struct Config {
    pub renderer: PathBuf,
    pub assets: PathBuf,
    pub user_data: PathBuf,
    pub web_dir: PathBuf,
    pub query: Option<String>,
    pub preview: Option<String>,
    pub debug_port: Option<u16>,
    pub selftest: bool,
    pub exit_after: Option<u64>,
    pub log: PathBuf,
    pub register_protocol: bool,
}

pub static CFG: OnceLock<Config> = OnceLock::new();
pub static START: OnceLock<Instant> = OnceLock::new();
static LOG: Mutex<Option<File>> = Mutex::new(None);
/// Events logged before the log file is opened (CEF runs on_context_initialized inside `initialize`).
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn cfg() -> &'static Config {
    CFG.get().expect("config")
}

pub fn now_ms() -> u128 {
    START.get().map(|s| s.elapsed().as_millis()).unwrap_or(0)
}

pub fn log(event: &str, fields: Value) {
    let mut obj = serde_json::Map::new();
    obj.insert("t".into(), json!(now_ms() as u64));
    obj.insert("event".into(), json!(event));
    match fields {
        Value::Object(m) => obj.extend(m),
        Value::Null => {}
        other => {
            obj.insert("value".into(), other);
        }
    }
    let line = Value::Object(obj).to_string();
    if let Ok(mut g) = LOG.lock() {
        match g.as_mut() {
            Some(f) => {
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
            }
            None => PENDING.lock().unwrap().push(line),
        }
    }
}

fn open_log() {
    let c = cfg();
    if let Some(p) = c.log.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    if let Ok(mut f) = File::create(&c.log) {
        for l in PENDING.lock().unwrap().drain(..) {
            let _ = writeln!(f, "{l}");
        }
        *LOG.lock().unwrap() = Some(f);
    }
}

#[cfg(windows)]
fn default_user_data() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("ompdesk-proto")
}

#[cfg(not(windows))]
fn default_user_data() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Application Support/ompdesk-proto")
}

fn parse_config() -> Config {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut flags: HashMap<String, String> = HashMap::new();
    let mut bools: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(name) = args[i].strip_prefix("--") {
            if let Some((k, v)) = name.split_once('=') {
                flags.insert(k.to_string(), v.to_string());
            } else if matches!(
                name,
                "renderer" | "assets" | "query" | "preview" | "debug-port" | "user-data" | "user-data-dir" | "log" | "exit-after"
            ) && i + 1 < args.len()
            {
                flags.insert(name.to_string(), args[i + 1].clone());
                i += 1;
            } else {
                bools.push(name.to_string());
            }
        }
        i += 1;
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let walk_up = |rel: &str| -> Option<PathBuf> {
        let mut d = Some(exe_dir.as_path());
        while let Some(p) = d {
            let c = p.join(rel);
            if c.exists() {
                return Some(c);
            }
            d = p.parent();
        }
        None
    };
    let pick = |flag: &str, env: &str, sub: &str, walk: &str| -> PathBuf {
        if let Some(v) = flags.get(flag) {
            return PathBuf::from(v);
        }
        if let Ok(v) = std::env::var(env) {
            if !v.is_empty() {
                return PathBuf::from(v);
            }
        }
        let c = exe_dir.join(sub);
        if c.exists() {
            return c;
        }
        // macOS bundle: Contents/MacOS/<exe> next to Contents/Resources/{renderer,shell-assets}
        let r = exe_dir.join("../Resources").join(sub);
        if r.exists() {
            return r;
        }
        walk_up(walk).unwrap_or(c)
    };
    let renderer = pick("renderer", "SHELL_RENDERER_DIR", "renderer", "out/renderer");
    let assets = pick("assets", "SHELL_ASSETS_DIR", "shell-assets", "native/shell-prototype/shell-assets");
    // Electron's `--user-data-dir` is an alias (precedence: --user-data, --user-data-dir, env, default).
    let user_data = flags
        .get("user-data")
        .or_else(|| flags.get("user-data-dir"))
        .map(PathBuf::from)
        .or_else(|| std::env::var("OMPDESK_PROTO_USER_DATA").ok().filter(|v| !v.is_empty()).map(PathBuf::from))
        .unwrap_or_else(default_user_data);
    let web_dir = user_data.join("shell-webview");
    let log = flags.get("log").map(PathBuf::from).unwrap_or_else(|| web_dir.join("shell.log.jsonl"));
    Config {
        renderer,
        assets,
        query: flags.get("query").cloned(),
        preview: flags.get("preview").cloned(),
        debug_port: flags.get("debug-port").and_then(|v| v.parse().ok()),
        selftest: bools.iter().any(|b| b == "selftest"),
        exit_after: flags.get("exit-after").and_then(|v| v.parse().ok()),
        log,
        register_protocol: bools.iter().any(|b| b == "register-protocol"),
        user_data,
        web_dir,
    }
}

// ---------------------------------------------------------------- UI-thread state

#[derive(Default)]
pub struct Ui {
    pub window: Option<Window>,
    pub container: Option<Panel>,
    pub page: Option<BrowserView>,
    pub preview: Option<BrowserView>,
    pub preview_browser: Option<Browser>,
    pub reg: Option<Registration>,
    pub browsers: usize,
    pub pending: HashMap<i64, Box<dyn FnOnce(Value)>>,
    pub next_id: i64,
    pub page_loaded: bool,
    pub preview_loaded: bool,
    pub selftest_started: bool,
    pub t0_page: Option<Instant>,
    pub t0_preview: Option<Instant>,
    pub tray: Option<tray_icon::TrayIcon>,
}

thread_local! {
    static UI: RefCell<Ui> = RefCell::new(Ui::default());
}

pub fn ui<R>(f: impl FnOnce(&mut Ui) -> R) -> R {
    UI.with(|u| f(&mut u.borrow_mut()))
}

wrap_task! {
    struct ClosureTask {
        f: Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>,
    }
    impl Task {
        fn execute(&self) {
            let f = self.f.lock().unwrap().take();
            if let Some(f) = f {
                f();
            }
        }
    }
}

pub fn post_ui(f: impl FnOnce() + Send + 'static) {
    let mut t = ClosureTask::new(Arc::new(Mutex::new(Some(Box::new(f)))));
    post_task(ThreadId::UI, Some(&mut t));
}

pub fn post_ui_delayed(ms: i64, f: impl FnOnce() + Send + 'static) {
    let mut t = ClosureTask::new(Arc::new(Mutex::new(Some(Box::new(f)))));
    post_delayed_task(ThreadId::UI, Some(&mut t), ms);
}

// ---------------------------------------------------------------- window actions

pub fn window_action(action: &str) {
    let action = action.to_string();
    post_ui(move || {
        let Some(w) = ui(|u| u.window.clone()) else { return };
        match action.as_str() {
            "minimize" => w.minimize(),
            "maximize" => {
                if w.is_maximized() != 0 {
                    w.restore()
                } else {
                    w.maximize()
                }
            }
            "close" => w.close(),
            #[cfg(windows)]
            "drag" => unsafe {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
                use windows_sys::Win32::UI::WindowsAndMessaging::{HTCAPTION, PostMessageW, WM_NCLBUTTONDOWN};
                ReleaseCapture();
                PostMessageW(w.window_handle().0.cast(), WM_NCLBUTTONDOWN, HTCAPTION as usize, 0);
            },
            _ => {}
        }
    });
}

pub fn show_window() {
    if let Some(w) = ui(|u| u.window.clone()) {
        if w.is_minimized() != 0 {
            w.restore();
        }
        w.show();
        w.activate();
        w.bring_to_top();
    }
}

fn quit_app() {
    match ui(|u| u.window.clone()) {
        Some(w) => w.close(),
        None => quit_message_loop(),
    }
}

// ---------------------------------------------------------------- layout

pub const BAR_H: i32 = 48;
pub const CAPTION_W: i32 = 138;

fn relayout(cw: i32, ch: i32) {
    let (page, preview) = ui(|u| (u.page.clone(), u.preview.clone()));
    if let Some(p) = page {
        p.set_bounds(Some(&Rect { x: 0, y: 0, width: cw, height: ch }));
    }
    if let Some(p) = preview {
        let pw = (cw as f32 * 0.4).round() as i32;
        p.set_bounds(Some(&Rect { x: cw - pw, y: BAR_H, width: pw, height: (ch - BAR_H).max(0) }));
    }
}

wrap_panel_delegate! {
    struct ContainerDelegate {}
    impl ViewDelegate {
        fn on_layout_changed(&self, _view: Option<&mut View>, new_bounds: Option<&Rect>) {
            if let Some(b) = new_bounds {
                relayout(b.width, b.height);
            }
        }
    }
    impl PanelDelegate {}
}

// ---------------------------------------------------------------- views: window

wrap_window_delegate! {
    struct ShellWindowDelegate {}
    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1280, height: 800 }
        }
    }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else { return };
            ui(|u| u.window = Some(window.clone()));
            let (page, preview) = ui(|u| (u.page.clone(), u.preview.clone()));
            window.set_to_fill_layout();
            let mut cd = ContainerDelegate::new();
            if let Some(container) = panel_create(Some(&mut cd)) {
                if let Some(p) = page {
                    container.add_child_view(Some(&mut View::from(&p)));
                }
                if let Some(p) = preview {
                    container.add_child_view(Some(&mut View::from(&p)));
                }
                window.add_child_view(Some(&mut View::from(&container)));
                ui(|u| u.container = Some(container));
            }
            window.set_title(Some(&CefString::from("OMPdesk (CEF proto)")));
            window.show();
            #[cfg(windows)]
            caption::attach(window.window_handle().0.cast());
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            ui(|u| {
                u.window = None;
                u.container = None;
                u.page = None;
                u.preview = None;
            });
        }

        fn on_window_bounds_changed(&self, _window: Option<&mut Window>, _new_bounds: Option<&Rect>) {
            #[cfg(windows)]
            caption::reposition();
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let page = ui(|u| u.page.clone());
            match page.and_then(|p| p.browser()).and_then(|b| b.host()) {
                Some(h) => h.try_close_browser(),
                None => 1,
            }
        }

        fn initial_bounds(&self, _window: Option<&mut Window>) -> Rect {
            Rect { x: 80, y: 60, width: 1280, height: 800 }
        }

        fn is_frameless(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        /// macOS `hiddenInset`: frameless, with the standard traffic lights. The buttons are centred in the title-bar
        /// height, so 46 puts a 12 px button's top at y = 17 (Electron's trafficLightPosition (18, 17)). UNVERIFIED.
        fn with_standard_window_buttons(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn titlebar_height(&self, _window: Option<&mut Window>, titlebar_height: Option<&mut f32>) -> i32 {
            if let Some(h) = titlebar_height {
                *h = 46.0;
            }
            1
        }

        fn can_resize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_maximize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn can_minimize(&self, _window: Option<&mut Window>) -> i32 {
            1
        }

        fn window_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

wrap_browser_view_delegate! {
    struct ShellBvDelegate {}
    impl ViewDelegate {}
    impl BrowserViewDelegate {
        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

// ---------------------------------------------------------------- client handlers

wrap_display_handler! {
    struct ShellDisplayHandler {
        role: &'static str,
    }
    impl DisplayHandler {
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            if self.role != "page" {
                return;
            }
            let mut b = browser.cloned();
            if let Some(w) = browser_view_get_for_browser(b.as_mut()).and_then(|bv| bv.window()) {
                w.set_title(title);
            }
        }
    }
}

wrap_life_span_handler! {
    struct ShellLifeSpanHandler {
        role: &'static str,
    }
    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(b) = browser.cloned() else { return };
            ui(|u| u.browsers += 1);
            if self.role == "preview" {
                selftest::attach_observer(&b);
            }
            log("browser.created", json!({ "role": self.role, "id": b.identifier() }));
        }

        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            0
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let left = ui(|u| {
                u.browsers = u.browsers.saturating_sub(1);
                u.browsers
            });
            if left == 0 {
                quit_message_loop();
            }
        }
    }
}

wrap_load_handler! {
    struct ShellLoadHandler {
        role: &'static str,
    }
    impl LoadHandler {
        fn on_load_start(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _t: TransitionType) {
            if frame.map(|f| f.is_main() != 0).unwrap_or(false) {
                let role = self.role;
                ui(|u| {
                    if role == "page" {
                        u.t0_page = Some(Instant::now());
                    } else {
                        u.t0_preview = Some(Instant::now());
                    }
                });
            }
        }

        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, status: i32) {
            let Some(frame) = frame else { return };
            if frame.is_main() == 0 {
                return;
            }
            let url = CefString::from(&frame.url()).to_string();
            let role = self.role;
            let ms = ui(|u| {
                let t = if role == "page" { u.t0_page } else { u.t0_preview };
                t.map(|t| t.elapsed().as_millis() as u64).unwrap_or(0)
            });
            if role == "page" {
                log("page.loaded", json!({ "ms": ms, "url": url, "status": status }));
                ui(|u| u.page_loaded = true);
            } else {
                log("preview.loaded", json!({ "ms": ms, "url": url, "status": status }));
                ui(|u| u.preview_loaded = true);
            }
            selftest::maybe_start();
        }

        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            log(
                "load.error",
                json!({
                    "role": self.role,
                    "code": sys::cef_errorcode_t::from(error_code) as i32,
                    "text": error_text.map(|s| s.to_string()).unwrap_or_default(),
                    "url": failed_url.map(|s| s.to_string()).unwrap_or_default(),
                }),
            );
        }
    }
}

wrap_drag_handler! {
    struct ShellDragHandler;
    impl DragHandler {
        fn on_draggable_regions_changed(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            regions: Option<&[DraggableRegion]>,
        ) {
            let mut b = browser.cloned();
            if let Some(w) = browser_view_get_for_browser(b.as_mut()).and_then(|bv| bv.window()) {
                w.set_draggable_regions(regions);
            }
            let n = regions.map(|r| r.len()).unwrap_or(0);
            let drag = regions.map(|r| r.iter().filter(|d| d.draggable != 0).count()).unwrap_or(0);
            log("window.drag_regions", json!({ "count": n, "draggable": drag }));
        }
    }
}

wrap_client! {
    struct ShellClient {
        role: &'static str,
    }
    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(ShellDisplayHandler::new(self.role))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(ShellLifeSpanHandler::new(self.role))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(ShellLoadHandler::new(self.role))
        }

        fn drag_handler(&self) -> Option<DragHandler> {
            if self.role == "page" { Some(ShellDragHandler::new()) } else { None }
        }
    }
}

// ---------------------------------------------------------------- tray

fn create_tray() {
    use tray_icon::{
        Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
        menu::{Menu, MenuEvent, MenuItem},
    };
    let menu = Menu::new();
    let show = MenuItem::new("Show", true, None);
    let quit = MenuItem::new("Quit", true, None);
    let _ = menu.append_items(&[&show, &quit]);
    let (show_id, quit_id) = (show.id().clone(), quit.id().clone());

    let mut rgba = Vec::with_capacity(16 * 16 * 4);
    for y in 0..16 {
        for x in 0..16 {
            let edge = x == 0 || y == 0 || x == 15 || y == 15;
            rgba.extend_from_slice(if edge { &[255, 255, 255, 255] } else { &[0x3b, 0x82, 0xf6, 255] });
        }
    }
    let icon = Icon::from_rgba(rgba, 16, 16).ok();
    let mut b = TrayIconBuilder::new().with_menu(Box::new(menu)).with_tooltip("OMPdesk proto (CEF)");
    if let Some(i) = icon {
        b = b.with_icon(i);
    }
    match b.build() {
        Ok(t) => {
            ui(|u| u.tray = Some(t));
            log("tray.created", json!({ "ok": true }));
        }
        Err(e) => log("tray.created", json!({ "ok": false, "error": e.to_string() })),
    }
    log("tray.menu", json!({ "show": show_id.0, "quit": quit_id.0 }));
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        let item = if e.id == show_id {
            "Show"
        } else if e.id == quit_id {
            "Quit"
        } else {
            "?"
        };
        log("tray.click", json!({ "item": item }));
        post_ui(move || match item {
            "Show" => show_window(),
            "Quit" => quit_app(),
            _ => {}
        });
    }));
    TrayIconEvent::set_event_handler(Some(|e: TrayIconEvent| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            log("tray.click", json!({ "item": "icon" }));
            post_ui(show_window);
        }
    }));
}

// ---------------------------------------------------------------- app + browser process handler

fn deep_links(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(i) = rest.find(DEEP_LINK_SCHEME) {
        let tail = &rest[i..];
        let end = tail.find(|c: char| c.is_whitespace() || c == '"').unwrap_or(tail.len());
        out.push(tail[..end].to_string());
        rest = &tail[end..];
    }
    out
}

wrap_browser_process_handler! {
    struct ShellBrowserProcessHandler;
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            let c = cfg();
            let mut factory = scheme::ShellSchemeFactory::new();
            register_scheme_handler_factory(
                Some(&CefString::from("app")),
                Some(&CefString::from("ompdesk")),
                Some(&mut factory),
            );
            create_tray();

            let mut url = "app://ompdesk/index.html".to_string();
            if let Some(q) = &c.query {
                url.push('?');
                url.push_str(q.trim_start_matches('?'));
            }
            log("page.url", json!({ "url": url }));
            let settings = BrowserSettings::default();
            let mut client = ShellClient::new("page");
            let mut bvd = ShellBvDelegate::new();
            let page = browser_view_create(
                Some(&mut client),
                Some(&CefString::from(url.as_str())),
                Some(&settings),
                None,
                None,
                Some(&mut bvd),
            );
            ui(|u| u.page = page);
            if let Some(p) = &c.preview {
                let mut client = ShellClient::new("preview");
                let mut bvd = ShellBvDelegate::new();
                let pv = browser_view_create(
                    Some(&mut client),
                    Some(&CefString::from(p.as_str())),
                    Some(&settings),
                    None,
                    None,
                    Some(&mut bvd),
                );
                ui(|u| u.preview = pv);
                log("preview.url", json!({ "url": p }));
            }
            let mut wd = ShellWindowDelegate::new();
            window_create_top_level(Some(&mut wd));

            for a in std::env::args().skip(1) {
                if a.starts_with(DEEP_LINK_SCHEME) {
                    log("deeplink", json!({ "url": a, "from": "argv" }));
                }
            }
            if let Some(s) = c.exit_after {
                post_ui_delayed(s as i64 * 1000, || {
                    log("exit-after", json!({}));
                    quit_app();
                });
            }
        }

        fn on_already_running_app_relaunch(
            &self,
            command_line: Option<&mut CommandLine>,
            _current_directory: Option<&CefString>,
        ) -> i32 {
            let line = command_line.map(|c| CefString::from(&c.command_line_string()).to_string()).unwrap_or_default();
            for url in deep_links(&line) {
                log("deeplink", json!({ "url": url, "from": "second-instance" }));
            }
            log("second-instance", json!({ "commandLine": line }));
            show_window();
            1
        }
    }
}

wrap_app! {
    struct ShellApp;
    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let is_browser = process_type.map(|p| p.to_string().is_empty()).unwrap_or(true);
            if is_browser {
                if let Some(c) = command_line {
                    // Electron's switch would re-point Chromium's profile at the bare folder: the profile is root_cache_path.
                    c.remove_switch(Some(&CefString::from("user-data-dir")));
                    c.append_switch_with_value(
                        Some(&CefString::from("remote-allow-origins")),
                        Some(&CefString::from("*")),
                    );
                    // CEF's own OSCrypt would otherwise create "<name> Safe Storage" in the login keychain.
                    #[cfg(target_os = "macos")]
                    c.append_switch(Some(&CefString::from("use-mock-keychain")));
                }
            }
        }

        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) {
            use sys::cef_scheme_options_t as O;
            if let Some(r) = registrar {
                let flags = O::CEF_SCHEME_OPTION_STANDARD as i32
                    | O::CEF_SCHEME_OPTION_SECURE as i32
                    | O::CEF_SCHEME_OPTION_CORS_ENABLED as i32
                    | O::CEF_SCHEME_OPTION_FETCH_ENABLED as i32;
                r.add_custom_scheme(Some(&CefString::from("app")), flags);
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(ShellBrowserProcessHandler::new())
        }
    }
}

// ---------------------------------------------------------------- main

#[cfg(windows)]
fn register_protocol() {
    let exe = std::env::current_exe().unwrap_or_default();
    let exe = exe.display().to_string();
    let reg = |args: &[&str]| {
        let _ = std::process::Command::new("reg").args(args).output();
    };
    let base = r"HKCU\Software\Classes\ompdesk-proto";
    reg(&["add", base, "/ve", "/d", "URL:ompdesk-proto", "/f"]);
    reg(&["add", base, "/v", "URL Protocol", "/d", "", "/f"]);
    reg(&["add", &format!(r"{base}\shell\open\command"), "/ve", "/d", &format!("\"{exe}\" \"%1\""), "/f"]);
}

/// macOS registers the scheme through `CFBundleURLTypes` in Info.plist (bundle-mac.sh); nothing to do at run time.
#[cfg(not(windows))]
fn register_protocol() {}

#[cfg(windows)]
fn set_app_id() -> String {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let id = std::env::var("OMPDESK_PROTO_APP_ID")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "com.seuput.ompdesk.proto".to_string());
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
    id
}

/// macOS: the bundle identifier stands in for the AppUserModelID.
#[cfg(not(windows))]
fn set_app_id() -> String {
    std::env::var("OMPDESK_PROTO_APP_ID").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "com.seuput.ompdesk.proto".to_string())
}

fn main() {
    let _ = START.set(Instant::now());
    // Move-test seam: `--proto-home=<dir>` (carried in the Electron copy's argv, which SWAP_SCRIPT hands to `open -n`)
    // points the Security framework's keychain search list at the test HOME before anything reads the keychain.
    if let Some(h) = std::env::args().find_map(|a| a.strip_prefix("--proto-home=").map(str::to_string)) {
        // SAFETY (prototype): single-threaded at this point, before CEF or any other thread starts.
        unsafe {
            std::env::set_var("HOME", h);
            std::env::set_var("OMPDESK_PROTO_KEYCHAIN_OK", "1");
        }
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let is_browser = !std::env::args().any(|a| a.starts_with("--type="));
    // macOS: load the CEF framework (the helper apps sit three levels below Frameworks/), then api hash, then the
    // NSApplication subclass, before anything else touches NSApp. UNVERIFIED.
    #[cfg(target_os = "macos")]
    let _loader = {
        let l = cef::library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), !is_browser);
        assert!(l.load(), "cannot load the CEF framework");
        l
    };
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    #[cfg(target_os = "macos")]
    if is_browser {
        mac_app::setup(quit_app);
    }
    let args = cef::args::Args::new();
    let _ = CFG.set(parse_config());

    let mut app = ShellApp::new();
    let ret = execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
    if !is_browser {
        return;
    }
    assert_eq!(ret, -1, "browser process expected");

    let c = cfg();
    if c.register_protocol {
        register_protocol();
        return;
    }
    let app_id = set_app_id();
    let _ = std::fs::create_dir_all(&c.web_dir);

    let settings = Settings {
        no_sandbox: 1,
        root_cache_path: CefString::from(c.web_dir.display().to_string().as_str()),
        cache_path: CefString::from(c.web_dir.display().to_string().as_str()),
        log_file: CefString::from(c.web_dir.join("cef.log").display().to_string().as_str()),
        log_severity: LogSeverity::WARNING,
        persist_session_cookies: 1,
        remote_debugging_port: c.debug_port.map(|p| p as i32).unwrap_or(0),
        ..Default::default()
    };
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        // Another instance owns this profile: CEF forwarded our command line to it.
        return;
    }
    open_log();
    log("start", json!({ "candidate": "cef", "version": CEF_VERSION, "appId": app_id }));
    log(
        "config",
        json!({
            "renderer": c.renderer.display().to_string(),
            "assets": c.assets.display().to_string(),
            "userData": c.user_data.display().to_string(),
            "preview": c.preview,
            "debugPort": c.debug_port,
            "selftest": c.selftest,
        }),
    );
    shell_migrate::run(&c.user_data, &c.web_dir, &mut |ev, fields| log(ev, fields));

    #[cfg(target_os = "macos")]
    let _delegate = mac::setup_delegate();
    run_message_loop();
    shutdown();
    log("exit", json!({}));
}
