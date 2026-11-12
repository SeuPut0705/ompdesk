//! The Windows clipboard as text (CF_UNICODETEXT). Another process may hold the clipboard open for a moment
//! (clipboard managers, remote desktop), so opening retries briefly before it gives up.

use std::time::Duration;

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

const OPEN_ATTEMPTS: u32 = 20;
const OPEN_PAUSE: Duration = Duration::from_millis(10);

/// The clipboard, open for this thread until dropped.
struct Open;

impl Open {
    fn new() -> Result<Self, String> {
        let mut last = String::new();
        for attempt in 0..OPEN_ATTEMPTS {
            // SAFETY: a null owner window opens the clipboard for the current task.
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return Ok(Self);
            }
            last = std::io::Error::last_os_error().to_string();
            if attempt + 1 < OPEN_ATTEMPTS {
                std::thread::sleep(OPEN_PAUSE);
            }
        }
        Err(format!("the clipboard is held by another program: {last}"))
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: this value exists only while the clipboard is open on this thread.
        unsafe { CloseClipboard() };
    }
}

/// The clipboard's text, `""` when it holds none.
pub fn read_text() -> Result<String, String> {
    let _open = Open::new()?;
    // SAFETY: a plain format query.
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT)) } == 0 {
        return Ok(String::new());
    }
    // SAFETY: the clipboard is open; the handle stays owned by the system.
    let handle = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT)) };
    if handle.is_null() {
        return Err(format!(
            "reading the clipboard: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `handle` is a movable global memory block of the clipboard.
    let data = unsafe { GlobalLock(handle) }.cast::<u16>();
    if data.is_null() {
        return Err(format!(
            "locking the clipboard data: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: the block is `GlobalSize` bytes; the units are read only up to that bound and the first NUL.
    let text = unsafe {
        let units = GlobalSize(handle) / 2;
        let slice = std::slice::from_raw_parts(data, units);
        let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
        String::from_utf16_lossy(&slice[..end])
    };
    // SAFETY: balances the GlobalLock above.
    unsafe { GlobalUnlock(handle) };
    Ok(text)
}

/// Replaces the clipboard's content with `text`.
pub fn write_text(text: &str) -> Result<(), String> {
    let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = units.len() * 2;
    let _open = Open::new()?;
    // SAFETY: the clipboard is open; EmptyClipboard takes ownership for this task.
    if unsafe { EmptyClipboard() } == 0 {
        return Err(format!(
            "clearing the clipboard: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: a movable block of `bytes` bytes, filled below before the system gets it.
    let block = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
    if block.is_null() {
        return Err("the clipboard text does not fit in memory".into());
    }
    // SAFETY: `block` was just allocated with room for `bytes`; the copy stays inside it.
    unsafe {
        let target = GlobalLock(block).cast::<u16>();
        if target.is_null() {
            let error = std::io::Error::last_os_error();
            GlobalFree(block);
            return Err(format!("locking the clipboard data: {error}"));
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), target, units.len());
        GlobalUnlock(block);
    }
    // SAFETY: on success the system owns `block`; on failure it is still ours and is freed.
    let stored: HANDLE = unsafe { SetClipboardData(u32::from(CF_UNICODETEXT), block) };
    if stored.is_null() {
        let error = std::io::Error::last_os_error();
        // SAFETY: SetClipboardData failed, so the block was not taken.
        unsafe { GlobalFree(block) };
        return Err(format!("writing the clipboard: {error}"));
    }
    Ok(())
}
