//! Min / max / close drawn as one small native popup window owned by the top-level HWND (138 x 48 DIP, top right).
//! Views overlays and Win32 child windows both end up under the web contents' DirectComposition surface, an owned popup stays above it.
use crate::{BAR_H, CAPTION_W, log, window_action};
use serde_json::json;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{HiDpi::GetDpiForWindow, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

const WM_MOUSELEAVE: u32 = 0x02A3;

static CAPTION: AtomicIsize = AtomicIsize::new(0);
static HOVER: AtomicIsize = AtomicIsize::new(-1);

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn scale(h: HWND) -> f32 {
    if h.is_null() {
        return 1.0;
    }
    let dpi = unsafe { GetDpiForWindow(h) };
    if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 }
}

fn zone(h: HWND, x: i32) -> isize {
    let cw = (CAPTION_W as f32 * scale(h)) as i32;
    ((x * 3) / cw.max(1)).clamp(0, 2) as isize
}

unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let dc = BeginPaint(h, &mut ps);
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(h, &mut r);
                let cell = (r.right - r.left) / 3;
                let hover = HOVER.load(Ordering::Relaxed);
                let maximized = {
                    let top = GetWindow(h, GW_OWNER);
                    IsZoomed(top) != 0
                };
                let glyphs = ["\u{E921}", if maximized { "\u{E923}" } else { "\u{E922}" }, "\u{E8BB}"];
                let font = CreateFontW(
                    -(10.0 * scale(h)) as i32 * 13 / 10,
                    0,
                    0,
                    0,
                    FW_NORMAL as i32,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET as u32,
                    OUT_DEFAULT_PRECIS as u32,
                    CLIP_DEFAULT_PRECIS as u32,
                    CLEARTYPE_QUALITY as u32,
                    DEFAULT_PITCH as u32,
                    w("Segoe MDL2 Assets").as_ptr(),
                );
                let old = SelectObject(dc, font);
                SetBkMode(dc, TRANSPARENT as i32);
                for i in 0..3 {
                    let cr = RECT { left: r.left + cell * i, top: r.top, right: r.left + cell * (i + 1), bottom: r.bottom };
                    let bg = if hover == i as isize {
                        if i == 2 { 0x2311E8 } else { 0x3A3A3A }
                    } else {
                        0x242120
                    };
                    let br = CreateSolidBrush(bg);
                    FillRect(dc, &cr, br);
                    DeleteObject(br);
                    SetTextColor(dc, 0xFFFFFF);
                    let mut cr2 = cr;
                    let g = w(glyphs[i as usize]);
                    DrawTextW(dc, g.as_ptr(), -1, &mut cr2, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                }
                SelectObject(dc, old);
                DeleteObject(font);
                EndPaint(h, &ps);
                0
            }
            WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
            WM_MOUSEMOVE => {
                let x = (lp & 0xFFFF) as i16 as i32;
                let z = zone(h, x);
                if HOVER.swap(z, Ordering::Relaxed) != z {
                    InvalidateRect(h, std::ptr::null(), 0);
                }
                let mut t = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: h, dwHoverTime: 0 };
                TrackMouseEvent(&mut t);
                0
            }
            WM_MOUSELEAVE => {
                HOVER.store(-1, Ordering::Relaxed);
                InvalidateRect(h, std::ptr::null(), 0);
                0
            }
            WM_LBUTTONUP => {
                let x = (lp & 0xFFFF) as i16 as i32;
                let action = ["minimize", "maximize", "close"][zone(h, x) as usize];
                log("caption.click", json!({ "action": action }));
                window_action(action);
                0
            }
            _ => DefWindowProcW(h, msg, wp, lp),
        }
    }
}

/// Create (once) the caption child under `top` and place it at the client area's top right.
pub fn attach(top: HWND) {
    unsafe {
        let inst = GetModuleHandleW(std::ptr::null());
        let cls = w("OmpProtoCaption");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: inst,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: cls.as_ptr(),
        };
        let atom = RegisterClassW(&wc);
        let reg_err = GetLastError();
        let h = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, cls.as_ptr(), std::ptr::null(), WS_POPUP | WS_VISIBLE, 0, 0, 10, 10, top, std::ptr::null_mut(), inst, std::ptr::null());
        let err = GetLastError();
        CAPTION.store(h as isize, Ordering::Relaxed);
        log("caption.created", json!({ "ok": !h.is_null(), "top": top as isize,  "regError": reg_err, "lastError": err }));
        reposition();
    }
}

pub fn reposition() {
    let h = CAPTION.load(Ordering::Relaxed) as HWND;
    if h.is_null() {
        return;
    }
    unsafe {
        let top = GetWindow(h, GW_OWNER);
        let mut r: RECT = std::mem::zeroed();
        GetClientRect(top, &mut r);
        let s = scale(top);
        let (cw, ch) = ((CAPTION_W as f32 * s) as i32, (BAR_H as f32 * s) as i32);
        let mut p = POINT { x: r.right - cw, y: 0 };
        ClientToScreen(top, &mut p);
        let flags = if IsIconic(top) != 0 { SWP_NOACTIVATE | SWP_HIDEWINDOW } else { SWP_NOACTIVATE | SWP_SHOWWINDOW };
        SetWindowPos(h, HWND_TOP, p.x, p.y, cw, ch, flags);
        InvalidateRect(h, std::ptr::null(), 0);
    }
}
