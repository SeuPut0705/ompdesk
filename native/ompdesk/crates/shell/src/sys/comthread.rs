//! COM on the calling thread. CEF's UI thread usually has it already (apartment-threaded); the shell dialogs, the
//! shell's file operations and WinRT toasts need it either way.

use std::cell::Cell;

use windows_sys::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};

thread_local! {
    static DONE: Cell<bool> = const { Cell::new(false) };
}

/// Initializes COM once per thread as an apartment (STA) and keeps it for the thread's life. `S_FALSE` (already
/// initialized) and `RPC_E_CHANGED_MODE` (initialized as another model: the calls below work in either) are fine.
pub fn init() {
    DONE.with(|done| {
        if !done.get() {
            // SAFETY: CoInitializeEx with a null reserved pointer; the result is deliberately not an error here
            // (see above) and the apartment is never torn down while the thread runs.
            unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as _) };
            done.set(true);
        }
    });
}
