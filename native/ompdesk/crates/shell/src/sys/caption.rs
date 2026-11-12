//! Windows: minimize / maximize / close drawn as one small native popup window owned by the top-level window
//! (138 × 48 DIP at its top right), in `titleBarOverlay`'s colours. Views overlays and Win32 child windows both end up
//! under the web contents' DirectComposition surface; an owned popup stays above it (measured in the prototype).

use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, ClientToScreen, CreateFontW,
    CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH, DT_CENTER, DT_SINGLELINE, DT_VCENTER,
    DeleteObject, DrawTextW, EndPaint, FW_NORMAL, FillRect, InvalidateRect, OUT_DEFAULT_PRECIS,
    PAINTSTRUCT, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    TME_LEAVE, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GW_OWNER, GWLP_USERDATA, GetClientRect,
    GetWindow, GetWindowLongPtrW, HWND_TOP, IDC_ARROW, IsIconic, IsZoomed, LoadCursorW,
    MA_NOACTIVATE, RegisterClassW, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    SetWindowLongPtrW, SetWindowPos, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_NCDESTROY,
    WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
};

const WM_MOUSELEAVE: u32 = 0x02A3;
/// Width of the three buttons, in DIP.
pub const CAPTION_W: i32 = 138;

static ACTION: OnceLock<fn(isize, &'static str)> = OnceLock::new();

/// Called on a click: the top-level window's HWND and `"minimize"`, `"maximize"` or `"close"`.
pub fn set_action_handler(f: fn(isize, &'static str)) {
    let _ = ACTION.set(f);
}

#[derive(Clone, Copy)]
pub struct Colors {
    /// `COLORREF`s.
    pub background: u32,
    pub symbol: u32,
    pub hover: u32,
    /// DIP.
    pub height: i32,
}

struct State {
    top: HWND,
    hover: i32,
    colors: Colors,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn scale(h: HWND) -> f32 {
    if h.is_null() {
        return 1.0;
    }
    // SAFETY: GetDpiForWindow reads a window's DPI; an invalid handle yields 0.
    let dpi = unsafe { GetDpiForWindow(h) };
    if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 }
}

fn zone(h: HWND, x: i32) -> i32 {
    let width = (CAPTION_W as f32 * scale(h)) as i32;
    ((x * 3) / width.max(1)).clamp(0, 2)
}

fn state<'a>(h: HWND) -> Option<&'a mut State> {
    // SAFETY: GWLP_USERDATA holds the `Box<State>` pointer `attach` stored, until WM_NCDESTROY clears it.
    let p = unsafe { GetWindowLongPtrW(h, GWLP_USERDATA) } as *mut State;
    // SAFETY: a non-null value is that live box; the window procedure runs on the thread that owns the window.
    unsafe { p.as_mut() }
}

unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    // SAFETY: a window procedure called by the system with valid arguments for its own window.
    unsafe {
        match msg {
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let dc = BeginPaint(h, &mut ps);
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(h, &mut r);
                let (hover, colors, top) = match state(h) {
                    Some(s) => (s.hover, s.colors, s.top),
                    None => (
                        -1,
                        Colors {
                            background: 0x242120,
                            symbol: 0xFFFFFF,
                            hover: 0x3A3A3A,
                            height: 48,
                        },
                        std::ptr::null_mut(),
                    ),
                };
                let cell = (r.right - r.left) / 3;
                let maximized = IsZoomed(top) != 0;
                let glyphs = [
                    "\u{E921}",
                    if maximized { "\u{E923}" } else { "\u{E922}" },
                    "\u{E8BB}",
                ];
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
                    wide("Segoe MDL2 Assets").as_ptr(),
                );
                let old = SelectObject(dc, font);
                SetBkMode(dc, TRANSPARENT as i32);
                for i in 0..3 {
                    let mut cr = RECT {
                        left: r.left + cell * i,
                        top: r.top,
                        right: r.left + cell * (i + 1),
                        bottom: r.bottom,
                    };
                    let (bg, fg) = if hover == i {
                        if i == 2 {
                            (0x2311E8, 0xFFFFFF)
                        } else {
                            (colors.hover, colors.symbol)
                        }
                    } else {
                        (colors.background, colors.symbol)
                    };
                    let brush = CreateSolidBrush(bg);
                    FillRect(dc, &cr, brush);
                    DeleteObject(brush);
                    SetTextColor(dc, fg);
                    let glyph = wide(glyphs[i as usize]);
                    DrawTextW(
                        dc,
                        glyph.as_ptr(),
                        -1,
                        &mut cr,
                        DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                    );
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
                if let Some(s) = state(h)
                    && s.hover != z
                {
                    s.hover = z;
                    InvalidateRect(h, std::ptr::null(), 0);
                }
                let mut track = TRACKMOUSEEVENT {
                    cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE,
                    hwndTrack: h,
                    dwHoverTime: 0,
                };
                TrackMouseEvent(&mut track);
                0
            }
            WM_MOUSELEAVE => {
                if let Some(s) = state(h) {
                    s.hover = -1;
                }
                InvalidateRect(h, std::ptr::null(), 0);
                0
            }
            WM_LBUTTONUP => {
                let x = (lp & 0xFFFF) as i16 as i32;
                let action = ["minimize", "maximize", "close"][zone(h, x) as usize];
                if let (Some(f), Some(s)) = (ACTION.get(), state(h)) {
                    f(s.top as isize, action);
                }
                0
            }
            WM_NCDESTROY => {
                let p = SetWindowLongPtrW(h, GWLP_USERDATA, 0) as *mut State;
                if !p.is_null() {
                    drop(Box::from_raw(p));
                }
                DefWindowProcW(h, msg, wp, lp)
            }
            _ => DefWindowProcW(h, msg, wp, lp),
        }
    }
}

/// Creates the caption popup owned by `top` and places it at the client area's top right. Returns its HWND.
pub fn attach(top: isize, colors: Colors) -> isize {
    let top = top as HWND;
    // SAFETY: plain Win32 window creation on the UI thread; every pointer argument outlives its call, and the boxed
    // State is owned by the window until WM_NCDESTROY frees it.
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let class = wide("OmpdeskCaption");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        let h = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.as_ptr(),
            std::ptr::null(),
            WS_POPUP | WS_VISIBLE,
            0,
            0,
            10,
            10,
            top,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if h.is_null() {
            let _ = GetLastError();
            return 0;
        }
        SetWindowLongPtrW(
            h,
            GWLP_USERDATA,
            Box::into_raw(Box::new(State {
                top,
                hover: -1,
                colors,
            })) as isize,
        );
        reposition(h as isize);
        h as isize
    }
}

pub fn set_colors(caption: isize, colors: Colors) {
    let h = caption as HWND;
    if let Some(s) = state(h) {
        s.colors = colors;
    }
    reposition(caption);
}

/// Places the popup at the owner's client top right (hidden while it is minimized) and repaints it.
pub fn reposition(caption: isize) {
    let h = caption as HWND;
    if h.is_null() {
        return;
    }
    // SAFETY: Win32 geometry calls on handles this module created or was given; the RECT/POINT are local.
    unsafe {
        let top = GetWindow(h, GW_OWNER);
        if top.is_null() {
            return;
        }
        let mut r: RECT = std::mem::zeroed();
        GetClientRect(top, &mut r);
        let s = scale(top);
        let height = state(h).map(|s| s.colors.height).unwrap_or(48);
        let (cw, ch) = ((CAPTION_W as f32 * s) as i32, (height as f32 * s) as i32);
        let mut p = POINT {
            x: r.right - cw,
            y: 0,
        };
        ClientToScreen(top, &mut p);
        let flags = if IsIconic(top) != 0 {
            SWP_NOACTIVATE | SWP_HIDEWINDOW
        } else {
            SWP_NOACTIVATE | SWP_SHOWWINDOW
        };
        SetWindowPos(h, HWND_TOP, p.x, p.y, cw, ch, flags);
        InvalidateRect(h, std::ptr::null(), 0);
    }
}

pub fn destroy(caption: isize) {
    if caption != 0 {
        // SAFETY: destroys a window this module created, on its own thread.
        unsafe { DestroyWindow(caption as HWND) };
    }
}
