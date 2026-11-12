//! Throwaway test parent for preview-host child mode: a plain top-level window.
//! Prints `{"hwnd":<decimal>}` once, then every 300 ms (when it changes) the child windows it owns:
//! `{"children":[{"hwnd":..,"parent":..,"class":"..","rect":[x,y,w,h],"visible":bool}]}` (rects in parent client px).
//! Exits after the first argument's seconds (default 60) or when closed.
use std::{ptr::null, sync::Mutex};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{HiDpi::*, WindowsAndMessaging::*},
};

static LAST: Mutex<String> = Mutex::new(String::new());

fn w(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn enum_child(hwnd: HWND, lp: LPARAM) -> i32 {
    let out = unsafe { &mut *(lp as *mut Vec<String>) };
    unsafe {
        let parent = GetParent(hwnd);
        let mut cls = [0u16; 128];
        let n = GetClassNameW(hwnd, cls.as_mut_ptr(), 128) as usize;
        let cls = String::from_utf16_lossy(&cls[..n]);
        let mut r: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut r);
        let mut tl = POINT { x: r.left, y: r.top };
        ScreenToClient(parent, &mut tl);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        out.push(format!(
            "{{\"hwnd\":{},\"parent\":{},\"class\":\"{}\",\"pid\":{},\"rect\":[{},{},{},{}],\"visible\":{}}}",
            hwnd as isize,
            parent as isize,
            cls,
            pid,
            tl.x,
            tl.y,
            r.right - r.left,
            r.bottom - r.top,
            IsWindowVisible(hwnd) != 0
        ));
    }
    1
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        match msg {
            WM_TIMER => {
                let mut v: Vec<String> = Vec::new();
                EnumChildWindows(hwnd, Some(enum_child), &mut v as *mut _ as LPARAM);
                let s = format!("{{\"children\":[{}]}}", v.join(","));
                let mut last = LAST.lock().unwrap();
                if *last != s {
                    println!("{s}");
                    *last = s;
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

fn main() {
    let secs: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(60);
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let inst = GetModuleHandleW(null());
        let cls = w("ParentWindowTest");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: inst,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: (COLOR_WINDOW + 1) as HBRUSH,
            lpszMenuName: null(),
            lpszClassName: cls.as_ptr(),
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            0,
            cls.as_ptr(),
            w("parent-window (preview-host child test)").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_CLIPCHILDREN,
            100,
            100,
            1000,
            700,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            inst,
            null(),
        );
        println!("{{\"hwnd\":{}}}", hwnd as isize);
        SetTimer(hwnd, 1, 300, None);
        SetTimer(hwnd, 2, secs * 1000, None);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.message == WM_TIMER && msg.wParam == 2 {
                DestroyWindow(hwnd);
                continue;
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
