use serde_json::{Value, json};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, SendMessageW, WM_NCHITTEST, WindowFromPoint};

fn class(h: HWND) -> String {
    let mut b = [0u16; 128];
    let n = unsafe { GetClassNameW(h, &mut b) } as usize;
    String::from_utf16_lossy(&b[..n])
}

fn name(code: isize) -> &'static str {
    match code {
        0 => "HTNOWHERE",
        1 => "HTCLIENT",
        2 => "HTCAPTION",
        -1 => "HTTRANSPARENT",
        10 => "HTMINBUTTON",
        20 => "HTCLOSE",
        _ => "other",
    }
}

/// WM_NCHITTEST at CSS-pixel client points (label, x, y): sent to the top-level window and to the window under the point.
pub fn hit_test(hwnd: isize, scale: f64, pts: &[(String, f64, f64)]) -> Value {
    let h = HWND(hwnd as _);
    let mut o = POINT { x: 0, y: 0 };
    unsafe { let _ = ClientToScreen(h, &mut o); }
    let mut out = vec![];
    for (label, cx, cy) in pts {
        let (x, y) = (o.x + (cx * scale).round() as i32, o.y + (cy * scale).round() as i32);
        let lp = LPARAM((((y as u32 & 0xffff) << 16) | (x as u32 & 0xffff)) as isize);
        let top = unsafe { SendMessageW(h, WM_NCHITTEST, Some(WPARAM(0)), Some(lp)) }.0;
        let under = unsafe { WindowFromPoint(POINT { x, y }) };
        let child = unsafe { SendMessageW(under, WM_NCHITTEST, Some(WPARAM(0)), Some(lp)) }.0;
        out.push(json!({"at": label, "x": x, "y": y, "topLevel": name(top), "windowUnder": class(under), "windowUnderHit": name(child)}));
    }
    json!({"points": out})
}

/// Top-level subclass: WM_NCHITTEST answers what the window under the point answers when that is HTCAPTION.
/// (A real mouse hits the WebView2 child first, which already answers HTCAPTION; this makes a probe of the top-level agree.)
pub fn install_forwarder(hwnd: isize) {
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::IsChild;
    use std::cell::Cell;
    thread_local!(static BUSY: Cell<bool> = const { Cell::new(false) });
    unsafe extern "system" fn proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM, _id: usize, _d: usize) -> LRESULT {
        unsafe {
            if msg == WM_NCHITTEST && !BUSY.with(|b| b.replace(true)) {
                let (x, y) = ((l.0 & 0xffff) as i16 as i32, ((l.0 >> 16) & 0xffff) as i16 as i32);
                let under = WindowFromPoint(POINT { x, y });
                let mut res = None;
                if under != h && IsChild(h, under).as_bool() {
                    let r = SendMessageW(under, WM_NCHITTEST, Some(w), Some(l));
                    if r.0 == 2 {
                        res = Some(r);
                    }
                }
                BUSY.with(|b| b.set(false));
                if let Some(r) = res {
                    return r;
                }
            }
            DefSubclassProc(h, msg, w, l)
        }
    }
    unsafe {
        let _ = SetWindowSubclass(HWND(hwnd as _), Some(proc), 0x0A1B, 0);
    }
}

/// WebView2 (WRY_WEBVIEW) sits above the foreign child window in z-order: put the preview-host's child window on top.
/// Returns how many windows were raised.
pub fn raise_host_child(parent: isize, pid: u32) -> usize {
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetParent, GetWindowThreadProcessId, HWND_TOP, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};
    use windows::core::BOOL;
    struct Ctx { parent: HWND, pid: u32, n: usize }
    unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
        unsafe {
            let c = &mut *(l.0 as *mut Ctx);
            let mut p = 0u32;
            GetWindowThreadProcessId(h, Some(&mut p));
            if p == c.pid && GetParent(h).ok() == Some(c.parent) {
                let _ = SetWindowPos(h, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
                c.n += 1;
            }
        }
        BOOL(1)
    }
    let mut c = Ctx { parent: HWND(parent as _), pid, n: 0 };
    unsafe { let _ = EnumChildWindows(Some(c.parent), Some(each), LPARAM(&mut c as *mut Ctx as isize)); }
    c.n
}
