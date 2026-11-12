//! The crate's only unsafe code: this computer's RAM, the stop signals a command holder passes on, a detached
//! runner's own session, and on Windows the desktop a check runs on.
#![allow(unsafe_code)]

/// This computer's physical memory in bytes, `None` when the system does not say.
#[cfg(unix)]
pub fn physical_memory() -> Option<u64> {
    // SAFETY: sysconf only reads its integer argument.
    let (pages, size) = unsafe {
        (
            libc::sysconf(libc::_SC_PHYS_PAGES),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    (pages > 0 && size > 0).then(|| pages as u64 * size as u64)
}

#[cfg(windows)]
pub fn physical_memory() -> Option<u64> {
    /// `MEMORYSTATUSEX`.
    #[repr(C)]
    #[derive(Default)]
    struct MemoryStatus {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    const _: () = assert!(size_of::<MemoryStatus>() == 64);
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status = MemoryStatus {
        length: 64,
        ..MemoryStatus::default()
    };
    // SAFETY: `status` is a `MEMORYSTATUSEX` laid out as C lays it out (size checked above) with `dwLength` set,
    // written only during the call.
    (unsafe { GlobalMemoryStatusEx(&raw mut status) } != 0).then_some(status.total_phys)
}

/// Whether a process with this id runs (a zombie counts; a process of another user too).
#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill only reads its two integer arguments, and signal 0 sends nothing.
    let found = unsafe { libc::kill(pid, 0) == 0 };
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use std::ffi::c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    // SAFETY: OpenProcess takes plain integers; the handle it returns is closed below and used only in between.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Access denied still means a process holds the id.
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code = 0u32;
        let read = GetExitCodeProcess(handle, &raw mut code);
        CloseHandle(handle);
        read == 0 || code == STILL_ACTIVE
    }
}

/// SIGTERM, SIGHUP and SIGINT, held by a command holder for the command instead of ending the holder first (which
/// would give its slot back while the command still runs).
#[cfg(unix)]
pub struct HeldSignals(libc::sigset_t);

#[cfg(unix)]
impl HeldSignals {
    /// Blocks the three in the calling thread and every thread it starts afterwards, so call it before starting any.
    /// A child inherits the mask; `child_defaults` empties it again.
    pub fn block() -> std::io::Result<HeldSignals> {
        let mut set = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
        // SAFETY: `sigemptyset` initializes the set before `sigaddset` reads it, and `pthread_sigmask` only reads it.
        let blocked = unsafe {
            libc::sigemptyset(set.as_mut_ptr());
            libc::sigaddset(set.as_mut_ptr(), libc::SIGTERM);
            libc::sigaddset(set.as_mut_ptr(), libc::SIGHUP);
            libc::sigaddset(set.as_mut_ptr(), libc::SIGINT);
            libc::pthread_sigmask(libc::SIG_BLOCK, set.as_ptr(), std::ptr::null_mut())
        };
        if blocked != 0 {
            return Err(std::io::Error::from_raw_os_error(blocked));
        }
        // SAFETY: `sigemptyset` initialized it above.
        Ok(HeldSignals(unsafe { set.assume_init() }))
    }

    /// Waits for one of the held signals; its number.
    pub fn wait(&self) -> i32 {
        let mut received = 0;
        // SAFETY: the set is initialized and only read; `received` is written during the call.
        while unsafe { libc::sigwait(&raw const self.0, &raw mut received) } != 0 {}
        received
    }
}

/// Sends `signal` to `pid`.
#[cfg(unix)]
pub fn signal(pid: u32, signal: i32) {
    if let Ok(pid) = libc::pid_t::try_from(pid) {
        // SAFETY: kill only reads its two integer arguments.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

/// The child starts with an empty signal mask, as a shell's child does, and, with `new_session`, in a session and
/// process group of its own (`setsid`), so a group kill of whoever started it does not reach it.
#[cfg(unix)]
pub fn child_defaults(command: &mut std::process::Command, new_session: bool) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the forked child before exec and calls only `setsid`, `sigemptyset` and
    // `pthread_sigmask`, which are async-signal-safe; the set is initialized by `sigemptyset` before it is read.
    unsafe {
        command.pre_exec(move || {
            if new_session && libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            let mut empty = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
            libc::sigemptyset(empty.as_mut_ptr());
            let set =
                libc::pthread_sigmask(libc::SIG_SETMASK, empty.as_ptr(), std::ptr::null_mut());
            if set != 0 {
                return Err(std::io::Error::from_raw_os_error(set));
            }
            Ok(())
        });
    }
}

/// The name of the desktop checks run on: windows they open (an installer's message box, a test's dialog) land
/// there, never on the person's desktop. Made once per window station; `None` when it cannot be made, and the check
/// then runs on the default desktop.
#[cfg(windows)]
pub fn check_desktop() -> Option<String> {
    use std::ffi::c_void;
    const NAME: &str = "ompdesk-checks";
    const GENERIC_ALL: u32 = 0x1000_0000;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn CreateDesktopW(
            name: *const u16,
            device: *const u16,
            mode: *const c_void,
            flags: u32,
            access: u32,
            attributes: *const c_void,
        ) -> *mut c_void;
    }
    let wide: Vec<u16> = NAME.encode_utf16().chain([0]).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; the other pointers are null as the API allows. The
    // handle is left open on purpose: the desktop lives while a handle to it or a process on it does, and this
    // process starts the check on it next.
    let handle = unsafe {
        CreateDesktopW(
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            GENERIC_ALL,
            std::ptr::null(),
        )
    };
    (!handle.is_null()).then(|| NAME.to_string())
}
