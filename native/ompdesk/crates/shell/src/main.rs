//! OMPdesk's shell: a CEF (Chromium Embedded Framework) host for the app's page, driven by the Node process that
//! runs the TypeScript main (PROTOCOL.md). README.md describes the layout and every deviation from Electron.
#![windows_subsystem = "windows"]

mod app;
mod appops;
mod cdp;
mod clipboard;
mod dialog;
mod dispatch;
mod host;
mod ipc;
mod lifecycle;
mod log;
#[cfg(target_os = "macos")]
mod macos;
mod menu;
mod net;
mod node;
mod notification;
#[cfg(target_os = "macos")]
mod platform;
mod power;
mod protocol;
mod proxy;
mod scheme;
mod screen;
mod session;
mod shellops;
mod shortcut;
mod state;
mod system;
mod theme;
mod tray;
mod ui;
mod view;
mod wc;
mod wcframe;
mod window;

use std::path::{Path, PathBuf};
use std::time::Duration;

use cef::*;
use serde_json::json;
use shell_core::conn::{self, Listener};
use shell_core::facts::{self, Launch};
use shell_core::migrate::local_storage;
use shell_core::startup;

use crate::lifecycle::Boot;
use crate::log::log;
use crate::state::{PATHS, Paths};

fn main() {
    log::start_clock();
    let argv: Vec<String> = std::env::args().collect();
    // macOS: the one-shot keychain read the shim runs on first use of safeStorage (never at launch).
    #[cfg(target_os = "macos")]
    if let Some(code) = shell_core::sys_mac::keychain::cli(&argv[1..]) {
        std::process::exit(code);
    }
    let is_helper = argv.iter().any(|a| a.starts_with("--type="));
    // macOS: CEF's framework is loaded before any CEF call, in every process, and stays loaded.
    #[cfg(target_os = "macos")]
    let _loader = macos::load_framework(!is_helper);
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    if is_helper {
        std::process::exit(helper());
    }
    std::process::exit(browser(argv));
}

/// A CEF subprocess (renderer, GPU, utility…): the same executable with `--type=…`. Nothing else runs there.
fn helper() -> i32 {
    let args = cef::args::Args::new();
    let mut app = app::ShellApp::new(false);
    execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    )
    .max(0)
}

fn default_user_data() -> PathBuf {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::FOLDERID_RoamingAppData;
        let roaming = shell_core::sys::known_folder(&FOLDERID_RoamingAppData)
            .unwrap_or_else(|| PathBuf::from(std::env::var("APPDATA").unwrap_or_default()));
        startup::default_user_data(&roaming)
    }
    #[cfg(not(windows))]
    {
        startup::default_user_data(
            &PathBuf::from(std::env::var("HOME").unwrap_or_default())
                .join("Library")
                .join("Application Support"),
        )
    }
}

struct Located {
    app_dir: PathBuf,
    resources: PathBuf,
    packaged: bool,
}

/// Packaged: `<resources>/app` beside the exe (Windows `<exe dir>/resources`, macOS `Contents/Resources`). Unpackaged:
/// env `OMPDESK_APP_DIR`, else the folder above the exe that holds `out/main/index.js`.
fn locate(exe: &Path) -> Option<Located> {
    let dir = exe.parent()?;
    let resources = if cfg!(target_os = "macos") {
        dir.join("..").join("Resources")
    } else {
        dir.join("resources")
    };
    let packaged_app = resources.join("app");
    if packaged_app
        .join("out")
        .join("main")
        .join("index.js")
        .is_file()
    {
        return Some(Located {
            app_dir: packaged_app,
            resources,
            packaged: true,
        });
    }
    let app_dir = match std::env::var("OMPDESK_APP_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => startup::find_app_dir(dir, |p| p.is_file())?,
    };
    Some(Located {
        resources: app_dir.join("resources"),
        app_dir,
        packaged: false,
    })
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where a relaunch waits for the instance it replaces to let go of the single-instance name.
const RELAUNCH_AFTER_ENV: &str = "OMPDESK_SHELL_RELAUNCH_AFTER_PID";

fn browser(argv: Vec<String>) -> i32 {
    // macOS: the NSApplication subclass CEF needs, before anything else touches NSApp, then the app delegate (Apple
    // Events, Dock re-open) and a default main menu until Node sends its own.
    #[cfg(target_os = "macos")]
    macos::setup_application(macos::request_quit);
    #[cfg(target_os = "macos")]
    let _delegate = macos::setup_delegate();
    #[cfg(target_os = "macos")]
    macos::install_main_menu();
    let args: Vec<String> = argv.iter().skip(1).cloned().collect();
    let Ok(exe) = std::env::current_exe() else {
        return 1;
    };
    let user_data = startup::resolve_user_data(
        &args,
        std::env::var(startup::USER_DATA_ENV).ok().as_deref(),
        default_user_data(),
    );
    let web_dir = user_data.join("shell-webview");
    let _ = std::fs::create_dir_all(&web_dir);
    log::open_file(&web_dir.join("shell.log.jsonl"));
    log(
        "start",
        json!({ "version": env!("CARGO_PKG_VERSION"), "cef": facts::CEF_VERSION, "userData": user_data.display().to_string(), "args": args }),
    );

    #[cfg(windows)]
    if let Some(pid) = std::env::var(RELAUNCH_AFTER_ENV)
        .ok()
        .and_then(|p| p.parse::<u32>().ok())
    {
        shell_core::sys::system::wait_for_pid(pid, Duration::from_secs(15));
    }

    // One instance per user-data folder, before Node starts: a second launch hands its arguments over and exits.
    #[cfg(windows)]
    let instance_name = startup::pipe_name(&user_data);
    #[cfg(not(windows))]
    let instance_name = startup::socket_path(&user_data).display().to_string();
    let instance = match Listener::bind(&instance_name) {
        Ok(listener) => listener,
        Err(_) => {
            let cwd = std::env::current_dir()
                .map(|d| d.display().to_string())
                .unwrap_or_default();
            return match conn::hand_over(&instance_name, &argv, &cwd) {
                Ok(()) => {
                    log("instance.handed_over", json!({}));
                    0
                }
                Err(error) => {
                    log(
                        "instance.hand_over_failed",
                        json!({ "error": error.to_string() }),
                    );
                    1
                }
            };
        }
    };
    spawn_instance_listener(instance);

    let Some(located) = locate(&exe) else {
        log(
            "app.not_found",
            json!({ "hint": "set OMPDESK_APP_DIR to the folder holding out/main/index.js" }),
        );
        eprintln!(
            "[shell] cannot find the app: no out/main/index.js above the executable (set OMPDESK_APP_DIR)"
        );
        return 1;
    };
    // The renderer and the preload are the main script's siblings (`out/main/index.js` → `out/renderer`): the e2e
    // harness runs pinned snapshots (`out-<hash>/main/index.js`) beside the checkout's own `out/`.
    let entry = node::entry_script(&located.app_dir);
    let build_dir = entry
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| located.app_dir.join("out"));
    let _ = PATHS.set(Paths {
        renderer_dir: build_dir.join("renderer"),
        preload_file: build_dir.join("preload").join("shell.js"),
        web_dir: web_dir.clone(),
    });
    local_storage::prepare(&user_data, &web_dir, &mut |event, data| log(event, data));

    let lang = args
        .iter()
        .rev()
        .find_map(|a| a.strip_prefix("--lang=").map(String::from));
    let launch = Launch {
        user_data: user_data.clone(),
        exe: exe.clone(),
        app_dir: located.app_dir.clone(),
        renderer_root: build_dir.join("renderer"),
        packaged: located.packaged,
        resources: located.resources.clone(),
        argv: argv.clone(),
        lang,
    };
    let facts = facts::collect(&launch, &mut |event, data| log(event, data));
    let app_locale = facts["locale"]["appLocale"]
        .as_str()
        .unwrap_or("en-US")
        .to_string();
    let languages: Vec<String> = facts["locale"]["preferredLanguages"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Node: it connects to the shell's socket with the token and speaks the host protocol.
    let token = random_hex(32);
    #[cfg(windows)]
    let socket = format!("{}-host-{}", instance_name, std::process::id());
    #[cfg(not(windows))]
    let socket = user_data
        .join(format!("shell-host-{}.sock", std::process::id()))
        .display()
        .to_string();
    let host_listener = match Listener::bind(&socket) {
        Ok(l) => l,
        Err(error) => {
            log("host.bind_failed", json!({ "error": error.to_string() }));
            return 1;
        }
    };
    let boot = lifecycle::boot_channel();
    host::serve(
        host_listener,
        token.clone(),
        facts,
        host::Handlers {
            request: dispatch::request,
            event: dispatch::event,
            closed: || lifecycle::node_gone(None),
        },
    );
    let program = node::node_program(located.packaged, &located.resources);
    if let Err(error) = node::spawn(&program, &entry, &args, &socket, &token) {
        log(
            "node.spawn_failed",
            json!({ "error": error.to_string(), "program": program.display().to_string() }),
        );
        eprintln!("[shell] cannot start Node ({}): {error}", program.display());
        return 1;
    }
    node::watch(lifecycle::node_gone);

    // Everything Electron's main does before `whenReady` arrives as `app.init`; CEF starts from it.
    let init_call = match boot.recv_timeout(Duration::from_secs(180)) {
        Ok(Boot::Init(call)) => call,
        Ok(Boot::Exit(code)) => {
            node::stop(Duration::from_secs(3));
            return code;
        }
        Ok(Boot::NodeGone) | Err(_) => {
            node::stop(Duration::from_secs(1));
            return 1;
        }
    };
    let init = app::parse_init(&init_call.params);
    #[cfg(windows)]
    if let Some(id) = init_call
        .params
        .get("appUserModelId")
        .and_then(|v| v.as_str())
    {
        appops::set_app_user_model_id(id);
    }
    let _ = app::INIT.set(init);
    let code = run_cef(&web_dir, &app_locale, &languages, &args, init_call);
    node::stop(Duration::from_secs(5));
    let exit = lifecycle::take_exit();
    log("exit", json!({ "code": code }));
    if let Some(relaunch) = exit.relaunch {
        relaunch_self(&exe, relaunch.unwrap_or_else(|| args.clone()));
    }
    code
}

fn relaunch_self(exe: &Path, args: Vec<String>) {
    let mut command = std::process::Command::new(exe);
    command
        .args(args)
        .env(RELAUNCH_AFTER_ENV, std::process::id().to_string());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: the new instance outlives this one.
        command.creation_flags(0x0000_0208);
    }
    if let Err(error) = command.spawn() {
        log("relaunch.failed", json!({ "error": error.to_string() }));
    }
}

fn spawn_instance_listener(mut listener: Listener) {
    std::thread::Builder::new()
        .name("instance".into())
        .spawn(move || {
            while let Ok(mut conn) = listener.accept() {
                match conn::take_hand_over(&mut conn) {
                    Ok((argv, cwd)) => {
                        log("instance.second", json!({ "argv": argv }));
                        host::event("app.secondInstance", json!({ "argv": argv, "cwd": cwd }));
                    }
                    Err(error) => log(
                        "instance.hand_over_bad",
                        json!({ "error": error.to_string() }),
                    ),
                }
            }
        })
        .expect("instance thread");
}

/// CEF: settings, initialisation, the message loop, shutdown. Returns the exit code Node asked for.
fn run_cef(
    web_dir: &Path,
    locale: &str,
    languages: &[String],
    args: &[String],
    init_call: host::Call,
) -> i32 {
    let cef_args = cef::args::Args::new();
    let mut app = app::ShellApp::new(true);
    let started = execute_process(
        Some(cef_args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    );
    if started != -1 {
        return started;
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    // Only the locales that ship (`en-US`, `ko`); any other falls back to en-US.
    let locale = if exe_dir
        .join("locales")
        .join(format!("{locale}.pak"))
        .is_file()
    {
        locale
    } else {
        "en-US"
    };
    let web = web_dir.display().to_string();
    let settings = Settings {
        no_sandbox: 1,
        windowless_rendering_enabled: 1,
        root_cache_path: CefString::from(web.as_str()),
        cache_path: CefString::from(web.as_str()),
        log_file: CefString::from(web_dir.join("cef.log").display().to_string().as_str()),
        log_severity: LogSeverity::WARNING,
        persist_session_cookies: 1,
        remote_debugging_port: startup::remote_debugging_port(args).map_or(0, i32::from),
        locale: CefString::from(locale),
        accept_language_list: CefString::from(languages.join(",").as_str()),
        ..Default::default()
    };
    window::init_caption();
    lifecycle::cef_started();
    if initialize(
        Some(cef_args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        std::ptr::null_mut(),
    ) != 1
    {
        log("cef.initialize_failed", json!({ "webDir": web }));
        eprintln!("[shell] CEF could not initialise (another process owns {web}?)");
        return 1;
    }
    #[cfg(target_os = "macos")]
    platform::apply_init(&init_call.params);
    lifecycle::answer_init(init_call);
    announce_debugging_port(web_dir, args);
    run_message_loop();
    shutdown();
    lifecycle::exit_code()
}

/// Chromium writes `DevToolsActivePort` into its user-data folder; the harness reads it from the profile folder the
/// shell gave CEF, so when CEF did not put one there the shell does, once the port is known.
fn announce_debugging_port(web_dir: &Path, args: &[String]) {
    let Some(port) = startup::remote_debugging_port(args) else {
        return;
    };
    let file = web_dir.join("DevToolsActivePort");
    if port != 0 {
        let _ = std::fs::write(&file, format!("{port}\n/devtools/browser\n"));
        return;
    }
    // Port 0: Chromium picks one and writes the file itself; wait for it on a thread (it appears after startup).
    std::thread::spawn(move || {
        for _ in 0..100 {
            if file.is_file() {
                log(
                    "devtools.port",
                    json!({ "file": file.display().to_string(), "text": std::fs::read_to_string(&file).unwrap_or_default() }),
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        log(
            "devtools.port_missing",
            json!({ "file": file.display().to_string() }),
        );
    });
}
