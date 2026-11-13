// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! The `win.op` ops Views does not give, on the `NSWindow` behind a CEF Views window. A Views window's
//! `window_handle()` is its content `NSView*`; `[view window]` is the `NSWindow`. Main thread.
//!
//! Not here, by design: `setSkipTaskbar` (macOS has no per-window taskbar entry), `setIcon` (the bundle owns the
//! icon) and `setFocusable` (whether a window can become key is `-[NSWindow canBecomeKeyWindow]`, a method of the
//! window's class that Views owns; neither AppKit nor CEF has a setter for it).
#![allow(unsafe_code)]

use std::ptr::null_mut;

use objc2::msg_send;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSPoint, NSRect, NSSize};

// NSWindowButton
const CLOSE_BUTTON: isize = 0;
const MINIATURIZE_BUTTON: isize = 1;
const ZOOM_BUTTON: isize = 2;
// NSWindowStyleMaskFullScreen
const FULL_SCREEN_MASK: usize = 1 << 14;

/// The `NSWindow` of the view `nsview` (null when the view is gone or not in a window).
fn window_of(nsview: isize) -> *mut AnyObject {
    if nsview == 0 {
        return null_mut();
    }
    // SAFETY: `nsview` is the NSView* CEF reported for a live Views window; `window` is a plain getter.
    unsafe { msg_send![nsview as *mut AnyObject, window] }
}

/// `setOpacity`: `NSWindow.alphaValue`, clamped to 0..1.
pub fn set_opacity(nsview: isize, value: f64) -> bool {
    let window = window_of(nsview);
    if window.is_null() {
        return false;
    }
    // SAFETY: `setAlphaValue:` takes a CGFloat.
    unsafe {
        let _: () = msg_send![window, setAlphaValue: value.clamp(0.0, 1.0)];
    }
    true
}

/// `setIgnoreMouseEvents`: clicks fall through to the windows behind. (`forward` has no AppKit counterpart: a window
/// that ignores the mouse gets no mouse-move events either.)
pub fn set_ignore_mouse_events(nsview: isize, ignore: bool) -> bool {
    let window = window_of(nsview);
    if window.is_null() {
        return false;
    }
    // SAFETY: `setIgnoresMouseEvents:` takes a BOOL.
    unsafe {
        let _: () = msg_send![window, setIgnoresMouseEvents: ignore];
    }
    true
}

/// Puts the three traffic-light buttons of a hidden-inset window at `trafficLightPosition {x, y}`: the left edge of
/// the close button `x` points from the window's left edge, the top of the buttons `y` points from its top (Electron's
/// meaning). The title bar container is resized to `button height + 2y` and pinned to the window's top, so the buttons
/// sit centred in it; the spacing between the buttons is the one AppKit chose. AppKit lays the container out again
/// on resize and on leaving full screen, so call this after both. Answers false when the window or its buttons do not
/// exist (a full-screen window moves the buttons into a separate toolbar window and is left alone).
pub fn apply_traffic_lights(nsview: isize, x: i32, y: i32) -> bool {
    let window = window_of(nsview);
    if window.is_null() {
        return false;
    }
    // SAFETY: AppKit getters and frame setters on the window's own title bar views, on the main thread; every pointer is
    // checked for nil before it is messaged.
    unsafe {
        let style: usize = msg_send![window, styleMask];
        if style & FULL_SCREEN_MASK != 0 {
            return false;
        }
        let buttons: [*mut AnyObject; 3] = [CLOSE_BUTTON, MINIATURIZE_BUTTON, ZOOM_BUTTON]
            .map(|kind: isize| msg_send![window, standardWindowButton: kind]);
        if buttons.iter().any(|b| b.is_null()) {
            return false;
        }
        let title_bar: *mut AnyObject = msg_send![buttons[0], superview];
        let container: *mut AnyObject = if title_bar.is_null() {
            null_mut()
        } else {
            msg_send![title_bar, superview]
        };
        if container.is_null() {
            return false;
        }
        let close: NSRect = msg_send![buttons[0], frame];
        let miniaturize: NSRect = msg_send![buttons[1], frame];
        let spacing = miniaturize.origin.x - close.origin.x;
        let window_frame: NSRect = msg_send![window, frame];
        let container_frame: NSRect = msg_send![container, frame];
        let margin = f64::from(y);
        let height = close.size.height + 2.0 * margin;
        let resized = NSRect {
            origin: NSPoint {
                x: container_frame.origin.x,
                y: window_frame.size.height - height,
            },
            size: NSSize {
                width: container_frame.size.width,
                height,
            },
        };
        let _: () = msg_send![container, setFrame: resized];
        for (index, button) in buttons.iter().enumerate() {
            let at = NSPoint {
                x: f64::from(x) + index as f64 * spacing,
                y: margin,
            };
            let _: () = msg_send![*button, setFrameOrigin: at];
        }
    }
    true
}

/// `NSApp.appearance` from `nativeTheme.themeSource`: `Some(true)` dark aqua, `Some(false)` aqua, `None` the system's.
/// Electron does exactly this.
pub fn set_app_appearance(dark: Option<bool>) {
    use objc2::class;
    use objc2_foundation::NSString;
    // SAFETY: NSApplication/NSAppearance class messages with live objects; `appearanceNamed:` returns nil for an
    // unknown name, which resets to the system appearance.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let appearance: *mut AnyObject = match dark {
            None => null_mut(),
            Some(d) => {
                let name = NSString::from_str(if d {
                    "NSAppearanceNameDarkAqua"
                } else {
                    "NSAppearanceNameAqua"
                });
                msg_send![class!(NSAppearance), appearanceNamed: &*name]
            }
        };
        let _: () = msg_send![app, setAppearance: appearance];
    }
}

static DOCK_PROGRESS: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

/// `setProgressBar` on the Dock icon, as Electron draws it: the dock tile gets a content view holding the app icon
/// and a bar-style `NSProgressIndicator`. `fraction`: `None` removes the bar, `Some(None)` indeterminate,
/// `Some(Some(f))` determinate 0..=1.
pub fn set_dock_progress(fraction: Option<Option<f64>>) {
    use objc2::class;
    let mut slot = DOCK_PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: AppKit messages on the main thread with objects created here or fetched from NSApplication; the
    // indicator is kept alive by the tile's content view, and `slot` holds its address only while that view is set.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let tile: *mut AnyObject = msg_send![app, dockTile];
        if tile.is_null() {
            return;
        }
        let Some(fraction) = fraction else {
            let none: *mut AnyObject = null_mut();
            let _: () = msg_send![tile, setContentView: none];
            let _: () = msg_send![tile, display];
            *slot = 0;
            return;
        };
        if *slot == 0 {
            let size: NSSize = msg_send![tile, size];
            let frame = NSRect {
                origin: NSPoint { x: 0.0, y: 0.0 },
                size,
            };
            let view: *mut AnyObject = msg_send![class!(NSImageView), alloc];
            let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
            let icon: *mut AnyObject = msg_send![app, applicationIconImage];
            let _: () = msg_send![view, setImage: icon];
            let bar_frame = NSRect {
                origin: NSPoint { x: 0.0, y: 0.0 },
                size: NSSize {
                    width: size.width,
                    height: 15.0,
                },
            };
            let bar: *mut AnyObject = msg_send![class!(NSProgressIndicator), alloc];
            let bar: *mut AnyObject = msg_send![bar, initWithFrame: bar_frame];
            let _: () = msg_send![bar, setStyle: 0isize]; // NSProgressIndicatorStyleBar
            let _: () = msg_send![bar, setMinValue: 0.0f64];
            let _: () = msg_send![bar, setMaxValue: 1.0f64];
            let _: () = msg_send![bar, setBezeled: true];
            let _: () = msg_send![view, addSubview: bar];
            let _: () = msg_send![tile, setContentView: view];
            *slot = bar as usize;
        }
        let bar = *slot as *mut AnyObject;
        match fraction {
            None => {
                let _: () = msg_send![bar, setIndeterminate: true];
                let _: () = msg_send![bar, startAnimation: null_mut::<AnyObject>()];
            }
            Some(f) => {
                let _: () = msg_send![bar, setIndeterminate: false];
                let _: () = msg_send![bar, setDoubleValue: f.clamp(0.0, 1.0)];
            }
        }
        let _: () = msg_send![tile, display];
    }
}
