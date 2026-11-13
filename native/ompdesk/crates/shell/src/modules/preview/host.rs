//! The Preview's hosts: per owner (an app window's renderer, or a paired viewer) a set of tabs, each a sandboxed page in
//! one of the owner's two in-memory partitions, the shown tab, the panel's layout and the agent's link. Everything here
//! runs on the UI thread and is `src/main/preview/host.ts`'s behaviour (the TypeScript this replaced): which addresses
//! a page may show, what a popup, a download or a console error becomes, how the shown page is placed and zoomed, and
//! what Node is told after each change (`preview.state`).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Instant;

use serde::Serialize;
use serde_json::{Value, json};
use shell_core::preview_core::dialog::DIALOG_PRELOAD_SOURCE;
use shell_core::preview_core::js;
use shell_core::preview_core::languages::accept_languages;
use shell_core::preview_core::layout::{self, Bounds, MIN_FRAME_SCALE, Placement};
use shell_core::preview_core::pacer::stream_profile;
use shell_core::preview_core::page_tools::{self, PAGE_WORLD};
use shell_core::preview_core::stream::StreamGeometry;
use shell_core::preview_core::urls::{
    is_loopback_url, parse_visual_url, pdf_name, preview_url, visual_may_navigate,
};
use shell_core::preview_core::visuals::VisualView;

use super::{ctx, page as cef_page, relay, scheme, stream, visualize};
use crate::host::Call;
use crate::log::log;
use crate::{cdp, session, state};

/// Tabs one owner's preview may hold; a page's popups beyond it are dropped.
const TAB_LIMIT: usize = 10;
/// Console problems kept per page, and the longest message kept per problem.
const PROBLEM_LIMIT: usize = 50;
const PROBLEM_TEXT_MAX: usize = 2000;
/// Console problems reach the panel at most this often.
const PROBLEMS_PUBLISH_MS: i64 = 250;
/// A `data-choice` click counts for the agent only after a real mouse or key release on that page this recently (C143).
pub(super) const GESTURE_WINDOW_MS: u64 = 1000;
/// Widest region screenshot sent to the agent, in pixels.
const REGION_MAX_WIDTH: f64 = 1600.0;
/// The widest or tallest an offscreen page's window is made, in DIPs.
const MAX_STREAM_DIP: f64 = 4096.0;
/// A new offscreen page's window, before its panel's first layout (a phone-sized frame).
const DEFAULT_STREAM_SIZE: (i32, i32) = (390, 844);
/// The offscreen browsers' device scale factor (`screen_info`): the DIPs of their window are their pixels.
const HOST_SCALE: f64 = 1.0;

// ------------------------------------------------------------------ the shape of the panel's state

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Session {
    Web,
    Visual,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Viewport {
    Fill,
    Phone,
    Tablet,
    Laptop,
}

impl Viewport {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "fill" => Self::Fill,
            "phone" => Self::Phone,
            "tablet" => Self::Tablet,
            "laptop" => Self::Laptop,
            _ => return None,
        })
    }

    /// The frame's size in CSS px; `fill` uses the whole panel.
    fn size(self) -> Option<(f64, f64)> {
        match self {
            Self::Fill => None,
            Self::Phone => Some((390.0, 844.0)),
            Self::Tablet => Some((768.0, 1024.0)),
            Self::Laptop => Some((1366.0, 768.0)),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentState {
    pub(super) tab_id: String,
    pub(super) attached: bool,
    pub(super) last_action: String,
}

/// A console error or warning the page logged.
#[derive(Clone, Serialize)]
pub(super) struct Problem {
    pub(super) level: String,
    pub(super) message: String,
    pub(super) source: String,
    pub(super) line: u64,
}

/// Something the page asked for that the Preview does not do itself (data: the panel words it).
#[derive(Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum Notice {
    Download { url: String, filename: String },
    Link { url: String },
    Unresponsive,
    Check { problem: String },
}

/// `PreviewPageState`: what one tab's page reports.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PageState {
    pub(super) url: String,
    pub(super) title: String,
    pub(super) loading: bool,
    pub(super) can_go_back: bool,
    pub(super) can_go_forward: bool,
    pub(super) error: Option<String>,
    pub(super) crashed: bool,
    pub(super) agent: Option<AgentState>,
    pub(super) zoom: f64,
    viewport: Viewport,
    pub(super) problems: Vec<Problem>,
    pub(super) notice: Option<Notice>,
    pub(super) visual: Option<VisualView>,
    pub(super) session: Session,
}

impl PageState {
    fn empty(session: Session) -> Self {
        Self {
            url: String::new(),
            title: String::new(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            error: None,
            crashed: false,
            agent: None,
            zoom: 1.0,
            viewport: Viewport::Fill,
            problems: Vec::new(),
            notice: None,
            visual: None,
            session,
        }
    }
}

/// `EMPTY_PREVIEW`.
fn empty_preview() -> Value {
    let mut state = serde_json::to_value(PageState::empty(Session::Web)).unwrap_or(Value::Null);
    state["tabs"] = json!([]);
    state["activeTab"] = json!("");
    state
}

// ------------------------------------------------------------------ hosts and pages

pub(super) type PageRef = Rc<RefCell<Page>>;
pub(super) type HostRef = Rc<RefCell<Host>>;

/// One tab: its own page in the owner's web or visual partition.
pub(super) struct Page {
    pub(super) id: String,
    pub(super) wc_id: u64,
    /// The page's native view in the app window; none for a viewer's offscreen page.
    pub(super) view_id: Option<u64>,
    /// The key of the host this page belongs to.
    owner: i64,
    pub(super) state: PageState,
    /// Zoom factor last given to the page (user zoom × frame fit).
    factor: f64,
    /// The agent's visual this page shows (`gui_visualize`) and its version.
    pub(super) visual: Option<(String, u64)>,
    /// When the user last released a mouse button or key on this page (epoch ms; the C143 gesture).
    pub(super) last_input: u64,
    /// A viewer's frames, acknowledgements, dialogs and input; none for a view.
    pub(super) stream: Option<stream::Stream>,
    problems_pending: bool,
    /// `choose` calls waiting for this page's document to finish loading.
    pub(super) choosers: Vec<u64>,
}

/// The panel's last surface box, kept to re-fit the page when the viewport frame or the tab changes.
#[derive(Clone)]
pub(super) struct Layout {
    pub(super) bounds: Bounds,
    pub(super) visible: bool,
    dpr: f64,
}

/// An owner's two in-memory partitions (`preview-<winId>` and `preview-visual-<winId>` for a window, `preview-web-<key>`
/// and `preview-visual-web-<key>` for a viewer), shared by its tabs.
#[derive(Clone)]
struct Sessions {
    web: String,
    visual: String,
    /// Why the visual partition's route (a dead proxy) could not be set: no visual loads in it then.
    failure: Option<String>,
}

pub(super) struct Host {
    pub(super) key: i64,
    /// The app window the pages are views of; none for a viewer (its pages are offscreen and streamed).
    pub(super) win_id: Option<u64>,
    /// The owner as Node sent it, for every event about this host.
    pub(super) owner: Value,
    /// Whether the owner's active tab runs on a paired host: its loopback addresses stay blocked.
    pub(super) remote: bool,
    sessions: Sessions,
    pub(super) pages: Vec<PageRef>,
    pub(super) active: u64,
    pub(super) agent: Option<relay::Agent>,
    pub(super) layout: Option<Layout>,
    /// Frame numbers of a viewer's streams share one counter, so an acknowledgement never names another page's frame.
    frames: Rc<Cell<u64>>,
}

thread_local! {
    static HOSTS: RefCell<Vec<HostRef>> = const { RefCell::new(Vec::new()) };
    static PAGES: RefCell<HashMap<u64, PageRef>> = RefCell::new(HashMap::new());
}

pub(super) fn hosts() -> Vec<HostRef> {
    HOSTS.with(|h| h.borrow().clone())
}

pub(super) fn host(key: i64) -> Option<HostRef> {
    HOSTS.with(|h| {
        h.borrow()
            .iter()
            .find(|host| host.borrow().key == key)
            .cloned()
    })
}

pub(super) fn page(wc_id: u64) -> Option<PageRef> {
    PAGES.with(|p| p.borrow().get(&wc_id).cloned())
}

pub(super) fn host_of(page: &PageRef) -> Option<HostRef> {
    let key = page.borrow().owner;
    host(key)
}

pub(super) fn active_page(host: &HostRef) -> PageRef {
    let h = host.borrow();
    h.pages
        .iter()
        .find(|p| p.borrow().wc_id == h.active)
        .or_else(|| h.pages.first())
        .cloned()
        .expect("a preview host always has a page")
}

/// Runs `f` on the page's stream (viewer pages only); `f` must not call back into the module.
pub(super) fn with_stream<R>(wc_id: u64, f: impl FnOnce(&mut stream::Stream) -> R) -> Option<R> {
    let page = page(wc_id)?;
    let mut p = page.borrow_mut();
    p.stream.as_mut().map(f)
}

/// The viewer's shown page, when it is streamed.
pub(super) fn streamed_page(key: i64) -> Option<PageRef> {
    let page = active_page(&host(key)?);
    let streamed = page.borrow().stream.is_some();
    streamed.then_some(page)
}

// ------------------------------------------------------------------ small helpers

/// `Date.now()`.
pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A monotonic clock in ms (the stream's and the agent's marks).
pub(super) fn clock_ms() -> f64 {
    static START: LazyLock<Instant> = LazyLock::new(Instant::now);
    START.elapsed().as_secs_f64() * 1000.0
}

pub(super) fn uuid() -> String {
    let mut bytes = [0u8; 16];
    // A system without randomness gets a clock-derived id: tab ids only need to differ within one preview.
    if getrandom::fill(&mut bytes).is_err() {
        bytes = ((u128::from(now_ms()) << 20) | u128::from(clock_ms() as u64)).to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Who a call is for.
pub(super) struct Owner {
    pub(super) key: i64,
    pub(super) win_id: Option<u64>,
}

pub(super) fn owner_of(params: &Value) -> Option<Owner> {
    let owner = params.get("owner")?;
    Some(Owner {
        key: owner.get("key")?.as_i64()?,
        win_id: owner.get("winId").and_then(Value::as_u64),
    })
}

fn visual_view(id: &str, version: u64) -> Option<VisualView> {
    scheme::store().view(id, Some(version))
}

// ------------------------------------------------------------------ what Node is told

/// The shown page's state plus the tab strip.
fn window_state(host: &HostRef) -> Value {
    let active = active_page(host);
    let mut state = serde_json::to_value(&active.borrow().state).unwrap_or(Value::Null);
    let h = host.borrow();
    let tabs: Vec<Value> = h
        .pages
        .iter()
        .map(|page| {
            let p = page.borrow();
            let title = if p.state.title.is_empty() {
                p.state.visual.as_ref().map(|v| v.label.clone()).unwrap_or_default()
            } else {
                p.state.title.clone()
            };
            let mut tab = json!({ "id": p.id, "title": title, "url": p.state.url, "loading": p.state.loading });
            if let Some((id, _)) = &p.visual {
                tab["visual"] = json!(id);
            }
            tab
        })
        .collect();
    state["tabs"] = Value::Array(tabs);
    state["activeTab"] = json!(active.borrow().id);
    state
}

/// `preview.state`: the panel's state after a change.
pub(super) fn send(host: &HostRef) {
    if host.borrow().pages.is_empty() {
        return;
    }
    let owner = host.borrow().owner.clone();
    ctx().emit(
        "state",
        json!({ "owner": owner, "state": window_state(host) }),
    );
}

/// The page's state refreshed from its browser, then `patch`, then sent.
pub(super) fn publish(host: &HostRef, page: &PageRef, patch: impl FnOnce(&mut PageState)) {
    let wc_id = page.borrow().wc_id;
    let Some(entry) = state::wc(wc_id) else {
        return;
    };
    let (url, title, loading, back, forward) = {
        let e = entry.borrow();
        (
            e.state.url.clone(),
            e.state.title.clone(),
            e.state.loading,
            e.state.can_go_back,
            e.state.can_go_forward,
        )
    };
    let visual = page
        .borrow()
        .visual
        .clone()
        .and_then(|(id, version)| visual_view(&id, version));
    {
        let mut p = page.borrow_mut();
        let s = &mut p.state;
        if !url.is_empty() {
            s.url = url;
        }
        s.title = title;
        s.loading = loading;
        s.can_go_back = back;
        s.can_go_forward = forward;
        s.visual = visual;
        patch(s);
    }
    send(host);
}

// ------------------------------------------------------------------ layout

/// Size the shown page to the panel and its frame, zoom it, and hide every other tab.
fn place(host: &HostRef) {
    let (layout, win_id) = {
        let h = host.borrow();
        (h.layout.clone(), h.win_id)
    };
    let Some(layout) = layout else { return };
    match win_id {
        None => place_streamed(host, &layout),
        Some(win_id) => place_view(host, &layout, win_id),
    }
}

fn place_view(host: &HostRef, layout: &Layout, win_id: u64) {
    let (window_width, window_height) = cef_page::window_content_size(win_id);
    let active = active_page(host);
    let others: Vec<PageRef> = {
        let h = host.borrow();
        h.pages
            .iter()
            .filter(|p| p.borrow().wc_id != h.active)
            .cloned()
            .collect()
    };
    for other in others {
        if let Some(view_id) = other.borrow().view_id {
            cef_page::set_view_visible(view_id, false);
        }
    }
    let (wc_id, view_id, viewport, zoom) = {
        let p = active.borrow();
        (p.wc_id, p.view_id, p.state.viewport, p.state.zoom)
    };
    let Some(view_id) = view_id else { return };
    let (fitted, scale) = layout::fit_frame(layout.bounds, viewport.size());
    match layout::place_view(fitted, layout.visible, window_width, window_height) {
        Placement::Hidden => cef_page::set_view_visible(view_id, false),
        Placement::Placed { rect, visible } => {
            cef_page::place_view(
                view_id,
                Some((rect.x, rect.y, rect.width, rect.height)),
                visible,
            );
        }
    }
    apply_zoom(&active, wc_id, js::max(MIN_FRAME_SCALE, zoom * scale));
}

fn apply_zoom(page: &PageRef, wc_id: u64, factor: f64) {
    let changed = {
        let mut p = page.borrow_mut();
        let changed = factor != p.factor;
        p.factor = factor;
        changed
    };
    if changed || cef_page::zoom_factor(wc_id) != factor {
        cef_page::set_zoom_factor(wc_id, factor);
    }
}

/// A viewer's shown page: its offscreen window is the frame's size times `profile.dpr / screen scale` and zoomed by the
/// same, so a frame pixel is a phone pixel whatever the host screen's density is.
fn place_streamed(host: &HostRef, layout: &Layout) {
    let active = active_page(host);
    let wc_id = active.borrow().wc_id;
    let others: Vec<u64> = {
        let h = host.borrow();
        h.pages
            .iter()
            .map(|p| p.borrow().wc_id)
            .filter(|id| *id != h.active)
            .collect()
    };
    for other in others {
        stream::set_visible(other, false);
    }
    let (viewport, zoom) = {
        let p = active.borrow();
        (p.state.viewport, p.state.zoom)
    };
    let (fitted, fit_scale) = layout::fit_frame(layout.bounds, viewport.size());
    let profile = stream_profile(fitted.width, layout.dpr);
    let scale = profile.dpr / js::max(0.5, HOST_SCALE);
    let width = js::max(
        1.0,
        js::min(MAX_STREAM_DIP, js::round(fitted.width * scale)),
    ) as i32;
    let height = js::max(
        1.0,
        js::min(MAX_STREAM_DIP, js::round(fitted.height * scale)),
    ) as i32;
    if cef_page::offscreen_size(wc_id) != (width, height) {
        cef_page::set_offscreen_size(wc_id, width, height);
    }
    with_stream(wc_id, |s| s.scale = scale);
    apply_zoom(
        &active,
        wc_id,
        js::max(MIN_FRAME_SCALE, zoom * fit_scale) * scale,
    );
    stream::configure(
        wc_id,
        StreamGeometry {
            rect: Bounds {
                x: fitted.x - layout.bounds.x,
                y: fitted.y - layout.bounds.y,
                width: fitted.width,
                height: fitted.height,
            },
            pixel_width: js::round(fitted.width * profile.dpr),
            profile,
        },
    );
    stream::set_visible(
        wc_id,
        layout.visible && fitted.width > 0.0 && fitted.height > 0.0,
    );
}

/// The viewer's pinch: its page's zoom is multiplied by `scale`.
pub(super) fn pinch(wc_id: u64, scale: f64) {
    let (Some(page), true) = (page(wc_id), cef_page::exists(wc_id)) else {
        return;
    };
    let Some(host) = host_of(&page) else { return };
    {
        let mut p = page.borrow_mut();
        p.state.zoom = layout::clamp_zoom(p.state.zoom * scale);
    }
    place(&host);
    publish(&host, &page, |_| {});
}

// ------------------------------------------------------------------ addresses

/// The web address a web page may show, or None: http(s) only, and no loopback for a paired host's tab.
fn allowed(host: &HostRef, url: &str) -> Option<String> {
    let remote = host.borrow().remote;
    preview_url(url).filter(|safe| !(remote && is_loopback_url(safe)))
}

/// A web address a visual's page tried to reach. It never goes there; right after the user's own click or key on the
/// page (the C143 gesture window) the panel offers the whole address to open in a new web tab.
fn offer_link(host: &HostRef, page: &PageRef, url: &str) {
    let Some(safe) = allowed(host, url) else {
        return;
    };
    if now_ms().saturating_sub(page.borrow().last_input) <= GESTURE_WINDOW_MS {
        publish(host, page, move |s| {
            s.notice = Some(Notice::Link { url: safe })
        });
    }
}

// ------------------------------------------------------------------ partitions

/// The visual partition's only route out: a proxy at loopback port 1 (tcpmux, which nothing serves on a desktop),
/// loopback included (`<-loopback>` drops Chromium's implicit loopback bypass), with no direct fallback. Its pages load
/// from `omp-visual:` (no network) and CSP blocks their requests; this catches what CSP cannot, WebRTC over TCP (TURN),
/// which goes through the session's proxy.
fn visual_no_route() -> Value {
    json!({ "mode": "fixed_servers", "proxyRules": "http://127.0.0.1:1", "proxyBypassRules": "<-loopback>" })
}

/// The owner's two partitions, set up before any page of them exists.
fn sessions_of(owner: &Owner) -> Result<Sessions, String> {
    let viewer = owner.win_id.is_none();
    let label = owner.win_id.map_or_else(
        || format!("web-{}", owner.key.unsigned_abs()),
        |win| win.to_string(),
    );
    let web = format!("preview-{label}");
    let visual = format!("preview-visual-{label}");
    let (Some(_), Some(visual_context)) =
        (session::context_for(&web), session::context_for(&visual))
    else {
        return Err("No preview surface".to_owned());
    };
    // A viewer's pages get the dialog shim and nothing else.
    if viewer {
        for partition in [&web, &visual] {
            session::register_preload(
                partition,
                "preview-dialog".to_owned(),
                DIALOG_PRELOAD_SOURCE.to_owned(),
            );
        }
    }
    // Pages see the user's languages, not the en-US the packaged locales leave Chromium.
    let languages = state::PREFERRED_LANGUAGES
        .get()
        .map(|l| accept_languages(l))
        .filter(|l| !l.is_empty());
    session::set_user_agent(&web, session::default_user_agent(), languages);
    // Visual pages (C135): only the files the store resolves for that visual, never cached across versions.
    let failure = scheme::register(&visual_context)
        .and_then(|()| session::set_proxy(&visual, &visual_no_route()))
        .err();
    if let Some(reason) = &failure {
        log(
            "preview.visual_session_failed",
            json!({ "partition": visual, "reason": reason }),
        );
    }
    Ok(Sessions {
        web,
        visual,
        failure,
    })
}

// ------------------------------------------------------------------ pages

/// A sandboxed page in one of the owner's partitions: a view in the owner's window, or (a viewer's) an offscreen
/// browser whose paints stream to the viewer.
fn create_page(
    key: i64,
    win_id: Option<u64>,
    sessions: &Sessions,
    kind: Session,
    frames: &Rc<Cell<u64>>,
) -> Result<PageRef, String> {
    let partition = match kind {
        Session::Web => &sessions.web,
        Session::Visual => &sessions.visual,
    };
    let (wc_id, view_id) = cef_page::create(
        partition,
        win_id,
        DEFAULT_STREAM_SIZE.0,
        DEFAULT_STREAM_SIZE.1,
    )
    .ok_or_else(|| "No preview surface".to_owned())?;
    // WebRTC is no CSP directive: over UDP (STUN, TURN) it would leave a visual's page directly; over TCP it takes the
    // visual partition's dead proxy.
    if kind == Session::Visual {
        cef_page::disable_non_proxied_udp(wc_id);
    }
    let id = uuid();
    let (stream, effects) = match win_id {
        Some(_) => (None, Vec::new()),
        None => {
            let (stream, effects) = stream::create(&id, frames);
            (Some(stream), effects)
        }
    };
    let page = Rc::new(RefCell::new(Page {
        id,
        wc_id,
        view_id,
        owner: key,
        state: PageState::empty(kind),
        factor: 1.0,
        visual: None,
        last_input: 0,
        stream,
        problems_pending: false,
        choosers: Vec::new(),
    }));
    PAGES.with(|p| p.borrow_mut().insert(wc_id, page.clone()));
    stream::run(wc_id, effects);
    Ok(page)
}

fn make_page(host: &HostRef, kind: Session) -> Result<PageRef, String> {
    let (key, win_id, sessions, frames) = {
        let h = host.borrow();
        (h.key, h.win_id, h.sessions.clone(), h.frames.clone())
    };
    create_page(key, win_id, &sessions, kind, &frames)
}

fn open_page(host: &HostRef, kind: Session, show: bool) -> Result<PageRef, String> {
    let page = make_page(host, kind)?;
    host.borrow_mut().pages.push(page.clone());
    if show {
        select(host, &page);
    } else {
        send(host);
    }
    Ok(page)
}

fn select(host: &HostRef, page: &PageRef) {
    let wc_id = page.borrow().wc_id;
    let (stop_agent, previous) = {
        let h = host.borrow();
        (h.agent.as_ref().is_some_and(|a| a.page != wc_id), h.active)
    };
    if stop_agent {
        relay::stop(host);
    }
    // A viewer's poll held on the page it leaves must not keep the next one waiting.
    if previous != wc_id {
        stream::release(previous);
    }
    host.borrow_mut().active = wc_id;
    place(host);
    stream::refresh(wc_id);
    send(host);
}

fn close_page(host: &HostRef, page: &PageRef) {
    let wc_id = page.borrow().wc_id;
    if host
        .borrow()
        .agent
        .as_ref()
        .is_some_and(|a| a.page == wc_id)
    {
        relay::stop(host);
    }
    stream::dispose(wc_id);
    PAGES.with(|p| p.borrow_mut().remove(&wc_id));
    cef_page::end_runs(wc_id);
    visualize::page_gone(wc_id);
    cef_page::close(wc_id);
}

/// Close one tab; closing the last leaves a fresh empty one.
pub(super) fn remove_page(host: &HostRef, target: &PageRef) {
    let Some(index) = host
        .borrow()
        .pages
        .iter()
        .position(|p| Rc::ptr_eq(p, target))
    else {
        return;
    };
    close_page(host, target);
    host.borrow_mut().pages.remove(index);
    let (empty, was_active, next) = {
        let h = host.borrow();
        let next = h
            .pages
            .get(index.min(h.pages.len().saturating_sub(1)))
            .cloned();
        (h.pages.is_empty(), target.borrow().wc_id == h.active, next)
    };
    if empty {
        if let Err(message) = open_page(host, Session::Web, true) {
            log("preview.page_failed", json!({ "message": message }));
        }
    } else if was_active {
        if let Some(next) = next {
            select(host, &next);
        }
    } else {
        send(host);
    }
}

/// Put a new page of session `kind` in `old`'s place (shown if `old` was), and close `old`.
fn replace_page(host: &HostRef, old: &PageRef, kind: Session) -> Result<PageRef, String> {
    let page = make_page(host, kind)?;
    {
        let mut h = host.borrow_mut();
        if let Some(index) = h.pages.iter().position(|p| Rc::ptr_eq(p, old)) {
            h.pages[index] = page.clone();
        }
    }
    close_page(host, old);
    if host.borrow().active == old.borrow().wc_id {
        select(host, &page);
    } else {
        send(host);
    }
    Ok(page)
}

fn load_into(host: &HostRef, page: &PageRef, url: &str) {
    let wc_id = page.borrow().wc_id;
    let visual = page
        .borrow()
        .visual
        .clone()
        .and_then(|(id, version)| visual_view(&id, version));
    {
        let mut p = page.borrow_mut();
        let s = &mut p.state;
        s.url = url.to_owned();
        s.title = String::new();
        s.loading = true;
        s.error = None;
        s.visual = visual;
    }
    send(host);
    cef_page::load(wc_id, url);
}

/// Show version `version` of `visual_id` in `page`, which must be of the visual's session.
fn load_visual(
    host: &HostRef,
    page: &PageRef,
    visual_id: &str,
    version: Option<u64>,
) -> Result<(), String> {
    let (shown, url) = {
        let store = scheme::store();
        let shown = store.view(visual_id, version).map(|v| v.version);
        (shown, shown.and_then(|v| store.url(visual_id, Some(v))))
    };
    let (Some(shown), Some(url)) = (shown, url) else {
        return Err("Unknown visual".to_owned());
    };
    let kind = if parse_visual_url(&url).is_some() {
        Session::Visual
    } else {
        Session::Web
    };
    if page.borrow().state.session != kind {
        return Err("Visual in the wrong session".to_owned());
    }
    page.borrow_mut().visual = Some((visual_id.to_owned(), shown));
    load_into(host, page, &url);
    Ok(())
}

/// Show `visual_id` (`version`, default latest) in the tab that shows it, else in an empty shown tab (only when `show`),
/// else in a new tab; at the tab limit it replaces the shown page when `show` and is skipped otherwise. A tab already on
/// that version keeps its page (and the user's tweaks). A file or inline visual needs a page of the visual session and a
/// web visual one of the web session: a tab of the other kind is replaced, never reused, so no page ever holds both.
fn show_visual(
    host: &HostRef,
    visual_id: &str,
    version: Option<u64>,
    show: bool,
) -> Result<(), String> {
    let (wanted, url) = {
        let store = scheme::store();
        let wanted = store.view(visual_id, version).map(|v| v.version);
        (wanted, wanted.and_then(|w| store.url(visual_id, Some(w))))
    };
    let (Some(wanted), Some(url)) = (wanted, url) else {
        return Ok(());
    };
    let kind = if parse_visual_url(&url).is_some() {
        Session::Visual
    } else {
        Session::Web
    };
    let in_session = |page: PageRef| -> Result<PageRef, String> {
        if page.borrow().state.session == kind {
            Ok(page)
        } else {
            replace_page(host, &page, kind)
        }
    };
    let shown = host
        .borrow()
        .pages
        .iter()
        .find(|p| {
            p.borrow()
                .visual
                .as_ref()
                .is_some_and(|(id, _)| id == visual_id)
        })
        .cloned();
    let active = active_page(host);
    let active_empty = {
        let p = active.borrow();
        p.state.url.is_empty() && p.visual.is_none()
    };
    let target = if let Some(shown) = shown {
        in_session(shown)?
    } else if show && active_empty {
        in_session(active)?
    } else if host.borrow().pages.len() < TAB_LIMIT {
        open_page(host, kind, false)?
    } else if show {
        in_session(active)?
    } else {
        return Ok(());
    };
    if target.borrow().visual != Some((visual_id.to_owned(), wanted)) {
        load_visual(host, &target, visual_id, Some(wanted))?;
    }
    if show {
        select(host, &target);
    }
    Ok(())
}

// ------------------------------------------------------------------ hosts

fn create_host(owner: &Owner, raw_owner: &Value, remote: bool) -> Result<HostRef, String> {
    if owner.win_id.is_some_and(|win| state::win(win).is_none()) {
        return Err("Invalid preview owner".to_owned());
    }
    let sessions = sessions_of(owner)?;
    let frames = Rc::new(Cell::new(0));
    let first = match create_page(owner.key, owner.win_id, &sessions, Session::Web, &frames) {
        Ok(first) => first,
        Err(message) => {
            session::forget(&sessions.web);
            session::forget(&sessions.visual);
            return Err(message);
        }
    };
    let active = first.borrow().wc_id;
    let host = Rc::new(RefCell::new(Host {
        key: owner.key,
        win_id: owner.win_id,
        owner: raw_owner.clone(),
        remote,
        sessions,
        pages: vec![first],
        active,
        agent: None,
        layout: None,
        frames,
    }));
    HOSTS.with(|h| h.borrow_mut().push(host.clone()));
    Ok(host)
}

fn ensure_host(call: &Call, remote: bool) -> Result<HostRef, String> {
    let Some(owner) = owner_of(&call.params) else {
        return Err("Invalid preview owner".to_owned());
    };
    let host = match host(owner.key) {
        Some(host) => host,
        None => {
            let raw = call.params.get("owner").cloned().unwrap_or(Value::Null);
            create_host(&owner, &raw, remote)?
        }
    };
    host.borrow_mut().remote = remote;
    Ok(host)
}

/// The owner's window closed, its renderer loaded another document, or the viewer went: its pages close, and what they
/// browsed goes with them (the partitions are let go: CEF frees an in-memory profile with its last page).
fn dispose_host(host: &HostRef) {
    // First out of the list: nothing that runs while its pages close may find a host without pages.
    let key = host.borrow().key;
    HOSTS.with(|h| h.borrow_mut().retain(|other| other.borrow().key != key));
    relay::stop(host);
    let pages = std::mem::take(&mut host.borrow_mut().pages);
    for page in &pages {
        close_page(host, page);
    }
    let (web, visual) = {
        let h = host.borrow();
        (h.sessions.web.clone(), h.sessions.visual.clone())
    };
    session::forget(&web);
    session::forget(&visual);
}

pub(super) fn shutdown() {
    for host in hosts() {
        dispose_host(&host);
    }
}

// ------------------------------------------------------------------ requests

pub(super) fn request(call: Call) {
    let name = call
        .method
        .strip_prefix("preview.")
        .unwrap_or_default()
        .to_owned();
    match name.as_str() {
        "command" => command(call),
        "agentStart" => agent_start(call),
        "agentReady" => agent_ready(call),
        "page" => page_tool(call),
        "pdfName" => pdf_file_name(call),
        "pdf" => pdf(call),
        "visuals" => call.ok(json!(scheme::store().list())),
        "poll" => stream::poll(call),
        "dialogAnswer" => stream::answer_dialog(call),
        "copy" => stream::copy(call),
        "visualize" => visualize::run(call),
        _ => call.unsupported(),
    }
}

pub(super) fn post(name: &str, data: Value) {
    let name = name.strip_prefix("preview.").unwrap_or(name);
    let Some(owner) = owner_of(&data) else {
        return log("preview.event_ignored", json!({ "event": name }));
    };
    match name {
        "relayIn" => {
            if let (Some(host), Some(frame)) =
                (host(owner.key), data.get("data").and_then(Value::as_str))
            {
                relay::incoming(&host, frame);
            }
        }
        "relayClosed" => {
            if let Some(host) = host(owner.key) {
                relay::stop(&host);
            }
        }
        "ownerGone" => {
            if let Some(host) = host(owner.key) {
                dispose_host(&host);
            }
        }
        "input" => stream::input(owner.key, data.get("events").unwrap_or(&Value::Null)),
        _ => log("preview.event_ignored", json!({ "event": name })),
    }
}

fn command(call: Call) {
    let request = call.params.get("request").cloned().unwrap_or(Value::Null);
    let remote = call
        .params
        .get("remote")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if text_of(&request, "action") == "dispose" {
        if let Some(host) = owner_of(&call.params).and_then(|o| host(o.key)) {
            dispose_host(&host);
        }
        return call.ok(empty_preview());
    }
    let host = match ensure_host(&call, remote) {
        Ok(host) => host,
        Err(message) => return call.err("failed", message),
    };
    match run_command(&host, &request) {
        Ok(()) => call.ok(window_state(&host)),
        Err(message) => call.err("failed", message),
    }
}

fn run_command(host: &HostRef, request: &Value) -> Result<(), String> {
    let action = text_of(request, "action");
    let page = active_page(host);
    let wc_id = page.borrow().wc_id;
    match action.as_str() {
        "agentStop" => relay::stop(host),
        "newTab" => {
            if host.borrow().pages.len() >= TAB_LIMIT {
                return Err("Too many preview tabs".to_owned());
            }
            let url = match request.get("url").and_then(Value::as_str) {
                None => None,
                Some(url) => Some(allowed(host, url).ok_or("Preview URL unavailable")?),
            };
            let opened = open_page(host, Session::Web, true)?;
            if let Some(url) = url {
                load_into(host, &opened, &url);
            }
        }
        "selectTab" | "closeTab" => {
            let id = text_of(request, "id");
            let target = host
                .borrow()
                .pages
                .iter()
                .find(|p| p.borrow().id == id)
                .cloned();
            let target = target.ok_or("Unknown preview tab")?;
            if action == "selectTab" {
                select(host, &target);
            } else {
                remove_page(host, &target);
            }
        }
        "showVisual" | "openVisual" | "restoreVisuals" => {
            if host.borrow().remote {
                return Err("Visuals are for tabs on this computer".to_owned());
            }
            let tab = text_of(request, "tabId");
            let visual = text_of(request, "visualId");
            if action == "openVisual" && !scheme::store().add_to_tab(&tab, &visual) {
                return Err("Unknown visual".to_owned());
            }
            if let Some(failure) = host.borrow().sessions.failure.clone() {
                return Err(failure);
            }
            let own = scheme::store().for_tab(&tab);
            if action == "restoreVisuals" {
                let show = request
                    .get("show")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                for (index, id) in own.iter().enumerate() {
                    show_visual(host, id, None, show && index == 0)?;
                }
            } else {
                if !own.contains(&visual) {
                    return Err("Unknown visual".to_owned());
                }
                let version = request
                    .get("version")
                    .and_then(Value::as_u64)
                    .filter(|_| action == "showVisual");
                show_visual(host, &visual, version, true)?;
            }
        }
        "layout" => {
            let number = |key: &str| {
                request
                    .get("bounds")
                    .and_then(|b| b.get(key))
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN)
            };
            let dpr = match request.get("dpr").and_then(Value::as_f64) {
                Some(dpr) if dpr.is_finite() => js::clamp(dpr, 0.5, 4.0),
                _ => 1.0,
            };
            host.borrow_mut().layout = Some(Layout {
                bounds: Bounds {
                    x: number("x"),
                    y: number("y"),
                    width: number("width"),
                    height: number("height"),
                },
                visible: request
                    .get("visible")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                dpr,
            });
            place(host);
        }
        "zoom" => {
            let zoom = layout::clamp_zoom(
                request
                    .get("zoom")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN),
            );
            page.borrow_mut().state.zoom = zoom;
            place(host);
            publish(host, &page, |_| {});
        }
        "viewport" => {
            let viewport =
                Viewport::parse(&text_of(request, "viewport")).ok_or("Unknown preview viewport")?;
            page.borrow_mut().state.viewport = viewport;
            place(host);
            publish(host, &page, |_| {});
        }
        "clearProblems" => publish(host, &page, |s| s.problems.clear()),
        "dismissNotice" => publish(host, &page, |s| s.notice = None),
        "load" => {
            let url = allowed(host, &text_of(request, "url")).ok_or("Preview URL unavailable")?;
            if page.borrow().state.session == Session::Web {
                // An address the user types replaces whatever web visual the page showed.
                page.borrow_mut().visual = None;
                load_into(host, &page, &url);
            } else {
                // A visual's tab stays a visual: the address opens in a new web tab.
                if host.borrow().pages.len() >= TAB_LIMIT {
                    return Err("Too many preview tabs".to_owned());
                }
                let opened = open_page(host, Session::Web, true)?;
                load_into(host, &opened, &url);
            }
        }
        "back" if can_go(wc_id, true) => cef_page::step(wc_id, cef_page::Step::Back),
        "forward" if can_go(wc_id, false) => cef_page::step(wc_id, cef_page::Step::Forward),
        "reload" => cef_page::step(wc_id, cef_page::Step::Reload),
        "stop" => cef_page::step(wc_id, cef_page::Step::Stop),
        _ => {}
    }
    Ok(())
}

/// Whether the page's own history can step back (or forward).
fn can_go(wc_id: u64, back: bool) -> bool {
    state::wc(wc_id).is_some_and(|e| {
        let e = e.borrow();
        if back {
            e.state.can_go_back
        } else {
            e.state.can_go_forward
        }
    })
}

/// `preview.agentStart`: the shown web page gets the relay extension; its socket's `hello` follows with `agentReady`.
fn agent_start(call: Call) {
    let remote = call
        .params
        .get("remote")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let host = match ensure_host(&call, remote) {
        Ok(host) => host,
        Err(message) => return call.err("failed", message),
    };
    // The agent's browser drives web pages only; a visual's page has no network and its own rules.
    if active_page(&host).borrow().state.session == Session::Visual {
        return call.err("failed", "Agent browsing is for web pages, not visuals");
    }
    relay::start(&host, &text_of(&call.params, "tabId"));
    call.ok(window_state(&host));
}

fn agent_ready(call: Call) {
    let Some(host) = owner_of(&call.params).and_then(|o| host(o.key)) else {
        return call.ok(empty_preview());
    };
    relay::ready(&host);
    call.ok(window_state(&host));
}

/// The shown page of the owner's host, when it has an address and has not crashed.
fn working_page(call: &Call) -> Option<PageRef> {
    let page = active_page(&owner_of(&call.params).and_then(|o| host(o.key))?);
    let usable = {
        let p = page.borrow();
        !p.state.url.is_empty() && !p.state.crashed
    };
    usable.then_some(page)
}

/// `preview.page`: one page tool (picker, region, pins, tweaks) run in OMPdesk's isolated world on the shown page.
fn page_tool(call: Call) {
    let Some(page) = working_page(&call) else {
        return call.err("failed", "No page to work on");
    };
    let request = call.params.get("request").cloned().unwrap_or(Value::Null);
    let action = text_of(&request, "action");
    let args: Vec<Value> = match action.as_str() {
        "parent" | "highlight" => vec![request.get("selector").cloned().unwrap_or(Value::Null)],
        "pins" => vec![request.get("pins").cloned().unwrap_or(Value::Null)],
        "setVariable" => vec![
            request.get("name").cloned().unwrap_or(Value::Null),
            request.get("value").cloned().unwrap_or(Value::Null),
        ],
        _ => Vec::new(),
    };
    let wc_id = page.borrow().wc_id;
    let code = page_tools::call(&action, &args);
    cef_page::run_in_world(wc_id, PAGE_WORLD, &code, move |result| {
        let falsy = match &result {
            Value::Null | Value::Bool(false) => true,
            Value::String(text) => text.is_empty(),
            Value::Number(n) => n.as_f64() == Some(0.0),
            _ => false,
        };
        if action != "region" || falsy {
            return call.ok(result);
        }
        region(call, wc_id, &result);
    });
}

/// The region the user dragged: its screenshot (PNG base64, at most 1600 px wide) and the elements under it.
fn region(call: Call, wc_id: u64, picked: &Value) {
    let rect = picked.get("rect").cloned().unwrap_or(Value::Null);
    let side = |key: &str| rect.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let (left, top, width, height) = (side("left"), side("top"), side("width"), side("height"));
    let elements = picked.get("elements").cloned().unwrap_or(json!([]));
    let factor = cef_page::zoom_factor(wc_id);
    let device_width = js::max(1.0, js::round(width * factor));
    let scale = js::min(1.0, REGION_MAX_WIDTH / device_width);
    // The rectangle is the viewport's; the screenshot's clip is the document's.
    cdp::send(wc_id, "Page.getLayoutMetrics", None, None, move |metrics| {
        let (page_x, page_y) = metrics
            .ok()
            .and_then(|m| {
                let viewport = m.get("cssVisualViewport")?;
                Some((
                    viewport.get("pageX")?.as_f64()?,
                    viewport.get("pageY")?.as_f64()?,
                ))
            })
            .unwrap_or((0.0, 0.0));
        let clip = (
            left + page_x,
            top + page_y,
            js::max(1.0, width),
            js::max(1.0, height),
        );
        cef_page::capture(wc_id, Some(clip), scale, move |png| match png {
            Some(png) => {
                use base64::Engine;
                let image = base64::engine::general_purpose::STANDARD.encode(png);
                call.ok(json!({ "image": image, "elements": elements }));
            }
            None => call.err("failed", "The region could not be captured"),
        });
    });
}

/// `preview.pdfName`: the shown page's title as a file name.
fn pdf_file_name(call: Call) {
    let Some(page) = working_page(&call) else {
        return call.err("failed", "No page to save");
    };
    let title = page.borrow().state.title.clone();
    call.ok(json!({ "name": pdf_name(&title) }));
}

/// `preview.pdf`: the shown page as PDF, with its backgrounds.
fn pdf(call: Call) {
    let Some(page) = working_page(&call) else {
        return call.err("failed", "No page to save");
    };
    let max = call.params.get("maxBytes").and_then(Value::as_u64);
    let wc_id = page.borrow().wc_id;
    cef_page::pdf(wc_id, move |result| match result {
        Ok(bytes) if max.is_some_and(|max| bytes.len() as u64 > max) => {
            call.err(
                "failed",
                "The page's PDF is too large to send over this link",
            );
        }
        Ok(bytes) => call.ok_bin(json!({}), &bytes),
        Err(message) => call.err("failed", message),
    });
}

// ------------------------------------------------------------------ what `wc.rs` hands over

/// A page event, in Electron's argument shapes (PROTOCOL.md §4).
pub(super) fn page_event(wc_id: u64, name: &str, args: &Value) {
    let Some(page) = page(wc_id) else { return };
    let Some(host) = host_of(&page) else { return };
    match name {
        "console-message" => console_message(&page, args.get(0).unwrap_or(&Value::Null)),
        "unresponsive" => publish(&host, &page, |s| s.notice = Some(Notice::Unresponsive)),
        "responsive" => {
            if page.borrow().state.notice == Some(Notice::Unresponsive) {
                publish(&host, &page, |s| s.notice = None);
            }
        }
        // Real input reaching the page; a script's `dispatchEvent` never does. The agent's CDP input may, so `choose`
        // also refuses while the agent or any debugger holds the page.
        "input-event" => {
            let released = matches!(
                args.get(0)
                    .and_then(|e| e.get("type"))
                    .and_then(Value::as_str),
                Some("mouseUp" | "keyUp")
            );
            if released {
                page.borrow_mut().last_input = now_ms();
            }
        }
        "did-start-navigation" => {
            let details = args.get(0).unwrap_or(&Value::Null);
            let main = details
                .get("isMainFrame")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let same = details
                .get("isSameDocument")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if main && !same {
                cef_page::end_runs(wc_id);
            }
        }
        // A notice from the Preview check described the document that is now being replaced.
        "did-start-loading" => publish(&host, &page, |s| {
            s.error = None;
            s.crashed = false;
            if matches!(s.notice, Some(Notice::Check { .. })) {
                s.notice = None;
            }
        }),
        "did-stop-loading" => {
            publish(&host, &page, |_| {});
            relay::loaded(&host, wc_id);
            visualize::loaded(wc_id);
        }
        "did-navigate" => did_navigate(
            &host,
            &page,
            args.get(0).and_then(Value::as_str).unwrap_or_default(),
        ),
        "did-navigate-in-page" | "page-title-updated" => {
            publish(&host, &page, |_| {});
            relay::page_updated(&host, &page);
        }
        "did-fail-load" => {
            let code = args.get(0).and_then(Value::as_i64).unwrap_or(0);
            let main = args.get(3).and_then(Value::as_bool).unwrap_or(false);
            if main && code != -3 {
                let description = match args
                    .get(1)
                    .and_then(Value::as_str)
                    .filter(|d| !d.is_empty())
                {
                    Some(description) => description.to_owned(),
                    None => format!("ERR_{}", code.abs()),
                };
                publish(&host, &page, move |s| {
                    s.error = Some(description);
                    s.loading = false;
                });
            }
            relay::loaded(&host, wc_id);
            visualize::loaded(wc_id);
        }
        "render-process-gone" => {
            if let Some(view_id) = page.borrow().view_id {
                cef_page::set_view_visible(view_id, false);
            }
            stream::set_visible(wc_id, false);
            publish(&host, &page, |s| {
                s.crashed = true;
                s.loading = false;
                s.notice = None;
            });
        }
        // The page went without the module closing it (its window closed): nothing waits on it any more.
        "destroyed" => {
            cef_page::end_runs(wc_id);
            stream::page_destroyed(wc_id);
            relay::loaded(&host, wc_id);
            visualize::loaded(wc_id);
        }
        _ => {}
    }
}

fn console_message(tab: &PageRef, message: &Value) {
    let level = text_of(message, "level");
    if level != "error" && level != "warning" {
        return;
    }
    let problem = Problem {
        level,
        message: js::slice_utf16(&text_of(message, "message"), PROBLEM_TEXT_MAX),
        source: text_of(message, "sourceId"),
        line: message
            .get("lineNumber")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    };
    let first = {
        let mut p = tab.borrow_mut();
        p.state.problems.push(problem);
        let extra = p.state.problems.len().saturating_sub(PROBLEM_LIMIT);
        p.state.problems.drain(..extra);
        !std::mem::replace(&mut p.problems_pending, true)
    };
    if first {
        let wc_id = tab.borrow().wc_id;
        crate::ui::post_delayed(PROBLEMS_PUBLISH_MS, move || {
            let Some(page) = self::page(wc_id) else {
                return;
            };
            page.borrow_mut().problems_pending = false;
            if let Some(host) = host_of(&page) {
                publish(&host, &page, |_| {});
            }
        });
    }
}

fn did_navigate(host: &HostRef, page: &PageRef, url: &str) {
    let wc_id = page.borrow().wc_id;
    // A visual's page that leaves its own address (for an empty document) no longer shows it; a web visual browses on.
    {
        let mut p = page.borrow_mut();
        if let Some((visual_id, _)) = p.visual.clone() {
            match parse_visual_url(url) {
                Some((id, version)) if id == visual_id => p.visual = Some((id, version)),
                _ if p.state.session == Session::Visual => p.visual = None,
                _ => {}
            }
        }
    }
    // Chromium keeps zoom per origin; the user's level follows the page across origins.
    if host.borrow().active == wc_id {
        place(host);
    }
    // A viewer's frame must show the new page now, not at the next paint tick.
    stream::refresh(wc_id);
    publish(host, page, |s| s.problems.clear());
    relay::page_updated(host, page);
}

/// `window.open` / `target=_blank` (always cancelled by the caller): a web page's popup becomes a web tab of this
/// preview under the same address rules (behind the agent's page while an agent drives, so the relay keeps its one
/// page); a visual's popup never opens, its address is offered.
pub(super) fn popup(wc_id: u64, url: &str) {
    let Some(page) = page(wc_id) else { return };
    let Some(host) = host_of(&page) else { return };
    if page.borrow().state.session == Session::Visual {
        return offer_link(&host, &page, url);
    }
    let Some(safe) = allowed(&host, url) else {
        return;
    };
    if host.borrow().pages.len() >= TAB_LIMIT {
        return;
    }
    let show = host.borrow().agent.is_none();
    match open_page(&host, Session::Web, show) {
        Ok(opened) => load_into(&host, &opened, &safe),
        Err(message) => log("preview.popup_failed", json!({ "message": message })),
    }
}

/// Whether the page may go to `url` on its own (a link, `location`, a form, a meta refresh, a frame's load, a redirect):
/// a visual's page stays inside its visual, a web page keeps to web addresses.
pub(super) fn may_navigate(wc_id: u64, main_frame: bool, redirect: bool, url: &str) -> bool {
    let Some(page) = page(wc_id) else { return true };
    let Some(host) = host_of(&page) else {
        return true;
    };
    let (kind, shown) = {
        let p = page.borrow();
        (p.state.session, p.visual.as_ref().map(|(id, _)| id.clone()))
    };
    let may = match kind {
        Session::Visual => visual_may_navigate(shown.as_deref(), url),
        Session::Web => allowed(&host, url).is_some(),
    };
    if !may && kind == Session::Visual && main_frame && !redirect {
        offer_link(&host, &page, url);
    }
    may
}

/// A download the page started (always cancelled by the caller): a web page's may go to the system browser, a visual's
/// never does (its address could carry what the page read).
pub(super) fn download(wc_id: u64, url: &str, filename: &str) {
    let Some(page) = page(wc_id) else { return };
    let Some(host) = host_of(&page) else { return };
    if page.borrow().state.session == Session::Visual {
        return;
    }
    if let Some(safe) = allowed(&host, url) {
        let filename = filename.to_owned();
        publish(&host, &page, move |s| {
            s.notice = Some(Notice::Download {
                url: safe,
                filename,
            })
        });
    }
}
