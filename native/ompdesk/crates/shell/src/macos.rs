// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! The macOS start-up the shell binary needs before and around CEF: loading the framework, the `NSApplication`
//! subclass CEF requires (`CefAppProtocol`), and the application delegate that turns the OS's URL / file / Dock
//! events into `app.openUrl`, `app.openFile` and `app.activate`. `define_class!` and the Apple Event plumbing are
//! Objective-C, so this file allows `unsafe_code` for itself (the rest of the OS access is in `shell_core::sys_mac`).
//!
//! Order in `main`: `load_framework` first of all (every process), then, in the browser process only,
//! `setup_application(request_quit)` before anything touches `NSApp`, `setup_delegate` and `install_main_menu` before
//! `initialize` (a cold launch by URL delivers its Apple Event as soon as the run loop starts), and `flush_pending`
//! when `app.ready` is sent.
#![allow(unsafe_code)]

use std::cell::Cell;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use cef::library_loader::LibraryLoader;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyObject, Bool, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, class, define_class, extern_methods,
    msg_send, sel,
};
use objc2_app_kit::{NSApp, NSApplication, NSApplicationDelegate, NSEvent};
use objc2_foundation::{NSArray, NSObject, NSString};
use serde_json::{Value, json};

use crate::host;
use crate::log::log;

/// Where the framework sits relative to the executable: the main app next to `Contents/Frameworks`, a helper app
/// (`Contents/Frameworks/<name> Helper.app/Contents/MacOS/<name> Helper`) three levels further down. The same binary
/// is every one of them, so the custom schemes are registered in all processes.
const FRAMEWORK: &str = "Chromium Embedded Framework.framework/Chromium Embedded Framework";

fn framework_relative(is_browser: bool) -> &'static str {
    if is_browser {
        "../Frameworks"
    } else {
        "../../.."
    }
}

/// Loads `Chromium Embedded Framework` (CEF's C API) into this process. Must run first, in every process, before any
/// other `cef` call; keep the returned loader alive until the process ends (it unloads on drop). Exits with a message
/// when the framework is not where the bundle layout puts it (an unbundled `cargo run` executable has none).
pub fn load_framework(is_browser: bool) -> LibraryLoader {
    let exe = std::env::current_exe().unwrap_or_default();
    let expected = exe
        .parent()
        .map(|dir| dir.join(framework_relative(is_browser)).join(FRAMEWORK))
        .unwrap_or_default();
    if !Path::new(&expected).is_file() {
        eprintln!(
            "[shell] the Chromium Embedded Framework is not at {}: run the shell from its .app bundle",
            expected.display()
        );
        std::process::exit(1);
    }
    let loader = LibraryLoader::new(&exe, !is_browser);
    if !loader.load() {
        eprintln!(
            "[shell] cannot load the Chromium Embedded Framework at {}",
            expected.display()
        );
        std::process::exit(1);
    }
    loader
}

static ON_TERMINATE: OnceLock<fn()> = OnceLock::new();

#[derive(Default)]
pub struct CefApplicationIvars {
    handling_send_event: Cell<Bool>,
}

define_class!(
    // SAFETY: NSApplication allows subclassing; this class only adds the ivar CEF's protocol needs and overrides
    // `sendEvent:` (calling super) and `terminate:`.
    #[unsafe(super(NSApplication))]
    #[ivars = CefApplicationIvars]
    pub struct CefApplication;

    impl CefApplication {
        #[unsafe(method(sendEvent:))]
        fn send_event(&self, event: &NSEvent) {
            let was_sending_event = self.is_handling_send_event();
            if !was_sending_event {
                self.set_handling_send_event(true);
            }
            // SAFETY: the superclass's own `sendEvent:` with the event AppKit passed in.
            unsafe {
                let _: () = msg_send![super(self), sendEvent: event];
            }
            if !was_sending_event {
                self.set_handling_send_event(false);
            }
        }

        /// Cocoa's quit entry point (⌘Q, Dock > Quit): the default calls `exit()` and never leaves the run loop, which
        /// Chromium needs for an orderly shutdown, so the quit goes to the app instead.
        #[unsafe(method(terminate:))]
        fn terminate(&self, _sender: &AnyObject) {
            if let Some(quit) = ON_TERMINATE.get() {
                quit();
            }
        }
    }

    unsafe impl CrAppControlProtocol for CefApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        fn _set_handling_send_event(&self, handling_send_event: Bool) {
            self.ivars().handling_send_event.set(handling_send_event);
        }
    }

    unsafe impl CrAppProtocol for CefApplication {
        #[unsafe(method(isHandlingSendEvent))]
        fn _is_handling_send_event(&self) -> Bool {
            self.ivars().handling_send_event.get()
        }
    }

    unsafe impl CefAppProtocol for CefApplication {}
);

impl CefApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;

        #[unsafe(method(setHandlingSendEvent:))]
        fn set_handling_send_event(&self, handling_send_event: bool);

        #[unsafe(method(isHandlingSendEvent))]
        fn is_handling_send_event(&self) -> bool;
    }
}

/// ⌘Q and Dock > Quit: Electron's `app.quit()` starts Node's quit sequence (`before-quit`, window closes, `will-quit`),
/// so the shell asks Node to run it (`app.quitRequested`); Node answers with `app.exit`. Without a Node connection
/// there is nobody to ask and the shell exits at once. Pass this to `setup_application`.
pub fn request_quit() {
    if host::connected() {
        host::event("app.quitRequested", json!({}));
    } else {
        crate::lifecycle::request_exit(0);
    }
}

/// Installs `CefApplication` as `NSApp`: the first `sharedApplication` message decides the class, so this runs before
/// anything else touches `NSApp`. `quit` runs on the main thread for ⌘Q / Dock > Quit (what Electron's `app.quit()`
/// starts: the shell asks Node to run its quit sequence). Browser process only, main thread.
pub fn setup_application(quit: fn()) {
    let _ = ON_TERMINATE.set(quit);
    let _ = CefApplication::shared_application();
    let mtm = MainThreadMarker::new().expect("the main thread");
    assert!(
        NSApp(mtm).isKindOfClass(CefApplication::class()),
        "NSApp is not a CefApplication"
    );
}

/// Events that arrive before `app.ready` (a cold launch by URL or by a dropped file comes before CEF is up, before Node
/// is connected): the host drops events nobody is connected for, so they wait here and `flush_pending` sends them.
static PENDING: Mutex<Vec<(&'static str, Value)>> = Mutex::new(Vec::new());
static READY: AtomicBool = AtomicBool::new(false);
/// More than this many events before the app is ready is a loop, not a launch.
const PENDING_MAX: usize = 64;

fn emit(name: &'static str, data: Value) {
    let mut queue = PENDING.lock().unwrap();
    if READY.load(Ordering::Acquire) {
        drop(queue);
        host::event(name, data);
    } else if queue.len() < PENDING_MAX {
        queue.push((name, data));
    }
}

/// Sends the events that waited for the app, in order, and from now on sends events at once. Call where `app.ready` is
/// sent (the UI thread, `on_context_initialized`), right after that event.
pub fn flush_pending() {
    let queued = {
        let mut queue = PENDING.lock().unwrap();
        READY.store(true, Ordering::Release);
        std::mem::take(&mut *queue)
    };
    for (name, data) in queued {
        host::event(name, data);
    }
}

const KEY_DIRECT_OBJECT: u32 = 0x2D2D_2D2D; // '----'
const CLASS_GURL: u32 = 0x4755_524C; // 'GURL' (kInternetEventClass = kAEGetURL)

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class adds no instance variables.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "OMPdeskAppDelegate"]
    pub struct AppDelegate;

    impl AppDelegate {
        /// `kAEGetURL`: a click on `scheme://…` in another app, `open url`, a Dock drop of a link.
        #[unsafe(method(handleGetURL:withReplyEvent:))]
        fn handle_get_url(&self, event: &AnyObject, _reply: &AnyObject) {
            // SAFETY: `event` is the NSAppleEventDescriptor AppKit delivered; both getters return nil when absent.
            let url: Option<Retained<NSString>> = unsafe {
                let direct: Option<Retained<AnyObject>> = msg_send![event, paramDescriptorForKeyword: KEY_DIRECT_OBJECT];
                direct.and_then(|d| msg_send![&*d, stringValue])
            };
            match url {
                Some(url) => emit("app.openUrl", json!({ "url": url.to_string() })),
                None => log("app.open_url_unreadable", json!({})),
            }
        }
    }

    unsafe impl NSObjectProtocol for AppDelegate {}

    unsafe impl NSApplicationDelegate for AppDelegate {
        /// `kAEOpenDocuments`: AppKit parses the event's file list and calls this; it must answer with
        /// `replyToOpenOrPrint:` (`NSApplicationDelegateReplySuccess` = 0).
        #[unsafe(method(application:openFiles:))]
        fn application_open_files(&self, sender: &NSApplication, filenames: &NSArray<NSString>) {
            for path in filenames.iter() {
                emit("app.openFile", json!({ "path": path.to_string() }));
            }
            // SAFETY: `replyToOpenOrPrint:` takes the NSApplicationDelegateReply value.
            unsafe {
                let _: () = msg_send![sender, replyToOpenOrPrint: 0usize];
            }
        }

        /// The Dock icon was clicked (or the app opened again) while running. Electron answers NO: the app decides
        /// what to show (`app.activate`), AppKit's default un-minimising is not wanted.
        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn application_should_handle_reopen(&self, _sender: &NSApplication, has_visible_windows: Bool) -> Bool {
            emit("app.activate", json!({ "hasVisibleWindows": has_visible_windows.as_bool() }));
            Bool::NO
        }

        #[unsafe(method(applicationSupportsSecureRestorableState:))]
        fn application_supports_secure_restorable_state(&self, _sender: &NSApplication) -> Bool {
            Bool::YES
        }
    }
);

/// Makes the delegate `NSApp`'s and registers its `kAEGetURL` handler. Browser process, main thread, after
/// `setup_application`. `NSApp` holds its delegate weakly: keep the returned value until the shell exits.
pub fn setup_delegate() -> Retained<AppDelegate> {
    let mtm = MainThreadMarker::new().expect("the main thread");
    let this = AppDelegate::alloc(mtm).set_ivars(());
    // SAFETY: `init` of NSObject on a freshly allocated instance whose (empty) ivars are set.
    let this: Retained<AppDelegate> = unsafe { msg_send![super(this), init] };
    NSApp(mtm).setDelegate(Some(ProtocolObject::from_ref(&*this)));
    // SAFETY: the manager is AppKit's singleton; it holds the target weakly (the caller keeps `this` alive) and the
    // selector exists on the class above with the `(event, replyEvent)` signature the manager calls.
    unsafe {
        let manager: *mut AnyObject =
            msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        let _: () = msg_send![manager, setEventHandler: &*this, andSelector: sel!(handleGetURL:withReplyEvent:), forEventClass: CLASS_GURL, andEventID: CLASS_GURL];
    }
    this
}

// NSEventModifierFlags
const OPTION: usize = 1 << 19;
const COMMAND: usize = 1 << 20;

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

/// An `NSMenuItem` whose action goes up the responder chain to `NSApp` / the key window. `key` is the key equivalent
/// (⌘ + key, an upper-case letter adds ⇧); `modifiers` replaces the ⌘ default when given.
fn menu_item(title: &str, action: Sel, key: &str, modifiers: Option<usize>) -> Retained<AnyObject> {
    // SAFETY: NSMenuItem's designated initialiser on a fresh allocation, with live NSStrings and a selector.
    unsafe {
        let item: Allocated<AnyObject> = msg_send![class!(NSMenuItem), alloc];
        let item: Retained<AnyObject> = msg_send![item, initWithTitle: &*ns(title), action: Some(action), keyEquivalent: &*ns(key)];
        if let Some(mask) = modifiers {
            let _: () = msg_send![&*item, setKeyEquivalentModifierMask: mask];
        }
        item
    }
}

fn separator() -> Retained<AnyObject> {
    // SAFETY: a class message returning a separator item.
    unsafe { msg_send![class!(NSMenuItem), separatorItem] }
}

/// Adds a top-level menu titled `title` holding `items` to the menu bar `bar`; answers the submenu.
fn add_menu(bar: &AnyObject, title: &str, items: &[Retained<AnyObject>]) -> Retained<AnyObject> {
    // SAFETY: NSMenu / NSMenuItem messages on live objects, on the main thread.
    unsafe {
        let menu: Allocated<AnyObject> = msg_send![class!(NSMenu), alloc];
        let menu: Retained<AnyObject> = msg_send![menu, initWithTitle: &*ns(title)];
        for item in items {
            let _: () = msg_send![&*menu, addItem: &**item];
        }
        let holder: Allocated<AnyObject> = msg_send![class!(NSMenuItem), alloc];
        let holder: Retained<AnyObject> = msg_send![holder, initWithTitle: &*ns(title), action: None::<Sel>, keyEquivalent: &*ns("")];
        let _: () = msg_send![&*holder, setSubmenu: &*menu];
        let _: () = msg_send![bar, addItem: &*holder];
        menu
    }
}

/// The menu bar the app has until Node sends `menu.setApplication` (which replaces it, `sys_mac::menu`): App (About,
/// Hide, Hide Others, Show All, Quit ⌘Q), Edit (Undo, Redo, Cut, Copy, Paste, Select All: the actions the page's text
/// fields answer) and Window (Close, Minimize, Zoom, Bring All to Front). Without a main menu ⌘Q, ⌘C, ⌘V and ⌘W do
/// nothing. Main thread, after `setup_application`; call it where `setup_delegate` is called, before the run loop.
pub fn install_main_menu() {
    // SAFETY: NSProcessInfo / NSApplication / NSMenu messages on the main thread with live objects.
    unsafe {
        let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let name: Option<Retained<NSString>> = msg_send![info, processName];
        let name = name
            .map(|n| n.to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "OMPdesk".into());
        let bar: Allocated<AnyObject> = msg_send![class!(NSMenu), alloc];
        let bar: Retained<AnyObject> = msg_send![bar, initWithTitle: &*ns("")];
        add_menu(
            &bar,
            &name,
            &[
                menu_item(
                    &format!("About {name}"),
                    sel!(orderFrontStandardAboutPanel:),
                    "",
                    None,
                ),
                separator(),
                menu_item(&format!("Hide {name}"), sel!(hide:), "h", None),
                menu_item(
                    "Hide Others",
                    sel!(hideOtherApplications:),
                    "h",
                    Some(COMMAND | OPTION),
                ),
                menu_item("Show All", sel!(unhideAllApplications:), "", None),
                separator(),
                menu_item(&format!("Quit {name}"), sel!(terminate:), "q", None),
            ],
        );
        add_menu(
            &bar,
            "Edit",
            &[
                menu_item("Undo", sel!(undo:), "z", None),
                menu_item("Redo", sel!(redo:), "Z", None),
                separator(),
                menu_item("Cut", sel!(cut:), "x", None),
                menu_item("Copy", sel!(copy:), "c", None),
                menu_item("Paste", sel!(paste:), "v", None),
                menu_item("Select All", sel!(selectAll:), "a", None),
            ],
        );
        let window_menu = add_menu(
            &bar,
            "Window",
            &[
                menu_item("Close", sel!(performClose:), "w", None),
                menu_item("Minimize", sel!(performMiniaturize:), "m", None),
                menu_item("Zoom", sel!(performZoom:), "", None),
                separator(),
                menu_item("Bring All to Front", sel!(arrangeInFront:), "", None),
            ],
        );
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setWindowsMenu: &*window_menu];
        let _: () = msg_send![app, setMainMenu: &*bar];
    }
}
