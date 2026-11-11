//! The only unsafe code: this user's uid, the home folder, and the interrupt handler of `events`.
#![allow(unsafe_code)]

use std::collections::HashMap;
use std::path::PathBuf;

#[cfg(unix)]
pub fn uid() -> Option<u32> {
    // SAFETY: getuid has no preconditions and cannot fail.
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
pub fn uid() -> Option<u32> {
    None
}

/// `os.homedir()`: `$HOME`, else the passwd entry (unix); `%USERPROFILE%` (Windows).
pub fn home(env: &HashMap<String, String>) -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Some(home) = env.get(var).filter(|h| !h.is_empty()) {
        return PathBuf::from(home);
    }
    #[cfg(unix)]
    if let Some(home) = passwd_home() {
        return home;
    }
    PathBuf::new()
}

#[cfg(unix)]
fn passwd_home() -> Option<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;

    let uid = uid()?;
    let mut buf = vec![0 as libc::c_char; 1024];
    loop {
        // SAFETY: an all-zero passwd is a valid value for getpwuid_r to fill.
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: every pointer is valid for the call and buf.len() is its true length.
        let rc =
            unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut found) };
        if rc == libc::ERANGE && buf.len() < 1 << 20 {
            buf.resize(buf.len() * 2, 0);
            continue;
        }
        if rc != 0 || found.is_null() || pwd.pw_dir.is_null() {
            return None;
        }
        // SAFETY: on success pw_dir points to a NUL-terminated string inside buf, alive here.
        let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
        return Some(PathBuf::from(OsStr::from_bytes(dir.to_bytes())));
    }
}

#[cfg(unix)]
extern "C" fn on_interrupt(_: libc::c_int) {
    // SAFETY: _exit is async-signal-safe.
    unsafe { libc::_exit(0) }
}

/// Ctrl-C ends `events` with exit code 0.
#[cfg(unix)]
pub fn exit_on_interrupt() {
    let handler = on_interrupt as extern "C" fn(libc::c_int);
    // SAFETY: the handler only calls an async-signal-safe function.
    unsafe {
        libc::signal(libc::SIGINT, handler as libc::sighandler_t);
    }
}

#[cfg(windows)]
mod win {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn SetConsoleCtrlHandler(
            handler: Option<extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
        pub fn ExitProcess(code: u32) -> !;
    }
}

#[cfg(windows)]
extern "system" fn on_interrupt(_: u32) -> i32 {
    // SAFETY: ExitProcess may be called from any thread.
    unsafe { win::ExitProcess(0) }
}

/// Ctrl-C ends `events` with exit code 0.
#[cfg(windows)]
pub fn exit_on_interrupt() {
    // SAFETY: the handler is a plain function that lives for the whole process.
    unsafe {
        win::SetConsoleCtrlHandler(Some(on_interrupt), 1);
    }
}
