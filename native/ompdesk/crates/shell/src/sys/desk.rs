//! The hidden window that receives the system's broadcasts (power, session, settings, display, hotkeys), plus the small
//! calls the screen / power / shortcut namespaces make. A message-only window would not get the broadcasts
//! (`WM_POWERBROADCAST`, `WM_QUERYENDSESSION`, `WM_SETTINGCHANGE`, `WM_DISPLAYCHANGE`), so this is a never-shown
//! top-level popup. Every function here runs on the thread that called `init` (CEF's UI thread).

use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromPoint};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::SetThreadExecutionState;
use windows_sys::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetCursorPos, RegisterClassExW, WM_DISPLAYCHANGE,
    WM_ENDSESSION, WM_HOTKEY, WM_POWERBROADCAST, WM_QUERYENDSESSION, WM_SETTINGCHANGE, WNDCLASSEXW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};

pub use super::system::{displays, idle_seconds, on_battery, online, reduced_motion, theme};
use crate::desk_state::{Msg, execution_flags};
use crate::hotkey::{self, Hotkey};

const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
const WTS_SESSION_LOCK: usize = 7;
const WTS_SESSION_UNLOCK: usize = 8;
const PBT_APMSUSPEND: usize = 0x4;
const PBT_APMRESUMESUSPEND: usize = 0x7;
const PBT_APMPOWERSTATUSCHANGE: usize = 0xA;
const PBT_APMRESUMEAUTOMATIC: usize = 0x12;

static HANDLER: OnceLock<fn(Msg)> = OnceLock::new();
static WINDOW: AtomicUsize = AtomicUsize::new(0);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn emit(msg: Msg) {
    if let Some(handler) = HANDLER.get() {
        handler(msg);
    }
}

unsafe extern "system" fn proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_POWERBROADCAST => {
            match wparam {
                PBT_APMSUSPEND => emit(Msg::Suspend),
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => emit(Msg::Resume),
                PBT_APMPOWERSTATUSCHANGE => emit(Msg::PowerStatus),
                _ => {}
            }
            1
        }
        WM_WTSSESSION_CHANGE => {
            match wparam {
                WTS_SESSION_LOCK => emit(Msg::Lock),
                WTS_SESSION_UNLOCK => emit(Msg::Unlock),
                _ => {}
            }
            0
        }
        // Electron reports `shutdown` from the query (the earlier of the two); the session ends whatever we answer.
        WM_QUERYENDSESSION => {
            emit(Msg::Shutdown);
            1
        }
        WM_ENDSESSION => 0,
        WM_SETTINGCHANGE => {
            emit(Msg::SettingChange);
            0
        }
        WM_DISPLAYCHANGE => {
            emit(Msg::DisplayChange);
            0
        }
        WM_HOTKEY => {
            emit(Msg::Hotkey(wparam as i32));
            0
        }
        // SAFETY: the arguments are the ones the system handed this window procedure.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

/// Creates the hidden window on the calling thread and starts delivering `Msg`s to `handler`.
pub fn init(handler: fn(Msg)) -> Result<(), String> {
    if HANDLER.set(handler).is_err() {
        return Err("the message window exists already".into());
    }
    let class = wide("OmpdeskShellMessages");
    // SAFETY: a null module name asks for this executable's handle.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        style: 0,
        lpfnWndProc: Some(proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class.as_ptr(),
        hIconSm: std::ptr::null_mut(),
    };
    // SAFETY: `wc` is fully initialised and `class` outlives the call.
    if unsafe { RegisterClassExW(&wc) } == 0 {
        return Err(format!(
            "RegisterClassExW failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: the class was just registered; the window is a zero-size popup that is never shown.
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.as_ptr(),
            class.as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if hwnd.is_null() {
        return Err(format!(
            "CreateWindowExW failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    WINDOW.store(hwnd as usize, Ordering::Release);
    // SAFETY: `hwnd` is the live window just created; a refusal only costs lock/unlock events.
    unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) };
    Ok(())
}

fn hwnd() -> HWND {
    WINDOW.load(Ordering::Acquire) as HWND
}

/// Registers `accelerator` as hotkey `id` on the hidden window; false when the combination is taken or has no
/// Windows key code.
pub fn register_hotkey(id: i32, accelerator: &Hotkey) -> bool {
    let Some(vk) = hotkey::win_vk(&accelerator.key) else {
        return false;
    };
    let window = hwnd();
    if window.is_null() {
        return false;
    }
    // SAFETY: `window` is the hidden window, owned by this thread; id and codes are plain integers.
    unsafe { RegisterHotKey(window, id, hotkey::win_mods(accelerator.mods), vk) != 0 }
}

pub fn unregister_hotkey(id: i32) {
    // SAFETY: unregistering an id this window registered (or none) is harmless.
    unsafe { UnregisterHotKey(hwnd(), id) };
}

/// Cursor position in DIP of the monitor under it, as `screen.getCursorScreenPoint()`.
pub fn cursor_point() -> Result<(f64, f64), String> {
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: `point` is a POINT the call fills.
    if unsafe { GetCursorPos(&mut point) } == 0 {
        return Err(format!(
            "GetCursorPos failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `point` is a valid screen point; the nearest monitor always exists.
    let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
    // SAFETY: the out-parameters are two u32s.
    unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    let scale = f64::from(dpi_x.max(96)) / 96.0;
    Ok((f64::from(point.x) / scale, f64::from(point.y) / scale))
}

/// Applies the live blockers to this thread's execution state (`ES_CONTINUOUS`; empty clears it).
pub fn set_blockers(system: bool, display: bool) -> Result<(), String> {
    // SAFETY: SetThreadExecutionState takes flags only; it affects the calling thread.
    if unsafe { SetThreadExecutionState(execution_flags(system, display)) } == 0 {
        return Err(format!(
            "SetThreadExecutionState failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub fn accessibility_trusted(_prompt: bool) -> bool {
    false
}

pub fn media_access_status(_media_type: &str) -> &'static str {
    "not-determined"
}
