// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! The macOS `app.*` ops of PROTOCOL.md §2: hide/unhide, the Dock badge and icon, the About panel, the activation
//! policy and the default handler of a URL scheme. AppKit is reached with runtime `msg_send!` calls (no per-class
//! cargo feature, as in `desk`). Everything except `register_default_protocol` runs on the main thread.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::Mutex;

use objc2::rc::{Allocated, Retained};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    /// Deprecated since macOS 12 but still the one call that sets a scheme's default handler without a prompt.
    fn LSSetDefaultHandlerForURLScheme(
        scheme: *const AnyObject,
        bundle_id: *const AnyObject,
    ) -> i32;
}

/// `app.init`'s `aboutPanel` options, shown by `show_about_panel`.
#[derive(Clone, Default)]
pub struct AboutPanel {
    pub application_name: Option<String>,
    pub icon_path: Option<String>,
}

static ABOUT: Mutex<AboutPanel> = Mutex::new(AboutPanel {
    application_name: None,
    icon_path: None,
});

fn ns(text: &str) -> Retained<NSString> {
    NSString::from_str(text)
}

fn shared_application() -> *mut AnyObject {
    // SAFETY: `sharedApplication` is a class message returning the process's NSApplication.
    unsafe { msg_send![class!(NSApplication), sharedApplication] }
}

/// `app.hide`: `[NSApp hide:nil]`.
pub fn hide() {
    // SAFETY: `hide:` takes a sender, which may be nil.
    unsafe {
        let _: () = msg_send![shared_application(), hide: null_mut::<AnyObject>()];
    }
}

/// `app.show`: `[NSApp unhide:nil]`.
pub fn unhide() {
    // SAFETY: `unhide:` takes a sender, which may be nil.
    unsafe {
        let _: () = msg_send![shared_application(), unhide: null_mut::<AnyObject>()];
    }
}

/// `app.setBadge`: the Dock tile's badge; empty text clears it.
pub fn set_badge(text: &str) {
    // SAFETY: `dockTile` is the application's NSDockTile; `setBadgeLabel:` takes an NSString or nil.
    unsafe {
        let tile: *mut AnyObject = msg_send![shared_application(), dockTile];
        if text.is_empty() {
            let _: () = msg_send![tile, setBadgeLabel: null_mut::<AnyObject>()];
        } else {
            let _: () = msg_send![tile, setBadgeLabel: &*ns(text)];
        }
    }
}

fn image_from_data(png: &[u8]) -> Option<Retained<AnyObject>> {
    // SAFETY: `dataWithBytes:length:` copies `png.len()` bytes from a live slice; NSImage's initialiser takes the NSData.
    unsafe {
        let data: Retained<AnyObject> = msg_send![class!(NSData), dataWithBytes: png.as_ptr().cast::<c_void>(), length: png.len()];
        let image: Allocated<AnyObject> = msg_send![class!(NSImage), alloc];
        msg_send![image, initWithData: &*data]
    }
}

fn image_from_file(path: &str) -> Option<Retained<AnyObject>> {
    // SAFETY: NSImage's file initialiser takes an NSString path and answers nil when it cannot read an image.
    unsafe {
        let image: Allocated<AnyObject> = msg_send![class!(NSImage), alloc];
        msg_send![image, initWithContentsOfFile: &*ns(path)]
    }
}

/// `app.setDockIcon`: the Dock icon from PNG bytes.
pub fn set_dock_icon(png: &[u8]) -> Result<(), String> {
    if png.is_empty() {
        return Err("app.setDockIcon needs the image bytes".into());
    }
    let image = image_from_data(png).ok_or("the Dock icon is not a readable image")?;
    // SAFETY: `setApplicationIconImage:` takes an NSImage and retains it.
    unsafe {
        let _: () = msg_send![shared_application(), setApplicationIconImage: &*image];
    }
    Ok(())
}

/// Remembers `app.init`'s `aboutPanel` options for `show_about_panel`.
pub fn set_about_panel(options: AboutPanel) {
    *ABOUT.lock().unwrap() = options;
}

/// `app.showAboutPanel`: the standard About panel (name, icon, version from the bundle), in front.
pub fn show_about_panel() {
    let about = ABOUT.lock().unwrap().clone();
    // SAFETY: NSMutableDictionary / NSApplication messages with live objects; `NSAboutPanelOptionApplicationName` and
    // `NSAboutPanelOptionApplicationIcon` are the strings "ApplicationName" and "ApplicationIcon".
    unsafe {
        let options: Retained<AnyObject> = msg_send![class!(NSMutableDictionary), dictionary];
        if let Some(name) = about.application_name.as_deref().filter(|n| !n.is_empty()) {
            let _: () =
                msg_send![&*options, setObject: &*ns(name), forKey: &*ns("ApplicationName")];
        }
        if let Some(image) = about
            .icon_path
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(image_from_file)
        {
            let _: () = msg_send![&*options, setObject: &*image, forKey: &*ns("ApplicationIcon")];
        }
        let app = shared_application();
        let _: () = msg_send![app, activateIgnoringOtherApps: true];
        let _: () = msg_send![app, orderFrontStandardAboutPanelWithOptions: &*options];
    }
}

/// `app.init`'s `activationPolicy`: `regular` (Dock icon and menu bar), `accessory` (neither, can still show windows),
/// `prohibited` (no UI). Answers whether AppKit accepted it.
pub fn set_activation_policy(policy: &str) -> bool {
    // NSApplicationActivationPolicyRegular 0, Accessory 1, Prohibited 2.
    let value: isize = match policy {
        "regular" => 0,
        "accessory" => 1,
        "prohibited" => 2,
        _ => return false,
    };
    // SAFETY: `setActivationPolicy:` takes an NSInteger and answers a BOOL.
    unsafe { msg_send![shared_application(), setActivationPolicy: value] }
}

/// `app.setAsDefaultProtocolClient`: Launch Services makes this app bundle the handler of `protocol://`. The scheme
/// must be declared in the bundle's `CFBundleURLTypes` (the packaging does); an unbundled executable has no bundle
/// identifier, so a dev run answers false. Any thread.
pub fn register_default_protocol(protocol: &str) -> bool {
    let valid = !protocol.is_empty()
        && protocol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid {
        return false;
    }
    // SAFETY: `mainBundle` and `bundleIdentifier` are plain getters; both NSStrings are toll-free bridged CFStrings that
    // live (the scheme as the retained local, the identifier as the bundle's) for the call.
    unsafe {
        let bundle: *mut AnyObject = msg_send![class!(NSBundle), mainBundle];
        let identifier: *mut AnyObject = msg_send![bundle, bundleIdentifier];
        if identifier.is_null() {
            return false;
        }
        let scheme = ns(&protocol.to_ascii_lowercase());
        LSSetDefaultHandlerForURLScheme(
            (&*scheme as *const NSString).cast::<AnyObject>(),
            identifier,
        ) == 0
    }
}
