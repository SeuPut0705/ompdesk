//! What the shell knows about its windows and pages. The CEF objects live in a UI-thread registry (`ui_state`);
//! the few facts other threads need (which page a browser is, the app's folders) are plain globals.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use cef::*;
use serde_json::{Value, json};

/// Ids Node sees (PROTOCOL.md §0). Node assigns its own from 1; the ones the shell makes (a create that omits them, a
/// window or page a moved module opens, §15) start at 2^32, so the two never meet. Never reused in a run.
const SHELL_IDS_BASE: u64 = 1 << 32;
static WIN_IDS: AtomicU64 = AtomicU64::new(SHELL_IDS_BASE);
static WC_IDS: AtomicU64 = AtomicU64::new(SHELL_IDS_BASE);
static VIEW_IDS: AtomicU64 = AtomicU64::new(SHELL_IDS_BASE);

pub fn next_win_id() -> u64 {
    WIN_IDS.fetch_add(1, Ordering::Relaxed)
}
pub fn next_wc_id() -> u64 {
    WC_IDS.fetch_add(1, Ordering::Relaxed)
}
pub fn next_view_id() -> u64 {
    VIEW_IDS.fetch_add(1, Ordering::Relaxed)
}

/// The app's places, set once at startup (`app.rs`).
pub struct Paths {
    pub renderer_dir: PathBuf,
    pub preload_file: PathBuf,
    pub web_dir: PathBuf,
}

pub static PATHS: OnceLock<Paths> = OnceLock::new();

/// The facts `hello` hands Node (PROTOCOL.md §1), kept for the modules that read the same places (`paths`, `exe`,
/// `argv`, `isPackaged`). Set once at startup (`main.rs`).
pub static FACTS: OnceLock<serde_json::Value> = OnceLock::new();

pub fn paths() -> &'static Paths {
    PATHS.get().expect("paths are set at startup")
}

/// CEF browser id → `wcId`, readable from CEF's IO thread (the scheme handlers find their page here).
static BROWSER_WC: Mutex<Option<HashMap<i32, u64>>> = Mutex::new(None);

pub fn map_browser(browser_id: i32, wc_id: u64) {
    BROWSER_WC
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(browser_id, wc_id);
}

pub fn unmap_browser(browser_id: i32) {
    if let Some(map) = BROWSER_WC.lock().unwrap().as_mut() {
        map.remove(&browser_id);
    }
}

pub fn wc_of_browser(browser_id: i32) -> Option<u64> {
    BROWSER_WC
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(&browser_id).copied())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    /// The app's page in an OS window.
    Page,
    /// A `WebContentsView` (the Preview).
    View,
    /// A windowless browser (`webPreferences.offscreen`).
    Offscreen,
}

/// A CDP call's answer: the result, or `(code, message)`.
pub type CdpCallback = Box<dyn FnOnce(Result<Value, (String, String)>)>;

/// `wc.state` (PROTOCOL.md §4).
#[derive(Clone, Default, PartialEq)]
pub struct WcState {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub zoom_factor: f64,
    pub audio_muted: bool,
    pub devtools_opened: bool,
    pub crashed: bool,
    pub user_agent: String,
}

impl WcState {
    pub fn json(&self, wc_id: u64) -> Value {
        json!({
            "wcId": wc_id, "url": self.url, "title": self.title, "loading": self.loading,
            "canGoBack": self.can_go_back, "canGoForward": self.can_go_forward, "zoomFactor": self.zoom_factor,
            "audioMuted": self.audio_muted, "devtoolsOpened": self.devtools_opened, "crashed": self.crashed,
            "userAgent": self.user_agent,
        })
    }
}

/// One painted frame of an offscreen browser, BGRA as CEF delivers it.
pub struct Painted {
    pub width: i32,
    pub height: i32,
    pub bgra: std::sync::Arc<Vec<u8>>,
}

pub struct WcEntry {
    pub id: u64,
    pub partition: String,
    pub browser: Option<Browser>,
    pub view: Option<BrowserView>,
    pub win_id: Option<u64>,
    pub state: WcState,
    pub sent_state: Option<Value>,
    /// Optional events Node asked for (`watchEvents`), navigation kinds it watches (`watchNavigation`).
    pub watch_events: HashSet<String>,
    pub watch_nav: HashSet<String>,
    pub cdp_attached: bool,
    /// The debugger's own DevTools session (a flat session the shell attached to this page's target): Electron's
    /// debugger is a session of its own, so detaching it drops everything it set (emulation, interception, scripts).
    pub cdp_session: Option<String>,
    /// Counts `debugger.attach`es: a session that opens after a later attach or a detach is not this attach's.
    pub cdp_attempt: u64,
    /// Debugger commands that arrived while its session was being made; they run once it exists (`None`: it failed).
    pub cdp_waiting: Vec<Box<dyn FnOnce(Option<String>)>>,
    pub cdp_registration: Option<Registration>,
    /// The DevTools observer was added (whatever `add_dev_tools_message_observer` returned): CEF adds each page's once.
    pub cdp_observer_added: bool,
    pub cdp_next_id: i32,
    /// CDP calls waiting for their answer, by the id the shell chose.
    pub cdp_pending: HashMap<i32, CdpCallback>,
    /// Which of `cdp_pending` the debugger sent (on its session or one under it): they end with its session.
    pub cdp_debugger_pending: HashSet<i32>,
    pub painted: Option<Painted>,
    pub view_size: (i32, i32),
    pub frame_rate: i32,
    pub closing: bool,
    pub created: bool,
    /// Operations asked before CEF created the browser; they run in `on_after_created`.
    pub queued: Vec<Box<dyn FnOnce(Browser)>>,
    /// Script a Preview partition's `registerPreload` handed over, run before page scripts (renderer process).
    pub preload: Option<String>,
    /// A navigation began and has not yet been committed (did-navigate vs did-navigate-in-page).
    pub nav_started: bool,
    pub committed: bool,
    /// Node started the next main-frame navigation itself (loadURL, reload, back, forward): never `will-navigate`.
    pub programmatic: bool,
}

impl WcEntry {
    pub fn new(id: u64, partition: &str) -> Self {
        Self {
            id,
            partition: partition.to_string(),
            browser: None,
            view: None,
            win_id: None,
            state: WcState {
                zoom_factor: 1.0,
                ..WcState::default()
            },
            sent_state: None,
            watch_events: HashSet::new(),
            watch_nav: HashSet::new(),
            cdp_attached: false,
            cdp_session: None,
            cdp_attempt: 0,
            cdp_waiting: Vec::new(),
            cdp_registration: None,
            cdp_observer_added: false,
            cdp_next_id: 0,
            cdp_pending: HashMap::new(),
            cdp_debugger_pending: HashSet::new(),
            painted: None,
            view_size: (1280, 720),
            frame_rate: 30,
            closing: false,
            created: false,
            queued: Vec::new(),
            preload: None,
            nav_started: false,
            committed: false,
            programmatic: false,
        }
    }
}

/// An attached `WebContentsView`'s place in its window.
pub struct ViewEntry {
    pub view_id: u64,
    pub wc_id: u64,
    pub win_id: Option<u64>,
    pub bounds: (i32, i32, i32, i32),
    pub visible: bool,
}

#[derive(Clone, Default)]
#[cfg_attr(
    not(windows),
    allow(
        dead_code,
        reason = "only the Windows caption buttons read the overlay"
    )
)]
pub struct Overlay {
    pub color: String,
    pub symbol_color: String,
    pub height: i32,
}

pub struct WinEntry {
    pub id: u64,
    pub wc_id: u64,
    pub window: Option<Window>,
    pub container: Option<Panel>,
    pub offscreen: bool,
    /// Options `win.create` carried that later code reads.
    pub options: Value,
    pub overlay: Option<Overlay>,
    pub caption: isize,
    pub title: String,
    pub min_size: (i32, i32),
    pub max_size: (i32, i32),
    pub opacity: f64,
    /// Node already ran the `close` listeners (or the app is exiting): the window may close.
    pub close_approved: bool,
    pub close_pending: bool,
    pub destroyed: bool,
    pub views: Vec<u64>,
    /// The page of this window (its own or a Preview view) that last took keyboard focus: edit commands of the
    /// application menu act on it, as Electron's roles act on the focused webContents.
    pub focused_wc: Option<u64>,
    pub sent_state: Option<Value>,
    /// `setFocusable(false)` on a platform with no window flag for it (macOS): the window never reports focus and `show`
    /// does not activate it.
    pub no_focus: bool,
}

impl WinEntry {
    pub fn new(id: u64, wc_id: u64, options: Value) -> Self {
        Self {
            id,
            wc_id,
            window: None,
            container: None,
            offscreen: false,
            options,
            overlay: None,
            caption: 0,
            title: String::new(),
            min_size: (0, 0),
            max_size: (0, 0),
            opacity: 1.0,
            close_approved: false,
            close_pending: false,
            destroyed: false,
            views: Vec::new(),
            focused_wc: None,
            sent_state: None,
            no_focus: false,
        }
    }
}

#[derive(Default)]
pub struct Ui {
    pub windows: HashMap<u64, Rc<RefCell<WinEntry>>>,
    pub wcs: HashMap<u64, Rc<RefCell<WcEntry>>>,
    pub views: HashMap<u64, Rc<RefCell<ViewEntry>>>,
    /// Request contexts by partition name; the app session is the global context and is not in here.
    pub contexts: HashMap<String, RequestContext>,
    /// Browsers alive (page, views, offscreen): the message loop quits when this reaches 0 while exiting.
    pub browsers: usize,
    pub exiting: bool,
}

thread_local! {
    static UI: RefCell<Ui> = RefCell::new(Ui::default());
}

/// The UI-thread registry. Never hold the borrow across a call into CEF that can call back into a handler.
pub fn ui_state<R>(f: impl FnOnce(&mut Ui) -> R) -> R {
    UI.with(|u| f(&mut u.borrow_mut()))
}

pub fn wc(id: u64) -> Option<Rc<RefCell<WcEntry>>> {
    ui_state(|u| u.wcs.get(&id).cloned())
}

/// The OS window handle as an integer: Windows' `HWND` is a struct around the pointer, macOS' `NSView*` is the pointer.
pub fn native_handle(window: &cef::Window) -> isize {
    #[cfg(windows)]
    return window.window_handle().0 as isize;
    #[cfg(not(windows))]
    return window.window_handle() as isize;
}

pub fn win(id: u64) -> Option<Rc<RefCell<WinEntry>>> {
    ui_state(|u| u.windows.get(&id).cloned())
}

pub fn view(id: u64) -> Option<Rc<RefCell<ViewEntry>>> {
    ui_state(|u| u.views.get(&id).cloned())
}

/// The window whose OS handle is `hwnd` (a caption click names its owner by handle).
#[cfg(windows)]
pub fn win_by_handle(handle: isize) -> Option<u64> {
    ui_state(|u| {
        u.windows.values().find_map(|w| {
            let w = w.borrow();
            let h = native_handle(w.window.as_ref()?);
            (h == handle).then_some(w.id)
        })
    })
}

pub fn rect_json(x: i32, y: i32, w: i32, h: i32) -> Value {
    json!({ "x": x, "y": y, "width": w, "height": h })
}
