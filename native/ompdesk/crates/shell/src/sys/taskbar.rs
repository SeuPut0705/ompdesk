//! Taskbar button progress through `ITaskbarList3`. windows-sys has no COM interfaces, so the vtable is declared here,
//! in the Windows SDK's method order. UI thread only (the object lives in that thread's apartment).

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows_sys::core::{GUID, HRESULT};

use crate::native_ui::{PROGRESS_TOTAL, Progress};

const CLSID_TASKBAR_LIST: GUID = GUID::from_u128(0x56FDF344_FD6D_11D0_958A_006097C9A090);
const IID_ITASKBAR_LIST3: GUID = GUID::from_u128(0xEA1AFB91_9E28_4B86_90E9_9E9F8A5EEFAF);

const TBPF_NOPROGRESS: u32 = 0;
const TBPF_INDETERMINATE: u32 = 1;
const TBPF_NORMAL: u32 = 2;
const TBPF_ERROR: u32 = 4;
const TBPF_PAUSED: u32 = 8;

type Method = unsafe extern "system" fn();

/// `ITaskbarList3`'s vtable. Only the entries used are typed; the rest keep their slots.
#[repr(C)]
struct Vtbl {
    query_interface: Method,
    add_ref: Method,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    hr_init: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    /// AddTab, DeleteTab, ActivateTab, SetActiveAlt (ITaskbarList) and MarkFullscreenWindow (ITaskbarList2).
    _list_methods: [Method; 5],
    set_progress_value: unsafe extern "system" fn(*mut c_void, HWND, u64, u64) -> HRESULT,
    set_progress_state: unsafe extern "system" fn(*mut c_void, HWND, u32) -> HRESULT,
    /// RegisterTab .. SetThumbnailClip.
    _rest: [Method; 10],
}

#[repr(C)]
struct Object {
    vtbl: *const Vtbl,
}

thread_local! {
    static LIST: Cell<*mut Object> = const { Cell::new(null_mut()) };
}

/// The cached object, created on first use. `None` when COM or the class is unavailable.
fn list() -> Option<*mut Object> {
    let cached = LIST.with(Cell::get);
    if !cached.is_null() {
        return Some(cached);
    }
    super::comthread::init();
    let mut raw: *mut c_void = null_mut();
    // SAFETY: CoCreateInstance with static GUIDs and a valid out pointer; COM is initialized on this thread.
    let hr = unsafe {
        CoCreateInstance(
            &CLSID_TASKBAR_LIST,
            null_mut(),
            CLSCTX_INPROC_SERVER,
            &IID_ITASKBAR_LIST3,
            &mut raw,
        )
    };
    if hr < 0 || raw.is_null() {
        return None;
    }
    let object = raw.cast::<Object>();
    // SAFETY: `object` is a live ITaskbarList3 whose first field is its vtable pointer; HrInit takes no arguments.
    let init = unsafe { ((*(*object).vtbl).hr_init)(raw) };
    if init < 0 {
        // SAFETY: releases the one reference CoCreateInstance gave us.
        unsafe { ((*(*object).vtbl).release)(raw) };
        return None;
    }
    LIST.with(|l| l.set(object));
    Some(object)
}

/// Shows `progress` on the taskbar button of `hwnd`. `false` when it failed, typically because the button does not
/// exist yet (before `TaskbarButtonCreated`): the caller may retry shortly.
pub fn set_progress(hwnd: isize, progress: Progress) -> bool {
    let Some(object) = list() else { return false };
    let (state, completed) = match progress {
        Progress::None => (TBPF_NOPROGRESS, None),
        Progress::Indeterminate => (TBPF_INDETERMINATE, None),
        Progress::Normal(n) => (TBPF_NORMAL, Some(n)),
        Progress::Error(n) => (TBPF_ERROR, Some(n)),
        Progress::Paused(n) => (TBPF_PAUSED, Some(n)),
    };
    let raw = object.cast::<c_void>();
    // SAFETY: `object` is the live cached ITaskbarList3 on its own thread; `hwnd` is a window of ours. The value is
    // set before the state so a determinate bar never flashes the previous fill.
    unsafe {
        let vtbl = &*(*object).vtbl;
        if let Some(n) = completed {
            let hr = (vtbl.set_progress_value)(raw, hwnd as HWND, n, PROGRESS_TOTAL);
            if hr < 0 {
                return false;
            }
        }
        (vtbl.set_progress_state)(raw, hwnd as HWND, state) >= 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vtable_matches_the_sdk_layout() {
        let word = std::mem::size_of::<usize>();
        // 3 IUnknown + HrInit + 5 ITaskbarList/2 + 2 progress + 10 remaining ITaskbarList3 methods.
        assert_eq!(std::mem::size_of::<Vtbl>(), 21 * word);
        assert_eq!(std::mem::offset_of!(Vtbl, set_progress_value), 9 * word);
        assert_eq!(std::mem::offset_of!(Vtbl, set_progress_state), 10 * word);
    }
}
