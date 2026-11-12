//! `shell.*` on Windows: open a URL or a path with the registered handler, reveal an item in Explorer, move an item to
//! the Recycle Bin, beep. Run these on the UI thread (COM apartment): the shell's verbs expect one.

use std::ffi::c_void;
use std::path::Path;

use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IBindCtx};
use windows::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOFX_ADDUNDORECORD,
    FOFX_RECYCLEONDELETE, FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
};
use windows::core::PCWSTR;
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Diagnostics::Debug::MessageBeep;
use windows_sys::Win32::UI::Shell::Common::ITEMIDLIST;
use windows_sys::Win32::UI::Shell::{
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, SHOpenFolderAndSelectItems,
    SHParseDisplayName, ShellExecuteExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{MB_OK, SW_SHOWNORMAL};

use super::comthread;
use crate::shell_args::{validate_external_url, validate_path, windows_path};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// ShellExecuteEx "open" on `target` (a URL, a file or a folder). The error is the system's own text.
fn execute_open(target: &str) -> Result<(), String> {
    comthread::init();
    let file = wide(target);
    let verb = wide("open");
    // SAFETY: SHELLEXECUTEINFOW is plain data; zero is "not set" for every field assigned below or left unused.
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    // SAFETY: `info` is filled in and the strings it points to outlive the call.
    if unsafe { ShellExecuteExW(&mut info) } != 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    // Older handlers report in hInstApp (SE_ERR_*) and leave the last error at 0.
    Err(match error.raw_os_error() {
        Some(0) | None => format!(
            "the shell could not open it (code {})",
            info.hInstApp as usize
        ),
        Some(_) => error.to_string(),
    })
}

pub fn open_external(url: &str) -> Result<(), String> {
    execute_open(validate_external_url(url)?)
}

pub fn open_path(path: &str) -> Result<(), String> {
    execute_open(&windows_path(validate_path(path)?))
}

struct Pidl(*mut ITEMIDLIST);

impl Pidl {
    fn parse(path: &str) -> Result<Self, String> {
        let name = wide(path);
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        // SAFETY: a NUL-terminated name and a valid out-pointer; no bind context, no attributes asked.
        let hr = unsafe {
            SHParseDisplayName(
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut pidl,
                0,
                std::ptr::null_mut(),
            )
        };
        if hr < 0 || pidl.is_null() {
            return Err(format!(
                "'{path}' is not a place the shell knows (HRESULT 0x{:08X})",
                hr as u32
            ));
        }
        Ok(Self(pidl))
    }
}

impl Drop for Pidl {
    fn drop(&mut self) {
        // SAFETY: the list came from SHParseDisplayName, which allocates with CoTaskMemAlloc.
        unsafe { CoTaskMemFree(self.0.cast::<c_void>()) };
    }
}

fn select_in_folder(full: &str, folder: &str) -> Result<(), String> {
    let folder_list = Pidl::parse(folder)?;
    let item_list = Pidl::parse(full)?;
    let items = [item_list.0.cast_const()];
    // SAFETY: the folder list and one item list, both alive until the call returns.
    let hr = unsafe { SHOpenFolderAndSelectItems(folder_list.0, 1, items.as_ptr(), 0) };
    if hr < 0 {
        Err(format!(
            "Explorer could not select the item (HRESULT 0x{:08X})",
            hr as u32
        ))
    } else {
        Ok(())
    }
}

/// Explorer with the item selected; when that cannot be done (the item is gone), the folder that holds it.
pub fn show_item_in_folder(path: &str) -> Result<(), String> {
    comthread::init();
    let full = windows_path(validate_path(path)?);
    let trimmed = full.trim_end_matches('\\');
    let parent = Path::new(trimmed)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| !p.is_empty());
    let Some(parent) = parent else {
        // A drive root or a bare name: there is no folder above it to select in.
        return execute_open(&full);
    };
    match select_in_folder(trimmed, &parent) {
        Ok(()) => Ok(()),
        Err(why) => execute_open(&parent)
            .map_err(|open| format!("{why}; opening the folder failed too: {open}")),
    }
}

/// Moves `path` to the Recycle Bin without any prompt.
pub fn trash_item(path: &str) -> Result<(), String> {
    comthread::init();
    let full = windows_path(validate_path(path)?);
    if std::fs::symlink_metadata(&full).is_err() {
        return Err(format!("'{full}' does not exist"));
    }
    let context = |what: &'static str| {
        move |e: windows::core::Error| {
            format!(
                "{what}: {} (0x{:08X})",
                e.message().trim(),
                e.code().0 as u32
            )
        }
    };
    let name = wide(&full);
    // SAFETY: a NUL-terminated path that outlives the call; no bind context.
    let item = unsafe {
        SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(name.as_ptr()), None::<&IBindCtx>)
    }
    .map_err(context("finding the item"))?;
    // SAFETY: CoCreateInstance of the system's file operation class in this (initialized) apartment.
    let operation: IFileOperation =
        unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER) }
            .map_err(context("starting the file operation"))?;
    // SAFETY: COM calls on the live operation object and item; the operation runs to completion inside PerformOperations.
    unsafe {
        operation
            .SetOperationFlags(
                FOF_SILENT
                    | FOF_NOCONFIRMATION
                    | FOF_NOERRORUI
                    | FOF_ALLOWUNDO
                    | FOFX_ADDUNDORECORD
                    | FOFX_RECYCLEONDELETE,
            )
            .map_err(context("setting the file operation flags"))?;
        operation
            .DeleteItem(&item, None)
            .map_err(context("queueing the delete"))?;
        operation
            .PerformOperations()
            .map_err(context("moving the item to the Recycle Bin"))?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(context("reading the result"))?
            .as_bool()
        {
            return Err(format!("'{full}' could not be moved to the Recycle Bin"));
        }
    }
    Ok(())
}

pub fn beep() {
    // SAFETY: MessageBeep plays a system sound; it takes no pointers.
    unsafe { MessageBeep(MB_OK) };
}
