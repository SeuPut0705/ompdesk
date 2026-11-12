//! CEF process that hosts only the Preview (candidate (c)).
//!
//! preview-host --url <u> --cdp-port <n> (--parent-hwnd <decimal HWND> --bounds x,y,w,h | --offscreen --size w,h) [--log <file>]
//! stdin lines: `bounds x y w h`, `navigate <url>`, `quit`; EOF = quit.
//! stdout lines: {"event":"ready","cdpPort":n}, {"event":"loaded","url":...}
#![windows_subsystem = "windows"]

use cef::*;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs::File,
    io::{BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
#[cfg(target_os = "macos")]
#[path = "../../shared/mac_app.rs"]
mod mac_app;
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, SWP_NOACTIVATE, SWP_NOZORDER, SetParent, SetWindowPos, ShowWindow};

struct Opts {
    url: String,
    cdp_port: u16,
    parent: Option<isize>,
    bounds: (i32, i32, i32, i32),
    offscreen: bool,
    size: (i32, i32),
    log: Option<PathBuf>,
    cache: Option<PathBuf>,
}

static OPTS: OnceLock<Opts> = OnceLock::new();
static START: OnceLock<Instant> = OnceLock::new();
static LOG: Mutex<Option<File>> = Mutex::new(None);

fn opts() -> &'static Opts {
    OPTS.get().expect("opts")
}

fn quad(s: &str) -> Vec<i32> {
    s.split(',').filter_map(|x| x.trim().parse().ok()).collect()
}

fn parse_opts() -> Opts {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut o = Opts {
        url: "about:blank".into(),
        cdp_port: 0,
        parent: None,
        bounds: (0, 0, 800, 600),
        offscreen: false,
        size: (800, 600),
        log: None,
        cache: None,
    };
    let mut i = 0;
    while i < args.len() {
        let next = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--url" => {
                o.url = next;
                i += 1;
            }
            "--cdp-port" => {
                o.cdp_port = next.parse().unwrap_or(0);
                i += 1;
            }
            "--parent-hwnd" => {
                o.parent = next.parse().ok();
                i += 1;
            }
            "--bounds" => {
                let q = quad(&next);
                if q.len() == 4 {
                    o.bounds = (q[0], q[1], q[2], q[3]);
                }
                i += 1;
            }
            "--size" => {
                let q = quad(&next);
                if q.len() == 2 {
                    o.size = (q[0], q[1]);
                }
                i += 1;
            }
            "--offscreen" => o.offscreen = true,
            "--log" => {
                o.log = Some(PathBuf::from(next));
                i += 1;
            }
            "--cache" => {
                o.cache = Some(PathBuf::from(next));
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    o
}

fn emit(event: &str, fields: Value) {
    let mut obj = serde_json::Map::new();
    obj.insert("event".into(), json!(event));
    if let Value::Object(m) = fields {
        obj.extend(m);
    }
    let line = Value::Object(obj.clone()).to_string();
    let _ = writeln!(std::io::stdout(), "{line}");
    let _ = std::io::stdout().flush();
    obj.insert("t".into(), json!(START.get().map(|s| s.elapsed().as_millis() as u64).unwrap_or(0)));
    if let Some(f) = LOG.lock().unwrap().as_mut() {
        let _ = writeln!(f, "{}", Value::Object(obj));
        let _ = f.flush();
    }
}

thread_local! {
    static BROWSER: RefCell<Option<Browser>> = const { RefCell::new(None) };
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

fn post_ui(f: impl FnOnce() + Send + 'static) {
    let mut t = ClosureTask::new(Arc::new(Mutex::new(Some(Box::new(f)))));
    post_task(ThreadId::UI, Some(&mut t));
}

fn quit() {
    emit("quit.begin", json!({}));
    let b = BROWSER.with(|b| b.borrow().clone());
    match b.and_then(|b| b.host()) {
        Some(h) => {
            // A child of a foreign window: CEF would send WM_CLOSE to that (top-level) parent. Detach and hide first so
            // the close stays inside this process.
            #[cfg(windows)]
            if !opts().offscreen {
                let hwnd = h.window_handle().0;
                if !hwnd.is_null() {
                    unsafe {
                        ShowWindow(hwnd.cast(), SW_HIDE);
                        SetParent(hwnd.cast(), std::ptr::null_mut());
                    }
                }
            }
            h.close_browser(1);
            emit("quit.close_browser_called", json!({}));
        }
        None => quit_message_loop(),
    }
}

fn apply_bounds(x: i32, y: i32, w: i32, h: i32) {
    let Some(host) = BROWSER.with(|b| b.borrow().clone()).and_then(|b| b.host()) else { return };
    let hwnd = host.window_handle().0;
    #[cfg(windows)]
    if !hwnd.is_null() {
        unsafe { SetWindowPos(hwnd.cast(), std::ptr::null_mut(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE) };
    }
    // macOS: `--parent-hwnd` is the parent NSView pointer; bounds are top-left based, NSView frames bottom-left. UNVERIFIED.
    #[cfg(target_os = "macos")]
    if !hwnd.is_null() {
        use objc2::{msg_send, runtime::AnyObject};
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        unsafe {
            let v = &*(hwnd as *mut AnyObject);
            let sup: *mut AnyObject = msg_send![v, superview];
            let ph = if sup.is_null() {
                0.0
            } else {
                let f: NSRect = msg_send![&*sup, frame];
                f.size.height
            };
            let r = NSRect::new(NSPoint::new(x as f64, ph - (y + h) as f64), NSSize::new(w as f64, h as f64));
            let _: () = msg_send![v, setFrame: r];
        }
    }
    host.was_resized();
    emit("bounds", json!({ "x": x, "y": y, "w": w, "h": h }));
}

fn handle_line(line: String) {
    let line = line.trim().to_string();
    if line == "quit" {
        quit();
    } else if let Some(rest) = line.strip_prefix("bounds ") {
        let n: Vec<i32> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if n.len() == 4 && !opts().offscreen {
            apply_bounds(n[0], n[1], n[2], n[3]);
        }
    } else if let Some(url) = line.strip_prefix("navigate ") {
        if let Some(b) = BROWSER.with(|b| b.borrow().clone()) {
            if let Some(f) = b.main_frame() {
                f.load_url(Some(&CefString::from(url.trim())));
            }
        }
    }
}

wrap_life_span_handler! {
    struct PhLifeSpan;
    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Some(b) = browser.cloned() {
                BROWSER.with(|x| *x.borrow_mut() = Some(b));
            }
            emit("ready", json!({ "cdpPort": opts().cdp_port }));
            std::thread::spawn(|| {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines() {
                    match line {
                        Ok(l) => post_ui(move || handle_line(l)),
                        Err(_) => break,
                    }
                }
                // stdin closed: the parent died or asked us to go
                post_ui(quit);
            });
        }

        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            emit("do_close", json!({}));
            0
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            emit("before_close", json!({}));
            BROWSER.with(|x| *x.borrow_mut() = None);
            quit_message_loop();
        }
    }
}

wrap_load_handler! {
    struct PhLoad;
    impl LoadHandler {
        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _status: i32) {
            let Some(f) = frame else { return };
            if f.is_main() != 0 {
                emit("loaded", json!({ "url": CefString::from(&f.url()).to_string() }));
            }
        }
    }
}

wrap_render_handler! {
    struct PhRender;
    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            if let Some(r) = rect {
                *r = Rect { x: 0, y: 0, width: opts().size.0, height: opts().size.1 };
            }
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            _type_: PaintElementType,
            _dirty_rects: Option<&[Rect]>,
            _buffer: *const u8,
            _width: i32,
            _height: i32,
        ) {
        }
    }
}

wrap_client! {
    struct PhClient;
    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(PhLifeSpan::new())
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(PhLoad::new())
        }

        fn render_handler(&self) -> Option<RenderHandler> {
            if opts().offscreen { Some(PhRender::new()) } else { None }
        }
    }
}

wrap_browser_process_handler! {
    struct PhBph;
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            let o = opts();
            let mut client = PhClient::new();
            let settings = BrowserSettings {
                windowless_frame_rate: 30,
                ..Default::default()
            };
            let info = if o.offscreen {
                WindowInfo::default().set_as_windowless(Default::default())
            } else {
                #[cfg(windows)]
                let parent = cef::sys::HWND(o.parent.unwrap_or(0) as *mut _);
                #[cfg(target_os = "macos")]
                let parent = o.parent.unwrap_or(0) as *mut _;
                let (x, y, w, h) = o.bounds;
                WindowInfo { runtime_style: RuntimeStyle::ALLOY, ..Default::default() }
                    .set_as_child(parent, &Rect { x, y, width: w, height: h })
            };
            browser_host_create_browser(
                Some(&info),
                Some(&mut client),
                Some(&CefString::from(o.url.as_str())),
                Some(&settings),
                None,
                None,
            );
        }
    }
}

wrap_app! {
    struct PhApp;
    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let is_browser = process_type.map(|p| p.to_string().is_empty()).unwrap_or(true);
            if !is_browser {
                return;
            }
            let Some(c) = command_line else { return };
            c.append_switch_with_value(Some(&CefString::from("remote-allow-origins")), Some(&CefString::from("*")));
            c.append_switch_with_value(
                Some(&CefString::from("remote-debugging-port")),
                Some(&CefString::from(opts().cdp_port.to_string().as_str())),
            );
            if opts().offscreen {
                // no occlusion pause: frames keep flowing for the screencast
                c.append_switch(Some(&CefString::from("disable-backgrounding-occluded-windows")));
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(PhBph::new())
        }
    }
}

fn main() {
    let _ = START.set(Instant::now());
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let is_browser = !std::env::args().any(|a| a.starts_with("--type="));
    // macOS: load the CEF framework (helpers resolve it three levels up), then the NSApplication subclass. UNVERIFIED.
    #[cfg(target_os = "macos")]
    let _loader = {
        let l = cef::library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), !is_browser);
        assert!(l.load(), "cannot load the CEF framework");
        l
    };
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    #[cfg(target_os = "macos")]
    if is_browser {
        mac_app::setup(quit);
    }
    let args = cef::args::Args::new();
    let _ = OPTS.set(parse_opts());
    let mut app = PhApp::new();
    let ret = execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
    if !is_browser {
        return;
    }
    assert_eq!(ret, -1);

    let o = opts();
    if let Some(p) = &o.log {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        *LOG.lock().unwrap() = File::create(p).ok();
    }
    let (cache, temp) = match &o.cache {
        Some(c) => (c.clone(), false),
        None => (std::env::temp_dir().join(format!("preview-host-{}", std::process::id())), true),
    };
    let _ = std::fs::create_dir_all(&cache);
    let cache_s = cache.display().to_string();
    let settings = Settings {
        no_sandbox: 1,
        root_cache_path: CefString::from(cache_s.as_str()),
        cache_path: CefString::from(cache_s.as_str()),
        log_file: CefString::from(cache.join("cef.log").display().to_string().as_str()),
        log_severity: LogSeverity::WARNING,
        windowless_rendering_enabled: o.offscreen as i32,
        ..Default::default()
    };
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        emit("error", json!({ "message": "cef initialize failed" }));
        return;
    }
    run_message_loop();
    shutdown();
    emit("exit", json!({}));
    if temp {
        let _ = std::fs::remove_dir_all(&cache);
    }
}
