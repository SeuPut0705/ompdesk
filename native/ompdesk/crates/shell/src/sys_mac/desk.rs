// UNVERIFIED on macOS: written against objc2 0.6 / block2 0.6 and the C frameworks' headers; never compiled.
//! macOS counterpart of `sys::desk`: the system's notifications (sleep/wake, session lock, power source, screens,
//! appearance), global hotkeys (Carbon `RegisterEventHotKey`), power assertions and the small queries behind
//! `screen.*`, `theme.*`, `power.*` and `system.*`. Everything runs on the main thread. Objective-C is reached with
//! runtime `msg_send!` calls so no per-class cargo feature is needed.
#![allow(unsafe_code)]

use std::ffi::{CStr, CString, c_char, c_void};
use std::ptr::{null, null_mut};
use std::sync::{Mutex, OnceLock};

use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use serde_json::{Value, json};

use crate::desk_state::Msg;
use crate::hotkey::{self, Hotkey};

type CFTypeRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    origin: Point,
    size: Size,
}
// SAFETY: these mirror CGPoint / CGSize / CGRect (NSPoint / NSSize / NSRect on 64-bit) field for field.
unsafe impl objc2::Encode for Point {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "CGPoint",
        &[objc2::Encoding::Double, objc2::Encoding::Double],
    );
}
// SAFETY: see above.
unsafe impl objc2::Encode for Size {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "CGSize",
        &[objc2::Encoding::Double, objc2::Encoding::Double],
    );
}
// SAFETY: see above.
unsafe impl objc2::Encode for Rect {
    const ENCODING: objc2::Encoding =
        objc2::Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    static kCFRunLoopCommonModes: CFTypeRef;
    fn CFDictionaryCreate(
        alloc: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        n: isize,
        kcb: *const c_void,
        vcb: *const c_void,
    ) -> CFTypeRef;
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, encoding: u32) -> CFTypeRef;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFRelease(o: CFTypeRef);
    fn CFRunLoopGetMain() -> CFTypeRef;
    fn CFRunLoopAddSource(rl: CFTypeRef, source: CFTypeRef, mode: CFTypeRef);
}
const UTF8: u32 = 0x0800_0100;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    static kAXTrustedCheckOptionPrompt: CFTypeRef;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    fn CGPreflightScreenCaptureAccess() -> u8;
    fn CGDisplayIsBuiltin(id: u32) -> u32;
    fn CGDisplayRotation(id: u32) -> f64;
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
    fn IOPSGetProvidingPowerSourceType(blob: CFTypeRef) -> CFTypeRef;
    fn IOPSNotificationCreateRunLoopSource(
        callback: extern "C" fn(*mut c_void),
        context: *mut c_void,
    ) -> CFTypeRef;
    fn IOPMAssertionCreateWithName(
        kind: CFTypeRef,
        level: u32,
        name: CFTypeRef,
        id: *mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

#[link(name = "SystemConfiguration", kind = "framework")]
unsafe extern "C" {
    fn SCNetworkReachabilityCreateWithAddress(alloc: CFTypeRef, addr: *const c_void) -> CFTypeRef;
    fn SCNetworkReachabilityGetFlags(target: CFTypeRef, flags: *mut u32) -> u8;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> *mut c_void;
    fn InstallEventHandler(
        target: *mut c_void,
        handler: extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32,
        n: u32,
        types: *const EventTypeSpec,
        data: *mut c_void,
        out: *mut *mut c_void,
    ) -> i32;
    fn RegisterEventHotKey(
        code: u32,
        mods: u32,
        id: EventHotKeyId,
        target: *mut c_void,
        options: u32,
        out: *mut *mut c_void,
    ) -> i32;
    fn UnregisterEventHotKey(r: *mut c_void) -> i32;
    fn GetEventParameter(
        event: *mut c_void,
        name: u32,
        kind: u32,
        actual: *mut u32,
        size: u32,
        actual_size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

#[repr(C)]
struct EventTypeSpec {
    class: u32,
    kind: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct EventHotKeyId {
    signature: u32,
    id: u32,
}

static HANDLER: OnceLock<fn(Msg)> = OnceLock::new();
/// Hotkey id -> Carbon reference (as usize: the pointer is only handed back to Carbon).
static HOTKEYS: Mutex<Vec<(i32, usize)>> = Mutex::new(Vec::new());
/// `[system sleep assertion, display sleep assertion]`, 0 when not held.
static ASSERTIONS: Mutex<[u32; 2]> = Mutex::new([0, 0]);

fn emit(msg: Msg) {
    if let Some(handler) = HANDLER.get() {
        handler(msg);
    }
}

fn nsstring(s: &CStr) -> *mut AnyObject {
    // SAFETY: `s` is NUL-terminated; the returned autoreleased NSString is used within the calling statement's pool.
    unsafe { msg_send![class!(NSString), stringWithUTF8String: s.as_ptr()] }
}

fn cfstring(s: &str) -> CFTypeRef {
    let c = CString::new(s).unwrap_or_default();
    // SAFETY: `c` is NUL-terminated; the caller releases the result.
    unsafe { CFStringCreateWithCString(null(), c.as_ptr(), UTF8) }
}

fn observe(center: *mut AnyObject, name: &CStr, msg: Msg) {
    let block = RcBlock::new(move |_notification: *mut AnyObject| emit(msg));
    // SAFETY: `center` is a live notification center; the name is an NSString; the center copies the block, which
    // lives for the rest of the process (the observer is never removed).
    unsafe {
        let _: *mut AnyObject = msg_send![center, addObserverForName: nsstring(name), object: null_mut::<AnyObject>(), queue: null_mut::<AnyObject>(), usingBlock: &*block];
    }
}

extern "C" fn power_source_changed(_context: *mut c_void) {
    emit(Msg::PowerStatus);
}

extern "C" fn hotkey_pressed(_next: *mut c_void, event: *mut c_void, _data: *mut c_void) -> i32 {
    let mut id = EventHotKeyId {
        signature: 0,
        id: 0,
    };
    // SAFETY: the event is Carbon's hot-key event; the out-buffer is an EventHotKeyID of the declared size.
    let status = unsafe {
        GetEventParameter(
            event,
            0x2D2D_2D2D,
            0x686B_6964,
            null_mut(),
            std::mem::size_of::<EventHotKeyId>() as u32,
            null_mut(),
            (&mut id as *mut EventHotKeyId).cast(),
        )
    };
    if status == 0 {
        emit(Msg::Hotkey(id.id as i32));
    }
    0
}

/// Subscribes to the system's notifications; main thread, once.
pub fn init(handler: fn(Msg)) -> Result<(), String> {
    if HANDLER.set(handler).is_err() {
        return Err("the system observers exist already".into());
    }
    // SAFETY: plain class messages on the main thread; every pointer comes from AppKit and stays valid.
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let ws_center: *mut AnyObject = msg_send![workspace, notificationCenter];
        observe(ws_center, c"NSWorkspaceWillSleepNotification", Msg::Suspend);
        observe(ws_center, c"NSWorkspaceDidWakeNotification", Msg::Resume);
        observe(
            ws_center,
            c"NSWorkspaceSessionDidResignActiveNotification",
            Msg::Lock,
        );
        observe(
            ws_center,
            c"NSWorkspaceSessionDidBecomeActiveNotification",
            Msg::Unlock,
        );
        observe(
            ws_center,
            c"NSWorkspaceWillPowerOffNotification",
            Msg::Shutdown,
        );
        observe(
            ws_center,
            c"NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification",
            Msg::SettingChange,
        );
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        observe(
            center,
            c"NSApplicationDidChangeScreenParametersNotification",
            Msg::DisplayChange,
        );
        let distributed: *mut AnyObject =
            msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
        observe(
            distributed,
            c"AppleInterfaceThemeChangedNotification",
            Msg::SettingChange,
        );

        let source = IOPSNotificationCreateRunLoopSource(power_source_changed, null_mut());
        if !source.is_null() {
            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
        }
        let types = EventTypeSpec {
            class: 0x6B65_7962,
            kind: 5,
        };
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            hotkey_pressed,
            1,
            &types,
            null_mut(),
            null_mut(),
        );
        if status != 0 {
            return Err(format!("InstallEventHandler failed: {status}"));
        }
    }
    Ok(())
}

pub fn register_hotkey(id: i32, accelerator: &Hotkey) -> bool {
    let Some(code) = hotkey::mac_keycode(&accelerator.key) else {
        return false;
    };
    let mut reference: *mut c_void = null_mut();
    // SAFETY: Carbon call with plain integers and an out-pointer to a local.
    let status = unsafe {
        RegisterEventHotKey(
            code,
            hotkey::mac_mods(accelerator.mods),
            EventHotKeyId {
                signature: 0x6F6D_7064,
                id: id as u32,
            },
            GetApplicationEventTarget(),
            0,
            &mut reference,
        )
    };
    if status != 0 || reference.is_null() {
        return false;
    }
    HOTKEYS.lock().unwrap().push((id, reference as usize));
    true
}

pub fn unregister_hotkey(id: i32) {
    let mut hotkeys = HOTKEYS.lock().unwrap();
    if let Some(at) = hotkeys.iter().position(|(h, _)| *h == id) {
        let (_, reference) = hotkeys.remove(at);
        // SAFETY: `reference` came from RegisterEventHotKey and is released once.
        unsafe { UnregisterEventHotKey(reference as *mut c_void) };
    }
}

fn primary_height() -> f64 {
    // SAFETY: `screens` is an NSArray of NSScreen; the first is the primary one.
    unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        let first: *mut AnyObject = msg_send![screens, firstObject];
        if first.is_null() {
            return 0.0;
        }
        let frame: Rect = msg_send![first, frame];
        frame.size.height
    }
}

/// `[NSEvent mouseLocation]` in DIP, top-left origin of the primary screen.
pub fn cursor_point() -> Result<(f64, f64), String> {
    // SAFETY: a class message with no arguments.
    let at: Point = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    Ok((at.x, primary_height() - at.y))
}

/// Holds or drops the two sleep assertions to match `system` / `display`.
pub fn set_blockers(system: bool, display: bool) -> Result<(), String> {
    let mut held = ASSERTIONS.lock().unwrap();
    for (slot, (wanted, kind)) in [
        (system, "PreventUserIdleSystemSleep"),
        (display, "PreventUserIdleDisplaySleep"),
    ]
    .into_iter()
    .enumerate()
    {
        if wanted && held[slot] == 0 {
            let (kind, name) = (cfstring(kind), cfstring("OMPdesk"));
            let mut id = 0u32;
            // SAFETY: valid CFStrings (released right after), level 255 = kIOPMAssertionLevelOn, `id` an out-parameter.
            let status = unsafe { IOPMAssertionCreateWithName(kind, 255, name, &mut id) };
            // SAFETY: both strings were created above.
            unsafe {
                CFRelease(kind);
                CFRelease(name);
            }
            if status != 0 {
                return Err(format!("IOPMAssertionCreateWithName failed: {status}"));
            }
            held[slot] = id;
        } else if !wanted && held[slot] != 0 {
            // SAFETY: the id came from IOPMAssertionCreateWithName and is released once.
            unsafe { IOPMAssertionRelease(held[slot]) };
            held[slot] = 0;
        }
    }
    Ok(())
}

pub fn accessibility_trusted(prompt: bool) -> bool {
    // SAFETY: the options dictionary is built from CF constants and released after the call.
    unsafe {
        if !prompt {
            return AXIsProcessTrustedWithOptions(null()) != 0;
        }
        let keys = [kAXTrustedCheckOptionPrompt];
        let values = [kCFBooleanTrue];
        let options = CFDictionaryCreate(
            null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &raw const kCFTypeDictionaryKeyCallBacks,
            &raw const kCFTypeDictionaryValueCallBacks,
        );
        let trusted = AXIsProcessTrustedWithOptions(options) != 0;
        if !options.is_null() {
            CFRelease(options);
        }
        trusted
    }
}

pub fn media_access_status(media_type: &str) -> &'static str {
    if media_type == "screen" {
        // SAFETY: no arguments.
        if unsafe { CGPreflightScreenCaptureAccess() } != 0 {
            "granted"
        } else {
            "denied"
        }
    } else {
        "not-determined"
    }
}

fn workspace_flag(selector_is: fn(*mut AnyObject) -> bool) -> bool {
    // SAFETY: sharedWorkspace is a class message returning a live singleton.
    let workspace: *mut AnyObject = unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
    selector_is(workspace)
}

/// `{dark, highContrast, inverted}`.
pub fn theme() -> Value {
    // SAFETY: NSUserDefaults reads; the string is converted before the autorelease pool drains.
    let dark = unsafe {
        let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let style: *mut AnyObject =
            msg_send![defaults, stringForKey: nsstring(c"AppleInterfaceStyle")];
        if style.is_null() {
            false
        } else {
            let text: *const c_char = msg_send![style, UTF8String];
            !text.is_null() && CStr::from_ptr(text).to_bytes() == b"Dark"
        }
    };
    // SAFETY: boolean property reads on the shared workspace.
    let high_contrast =
        workspace_flag(|w| unsafe { msg_send![w, accessibilityDisplayShouldIncreaseContrast] });
    // SAFETY: as above.
    let inverted =
        workspace_flag(|w| unsafe { msg_send![w, accessibilityDisplayShouldInvertColors] });
    json!({ "dark": dark, "highContrast": high_contrast, "inverted": inverted })
}

pub fn reduced_motion() -> bool {
    // SAFETY: boolean property read on the shared workspace.
    workspace_flag(|w| unsafe { msg_send![w, accessibilityDisplayShouldReduceMotion] })
}

pub fn on_battery() -> bool {
    // SAFETY: IOKit returns owned CF objects released below; the type string is read into a local buffer.
    unsafe {
        let blob = IOPSCopyPowerSourcesInfo();
        if blob.is_null() {
            return false;
        }
        let kind = IOPSGetProvidingPowerSourceType(blob);
        let mut buf = [0 as c_char; 64];
        let battery = !kind.is_null()
            && CFStringGetCString(kind, buf.as_mut_ptr(), 64, UTF8) != 0
            && CStr::from_ptr(buf.as_ptr()).to_bytes() == b"Battery Power";
        CFRelease(blob);
        battery
    }
}

pub fn idle_seconds() -> u64 {
    // SAFETY: state 0 = combined session, event type !0 = any input event.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    if seconds.is_finite() && seconds > 0.0 {
        seconds as u64
    } else {
        0
    }
}

/// Reachability of the default route (an unspecified IPv4 address): reachable and no connection needed.
pub fn online() -> bool {
    let address: [u8; 16] = [16, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // SAFETY: `address` is a zeroed sockaddr_in (length 16, AF_INET); the reachability ref is released.
    unsafe {
        let target = SCNetworkReachabilityCreateWithAddress(null(), address.as_ptr().cast());
        if target.is_null() {
            return true;
        }
        let mut flags = 0u32;
        let ok = SCNetworkReachabilityGetFlags(target, &mut flags) != 0;
        CFRelease(target);
        ok && flags & 0x2 != 0 && flags & 0x4 == 0
    }
}

/// NSScreen list as DIP rectangles with the primary screen's top-left origin.
pub fn displays() -> (Vec<Value>, i64) {
    let height = primary_height();
    let dip = |r: Rect| json!({ "x": r.origin.x.round() as i64, "y": (height - r.origin.y - r.size.height).round() as i64, "width": r.size.width.round() as i64, "height": r.size.height.round() as i64 });
    let mut out = Vec::new();
    let mut primary = 0i64;
    // SAFETY: NSScreen / NSDictionary / NSNumber reads on the main thread; strings are converted at once.
    unsafe {
        let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
        let count: usize = msg_send![screens, count];
        for index in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: index];
            let frame: Rect = msg_send![screen, frame];
            let work: Rect = msg_send![screen, visibleFrame];
            let scale: f64 = msg_send![screen, backingScaleFactor];
            let description: *mut AnyObject = msg_send![screen, deviceDescription];
            let number: *mut AnyObject =
                msg_send![description, objectForKey: nsstring(c"NSScreenNumber")];
            let id: u32 = if number.is_null() {
                index as u32 + 1
            } else {
                msg_send![number, unsignedIntValue]
            };
            let name: *mut AnyObject = msg_send![screen, localizedName];
            let label = if name.is_null() {
                String::new()
            } else {
                let text: *const c_char = msg_send![name, UTF8String];
                if text.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(text).to_string_lossy().into_owned()
                }
            };
            if index == 0 {
                primary = i64::from(id);
            }
            out.push(json!({
                "id": id,
                "label": label,
                "bounds": dip(frame),
                "workArea": dip(work),
                "scaleFactor": scale,
                "rotation": CGDisplayRotation(id) as i64,
                "internal": CGDisplayIsBuiltin(id) != 0,
                "colorDepth": 24,
            }));
        }
    }
    (out, primary)
}
