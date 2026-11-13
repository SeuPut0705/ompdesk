//! Pages (`webContents`, PROTOCOL.md §4): the CEF client handlers of every browser the shell creates, the events they
//! turn into, and `wc.op`. `on_paint` reads CEF's pixel buffer through a raw pointer: the module's one unsafe block.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Mutex;
use std::time::Duration;

use cef::*;
use serde_json::{Value, json};

use crate::host::{self, Call};
use crate::state::{self, Role, WcEntry, ui_state, wc};
use crate::{cdp, ipc, log::log, session};

/// Files of the last drag-and-drop onto an app page, by name: `fs.pathForFile` asks for them (`scheme.rs`).
pub static DROPPED: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn string_of(u: &CefStringUserfree) -> String {
    CefString::from(u).to_string()
}

fn cs(text: &str) -> CefString {
    CefString::from(text)
}

// ------------------------------------------------------------------ events and state pushes

pub fn emit(wc_id: u64, name: &str, args: Value) {
    host::event(
        "wc.event",
        json!({ "wcId": wc_id, "name": name, "args": args }),
    );
}

/// `wc.state` when anything changed since the last push.
pub fn push_state(wc_id: u64) {
    let Some(entry) = wc(wc_id) else { return };
    let mut e = entry.borrow_mut();
    let json = e.state.json(wc_id);
    if e.sent_state.as_ref() != Some(&json) {
        e.sent_state = Some(json.clone());
        drop(e);
        host::event("wc.state", json);
    }
}

fn update(wc_id: u64, f: impl FnOnce(&mut WcEntry)) {
    if let Some(entry) = wc(wc_id) {
        f(&mut entry.borrow_mut());
    }
}

/// Runs `f` with the page's browser now, or once CEF created it.
pub fn with_browser(wc_id: u64, f: impl FnOnce(Browser) + 'static) {
    let Some(entry) = wc(wc_id) else { return };
    let browser = entry.borrow().browser.clone();
    match browser {
        Some(browser) => f(browser),
        None => entry.borrow_mut().queued.push(Box::new(f)),
    }
}

// ------------------------------------------------------------------ handlers

wrap_display_handler! {
    struct ShellDisplay {
        wc_id: u64,
    }
    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let title = title.map(|t| t.to_string()).unwrap_or_default();
            update(self.wc_id, |e| e.state.title = title.clone());
            push_state(self.wc_id);
            emit(self.wc_id, "page-title-updated", json!([title, true]));
            crate::window::page_title_changed(self.wc_id, &title);
        }

        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            let Some(frame) = frame else { return };
            if frame.is_main() == 0 {
                return;
            }
            let url = url.map(|u| u.to_string()).unwrap_or_default();
            let Some(entry) = wc(self.wc_id) else { return };
            let committed = {
                let mut e = entry.borrow_mut();
                e.state.url = url.clone();
                let first = e.nav_started && !e.committed;
                if first {
                    e.committed = true;
                }
                first
            };
            push_state(self.wc_id);
            if committed {
                emit(self.wc_id, "did-navigate", json!([url, 200, "OK"]));
            } else {
                emit(self.wc_id, "did-navigate-in-page", json!([url, true]));
            }
        }

        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: i32,
        ) -> i32 {
            let watching = wc(self.wc_id).map(|e| e.borrow().watch_events.contains("console-message")).unwrap_or(false);
            if watching {
                let level = match level {
                    LogSeverity::VERBOSE => "debug",
                    LogSeverity::INFO => "info",
                    LogSeverity::WARNING => "warning",
                    _ => "error",
                };
                emit(
                    self.wc_id,
                    "console-message",
                    json!([{
                        "level": level,
                        "message": message.map(|m| m.to_string()).unwrap_or_default(),
                        "lineNumber": line,
                        "sourceId": source.map(|s| s.to_string()).unwrap_or_default(),
                    }]),
                );
            }
            0
        }
    }
}

wrap_load_handler! {
    struct ShellLoad {
        wc_id: u64,
    }
    impl LoadHandler {
        fn on_loading_state_change(&self, _browser: Option<&mut Browser>, loading: i32, can_back: i32, can_forward: i32) {
            let Some(entry) = wc(self.wc_id) else { return };
            let was_loading = {
                let mut e = entry.borrow_mut();
                let was = e.state.loading;
                e.state.loading = loading != 0;
                e.state.can_go_back = can_back != 0;
                e.state.can_go_forward = can_forward != 0;
                if loading != 0 && !was {
                    e.nav_started = true;
                    e.committed = false;
                    e.state.crashed = false;
                }
                was
            };
            push_state(self.wc_id);
            if loading != 0 && !was_loading {
                emit(self.wc_id, "did-start-loading", json!([]));
            } else if loading == 0 && was_loading {
                entry.borrow_mut().nav_started = false;
                emit(self.wc_id, "did-stop-loading", json!([]));
            }
        }

        fn on_load_start(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _transition: TransitionType) {
            let Some(frame) = frame else { return };
            let main = frame.is_main() != 0;
            emit(
                self.wc_id,
                "did-start-navigation",
                json!([{
                    "url": string_of(&frame.url()),
                    "isInPlace": false,
                    "isMainFrame": main,
                    "frameProcessId": 0,
                    "frameRoutingId": 0,
                    "isSameDocument": false,
                }]),
            );
        }

        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _status: i32) {
            let Some(frame) = frame else { return };
            if frame.is_main() == 0 {
                return;
            }
            emit(self.wc_id, "did-finish-load", json!([]));
            crate::window::page_first_load(self.wc_id);
        }

        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            failed_url: Option<&CefString>,
        ) {
            let main = frame.map(|f| f.is_main() != 0).unwrap_or(true);
            let code = sys::cef_errorcode_t::from(error_code) as i32;
            emit(
                self.wc_id,
                "did-fail-load",
                json!([
                    code,
                    error_text.map(|t| t.to_string()).unwrap_or_default(),
                    failed_url.map(|u| u.to_string()).unwrap_or_default(),
                    main,
                    0,
                    0
                ]),
            );
        }
    }
}

wrap_life_span_handler! {
    struct ShellLifeSpan {
        wc_id: u64,
    }
    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            target_frame_name: Option<&CefString>,
            target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            // The app only ever denies (it opens the system browser or its own Preview tab itself): the request
            // goes to Node for its side effects and the popup is cancelled at once, never waiting for the answer.
            host::request(
                "wc.windowOpen",
                json!({
                    "wcId": self.wc_id,
                    "url": target_url.map(|u| u.to_string()).unwrap_or_default(),
                    "frameName": target_frame_name.map(|n| n.to_string()).unwrap_or_default(),
                    "disposition": format!("{:?}", target_disposition).to_lowercase(),
                    "features": "",
                }),
                None,
                |_, _| {},
            );
            1
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser.cloned() else { return };
            let wc_id = self.wc_id;
            state::map_browser(browser.identifier(), wc_id);
            let queued = ui_state(|u| {
                u.browsers += 1;
                u.wcs.get(&wc_id).cloned()
            })
            .map(|entry| {
                let mut e = entry.borrow_mut();
                e.browser = Some(browser.clone());
                e.created = true;
                std::mem::take(&mut e.queued)
            })
            .unwrap_or_default();
            for f in queued {
                f(browser.clone());
            }
            log("wc.created", json!({ "wcId": wc_id, "browser": browser.identifier() }));
            session::apply_user_agent(wc_id);
            crate::theme::apply_to(wc_id);
            push_state(wc_id);
        }

        fn do_close(&self, _browser: Option<&mut Browser>) -> i32 {
            0
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            let wc_id = self.wc_id;
            if let Some(b) = browser {
                state::unmap_browser(b.identifier());
            }
            let exiting_and_last = ui_state(|u| {
                u.browsers = u.browsers.saturating_sub(1);
                u.exiting && u.browsers == 0
            });
            let entry = ui_state(|u| u.wcs.remove(&wc_id));
            ipc::drop_page(wc_id);
            if let Some(entry) = entry {
                let mut e = entry.borrow_mut();
                e.cdp_registration = None;
                for (_, callback) in std::mem::take(&mut e.cdp_pending) {
                    callback(Err(("gone".into(), "the page was destroyed".into())));
                }
            }
            emit(wc_id, "destroyed", json!([]));
            crate::window::page_destroyed(wc_id);
            if exiting_and_last {
                quit_message_loop();
            }
        }
    }
}

/// The bits of the request's transition type: CEF puts the source and its qualifiers together in a value the enum's
/// variants do not list, which is read as the integer it is.
fn transition_bits(request: &Request) -> i32 {
    let transition = request.transition_type();
    // SAFETY: `cef_transition_type_t` is a `repr(i32)` value; only its bits are read.
    unsafe { *std::ptr::from_ref(transition.as_ref()).cast::<i32>() }
}
wrap_request_handler! {
    struct ShellRequest {
        wc_id: u64,
    }
    impl RequestHandler {
        fn on_before_browse(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            request: Option<&mut Request>,
            _user_gesture: i32,
            is_redirect: i32,
        ) -> i32 {
            let Some(entry) = wc(self.wc_id) else { return 0 };
            let kinds = entry.borrow().watch_nav.clone();
            if kinds.is_empty() {
                return 0;
            }
            let (Some(frame), Some(request)) = (frame, request) else { return 0 };
            let main = frame.is_main() != 0;
            let url = string_of(&request.url());
            // A navigation Node started itself (loadURL, reload, back, forward) is never asked about, as in Electron.
            if main && std::mem::take(&mut entry.borrow_mut().programmatic) {
                return 0;
            }
            // Electron emits no will-navigate for a reload, a history step or a fragment change either: one sent through the DevTools
            // protocol (DevTools' reload button, the e2e harness) reaches here without Node having started it.
            if main && !shell_core::transition::asks_node(transition_bits(request), &string_of(&frame.url()), &url) {
                return 0;
            }
            let kind = if is_redirect != 0 && kinds.contains("will-redirect") {
                "will-redirect"
            } else if kinds.contains("will-frame-navigate") {
                "will-frame-navigate"
            } else if main && kinds.contains("will-navigate") {
                "will-navigate"
            } else {
                return 0;
            };
            let answer = host::request_blocking(
                "wc.navigate",
                json!({
                    "wcId": self.wc_id, "kind": kind, "url": url, "isMainFrame": main,
                    "isSameDocument": false, "isRedirect": is_redirect != 0,
                }),
                Duration::from_secs(2),
            );
            if std::env::var_os("OMPDESK_SHELL_TRACE").is_some() {
                crate::log::log("wc.navigate.answer", json!({ "kind": kind, "url": url, "answer": format!("{answer:?}") }));
            }
            // No answer in 2 s: the navigation is prevented (fail closed).
            match answer {
                Ok(value) => i32::from(value.get("prevent").and_then(Value::as_bool).unwrap_or(true)),
                Err(_) => 1,
            }
        }

        fn on_render_process_terminated(
            &self,
            _browser: Option<&mut Browser>,
            status: TerminationStatus,
            error_code: i32,
            _error_string: Option<&CefString>,
        ) {
            let reason = match status {
                TerminationStatus::ABNORMAL_TERMINATION => "abnormal-exit",
                TerminationStatus::PROCESS_WAS_KILLED => "killed",
                TerminationStatus::PROCESS_CRASHED => "crashed",
                TerminationStatus::PROCESS_OOM => "oom",
                TerminationStatus::LAUNCH_FAILED => "launch-failed",
                TerminationStatus::INTEGRITY_FAILURE => "integrity-failure",
                _ => "abnormal-exit",
            };
            update(self.wc_id, |e| e.state.crashed = true);
            push_state(self.wc_id);
            emit(self.wc_id, "render-process-gone", json!([{ "reason": reason, "exitCode": error_code }]));
        }

        fn on_render_process_unresponsive(&self, _browser: Option<&mut Browser>, _callback: Option<&mut UnresponsiveProcessCallback>) -> i32 {
            emit(self.wc_id, "unresponsive", json!([]));
            0
        }

        fn on_render_process_responsive(&self, _browser: Option<&mut Browser>) {
            emit(self.wc_id, "responsive", json!([]));
        }

        fn on_document_available_in_main_frame(&self, _browser: Option<&mut Browser>) {
            emit(self.wc_id, "dom-ready", json!([]));
        }
    }
}

wrap_drag_handler! {
    struct ShellDrag {
        wc_id: u64,
    }
    impl DragHandler {
        fn on_drag_enter(&self, _browser: Option<&mut Browser>, drag_data: Option<&mut DragData>, _mask: DragOperationsMask) -> i32 {
            if let Some(data) = drag_data {
                let mut names = CefStringList::new();
                if data.file_paths(Some(&mut names)) != 0 {
                    let paths: Vec<String> = names.into_iter().collect();
                    let list = paths
                        .into_iter()
                        .map(|p| {
                            let name = std::path::Path::new(&p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                            (name, p)
                        })
                        .collect();
                    *DROPPED.lock().unwrap() = list;
                }
            }
            0
        }

        fn on_draggable_regions_changed(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, regions: Option<&[DraggableRegion]>) {
            crate::window::set_draggable_regions(self.wc_id, regions);
        }
    }
}

wrap_context_menu_handler! {
    struct ShellContextMenu {
        wc_id: u64,
    }
    impl ContextMenuHandler {
        fn run_context_menu(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            params: Option<&mut ContextMenuParams>,
            _model: Option<&mut MenuModel>,
            callback: Option<&mut RunContextMenuCallback>,
        ) -> i32 {
            // Electron shows no menu of its own: a page with a `context-menu` listener gets the event, every other
            // page gets nothing. CEF's own menu is always suppressed.
            if let Some(callback) = callback {
                callback.cancel();
            }
            let watching = wc(self.wc_id).map(|e| e.borrow().watch_events.contains("context-menu")).unwrap_or(false);
            if let (true, Some(p)) = (watching, params) {
                let mut suggestions = CefStringList::new();
                p.dictionary_suggestions(Some(&mut suggestions));
                let edit: u32 = sys::cef_context_menu_edit_state_flags_t::from(p.edit_state_flags()).0 as _;
                let media = format!("{:?}", p.media_type()).to_lowercase();
                emit(
                    self.wc_id,
                    "context-menu",
                    json!([{
                        "x": p.xcoord(), "y": p.ycoord(),
                        "isEditable": p.is_editable() != 0,
                        "selectionText": string_of(&p.selection_text()),
                        "misspelledWord": string_of(&p.misspelled_word()),
                        "dictionarySuggestions": suggestions.into_iter().collect::<Vec<String>>(),
                        "mediaType": if media.contains("image") { "image" } else if media.contains("video") { "video" } else if media.contains("audio") { "audio" } else { "none" },
                        "linkURL": string_of(&p.link_url()),
                        "srcURL": string_of(&p.source_url()),
                        "editFlags": {
                            "canUndo": edit & 1 != 0, "canRedo": edit & 2 != 0, "canCut": edit & 4 != 0,
                            "canCopy": edit & 8 != 0, "canPaste": edit & 16 != 0, "canSelectAll": edit & 64 != 0,
                        },
                    }]),
                );
            }
            1
        }
    }
}

wrap_jsdialog_handler! {
    struct ShellJsDialog {
        wc_id: u64,
    }
    impl JsdialogHandler {
        fn on_jsdialog(
            &self,
            _browser: Option<&mut Browser>,
            origin_url: Option<&CefString>,
            dialog_type: JsdialogType,
            message_text: Option<&CefString>,
            _default_prompt_text: Option<&CefString>,
            callback: Option<&mut JsdialogCallback>,
            _suppress_message: Option<&mut i32>,
        ) -> i32 {
            // `__ompdeskSendSync(channel, payload)` of a Preview partition's preload is a `prompt()` whose message
            // starts with NUL + "omp-sync:" (PROTOCOL.md §6): a page → Node call that returns an answer to the page
            // synchronously, with the answer as the prompt's result.
            let message = message_text.map(|m| m.to_string()).unwrap_or_default();
            let (JsdialogType::PROMPT, Some(body)) = (dialog_type, message.strip_prefix("\u{0}omp-sync:")) else { return 0 };
            let Some(callback) = callback.cloned() else { return 0 };
            let Ok(Value::Object(call)) = serde_json::from_str::<Value>(body) else {
                callback.cont(0, Some(&cs("")));
                return 1;
            };
            host::request(
                "ipc.sendSync",
                json!({
                    "wcId": self.wc_id,
                    "frameUrl": origin_url.map(|u| u.to_string()).unwrap_or_default(),
                    "channel": call.get("channel").cloned().unwrap_or(Value::Null),
                    "args": [call.get("payload").cloned().unwrap_or(Value::Null)],
                }),
                None,
                move |result, _| {
                    let value = result.ok().and_then(|v| v.get("value").cloned()).unwrap_or(Value::Null);
                    let text = value.to_string();
                    crate::ui::post(move || callback.cont(1, Some(&cs(&text))));
                },
            );
            1
        }

        fn on_before_unload_dialog(
            &self,
            _browser: Option<&mut Browser>,
            _message_text: Option<&CefString>,
            _is_reload: i32,
            callback: Option<&mut JsdialogCallback>,
        ) -> i32 {
            // Leaving a page is never a question (the app's Preview and its windows decide to go; the shim
            // prevented the prompt in Electron too).
            if let Some(callback) = callback {
                callback.cont(1, Some(&cs("")));
            }
            1
        }
    }
}

wrap_download_handler! {
    struct ShellDownload {
        wc_id: u64,
    }
    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, url: Option<&CefString>, _method: Option<&CefString>) -> i32 {
            let partition = wc(self.wc_id).map(|e| e.borrow().partition.clone()).unwrap_or_default();
            if session::downloads_denied(&partition) {
                host::event(
                    "session.download",
                    json!({
                        "partition": partition, "wcId": self.wc_id,
                        "url": url.map(|u| u.to_string()).unwrap_or_default(),
                        "filename": "", "mimeType": "", "totalBytes": 0,
                    }),
                );
                return 0;
            }
            1
        }

        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _item: Option<&mut DownloadItem>,
            _suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
            if let Some(callback) = callback {
                callback.cont(Some(&cs("")), 1);
            }
            1
        }
    }
}

wrap_permission_handler! {
    struct ShellPermission {
        wc_id: u64,
    }
    impl PermissionHandler {
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _origin: Option<&CefString>,
            requested: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> i32 {
            let partition = wc(self.wc_id).map(|e| e.borrow().partition.clone()).unwrap_or_default();
            if let Some(callback) = callback {
                if session::permissions_denied(&partition) {
                    callback.cancel();
                } else {
                    callback.cont(requested);
                }
            }
            1
        }

        fn on_show_permission_prompt(
            &self,
            _browser: Option<&mut Browser>,
            _prompt_id: u64,
            _origin: Option<&CefString>,
            _requested: u32,
            callback: Option<&mut PermissionPromptCallback>,
        ) -> i32 {
            let partition = wc(self.wc_id).map(|e| e.borrow().partition.clone()).unwrap_or_default();
            if let Some(callback) = callback {
                callback.cont(if session::permissions_denied(&partition) { PermissionRequestResult::DENY } else { PermissionRequestResult::ACCEPT });
            }
            1
        }
    }
}

/// Keys the page did not take never become browser shortcuts (Ctrl+W closing the page, Ctrl+T/N, F5…): the app's own
/// shortcuts live in the page. Alt combinations stay with the system (Alt+F4 closes the window).
fn swallow_browser_shortcut(event: Option<&KeyEvent>) -> i32 {
    let Some(event) = event else { return 0 };
    const CTRL: u32 = 1 << 2;
    const ALT: u32 = 1 << 3;
    let f5 = event.windows_key_code == 0x74;
    i32::from(
        (event.modifiers & CTRL != 0 && event.modifiers & ALT == 0 && event.is_system_key == 0)
            || f5,
    )
}

/// A key the page left alone that is an accelerator of the application menu (Windows: typed keys are matched by the
/// message hook before they get here, so this is a key sent through the DevTools protocol).
#[cfg(windows)]
fn application_accelerator(event: &KeyEvent) -> bool {
    use shell_core::accelerator::Mods;
    if event.type_ != cef::sys::cef_key_event_type_t::KEYEVENT_RAWKEYDOWN.into() {
        return false;
    }
    let held = Mods {
        shift: event.modifiers & (1 << 1) != 0,
        ctrl: event.modifiers & (1 << 2) != 0,
        alt: event.modifiers & (1 << 3) != 0,
        meta: event.modifiers & (1 << 7) != 0,
    };
    u16::try_from(event.windows_key_code)
        .is_ok_and(|vk| shell_core::sys::menu::accelerator_for_event(vk, held))
}

// The platform's native event is the one parameter that differs: a `MSG` on Windows, a bare pointer on macOS.
#[cfg(windows)]
wrap_keyboard_handler! {
    struct ShellKeyboard {
        wc_id: u64,
    }
    impl KeyboardHandler {
        fn on_key_event(&self, _browser: Option<&mut Browser>, event: Option<&KeyEvent>, _os_event: Option<&mut cef::sys::MSG>) -> i32 {
            let _ = self.wc_id;
            if event.is_some_and(application_accelerator) {
                return 1;
            }
            swallow_browser_shortcut(event)
        }
    }
}

#[cfg(not(windows))]
wrap_keyboard_handler! {
    struct ShellKeyboard {
        wc_id: u64,
    }
    impl KeyboardHandler {
        fn on_key_event(&self, _browser: Option<&mut Browser>, event: Option<&KeyEvent>, _os_event: *mut u8) -> i32 {
            let _ = self.wc_id;
            swallow_browser_shortcut(event)
        }
    }
}

wrap_render_handler! {
    struct ShellRender {
        wc_id: u64,
    }
    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut Rect>) {
            let (w, h) = wc(self.wc_id).map(|e| e.borrow().view_size).unwrap_or((1280, 720));
            if let Some(r) = rect {
                *r = Rect { x: 0, y: 0, width: w.max(1), height: h.max(1) };
            }
        }

        fn screen_info(&self, _browser: Option<&mut Browser>, info: Option<&mut ScreenInfo>) -> i32 {
            let (w, h) = wc(self.wc_id).map(|e| e.borrow().view_size).unwrap_or((1280, 720));
            if let Some(info) = info {
                info.device_scale_factor = 1.0;
                info.rect = Rect { x: 0, y: 0, width: w.max(1), height: h.max(1) };
                info.available_rect = info.rect.clone();
            }
            1
        }

        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            _dirty: Option<&[Rect]>,
            buffer: *const u8,
            width: i32,
            height: i32,
        ) {
            if type_ != PaintElementType::VIEW || buffer.is_null() || width <= 0 || height <= 0 {
                return;
            }
            // SAFETY: CEF hands `width * height` BGRA pixels at `buffer`, valid for this call; copied before return.
            let bgra = unsafe { std::slice::from_raw_parts(buffer, width as usize * height as usize * 4) }.to_vec();
            let watching = wc(self.wc_id).map(|e| e.borrow().watch_events.contains("paint")).unwrap_or(false);
            update(self.wc_id, |e| e.painted = Some(state::Painted { width, height, bgra: std::sync::Arc::new(bgra) }));
            if watching {
                host::event("wc.paint", json!({ "wcId": self.wc_id, "width": width, "height": height, "scale": 1.0 }));
            }
        }
    }
}

wrap_client! {
    pub struct ShellClient {
        wc_id: u64,
        role: u8,
    }
    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(ShellDisplay::new(self.wc_id))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(ShellLifeSpan::new(self.wc_id))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(ShellLoad::new(self.wc_id))
        }

        fn request_handler(&self) -> Option<RequestHandler> {
            Some(ShellRequest::new(self.wc_id))
        }

        fn drag_handler(&self) -> Option<DragHandler> {
            (self.role == 0).then(|| ShellDrag::new(self.wc_id))
        }

        fn context_menu_handler(&self) -> Option<ContextMenuHandler> {
            Some(ShellContextMenu::new(self.wc_id))
        }

        fn jsdialog_handler(&self) -> Option<JsdialogHandler> {
            Some(ShellJsDialog::new(self.wc_id))
        }

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(ShellDownload::new(self.wc_id))
        }

        fn permission_handler(&self) -> Option<PermissionHandler> {
            Some(ShellPermission::new(self.wc_id))
        }

        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            (self.role != 2).then(|| ShellKeyboard::new(self.wc_id))
        }

        fn render_handler(&self) -> Option<RenderHandler> {
            (self.role == 2).then(|| ShellRender::new(self.wc_id))
        }
    }
}

fn client(wc_id: u64, role: Role) -> Client {
    ShellClient::new(
        wc_id,
        match role {
            Role::Page => 0,
            Role::View => 1,
            Role::Offscreen => 2,
        },
    )
}

// ------------------------------------------------------------------ creating browsers

wrap_browser_view_delegate! {
    struct ShellBrowserViewDelegate {}
    impl ViewDelegate {}
    impl BrowserViewDelegate {
        fn browser_runtime_style(&self) -> RuntimeStyle {
            RuntimeStyle::ALLOY
        }
    }
}

fn extra_info(preload: Option<&str>) -> Option<DictionaryValue> {
    let preload = preload?;
    let dict = dictionary_value_create()?;
    dict.set_string(Some(&cs("preload")), Some(&cs(preload)));
    Some(dict)
}

/// A Views browser (the app page or a Preview view). Registers the entry; the browser itself arrives in
/// `on_after_created`.
pub fn create_view(wc_id: u64, role: Role, partition: &str) -> Option<BrowserView> {
    let mut entry = WcEntry::new(wc_id, partition);
    let preload = session::preload_for(partition);
    entry.preload = preload.clone();
    let ctx = session::context_for(partition);
    let rc = Rc::new(RefCell::new(entry));
    ui_state(|u| u.wcs.insert(wc_id, rc.clone()));
    let mut c = client(wc_id, role);
    let mut delegate = ShellBrowserViewDelegate::new();
    let settings = BrowserSettings::default();
    let mut info = extra_info(preload.as_deref());
    let mut ctx = ctx;
    let view = browser_view_create(
        Some(&mut c),
        Some(&cs("")),
        Some(&settings),
        info.as_mut(),
        ctx.as_mut(),
        Some(&mut delegate),
    );
    rc.borrow_mut().view = view.clone();
    view
}

/// A windowless browser (`webPreferences.offscreen`): paints arrive in `ShellRender`.
pub fn create_offscreen(wc_id: u64, partition: &str, width: i32, height: i32) -> bool {
    let mut entry = WcEntry::new(wc_id, partition);
    entry.view_size = (width, height);
    entry.preload = session::preload_for(partition);
    let preload = entry.preload.clone();
    ui_state(|u| u.wcs.insert(wc_id, Rc::new(RefCell::new(entry))));
    let mut c = client(wc_id, Role::Offscreen);
    let info = WindowInfo {
        windowless_rendering_enabled: 1,
        bounds: Rect {
            x: 0,
            y: 0,
            width,
            height,
        },
        ..Default::default()
    };
    let settings = BrowserSettings {
        windowless_frame_rate: 30,
        ..Default::default()
    };
    let mut dict = extra_info(preload.as_deref());
    let mut ctx = session::context_for(partition);
    browser_host_create_browser(
        Some(&info),
        Some(&mut c),
        Some(&cs("")),
        Some(&settings),
        dict.as_mut(),
        ctx.as_mut(),
    ) != 0
}

// ------------------------------------------------------------------ wc.op

fn zoom_level(factor: f64) -> f64 {
    factor.max(0.01).ln() / 1.2f64.ln()
}

fn load_url(browser: &Browser, args: &Value) {
    let Some(frame) = browser.main_frame() else {
        return;
    };
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("about:blank");
    let referrer = args
        .get("httpReferrer")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty());
    let headers = args
        .get("extraHeaders")
        .and_then(Value::as_str)
        .filter(|h| !h.is_empty());
    let user_agent = args
        .get("userAgent")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty());
    if referrer.is_none() && headers.is_none() && user_agent.is_none() {
        return frame.load_url(Some(&cs(url)));
    }
    let Some(mut request) = request_create() else {
        return frame.load_url(Some(&cs(url)));
    };
    request.set_url(Some(&cs(url)));
    request.set_method(Some(&cs("GET")));
    if let Some(r) = referrer {
        request.set_referrer(
            Some(&cs(r)),
            ReferrerPolicy::CLEAR_REFERRER_ON_TRANSITION_FROM_SECURE_TO_INSECURE,
        );
    }
    if let Some(ua) = user_agent {
        request.set_header_by_name(Some(&cs("User-Agent")), Some(&cs(ua)), 1);
    }
    for line in headers.unwrap_or("").lines() {
        if let Some((name, value)) = line.split_once(':') {
            request.set_header_by_name(Some(&cs(name.trim())), Some(&cs(value.trim())), 1);
        }
    }
    frame.load_request(Some(&mut request));
}

fn focused_frame(browser: &Browser) -> Option<Frame> {
    browser.focused_frame().or_else(|| browser.main_frame())
}

/// `wc.op` (UI thread).
pub fn op(call: Call) {
    let Some(wc_id) = call.params.get("wcId").and_then(Value::as_u64) else {
        return call.err("invalid", "wcId is missing");
    };
    let name = call.str("op").unwrap_or_default();
    let args = call.params.get("args").cloned().unwrap_or(Value::Null);
    crate::ui::run(move || run_op(call, wc_id, &name, args));
}

fn ok(call: Call) {
    call.ok(json!({}));
}

fn run_op(call: Call, wc_id: u64, name: &str, args: Value) {
    let Some(entry) = wc(wc_id) else {
        return call.err("gone", format!("no page {wc_id}"));
    };
    let name = name.to_string();
    match name.as_str() {
        "watchEvents" => {
            let names: std::collections::HashSet<String> = args
                .get("names")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|n| n.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let mut e = entry.borrow_mut();
            e.watch_nav = names
                .iter()
                .filter(|n| {
                    matches!(
                        n.as_str(),
                        "will-navigate" | "will-frame-navigate" | "will-redirect"
                    )
                })
                .cloned()
                .collect();
            let arm_input =
                names.contains("input-event") && !e.watch_events.contains("input-event");
            e.watch_events = names;
            drop(e);
            if arm_input {
                crate::cdp::watch_input(wc_id);
            }
            ok(call)
        }
        "ignoreBeforeUnload" => ok(call),
        "setBackgroundThrottling" => ok(call),
        "loadURL" => with_browser(wc_id, move |b| {
            if let Some(e) = wc(wc_id) {
                e.borrow_mut().programmatic = true;
            }
            load_url(&b, &args);
            ok(call);
        }),
        "reload" | "reloadIgnoringCache" | "stop" | "goBack" | "goForward" => {
            with_browser(wc_id, move |b| {
                if let Some(e) = wc(wc_id) {
                    e.borrow_mut().programmatic = true;
                }
                match name.as_str() {
                    "reload" => b.reload(),
                    "reloadIgnoringCache" => b.reload_ignore_cache(),
                    "stop" => b.stop_load(),
                    "goBack" => b.go_back(),
                    _ => b.go_forward(),
                }
                ok(call);
            })
        }
        "executeJavaScript" => {
            let code = args
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let gesture = args
                .get("userGesture")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            with_browser(wc_id, move |_| {
                cdp::evaluate(wc_id, &code, gesture, move |result| match result {
                    Ok(value) => call.ok(value),
                    Err((code, message)) => call.err(&code, message),
                })
            })
        }
        "setZoomFactor" => {
            let factor = args.get("factor").and_then(Value::as_f64).unwrap_or(1.0);
            entry.borrow_mut().state.zoom_factor = factor;
            with_browser(wc_id, move |b| {
                if let Some(h) = b.host() {
                    h.set_zoom_level(zoom_level(factor));
                }
                push_state(wc_id);
                ok(call);
            })
        }
        "setUserAgent" => {
            let ua = args
                .get("userAgent")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let lang = args
                .get("acceptLanguages")
                .and_then(Value::as_str)
                .map(String::from);
            entry.borrow_mut().state.user_agent = ua.clone();
            let mut params = json!({ "userAgent": ua });
            if let Some(l) = lang {
                params["acceptLanguage"] = json!(l);
            }
            with_browser(wc_id, move |_| {
                cdp::send(
                    wc_id,
                    "Emulation.setUserAgentOverride",
                    Some(params),
                    None,
                    move |r| match r {
                        Ok(_) => {
                            push_state(wc_id);
                            ok(call)
                        }
                        Err((code, message)) => call.err(&code, message),
                    },
                )
            })
        }
        "openDevTools" => with_browser(wc_id, move |b| {
            if let Some(h) = b.host() {
                h.show_dev_tools(None, None, None, None);
            }
            update(wc_id, |e| e.state.devtools_opened = true);
            push_state(wc_id);
            ok(call);
        }),
        "closeDevTools" => with_browser(wc_id, move |b| {
            if let Some(h) = b.host() {
                h.close_dev_tools();
            }
            update(wc_id, |e| e.state.devtools_opened = false);
            push_state(wc_id);
            ok(call);
        }),
        "undo" | "redo" | "cut" | "copy" | "paste" | "pasteAndMatchStyle" | "selectAll"
        | "delete" => with_browser(wc_id, move |b| {
            if let Some(f) = focused_frame(&b) {
                match name.as_str() {
                    "undo" => f.undo(),
                    "redo" => f.redo(),
                    "cut" => f.cut(),
                    "copy" => f.copy(),
                    "paste" => f.paste(),
                    "pasteAndMatchStyle" => f.paste_and_match_style(),
                    "selectAll" => f.select_all(),
                    _ => f.del(),
                }
            }
            ok(call);
        }),
        "replaceMisspelling" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            with_browser(wc_id, move |b| {
                if let Some(h) = b.host() {
                    h.replace_misspelling(Some(&cs(&text)));
                }
                ok(call);
            })
        }
        "copyImageAt" => {
            let (x, y) = (
                args.get("x").and_then(Value::as_f64).unwrap_or(0.0),
                args.get("y").and_then(Value::as_f64).unwrap_or(0.0),
            );
            let script = format!(
                "(async()=>{{const el=document.elementFromPoint({x},{y});const img=el&&(el.closest('img')||el);if(!img)return;const url=img.currentSrc||img.src;if(!url)return;const blob=await (await fetch(url)).blob();await navigator.clipboard.write([new ClipboardItem({{[blob.type]:blob}})]);}})()"
            );
            with_browser(wc_id, move |_| {
                cdp::evaluate(wc_id, &script, true, move |r| match r {
                    Ok(_) => ok(call),
                    Err((code, message)) => call.err(&code, message),
                })
            })
        }
        "setWebRTCIPHandlingPolicy" => {
            let policy = args
                .get("policy")
                .and_then(Value::as_str)
                .unwrap_or("default")
                .to_string();
            with_browser(wc_id, move |b| {
                if let (Some(h), Some(value)) = (b.host(), value_create())
                    && let Some(ctx) = h.request_context()
                {
                    value.set_string(Some(&cs(&policy)));
                    let mut value = value;
                    let mut error = CefString::default();
                    ctx.set_preference(
                        Some(&cs("webrtc.ip_handling_policy")),
                        Some(&mut value),
                        Some(&mut error),
                    );
                }
                ok(call);
            })
        }
        "setFrameRate" => {
            let fps = args.get("fps").and_then(Value::as_i64).unwrap_or(30) as i32;
            entry.borrow_mut().frame_rate = fps;
            with_browser(wc_id, move |b| {
                if let Some(h) = b.host() {
                    h.set_windowless_frame_rate(fps);
                }
                ok(call);
            })
        }
        "invalidate" => with_browser(wc_id, move |b| {
            if let Some(h) = b.host() {
                h.invalidate(PaintElementType::VIEW);
            }
            ok(call);
        }),
        "startPainting" | "stopPainting" => {
            let hidden = name == "stopPainting";
            with_browser(wc_id, move |b| {
                if let Some(h) = b.host() {
                    h.was_hidden(i32::from(hidden));
                }
                ok(call);
            })
        }
        "focus" => with_browser(wc_id, move |b| {
            if let Some(h) = b.host() {
                h.set_focus(1);
            }
            ok(call);
        }),
        "setAudioMuted" => {
            let muted = args.get("muted").and_then(Value::as_bool).unwrap_or(false);
            entry.borrow_mut().state.audio_muted = muted;
            with_browser(wc_id, move |b| {
                if let Some(h) = b.host() {
                    h.set_audio_muted(i32::from(muted));
                }
                push_state(wc_id);
                ok(call);
            })
        }
        "close" => {
            close(wc_id);
            ok(call)
        }
        other => call.err(
            "unsupported",
            format!("wc.op {other} is not implemented by this shell"),
        ),
    }
}

/// Destroys a page: its browser closes (`on_before_close` removes the entry and tells Node).
pub fn close(wc_id: u64) {
    let Some(entry) = wc(wc_id) else { return };
    let (browser, view_id) = {
        let mut e = entry.borrow_mut();
        e.closing = true;
        (
            e.browser.clone(),
            ui_state(|u| {
                u.views
                    .values()
                    .find(|v| v.borrow().wc_id == wc_id)
                    .map(|v| v.borrow().view_id)
            }),
        )
    };
    if let Some(view_id) = view_id {
        crate::view::detach_for_close(view_id);
    }
    match browser.and_then(|b| b.host()) {
        Some(host) => host.close_browser(1),
        None => {
            // Not created yet: nothing to close; forget it.
            ui_state(|u| u.wcs.remove(&wc_id));
            emit(wc_id, "destroyed", json!([]));
        }
    }
}

/// `wc.cdp.*` and `wc.frame` requests.
pub fn cdp_request(call: Call) {
    let Some(wc_id) = call.params.get("wcId").and_then(Value::as_u64) else {
        return call.err("invalid", "wcId is missing");
    };
    crate::ui::run(move || match call.method.as_str() {
        "wc.cdp.attach" => {
            cdp::attach(wc_id);
            ok(call)
        }
        "wc.cdp.detach" => {
            cdp::detach(wc_id);
            ok(call)
        }
        "wc.cdp.send" => {
            let method = call.str("method").unwrap_or_default();
            let params = call.params.get("params").cloned();
            let session = call.str("sessionId");
            with_browser(wc_id, move |_| {
                cdp::send(wc_id, &method, params, session, move |r| match r {
                    Ok(result) => call.ok(json!({ "result": result })),
                    Err((code, message)) => call.err(&code, message),
                })
            })
        }
        "wc.frame" => crate::wcframe::request(call, wc_id),
        _ => call.unsupported(),
    });
}
