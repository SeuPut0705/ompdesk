//! macOS app delegate: `ompdesk-proto://` deep links (kAEGetURL Apple Event) and Dock re-open.
//! UNVERIFIED: written without a Mac (modelled on cef-rs cefsimple's SimpleAppDelegate).
use objc2::{
    MainThreadMarker, MainThreadOnly, class, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObjectProtocol, ProtocolObject},
    sel,
};
use objc2_app_kit::{NSApp, NSApplication, NSApplicationDelegate};
use objc2_foundation::{NSObject, NSString};
use serde_json::json;

const KEY_DIRECT_OBJECT: u32 = 0x2D2D_2D2D; // '----'
const CLASS_GURL: u32 = 0x4755_524C; // 'GURL'

define_class! {
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    pub struct AppDelegate;

    impl AppDelegate {
        #[unsafe(method(handleGetURL:withReplyEvent:))]
        unsafe fn handle_get_url(&self, event: &AnyObject, _reply: &AnyObject) {
            let desc: Option<Retained<AnyObject>> = msg_send![event, paramDescriptorForKeyword: KEY_DIRECT_OBJECT];
            let Some(desc) = desc else { return };
            let s: Option<Retained<NSString>> = msg_send![&*desc, stringValue];
            if let Some(s) = s {
                crate::log("deeplink", json!({ "url": s.to_string(), "from": "apple-event" }));
                crate::show_window();
            }
        }
    }

    unsafe impl NSObjectProtocol for AppDelegate {}

    unsafe impl NSApplicationDelegate for AppDelegate {
        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        unsafe fn application_should_handle_reopen(&self, _sender: &NSApplication, _has_visible_windows: Bool) -> Bool {
            crate::show_window();
            Bool::NO
        }

        #[unsafe(method(applicationSupportsSecureRestorableState:))]
        unsafe fn application_supports_secure_restorable_state(&self, _sender: &NSApplication) -> Bool {
            Bool::YES
        }
    }
}

/// The main menu cefsimple loads from MainMenu.xib: App (Hide, Quit ⌘Q) and Edit (the responder-chain actions the page's
/// text fields need for ⌘Z/⌘C/⌘V/⌘A). Quit sends `terminate:`, which `mac_app` routes to the app's quit path.
fn install_main_menu(mtm: MainThreadMarker) {
    use objc2_app_kit::{NSMenu, NSMenuItem};
    unsafe fn item(mtm: MainThreadMarker, title: &str, action: Option<objc2::runtime::Sel>, key: &str) -> Retained<NSMenuItem> {
        unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                action,
                &NSString::from_str(key),
            )
        }
    }
    unsafe {
        let bar = NSMenu::new(mtm);
        let app_item = NSMenuItem::new(mtm);
        let app_menu = NSMenu::new(mtm);
        app_menu.addItem(&item(mtm, "Hide OMPdesk", Some(sel!(hide:)), "h"));
        app_menu.addItem(&NSMenuItem::separatorItem(mtm));
        app_menu.addItem(&item(mtm, "Quit OMPdesk", Some(sel!(terminate:)), "q"));
        app_item.setSubmenu(Some(&app_menu));
        bar.addItem(&app_item);
        let edit_item = NSMenuItem::new(mtm);
        let edit_menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("Edit"));
        edit_menu.addItem(&item(mtm, "Undo", Some(sel!(undo:)), "z"));
        edit_menu.addItem(&item(mtm, "Redo", Some(sel!(redo:)), "Z"));
        edit_menu.addItem(&NSMenuItem::separatorItem(mtm));
        edit_menu.addItem(&item(mtm, "Cut", Some(sel!(cut:)), "x"));
        edit_menu.addItem(&item(mtm, "Copy", Some(sel!(copy:)), "c"));
        edit_menu.addItem(&item(mtm, "Paste", Some(sel!(paste:)), "v"));
        edit_menu.addItem(&item(mtm, "Select All", Some(sel!(selectAll:)), "a"));
        edit_item.setSubmenu(Some(&edit_menu));
        bar.addItem(&edit_item);
        NSApp(mtm).setMainMenu(Some(&bar));
    }
}

/// Set as `NSApp`'s delegate and register for `GURL` Apple Events. Keep the returned value alive until shutdown.
pub fn setup_delegate() -> Retained<AppDelegate> {
    let mtm = MainThreadMarker::new().expect("main thread");
    let this: Retained<AppDelegate> = unsafe { msg_send![AppDelegate::alloc(mtm), init] };
    let proto = ProtocolObject::<dyn NSApplicationDelegate>::from_retained(this.clone());
    NSApp(mtm).setDelegate(Some(&proto));
    install_main_menu(mtm);
    unsafe {
        let mgr: Retained<AnyObject> = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        let _: () = msg_send![
            &*mgr,
            setEventHandler: &*this,
            andSelector: sel!(handleGetURL:withReplyEvent:),
            forEventClass: CLASS_GURL,
            andEventID: CLASS_GURL
        ];
    }
    this
}
