//! Native popup menus and the application menu's accelerators (PROTOCOL.md §7). A popup is a Win32 menu shown with
//! `TrackPopupMenuEx` on the calling (UI) thread; the application menu has no bar (the windows are frameless), so its
//! accelerators are matched by a message hook on the UI thread, which sees every key a window of this thread is
//! about to get and turns the one that matches into a `Hit` instead of passing it on.

use std::cell::{Cell, RefCell};
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, GA_ROOT,
    GetAncestor, GetClassNameW, GetCursorPos, GetForegroundWindow, HHOOK, HMENU, InsertMenuItemW,
    IsWindow, MENUITEMINFOW, MFS_CHECKED, MFS_GRAYED, MFT_RADIOCHECK, MFT_SEPARATOR, MIIM_FTYPE,
    MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, MSG, PM_REMOVE, PostMessageW, RegisterClassExW,
    SetForegroundWindow, SetWindowsHookExW, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON,
    TPM_TOPALIGN, TrackPopupMenuEx, WH_GETMESSAGE, WM_KEYDOWN, WM_NULL, WM_SYSKEYDOWN, WNDCLASSEXW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::accelerator::Mods;
use crate::menu_model::{
    Binding, Entry, Hit, Item, ItemEntry, Kind, Mark, collect_bindings, escape_mnemonics,
    find_binding,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The system DPI as a scale (1.0 at 96): the tray's and a windowless menu's.
pub fn system_scale() -> f64 {
    // SAFETY: GetDpiForSystem takes no arguments and only reads the process's DPI awareness.
    let dpi = unsafe { GetDpiForSystem() };
    if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 }
}

thread_local! {
    static OPEN: Cell<bool> = const { Cell::new(false) };
    static OWNER: Cell<isize> = const { Cell::new(0) };
    static BINDINGS: RefCell<Vec<Binding>> = const { RefCell::new(Vec::new()) };
    static HOOK: Cell<isize> = const { Cell::new(0) };
    static ON_HIT: Cell<Option<fn(Hit)>> = const { Cell::new(None) };
}

/// Whether a popup is open on this thread (its modal loop is running).
pub fn popup_open() -> bool {
    OPEN.with(Cell::get)
}

/// A hidden window to own menus that belong to no app window (the tray's): `TrackPopupMenuEx` needs an owner of the
/// calling thread that can be made the foreground window.
fn helper_owner() -> Result<HWND, String> {
    let existing = OWNER.with(Cell::get);
    if existing != 0 {
        return Ok(existing as HWND);
    }
    let class = wide("OMPdeskMenuOwner");
    // SAFETY: a null module name asks for this executable's handle.
    let instance = unsafe { GetModuleHandleW(null()) };
    // SAFETY: WNDCLASSEXW is plain data; every field the call reads is set below.
    let mut class_info: WNDCLASSEXW = unsafe { std::mem::zeroed() };
    class_info.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
    class_info.lpfnWndProc = Some(DefWindowProcW);
    class_info.hInstance = instance;
    class_info.lpszClassName = class.as_ptr();
    // SAFETY: `class_info` is fully initialised and `class` outlives the call. A second registration of the same
    // class fails harmlessly (the class exists), which the window creation below shows if it matters.
    unsafe { RegisterClassExW(&class_info) };
    // SAFETY: a hidden, never-shown popup window of the registered class on the calling thread.
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
            null_mut(),
            null_mut(),
            instance,
            null(),
        )
    };
    if hwnd.is_null() {
        return Err("could not create the menu's owner window".into());
    }
    OWNER.with(|o| o.set(hwnd as isize));
    Ok(hwnd)
}

fn append_entries(menu: HMENU, entries: &[Entry]) -> Result<(), String> {
    for (position, entry) in entries.iter().enumerate() {
        // SAFETY: MENUITEMINFOW is plain data; cbSize and the masked fields are set below.
        let mut info: MENUITEMINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<MENUITEMINFOW>() as u32;
        // `_text` stays alive until the insert returns (the menu copies the string, `info` points at it).
        let (_text, sub): (Vec<u16>, HMENU) = match entry {
            Entry::Separator => {
                info.fMask = MIIM_FTYPE;
                info.fType = MFT_SEPARATOR;
                (Vec::new(), null_mut())
            }
            Entry::Item(item) => {
                let text = wide(&item_text(item));
                info.fMask = MIIM_ID | MIIM_FTYPE | MIIM_STATE | MIIM_STRING;
                info.wID = item.cmd;
                info.fState = (if item.enabled { 0 } else { MFS_GRAYED })
                    | (if matches!(item.mark, Mark::Checkbox(true) | Mark::Radio(true)) {
                        MFS_CHECKED
                    } else {
                        0
                    });
                info.fType = if matches!(item.mark, Mark::Radio(_)) {
                    MFT_RADIOCHECK
                } else {
                    0
                };
                info.dwTypeData = text.as_ptr().cast_mut();
                (text, null_mut())
            }
            Entry::Submenu {
                label,
                enabled,
                entries,
                ..
            } => {
                // SAFETY: creates an empty popup menu owned by this code until it is attached or destroyed.
                let sub = unsafe { CreatePopupMenu() };
                if sub.is_null() {
                    return Err("could not create a submenu".into());
                }
                if let Err(error) = append_entries(sub, entries) {
                    // SAFETY: `sub` is a menu created above and not attached anywhere.
                    unsafe { DestroyMenu(sub) };
                    return Err(error);
                }
                let text = wide(&escape_mnemonics(label));
                info.fMask = MIIM_FTYPE | MIIM_STATE | MIIM_STRING | MIIM_SUBMENU;
                info.fState = if *enabled { 0 } else { MFS_GRAYED };
                info.hSubMenu = sub;
                info.dwTypeData = text.as_ptr().cast_mut();
                (text, sub)
            }
        };
        // SAFETY: `info` describes one item; `text` (pointed to by dwTypeData) is alive across the call.
        let inserted = unsafe { InsertMenuItemW(menu, position as u32, 1, &info) };
        if inserted == 0 {
            if !sub.is_null() {
                // SAFETY: the insert failed, so `sub` is still ours.
                unsafe { DestroyMenu(sub) };
            }
            return Err("could not add a menu item".into());
        }
    }
    Ok(())
}

/// The item's text as a Windows menu draws it: the label (a literal `&` doubled), then TAB and the accelerator.
pub fn item_text(item: &ItemEntry) -> String {
    let mut text = escape_mnemonics(&item.label);
    if let Some(accelerator) = &item.accelerator {
        text.push('\t');
        text.push_str(&accelerator.display());
    }
    text
}

/// Shows `entries` and returns the command the user chose; `None` when the menu was dismissed. `owner` is the
/// window's handle (0: none, a hidden helper owns it); `at` is a point in DIP of the owner's content (`None`: the
/// cursor). Runs the menu's modal loop on the calling (UI) thread; `before` runs once the menu is built and just
/// before it is shown, `after` right after it closed.
pub fn popup(
    owner: isize,
    entries: &[Entry],
    at: Option<(f64, f64)>,
    before: impl FnOnce(),
    after: impl FnOnce(),
) -> Result<Option<u32>, String> {
    if popup_open() {
        // One menu at a time, as with any native menu: a second request while one is up is a dismissal.
        return Ok(None);
    }
    // SAFETY: IsWindow takes any handle value and reports whether it names a window.
    let window = if owner != 0 && unsafe { IsWindow(owner as HWND) } != 0 {
        owner as HWND
    } else {
        null_mut()
    };
    let hwnd = if window.is_null() {
        helper_owner()?
    } else {
        window
    };
    let mut point = POINT { x: 0, y: 0 };
    match at {
        Some((x, y)) => {
            let scale = if window.is_null() {
                system_scale()
            } else {
                // SAFETY: reads the DPI of a window handle checked above.
                let dpi = unsafe { GetDpiForWindow(window) };
                if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 }
            };
            point = POINT {
                x: (x * scale).round() as i32,
                y: (y * scale).round() as i32,
            };
            if !window.is_null() {
                // SAFETY: converts a point of a live window's client area to the screen.
                unsafe { ClientToScreen(window, &mut point) };
            }
        }
        None => {
            // SAFETY: GetCursorPos fills `point`.
            if unsafe { GetCursorPos(&mut point) } == 0 {
                return Err("could not read the cursor position".into());
            }
        }
    }
    // SAFETY: creates an empty popup menu; destroyed below on every path.
    let menu = unsafe { CreatePopupMenu() };
    if menu.is_null() {
        return Err("could not create the menu".into());
    }
    if let Err(error) = append_entries(menu, entries) {
        // SAFETY: `menu` was created above and holds nothing that outlives it.
        unsafe { DestroyMenu(menu) };
        return Err(error);
    }
    before();
    OPEN.with(|o| o.set(true));
    // SAFETY: the owner must be the foreground window for the menu to close when the user clicks elsewhere.
    unsafe { SetForegroundWindow(hwnd) };
    // SAFETY: `menu` is a valid popup menu and `hwnd` a window of this thread; TPM_RETURNCMD makes the call return
    // the chosen command (0: none) instead of posting WM_COMMAND.
    let chosen = unsafe {
        TrackPopupMenuEx(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN,
            point.x,
            point.y,
            hwnd,
            null(),
        )
    };
    OPEN.with(|o| o.set(false));
    // SAFETY: the documented follow-up to a tracked popup (it lets the menu's owner settle); also frees the menu
    // and its submenus.
    unsafe {
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(menu);
    }
    after();
    Ok(u32::try_from(chosen).ok().filter(|c| *c != 0))
}

/// Installs the application menu's accelerators (replacing the earlier ones; `None` removes them): while a window of
/// this thread has the keyboard focus, a key press that is one of them goes to `on_hit` and not to the window. Must
/// run on the UI thread.
pub fn set_application(items: Option<&[Item]>, on_hit: fn(Hit)) -> Result<(), String> {
    let mut bindings = Vec::new();
    if let Some(items) = items {
        collect_bindings(items, false, &mut bindings);
    }
    ON_HIT.with(|h| h.set(Some(on_hit)));
    BINDINGS.with(|b| *b.borrow_mut() = bindings);
    if HOOK.with(Cell::get) != 0 {
        return Ok(());
    }
    // SAFETY: a hook on this thread's own message retrieval; `hook_proc` has the HOOKPROC signature and lives for
    // the whole run. Thread hooks of the same process need no module handle.
    let hook: HHOOK = unsafe {
        SetWindowsHookExW(
            WH_GETMESSAGE,
            Some(hook_proc),
            null_mut(),
            GetCurrentThreadId(),
        )
    };
    if hook.is_null() {
        return Err("could not install the keyboard hook for the menu's accelerators".into());
    }
    HOOK.with(|h| h.set(hook as isize));
    Ok(())
}

fn key_down(vk: u16) -> bool {
    // SAFETY: GetKeyState reads the calling thread's keyboard state for a virtual key.
    unsafe { GetKeyState(i32::from(vk)) < 0 }
}

fn held_mods() -> Mods {
    Mods {
        ctrl: key_down(0x11),
        alt: key_down(0x12),
        shift: key_down(0x10),
        meta: key_down(0x5B) || key_down(0x5C),
    }
}

/// Whether `hwnd`'s top-level window is the foreground window and is not a dialog or the menu's own owner.
fn in_focused_app_window(hwnd: HWND) -> bool {
    // SAFETY: both calls take window handles and tolerate stale ones (they return null).
    let (root, foreground) = unsafe { (GetAncestor(hwnd, GA_ROOT), GetForegroundWindow()) };
    if root.is_null() || root != foreground || root as isize == OWNER.with(Cell::get) {
        return false;
    }
    let mut class = [0u16; 16];
    // SAFETY: GetClassNameW writes at most `class.len()` units into the buffer.
    let len = unsafe { GetClassNameW(root, class.as_mut_ptr(), class.len() as i32) };
    // "#32770" is the class of the system's dialogs (file pickers, message boxes): their keys are theirs.
    !(len > 0 && String::from_utf16_lossy(&class[..len as usize]) == "#32770")
}

/// `None`: the key is not an accelerator; `Some(None)`: it is one and goes nowhere (a held key repeating a toggle);
/// `Some(Some(hit))`: it fired an item.
fn match_key(msg: &MSG) -> Option<Option<Hit>> {
    let vk = u16::try_from(msg.wParam).ok()?;
    if popup_open() || !in_focused_app_window(msg.hwnd) {
        return None;
    }
    let held = held_mods();
    let repeat = msg.lParam & (1 << 30) != 0;
    BINDINGS.with(|bindings| {
        let mut bindings = bindings.borrow_mut();
        let index = find_binding(&bindings, vk, held)?;
        let binding = &mut bindings[index];
        match binding.kind {
            Kind::Checkbox => {
                // A held key repeats: the key is still ours, the toggle is not repeated.
                if repeat {
                    return Some(None);
                }
                binding.checked = !binding.checked;
                Some(Some(Hit {
                    id: binding.id.clone(),
                    checked: Some(binding.checked),
                }))
            }
            Kind::Radio => {
                if repeat {
                    return Some(None);
                }
                binding.checked = true;
                Some(Some(Hit {
                    id: binding.id.clone(),
                    checked: Some(true),
                }))
            }
            _ => Some(Some(Hit {
                id: binding.id.clone(),
                checked: None,
            })),
        }
    })
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam == PM_REMOVE as WPARAM && lparam != 0 {
        // SAFETY: for WH_GETMESSAGE with code >= 0, lParam points at the MSG GetMessage/PeekMessage is returning.
        let msg = unsafe { &mut *(lparam as *mut MSG) };
        if (msg.message == WM_KEYDOWN || msg.message == WM_SYSKEYDOWN)
            && let Some(hit) = match_key(msg)
        {
            // The window never sees the key (and TranslateMessage makes no character of it).
            msg.message = WM_NULL;
            if let (Some(hit), Some(on_hit)) = (hit, ON_HIT.with(Cell::get)) {
                on_hit(hit);
            }
        }
    }
    // SAFETY: passes the hook chain's own arguments on, as the contract asks.
    unsafe { CallNextHookEx(null_mut(), code, wparam, lparam) }
}
