//! The shell's child processes, for `childproc`: which pids have the shell as parent, a child's command line and, once it
//! has ended, its exit code. A child is held by a handle opened the first time it is seen, so its exit code stays
//! readable and its pid cannot be reused under the watcher.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    WaitForSingleObject,
};

#[link(name = "ntdll", kind = "raw-dylib")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process: HANDLE,
        class: u32,
        info: *mut c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
}

/// `PROCESSINFOCLASS::ProcessCommandLineInformation` (Windows 8.1 and later): a `UNICODE_STRING` followed by its text.
const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005_u32 as i32;
const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;

/// `UNICODE_STRING`.
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

/// An open process handle, closed on drop.
pub struct Proc(HANDLE);

impl Drop for Proc {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by `open` and is closed exactly once, here.
        unsafe { CloseHandle(self.0) };
    }
}

/// The pids whose parent is `parent`.
pub fn children_of(parent: u32) -> Vec<u32> {
    // SAFETY: a plain snapshot call; the handle is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut pids = Vec::new();
    // SAFETY: PROCESSENTRY32W is plain data, all-zero is valid; `dwSize` is set before the first call as the API requires.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: `snapshot` is a live snapshot handle and `entry` a correctly sized, writable entry.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        if entry.th32ParentProcessID == parent && entry.th32ProcessID != 0 {
            pids.push(entry.th32ProcessID);
        }
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: the snapshot handle is ours and closed once.
    unsafe { CloseHandle(snapshot) };
    pids
}

/// A handle that can wait for the process and read its command line and exit code; `None` when it is not ours to open.
pub fn open(pid: u32) -> Option<Proc> {
    // SAFETY: OpenProcess has no preconditions; a null result means failure.
    let handle = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    };
    (!handle.is_null()).then_some(Proc(handle))
}

/// The process's command line, as Windows keeps it for the process; `None` when it cannot be read (it ended meanwhile).
pub fn command_line(process: &Proc) -> Option<String> {
    // u64 units: the UNICODE_STRING header at the start needs pointer alignment.
    let mut buffer: Vec<u64> = vec![0; 512];
    for _ in 0..4 {
        let mut needed = 0u32;
        let bytes = (buffer.len() * 8) as u32;
        // SAFETY: `buffer` is writable for `bytes` bytes; `needed` receives the length the call wants.
        let status = unsafe {
            NtQueryInformationProcess(
                process.0,
                PROCESS_COMMAND_LINE_INFORMATION,
                buffer.as_mut_ptr().cast(),
                bytes,
                &mut needed,
            )
        };
        if status >= 0 {
            // SAFETY: on success the buffer starts with a UNICODE_STRING whose Buffer points into the same buffer,
            // `Length` bytes long; the u64 units keep the header aligned.
            return unsafe {
                let header = &*buffer.as_ptr().cast::<UnicodeString>();
                if header.buffer.is_null() {
                    return None;
                }
                let units =
                    std::slice::from_raw_parts(header.buffer, usize::from(header.length) / 2);
                Some(String::from_utf16_lossy(units))
            };
        }
        if matches!(
            status,
            STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_OVERFLOW | STATUS_BUFFER_TOO_SMALL
        ) && needed as usize > buffer.len() * 8
        {
            buffer = vec![0; (needed as usize).div_ceil(8) + 1];
        } else {
            return None;
        }
    }
    None
}

/// The exit code once the process has ended, `None` while it runs.
pub fn exit_code(process: &Proc) -> Option<u32> {
    // SAFETY: the handle has SYNCHRONIZE access; a zero timeout only polls.
    if unsafe { WaitForSingleObject(process.0, 0) } != WAIT_OBJECT_0 {
        return None;
    }
    let mut code = 0u32;
    // SAFETY: the handle has PROCESS_QUERY_LIMITED_INFORMATION access and `code` is writable.
    (unsafe { GetExitCodeProcess(process.0, &mut code) } != 0).then_some(code)
}

#[cfg(test)]
mod tests {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::*;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[test]
    fn a_child_is_listed_read_and_its_exit_code_is_found() {
        let mut child = Command::new("cmd.exe")
            .args(["/c", "ping -n 30 127.0.0.1 >nul & exit 7 --type=utility"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(children_of(std::process::id()).contains(&pid));
        let process = open(pid).unwrap();
        let line = command_line(&process).unwrap();
        assert!(line.contains("--type=utility"), "{line}");
        assert_eq!(exit_code(&process), None);
        child.kill().unwrap();
        let _ = child.wait();
        let until = Instant::now() + Duration::from_secs(5);
        while exit_code(&process).is_none() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        // `Child::kill` ends the process with exit code 1.
        assert_eq!(exit_code(&process), Some(1));
    }
}
