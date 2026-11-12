mod cdp;
mod hit;
mod preview;
mod scheme;
mod selftest;
mod stream;

use cdp::{Cdp, WsCdp};
use serde_json::{Value, json};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::window::WindowBuilder;
use tauri::{Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WindowEvent};

const SCHEME_URL: &str = "ompdesk-proto://";
const WV_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-allow-origins=*";

// ---------------------------------------------------------------- log
static START: OnceLock<Instant> = OnceLock::new();
static LOG: Mutex<Option<File>> = Mutex::new(None);

pub fn log(event: &str, fields: Value) {
    let t = START.get_or_init(Instant::now).elapsed().as_millis() as u64;
    let mut o = serde_json::Map::new();
    o.insert("t".into(), json!(t));
    o.insert("event".into(), json!(event));
    if let Value::Object(m) = fields {
        for (k, v) in m {
            let k = if k == "t" || k == "event" { format!("page_{k}") } else { k };
            o.insert(k, v);
        }
    }
    let line = Value::Object(o).to_string();
    if let Some(f) = LOG.lock().unwrap().as_mut() {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

// ---------------------------------------------------------------- args
#[derive(Clone, Copy, PartialEq, Debug)]
enum PMode {
    Webview2,
    CefChild,
    CefStream,
}

impl PMode {
    fn name(self) -> &'static str {
        match self {
            PMode::Webview2 => "webview2",
            PMode::CefChild => "cef-child",
            PMode::CefStream => "cef-stream",
        }
    }
}

struct Args {
    renderer: Option<PathBuf>,
    assets: Option<PathBuf>,
    query: Option<String>,
    preview: Option<String>,
    debug_port: Option<u16>,
    user_data: PathBuf,
    log: Option<PathBuf>,
    selftest: bool,
    exit_after: Option<u64>,
    register: bool,
    mode: PMode,
    preview_host: Option<PathBuf>,
    cdp_port: u16,
    deeplinks: Vec<String>,
}

fn parse_args() -> Args {
    let mut a = Args {
        renderer: None,
        assets: None,
        query: None,
        preview: None,
        debug_port: None,
        user_data: std::env::var_os("OMPDESK_PROTO_USER_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("ompdesk-proto")),
        log: None,
        selftest: false,
        exit_after: None,
        register: false,
        mode: PMode::Webview2,
        preview_host: None,
        cdp_port: 9303,
        deeplinks: vec![],
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut val = || it.next().unwrap_or_default();
        match k.as_str() {
            "--renderer" => a.renderer = Some(val().into()),
            "--assets" => a.assets = Some(val().into()),
            "--query" => a.query = Some(val().trim_start_matches('?').to_string()),
            "--preview" => a.preview = Some(val()),
            "--debug-port" => a.debug_port = val().parse().ok(),
            "--user-data" => a.user_data = val().into(),
            "--log" => a.log = Some(val().into()),
            "--selftest" => a.selftest = true,
            "--exit-after" => a.exit_after = val().parse().ok(),
            "--register-protocol" => a.register = true,
            "--cdp-port" => a.cdp_port = val().parse().unwrap_or(9303),
            "--preview-host" => a.preview_host = Some(val().into()),
            "--preview-mode" => {
                a.mode = match val().as_str() {
                    "cef-child" => PMode::CefChild,
                    "cef-stream" => PMode::CefStream,
                    _ => PMode::Webview2,
                }
            }
            s if s.starts_with(SCHEME_URL) => a.deeplinks.push(s.to_string()),
            _ => {} // --updated, --force-run, anything else
        }
    }
    a
}

fn find_dir(flag: &Option<PathBuf>, env: &str, exe_sub: &str, walk: &str) -> PathBuf {
    if let Some(p) = flag {
        return p.clone();
    }
    if let Some(p) = std::env::var_os(env) {
        return p.into();
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    if dir.join(exe_sub).exists() {
        return dir.join(exe_sub);
    }
    let mut cur = Some(dir.as_path());
    while let Some(d) = cur {
        if d.join(walk).exists() {
            return d.join(walk);
        }
        cur = d.parent();
    }
    PathBuf::from(walk)
}

fn register_protocol() {
    let exe = std::env::current_exe().unwrap_or_default();
    let key = r"HKCU\Software\Classes\ompdesk-proto";
    let run = |args: &[&str]| {
        let ok = std::process::Command::new("reg").args(args).output().map(|o| o.status.success()).unwrap_or(false);
        println!("reg {} -> {ok}", args.join(" "));
    };
    run(&["add", key, "/ve", "/d", "URL:ompdesk-proto", "/f"]);
    run(&["add", key, "/v", "URL Protocol", "/d", "", "/f"]);
    run(&["add", &format!(r"{key}\shell\open\command"), "/ve", "/d", &format!("\"{}\" \"%1\"", exe.display()), "/f"]);
}

// ---------------------------------------------------------------- shared state
struct Shared {
    cfg: Arc<scheme::Cfg>,
    args: Args,
    host: Mutex<Option<preview::Host>>,
    stream: OnceLock<stream::Stream>,
    preview_wv: Mutex<Option<tauri::Webview>>,
    page_wv: Mutex<Option<tauri::Webview>>,
    preview_url: Mutex<String>,
    bits: AtomicU8,
    hwnd: Mutex<isize>,
    scale: Mutex<f64>,
    out_dir: PathBuf,
}

static SH: OnceLock<Shared> = OnceLock::new();

fn sh() -> &'static Shared {
    SH.get().expect("shared")
}

fn mark(bit: u8) {
    let s = sh();
    let need = 1 | if s.args.preview.is_some() { 2 } else { 0 };
    let old = s.bits.fetch_or(bit, Ordering::SeqCst);
    let new = old | bit;
    if s.args.selftest && new == need && old != new {
        std::thread::spawn(run_selftests);
    }
}

/// cef-child: the WebView2 child window outranks the foreign window in z-order; put the host's on top.
fn raise_host() {
    let s = sh();
    if let Some(h) = s.host.lock().unwrap().as_ref() {
        let n = hit::raise_host_child(*s.hwnd.lock().unwrap(), h.pid());
        log("preview.raise", json!({"raised": n}));
    }
}

fn layout(w: u32, h: u32, scale: f64) -> (i32, i32, i32, i32) {
    let x = (w as f64 * 0.6).round() as i32;
    let y = (48.0 * scale).round() as i32;
    (x, y, w as i32 - x, (h as i32 - y).max(1))
}

// ---------------------------------------------------------------- CDP through WebView2
struct Wv2Cdp(tauri::Webview);

impl Cdp for Wv2Cdp {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let (m, p) = (HSTRING::from(method), HSTRING::from(params.to_string()));
        self.0
            .with_webview(move |pv| unsafe {
                let tx2 = tx.clone();
                let r = (|| -> windows::core::Result<()> {
                    let core = pv.controller().CoreWebView2()?;
                    let h = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |res, json| {
                        let _ = tx2.send(res.map(|_| json).map_err(|e| e.to_string()));
                        Ok(())
                    }));
                    core.CallDevToolsProtocolMethod(&m, &p, &h)
                })();
                if let Err(e) = r {
                    let _ = tx.send(Err(e.to_string()));
                }
            })
            .map_err(|e| e.to_string())?;
        let s = rx.recv_timeout(Duration::from_secs(20)).map_err(|e| format!("{method}: {e}"))??;
        let v: Value = serde_json::from_str(&s).unwrap_or(Value::Null);
        Ok(v)
    }
}

fn run_selftests() {
    let s = sh();
    std::thread::sleep(Duration::from_millis(800));
    let filter = s
        .preview_url
        .lock()
        .unwrap()
        .split('?')
        .next()
        .and_then(|u| u.rsplit('/').next())
        .unwrap_or("")
        .to_string();
    if s.args.preview.is_some() {
        match s.args.mode {
            PMode::Webview2 => {
                let wv = s.preview_wv.lock().unwrap().clone().expect("preview webview");
                selftest::run(&mut Wv2Cdp(wv), &s.out_dir);
                selftest::external(s.args.debug_port, &filter);
            }
            _ => {
                let port = s.args.cdp_port;
                match cdp::page_ws_url(port, Some(&filter), Duration::from_secs(30)).and_then(|u| WsCdp::connect(&u).map(|c| (u, c))) {
                    Ok((url, mut c)) => {
                        selftest::run(&mut c, &s.out_dir);
                        drop(c);
                        selftest::external(Some(port), &filter);
                        selftest::stream_latency(&url, s.args.mode.name(), 3);
                    }
                    Err(e) => log("selftest.cdp_evaluate", json!({"ok": false, "error": e})),
                }
            }
        }
    }
    let t = Instant::now();
    let mut pts: Vec<(String, f64, f64)> = vec![];
    let mut regions = Value::Null;
    if let Some(wv) = s.page_wv.lock().unwrap().clone() {
        let js = "(()=>{const out=[];for(const el of document.querySelectorAll('*')){const cs=getComputedStyle(el);if((cs.webkitAppRegion||cs.appRegion)==='drag'){const r=el.getBoundingClientRect();if(r.width>20&&r.height>10)out.push([r.x,r.y,r.width,r.height,String(el.className)])}}return out})()";
        if let Ok(r) = Wv2Cdp(wv).call("Runtime.evaluate", json!({"expression": js, "returnByValue": true})) {
            regions = r.pointer("/result/value").cloned().unwrap_or(Value::Null);
        }
    }
    if let Some(a) = regions.as_array() {
        for (i, r) in a.iter().take(3).enumerate() {
            let f = |k: usize| r[k].as_f64().unwrap_or(0.0);
            pts.push((format!("drag-region#{i} centre"), f(0) + f(2) / 2.0, f(1) + f(3) / 2.0));
        }
    }
    pts.push(("caption buttons (no-drag)".into(), 1280.0 - 69.0, 24.0));
    pts.push(("page body (no drag)".into(), 640.0, 400.0));
    let mut v = hit::hit_test(*s.hwnd.lock().unwrap(), *s.scale.lock().unwrap(), &pts);
    v["dragRegions"] = regions;
    let ok = v["points"].as_array().is_some_and(|p| p.iter().any(|x| x["at"].as_str().is_some_and(|a| a.starts_with("drag-region")) && (x["topLevel"] == "HTCAPTION" || x["windowUnderHit"] == "HTCAPTION")));
    v["ok"] = json!(ok);
    v["ms"] = json!(t.elapsed().as_millis() as u64);
    log("selftest.hittest", v);
}

// ---------------------------------------------------------------- scheme handler
fn handle(app: &tauri::AppHandle, method: &str, target: &str, range: Option<&str>, body: &[u8]) -> scheme::Reply {
    let s = sh();
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/__shell/window" if method == "POST" => {
            let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            if let Some(w) = app.get_window("main") {
                match v["action"].as_str().unwrap_or("") {
                    "minimize" => { let _ = w.minimize(); }
                    "maximize" => {
                        if w.is_maximized().unwrap_or(false) { let _ = w.unmaximize(); } else { let _ = w.maximize(); }
                    }
                    "close" => { let _ = w.close(); }
                    "drag" => { let _ = w.start_dragging(); }
                    _ => {}
                }
            }
            scheme::Reply::new(204)
        }
        "/__shell/preview-frame" => {
            let after = query.split('&').find_map(|p| p.strip_prefix("after=")).and_then(|v| v.parse().ok()).unwrap_or(0);
            match s.stream.get().and_then(|st| st.wait_frame(after)) {
                Some((seq, data)) => {
                    let mut r = scheme::Reply::new(200).header("Content-Type", "image/jpeg").header("X-Frame-Seq", seq.to_string()).header("Access-Control-Expose-Headers", "X-Frame-Seq");
                    r.body = data;
                    r
                }
                None => scheme::Reply::new(204),
            }
        }
        "/__shell/preview-input" if method == "POST" => {
            if let (Some(st), Ok(v)) = (s.stream.get(), serde_json::from_slice::<Value>(body)) {
                st.cdp("Input.dispatchMouseEvent", v);
            }
            scheme::Reply::new(204)
        }
        _ => scheme::serve(&s.cfg, method, target, range, body),
    }
}

// ---------------------------------------------------------------- main
fn main() {
    let args = parse_args();
    if args.register {
        register_protocol();
        return;
    }
    START.get_or_init(Instant::now);
    let first_args_deeplinks = args.deeplinks.clone();
    let mode = args.mode;
    let user_data = args.user_data.clone();

    let cfg = Arc::new(scheme::Cfg {
        renderer: find_dir(&args.renderer, "SHELL_RENDERER_DIR", "renderer", "out/renderer"),
        assets: find_dir(&args.assets, "SHELL_ASSETS_DIR", "shell-assets", "native/shell-prototype/shell-assets"),
        webview_dir: user_data.join("shell-webview"),
        mode: mode.name().to_string(),
    });
    let log_path = args.log.clone().unwrap_or_else(|| cfg.webview_dir.join("shell.log.jsonl"));
    let out_dir = log_path.parent().map(Path::to_path_buf).unwrap_or_default();
    let _ = SH.set(Shared {
        cfg: cfg.clone(),
        args,
        host: Mutex::new(None),
        stream: OnceLock::new(),
        preview_wv: Mutex::new(None),
        page_wv: Mutex::new(None),
        preview_url: Mutex::new(String::new()),
        bits: AtomicU8::new(0),
        hwnd: Mutex::new(0),
        scale: Mutex::new(1.0),
        out_dir,
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for a in argv.iter().filter(|a| a.starts_with(SCHEME_URL)) {
                log("deeplink", json!({"url": a, "from": "second-instance"}));
            }
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .register_asynchronous_uri_scheme_protocol("app", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let method = req.method().as_str().to_string();
                let target = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
                let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_string);
                let r = handle(&app, &method, &target, range.as_deref(), req.body());
                let mut b = tauri::http::Response::builder().status(r.status).header("Access-Control-Allow-Origin", "*");
                for (k, v) in &r.headers {
                    b = b.header(k.as_str(), v.as_str());
                }
                responder.respond(b.body(r.body).unwrap());
            });
        })
        .setup(move |app| {
            let s = sh();
            let _ = std::fs::create_dir_all(&s.cfg.webview_dir);
            if let Some(p) = log_path.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            *LOG.lock().unwrap() = File::create(&log_path).ok();

            let app_id = std::env::var("OMPDESK_PROTO_APP_ID").unwrap_or_else(|_| "com.seuput.ompdesk.proto".into());
            unsafe {
                let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(app_id.as_str()));
            }
            log(
                "start",
                json!({"candidate": format!("tauri2/{}", mode.name()), "version": format!("tauri {}", tauri::VERSION), "appId": app_id,
                       "renderer": s.cfg.renderer.display().to_string(), "assets": s.cfg.assets.display().to_string()}),
            );
            for d in &first_args_deeplinks {
                log("deeplink", json!({"url": d, "from": "argv"}));
            }
            shell_migrate::run(&user_data, &s.cfg.webview_dir, &mut |e, f| log(e, f));

            // window + page webview
            let window = WindowBuilder::new(app, "main")
                .title("OMPdesk proto (tauri2)")
                .inner_size(1280.0, 800.0)
                .decorations(false)
                .build()?;
            let size = window.inner_size()?;
            let scale = window.scale_factor()?;
            *s.scale.lock().unwrap() = scale;
            *s.hwnd.lock().unwrap() = window.hwnd()?.0 as isize;
            hit::install_forwarder(*s.hwnd.lock().unwrap());

            let mut bargs = WV_ARGS.to_string();
            if let Some(p) = s.args.debug_port {
                bargs += &format!(" --remote-debugging-port={p}");
            }
            let mut url = "http://app.localhost/index.html".to_string();
            if let Some(q) = &s.args.query {
                url += &format!("?{q}");
            }
            let nav_start = Arc::new(Mutex::new(Instant::now()));
            let ns = nav_start.clone();
            let page_wv = window.add_child(
                WebviewBuilder::new("page", WebviewUrl::External(url.parse()?))
                    .auto_resize()
                    .additional_browser_args(&bargs)
                    .data_directory(s.cfg.webview_dir.clone())
                    .on_page_load(move |_wv, p| match p.event() {
                        PageLoadEvent::Started => *ns.lock().unwrap() = Instant::now(),
                        PageLoadEvent::Finished => {
                            log("page.url", json!({"url": p.url().to_string()}));
                            log("page.loaded", json!({"ms": nav_start.lock().unwrap().elapsed().as_millis() as u64}));
                            mark(1);
                        }
                    }),
                PhysicalPosition::new(0, 0),
                size,
            )?;
            *s.page_wv.lock().unwrap() = Some(page_wv);

            // Preview
            if let Some(purl) = &s.args.preview {
                let (px, py, pw, ph) = layout(size.width, size.height, scale);
                let mut real = purl.clone();
                match s.args.mode {
                    PMode::Webview2 => {
                        if let Some(r) = purl.strip_prefix("app://ompdesk") {
                            real = format!("http://app.localhost{r}");
                        }
                        *s.preview_url.lock().unwrap() = real.clone();
                        let t0 = Instant::now();
                        let pv = window.add_child(
                            WebviewBuilder::new("preview", WebviewUrl::External(real.parse()?))
                                .additional_browser_args(&bargs)
                                .data_directory(s.cfg.webview_dir.clone())
                                .on_page_load(move |_wv, p| {
                                    if p.event() == PageLoadEvent::Finished {
                                        log("preview.loaded", json!({"url": p.url().to_string(), "ms": t0.elapsed().as_millis() as u64}));
                                        mark(2);
                                    }
                                }),
                            PhysicalPosition::new(px, py),
                            PhysicalSize::new(pw as u32, ph as u32),
                        )?;
                        *s.preview_wv.lock().unwrap() = Some(pv);
                    }
                    m => {
                        let port = preview::http_server(s.cfg.clone());
                        if let Some(r) = purl.strip_prefix("app://ompdesk") {
                            real = format!("http://127.0.0.1:{port}{r}");
                        }
                        *s.preview_url.lock().unwrap() = real.clone();
                        let exe = s.args.preview_host.clone().unwrap_or_else(|| {
                            let dir = std::env::current_exe().unwrap_or_default().parent().map(Path::to_path_buf).unwrap_or_default();
                            let local = dir.join("preview-host.exe");
                            if local.exists() {
                                return local;
                            }
                            let mut cur = Some(dir.as_path());
                            while let Some(d) = cur {
                                let p = d.join("native/shell-prototype/cef/target/release/preview-host.exe");
                                if p.exists() {
                                    return p;
                                }
                                cur = d.parent();
                            }
                            local
                        });
                        let pm = if m == PMode::CefChild {
                            preview::Mode::Child { hwnd: *s.hwnd.lock().unwrap(), bounds: (px, py, pw, ph) }
                        } else {
                            preview::Mode::Offscreen { w: pw as u32, h: ph as u32 }
                        };
                        log("preview.spawn", json!({"exe": exe.display().to_string(), "url": real, "mode": m.name()}));
                        match preview::Host::spawn(&exe, &real, s.args.cdp_port, pm, &s.out_dir.join("preview-host.log"), |url, ms| {
                            log("preview.loaded", json!({"url": url, "ms": ms}));
                            if sh().args.mode == PMode::CefChild {
                                raise_host();
                                std::thread::spawn(|| {
                                    std::thread::sleep(Duration::from_millis(500));
                                    raise_host();
                                });
                            }
                            mark(2);
                        }) {
                            Ok(h) => *s.host.lock().unwrap() = Some(h),
                            Err(e) => log("preview.spawn_error", json!({"error": e})),
                        }
                        if m == PMode::CefStream {
                            let _ = s.stream.set(stream::start(s.args.cdp_port, (pw as u32, ph as u32)));
                        }
                    }
                }
                let w2 = window.clone();
                window.on_window_event(move |ev| {
                    if let WindowEvent::Resized(sz) = ev {
                        if sz.width == 0 || sz.height == 0 {
                            return;
                        }
                        let sc = w2.scale_factor().unwrap_or(1.0);
                        let (x, y, w, h) = layout(sz.width, sz.height, sc);
                        let s = sh();
                        match s.args.mode {
                            PMode::Webview2 => {
                                if let Some(pv) = s.preview_wv.lock().unwrap().as_ref() {
                                    let _ = pv.set_position(PhysicalPosition::new(x, y));
                                    let _ = pv.set_size(PhysicalSize::new(w as u32, h as u32));
                                }
                            }
                            PMode::CefChild => {
                                if let Some(h2) = s.host.lock().unwrap().as_ref() {
                                    h2.send(&format!("bounds {x} {y} {w} {h}"));
                                }
                                raise_host();
                            }
                            PMode::CefStream => {
                                if let Some(st) = s.stream.get() {
                                    st.cdp("Emulation.setDeviceMetricsOverride", json!({"width": w, "height": h, "deviceScaleFactor": 1, "mobile": false}));
                                }
                            }
                        }
                    }
                });
            }

            // tray
            let tray = (|| -> tauri::Result<()> {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
                let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let mut b = TrayIconBuilder::new().tooltip("shell-tauri2").menu(&menu).on_menu_event(|app, ev| {
                    let id = ev.id().as_ref().to_string();
                    log("tray.click", json!({"item": id}));
                    if id == "quit" {
                        app.exit(0);
                    } else if let Some(w) = app.get_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }).on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        log("tray.click", json!({"item": "icon"}));
                        if let Some(w) = tray.app_handle().get_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                });
                if let Some(i) = app.default_window_icon() {
                    b = b.icon(i.clone());
                }
                let t = b.build(app)?;
                app.manage(t);
                Ok(())
            })();
            log("tray.created", json!({"ok": tray.is_ok(), "error": tray.err().map(|e| e.to_string())}));

            if let Some(sec) = s.args.exit_after {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(sec));
                    h.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build tauri app");

    app.run(|_app, ev| {
        if let RunEvent::Exit = ev {
            if let Some(h) = sh().host.lock().unwrap().take() {
                h.shutdown();
            }
            log("exit", json!({}));
        }
    });
}
