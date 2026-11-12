//! The `NSApplication` subclass CEF requires on macOS (`CefAppProtocol`), shared by shell-cef and preview-host.
//! Ported from cef-rs `examples/cefsimple/src/mac/mod.rs` (SimpleApplication). UNVERIFIED: written without a Mac.
use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::{
    ClassType, MainThreadMarker, define_class, extern_methods, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool, NSObjectProtocol},
};
use objc2_app_kit::{NSApp, NSApplication, NSEvent};
use std::{cell::Cell, sync::OnceLock};

static ON_TERMINATE: OnceLock<fn()> = OnceLock::new();

#[derive(Default)]
pub struct CefApplicationIvars {
    handling_send_event: Cell<Bool>,
}

define_class!(
    #[unsafe(super(NSApplication))]
    #[ivars = CefApplicationIvars]
    pub struct CefApplication;

    impl CefApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let was_sending_event = self.is_handling_send_event();
            if !was_sending_event {
                self.set_handling_send_event(true);
            }
            let _: () = msg_send![super(self), sendEvent: event];
            if !was_sending_event {
                self.set_handling_send_event(false);
            }
        }

        /// Cocoa's quit entry point: the default calls exit() and never leaves the run loop, which Chromium needs for an
        /// orderly shutdown (same reasoning as cefsimple): hand it to the app instead.
        #[unsafe(method(terminate:))]
        unsafe fn terminate(&self, _sender: &AnyObject) {
            if let Some(f) = ON_TERMINATE.get() {
                f();
            }
        }
    }

    unsafe impl CrAppControlProtocol for CefApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn _set_handling_send_event(&self, handling_send_event: Bool) {
            self.ivars().handling_send_event.set(handling_send_event);
        }
    }

    unsafe impl CrAppProtocol for CefApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn _is_handling_send_event(&self) -> Bool {
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

/// Must run before anything else touches `NSApp`. `on_terminate` runs on the main thread for Cmd-Q / Dock Quit.
pub fn setup(on_terminate: fn()) {
    let _ = ON_TERMINATE.set(on_terminate);
    let _ = CefApplication::shared_application();
    assert!(NSApp(MainThreadMarker::new().expect("main thread")).isKindOfClass(CefApplication::class()));
}
