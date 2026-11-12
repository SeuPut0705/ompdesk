//! Per-window Win32 operations Views does not offer: placement, opacity, click-through, taskbar and focus flags,
//! the window icon, the Mica backdrop.

use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmExtendFrameIntoClientArea, DwmSetWindowAttribute};
use windows_sys::Win32::UI::Controls::MARGINS;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, GetWindowPlacement, ICON_BIG, ICON_SMALL, IMAGE_ICON,
    LR_DEFAULTSIZE, LR_LOADFROMFILE, LWA_ALPHA, LoadImageW, SendMessageW,
    SetLayeredWindowAttributes, SetWindowLongPtrW, WINDOWPLACEMENT, WM_SETICON, WS_EX_APPWINDOW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn scale(hwnd: isize) -> f64 {
    // SAFETY: GetDpiForWindow reads a window's DPI; an invalid handle yields 0.
    let dpi = unsafe { GetDpiForWindow(hwnd as HWND) };
    if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 }
}

/// The restored rectangle in DIP (`x, y, width, height`), also while the window is maximized or minimized.
pub fn normal_rect(hwnd: isize) -> Option<(i32, i32, i32, i32)> {
    // SAFETY: WINDOWPLACEMENT with its length set, for a window handle.
    let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
    placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    // SAFETY: as above; the call fills `placement`.
    if unsafe { GetWindowPlacement(hwnd as HWND, &mut placement) } == 0 {
        return None;
    }
    let RECT {
        left,
        top,
        right,
        bottom,
    } = placement.rcNormalPosition;
    let s = scale(hwnd);
    Some((
        (f64::from(left) / s).round() as i32,
        (f64::from(top) / s).round() as i32,
        (f64::from(right - left) / s).round() as i32,
        (f64::from(bottom - top) / s).round() as i32,
    ))
}

fn ex_style(hwnd: isize) -> isize {
    // SAFETY: reads a window's extended style.
    unsafe { GetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE) }
}

fn set_ex_style(hwnd: isize, style: isize) {
    // SAFETY: writes a window's extended style; the window is ours.
    unsafe { SetWindowLongPtrW(hwnd as HWND, GWL_EXSTYLE, style) };
}

fn modify_ex(hwnd: isize, add: u32, remove: u32) {
    set_ex_style(hwnd, (ex_style(hwnd) | add as isize) & !(remove as isize));
}

/// 0.0 (invisible) to 1.0 (opaque).
pub fn set_opacity(hwnd: isize, opacity: f64) {
    let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
    if alpha == 255 {
        modify_ex(hwnd, 0, WS_EX_LAYERED);
        return;
    }
    modify_ex(hwnd, WS_EX_LAYERED, 0);
    // SAFETY: a layered window of ours; no colour key.
    unsafe { SetLayeredWindowAttributes(hwnd as HWND, 0, alpha, LWA_ALPHA) };
}

pub fn set_ignore_mouse(hwnd: isize, ignore: bool) {
    if ignore {
        modify_ex(hwnd, WS_EX_TRANSPARENT | WS_EX_LAYERED, 0);
    } else {
        modify_ex(hwnd, 0, WS_EX_TRANSPARENT);
    }
}

pub fn set_skip_taskbar(hwnd: isize, skip: bool) {
    if skip {
        modify_ex(hwnd, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW);
    } else {
        modify_ex(hwnd, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW);
    }
}

pub fn set_focusable(hwnd: isize, focusable: bool) {
    if focusable {
        modify_ex(hwnd, 0, WS_EX_NOACTIVATE);
    } else {
        modify_ex(hwnd, WS_EX_NOACTIVATE, 0);
    }
}

/// An `.ico` file as the window's big and small icon.
pub fn set_icon(hwnd: isize, path: &str) -> bool {
    let name = wide(path);
    for (kind, size) in [(ICON_BIG, 32), (ICON_SMALL, 16)] {
        // SAFETY: loads an icon from a file path (NUL-terminated); the HICON is handed to the window, which keeps it.
        let icon = unsafe {
            LoadImageW(
                std::ptr::null_mut(),
                name.as_ptr(),
                IMAGE_ICON,
                size,
                size,
                LR_LOADFROMFILE | LR_DEFAULTSIZE,
            )
        };
        if icon.is_null() {
            return false;
        }
        // SAFETY: WM_SETICON with a valid icon handle for a window of ours.
        unsafe { SendMessageW(hwnd as HWND, WM_SETICON, kind as usize, icon as isize) };
    }
    true
}

/// The Mica backdrop (`DWMWA_SYSTEMBACKDROP_TYPE` = main window): needs the frame extended over the client area.
pub fn set_mica(hwnd: isize, on: bool) {
    let backdrop: i32 = if on { 2 } else { 0 };
    // SAFETY: DwmSetWindowAttribute with a 4-byte value for a window of ours; margins are a plain struct.
    unsafe {
        DwmSetWindowAttribute(hwnd as HWND, 38, (&backdrop as *const i32).cast(), 4);
        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        if on {
            DwmExtendFrameIntoClientArea(hwnd as HWND, &margins);
        }
    }
}
