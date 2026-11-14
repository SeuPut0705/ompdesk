//! DPAPI (Electron's safeStorage key) and the known folders `app.getPath` serves.

use std::path::PathBuf;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;

/// Runs a DPAPI call over `data` and copies out what it allocated.
fn dpapi(
    data: &[u8],
    call: impl FnOnce(&CRYPT_INTEGER_BLOB, &mut CRYPT_INTEGER_BLOB) -> i32,
    what: &str,
) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    if call(&input, &mut output) == 0 {
        return Err(format!(
            "{what} failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: the API returned `cbData` bytes at `pbData`, allocated with LocalAlloc.
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: `pbData` is the API's LocalAlloc block, freed once here.
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

pub fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(
        data,
        // SAFETY: `input` points at `data` for the call, `output` is ours to receive the allocation; the optional
        // arguments are null.
        |input, output| unsafe {
            CryptUnprotectData(
                input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                output,
            )
        },
        "CryptUnprotectData",
    )
}

pub fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(
        data,
        // SAFETY: as in `dpapi_unprotect`.
        |input, output| unsafe {
            CryptProtectData(
                input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                output,
            )
        },
        "CryptProtectData",
    )
}

/// A known folder (`FOLDERID_RoamingAppData` and the like) of the current user.
pub fn known_folder(id: &windows_sys::core::GUID) -> Option<PathBuf> {
    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: `id` is a valid GUID, a null token means the current user, `raw` receives a CoTaskMem string.
    let hr = unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut raw) };
    if hr != 0 || raw.is_null() {
        return None;
    }
    // SAFETY: on success `raw` is a NUL-terminated UTF-16 string.
    let path = unsafe {
        let mut len = 0;
        while *raw.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(raw, len))
    };
    // SAFETY: `raw` came from SHGetKnownFolderPath and is freed once.
    unsafe { CoTaskMemFree(raw.cast()) };
    Some(PathBuf::from(path))
}
