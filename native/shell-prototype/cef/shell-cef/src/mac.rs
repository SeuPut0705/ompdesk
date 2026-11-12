//! macOS app delegate: `ompdesk-proto://` deep links (kAEGetURL Apple Event) and Dock re-open.
//! UNVERIFIED: written without a Mac (modelled on cef-rs cefsimple's SimpleAppDelegate).
use objc2::{
    ClassType, MainThreadMarker, MainThreadOnly, class, define_class, msg_send,
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

/// Set as `NSApp`'s delegate and register for `GURL` Apple Events. Keep the returned value alive until shutdown.
pub fn setup_delegate() -> Retained<AppDelegate> {
    let mtm = MainThreadMarker::new().expect("main thread");
    let this: Retained<AppDelegate> = unsafe { msg_send![AppDelegate::alloc(mtm), init] };
    let proto = ProtocolObject::<dyn NSApplicationDelegate>::from_retained(this.clone());
    NSApp(mtm).setDelegate(Some(&proto));
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
