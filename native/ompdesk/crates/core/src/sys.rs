//! The only unsafe code: asking a child process to end with SIGTERM and (Windows) the job object that ends its
//! children with it and the one that ends an ssh with its whole tree, physical memory and process reads, reading and
//! ending other processes (their environment and command line, `WM_CLOSE`, SIGKILL), `ReadDirectoryChangesW`, and the
//! system random generator.
#![allow(unsafe_code)]

/// Fills `bytes` from the system's random generator (the control socket's token), as node's `randomBytes` does.
#[cfg(unix)]
pub fn random(bytes: &mut [u8]) -> std::io::Result<()> {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")?.read_exact(bytes)
}

/// Fills `bytes` from the system's random generator (the control socket's token), as node's `randomBytes` does.
#[cfg(windows)]
pub fn random(bytes: &mut [u8]) -> std::io::Result<()> {
    // No import library names this DLL, so the linker is told the DLL itself (what std does for its own hash keys).
    #[link(name = "bcryptprimitives", kind = "raw-dylib")]
    unsafe extern "system" {
        fn ProcessPrng(data: *mut u8, length: usize) -> i32;
    }
    // SAFETY: `bytes` is valid for writes of its whole length, which is all the call writes.
    if unsafe { ProcessPrng(bytes.as_mut_ptr(), bytes.len()) } == 0 {
        return Err(std::io::Error::other(
            "the system's random generator failed",
        ));
    }
    Ok(())
}

/// Sends SIGTERM to `pid`, a child this process has not reaped yet (so the id still names it).
#[cfg(unix)]
pub fn terminate(pid: u32) {
    signal(pid, false);
}

/// Sends SIGTERM, or with `force` SIGKILL, to `pid`; whether a process was there to receive it. Never pid 0 or one
/// past `pid_t`, which `kill` reads as a whole process group.
#[cfg(unix)]
pub fn signal(pid: u32, force: bool) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: kill only reads its two integer arguments; `pid` is one process's id, never a group's.
    unsafe { libc::kill(pid, signal) == 0 }
}

/// `KERN_ARGMAX`: the most bytes a process's arguments and environment take, the size `procargs` needs.
#[cfg(target_os = "macos")]
pub fn argmax() -> Option<usize> {
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut value: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    // SAFETY: `name` is two live ints, as the call is told; `value` is a live int and `size` its size, so the call
    // writes at most that; nothing is set (null, 0).
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&raw mut value).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    usize::try_from(value).ok()
}

/// `KERN_PROCARGS2` of `pid` into `buffer` (`argmax` bytes): its argument count, executable path, arguments and
/// environment as they were at its exec. None for a process this user may not read, a zombie and one that is gone.
#[cfg(target_os = "macos")]
pub fn procargs(pid: u32, buffer: &mut [u8]) -> Option<&[u8]> {
    let mut name = [
        libc::CTL_KERN,
        libc::KERN_PROCARGS2,
        libc::c_int::try_from(pid).ok()?,
    ];
    let mut size = buffer.len();
    // SAFETY: `name` is three live ints, as the call is told; `buffer` is valid for writes of `size` bytes, which is
    // the most the call writes, and it sets `size` to what it wrote; nothing is set (null, 0).
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (read == 0).then(|| &buffer[..size.min(buffer.len())])
}

/// Whether this process may execute `path`, as node's `accessSync(path, X_OK)` answers: `access(2)`, which follows
/// links and asks with the real user.
#[cfg(unix)]
pub fn may_execute(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a NUL-terminated string that lives through the call, which only reads it.
    unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
}

/// Puts this process in a new job object that kills every process in it once its last handle closes, which is when
/// this process ends, however it ends: the gits it starts join the job and cannot outlive it. The handle is never
/// closed. Jobs nest (Windows 8 and later), so a job main put this process in does not prevent it.
#[cfg(windows)]
pub fn end_children_with_this_process() -> std::io::Result<()> {
    let job = job::kill_on_close()?;
    // SAFETY: `job` is the live handle above; `GetCurrentProcess` returns a pseudo-handle that needs no closing.
    if unsafe { job::AssignProcessToJobObject(job, job::GetCurrentProcess()) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
pub use job::ProcessTree;

/// Job objects: the one this process lives in, and one for each process whose whole tree is ended together.
#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::io;

    pub type Handle = *mut c_void;

    /// `JOBOBJECT_BASIC_LIMIT_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    /// `IO_COUNTERS`.
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    /// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(size_of::<ExtendedLimits>() == 144);

    /// `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        total_user_time: i64,
        total_kernel_time: i64,
        this_period_total_user_time: i64,
        this_period_total_kernel_time: i64,
        total_page_fault_count: u32,
        total_processes: u32,
        active_processes: u32,
        total_terminated_processes: u32,
    }

    const _: () = assert!(size_of::<Accounting>() == 48);

    /// `JobObjectBasicAccountingInformation`.
    const BASIC_ACCOUNTING_INFORMATION: i32 = 1;
    /// `JobObjectExtendedLimitInformation`.
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn QueryInformationJobObject(
            job: Handle,
            class: i32,
            info: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        pub fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        pub fn GetCurrentProcess() -> Handle;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// A new, empty job object that kills every process in it once its last handle closes.
    pub fn kill_on_close() -> io::Result<Handle> {
        // SAFETY: both pointers may be null (default security, no name); the call returns a new handle or null.
        let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits = ExtendedLimits::default();
        limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let length = u32::try_from(size_of::<ExtendedLimits>()).unwrap_or(u32::MAX);
        // SAFETY: `job` is the live handle above; `limits` is a `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` laid out as C
        // lays it out (`repr(C)`, size checked above), read only for the call, and `length` is its size.
        let set = unsafe {
            SetInformationJobObject(
                job,
                EXTENDED_LIMIT_INFORMATION,
                std::ptr::from_ref(&limits).cast(),
                length,
            )
        };
        if set == 0 {
            let error = io::Error::last_os_error();
            // SAFETY: `job` is the live handle above, closed once.
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(job)
    }

    /// One process and everything it starts from now on (an ssh with its ProxyJump hops and its askpass helper), in a
    /// job of their own inside this process's: `end` ends them all at once, as does dropping it. A process leaves a
    /// tree only by ending.
    pub struct ProcessTree(Handle);

    // SAFETY: a job handle names a kernel object; the calls made on it here are safe from any thread.
    unsafe impl Send for ProcessTree {}
    // SAFETY: as above; no call here needs exclusive access.
    unsafe impl Sync for ProcessTree {}

    impl ProcessTree {
        /// `process` is a live process handle (a child that was just started).
        pub fn of(process: std::os::windows::io::RawHandle) -> io::Result<ProcessTree> {
            let tree = ProcessTree(kill_on_close()?);
            // SAFETY: the job is the live handle `tree` owns; `process` is a live handle by this function's contract.
            if unsafe { AssignProcessToJobObject(tree.0, process) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(tree)
        }

        /// Ends every process of the tree (`TerminateProcess` for each, as node's `kill()` is on Windows).
        pub fn end(&self) {
            // SAFETY: the job is the live handle `self` owns; a failure (nothing left to end) is ignored.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }

        /// Whether a process of the tree still runs; false when the system cannot say.
        pub fn alive(&self) -> bool {
            let mut accounting = Accounting::default();
            let length = u32::try_from(size_of::<Accounting>()).unwrap_or(u32::MAX);
            // SAFETY: the job is the live handle `self` owns; `accounting` is a
            // `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` (`repr(C)`, size checked above) written only during the call,
            // `length` is its size, and the returned-length pointer may be null.
            let read = unsafe {
                QueryInformationJobObject(
                    self.0,
                    BASIC_ACCOUNTING_INFORMATION,
                    std::ptr::from_mut(&mut accounting).cast(),
                    length,
                    std::ptr::null_mut(),
                )
            };
            read != 0 && accounting.active_processes > 0
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            // SAFETY: the job is the live handle `self` owns, closed once; closing it ends what is left of the tree.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// This computer's physical memory and what of it is available, in bytes (`GlobalMemoryStatusEx`, which Electron's
/// `process.getSystemMemoryInfo()` read).
#[cfg(windows)]
pub fn physical_memory() -> std::io::Result<(u64, u64)> {
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
    // SAFETY: `status` is a `MEMORYSTATUSEX` laid out as C lays it out (`repr(C)`, size checked above) with its
    // `dwLength` set, written only during the call.
    if unsafe { GlobalMemoryStatusEx(&raw mut status) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((status.total_phys, status.avail_phys))
}

#[cfg(windows)]
pub use process_list::{Process, ask_to_close, processes};

/// This computer's processes: a Toolhelp32 snapshot with each one's working set (`memory.processes`) and, for
/// `procs.*`, its start and a handle to read its environment and command line and to end it.
#[cfg(windows)]
mod process_list {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    // The offsets into another process's PEB and parameters below are the 64-bit layout (x64 and ARM64 share it). A
    // 64-bit reader also reads a WOW64 process this way: its native PEB holds valid 64-bit parameters.
    #[cfg(not(target_pointer_width = "64"))]
    compile_error!(
        "the process parameter offsets are the 64-bit layout; OMPdesk ships 64-bit only"
    );

    type Handle = *mut c_void;

    /// `PROCESSENTRY32W`.
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        priority_class_base: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    /// `PROCESS_MEMORY_COUNTERS`.
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        size: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    /// `FILETIME`.
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    /// `PROCESS_BASIC_INFORMATION`.
    #[repr(C)]
    #[derive(Default)]
    struct BasicInformation {
        exit_status: i32,
        peb: usize,
        affinity_mask: usize,
        base_priority: i32,
        process_id: usize,
        parent_process_id: usize,
    }

    const _: () = assert!(
        size_of::<Entry>() == 568
            && size_of::<Counters>() == 72
            && size_of::<FileTime>() == 8
            && size_of::<BasicInformation>() == 48
    );

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_VM_READ: u32 = 0x0010;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    /// What `Process` is opened with: read its memory, end it, wait for it.
    const READ_AND_END: u32 =
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_TERMINATE | SYNCHRONIZE;
    const INVALID_HANDLE: Handle = std::ptr::without_provenance_mut(usize::MAX);
    const WAIT_OBJECT_0: u32 = 0;
    const WM_CLOSE: u32 = 0x0010;
    /// `ProcessBasicInformation`.
    const BASIC_INFORMATION: u32 = 0;
    /// `PEB.ProcessParameters`.
    const PEB_PARAMETERS: usize = 0x20;
    /// `RTL_USER_PROCESS_PARAMETERS`: `Length` (how much of the structure this Windows has), `CommandLine` (a
    /// `UNICODE_STRING`: its byte length, then its buffer at +8), `Environment`, `EnvironmentSize`, and the bytes up to
    /// the end of that last one.
    const PARAMETERS_LENGTH: usize = 0x04;
    const COMMAND_LINE: usize = 0x70;
    const ENVIRONMENT: usize = 0x80;
    const ENVIRONMENT_SIZE: usize = 0x3F0;
    const PARAMETERS_BYTES: usize = 0x3F8;
    /// The most of one environment block read; a real one is a few KiB, and Windows caps it at 32 767 characters a
    /// variable.
    const ENVIRONMENT_CAP: usize = 1 << 20;
    const PAGE: usize = 4096;
    /// 1970-01-01 in `FILETIME`'s milliseconds since 1601-01-01.
    const UNIX_EPOCH_MS: u64 = 11_644_473_600_000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn K32GetProcessMemoryInfo(process: Handle, counters: *mut Counters, size: u32) -> i32;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn ReadProcessMemory(
            process: Handle,
            address: *const c_void,
            buffer: *mut c_void,
            size: usize,
            read: *mut usize,
        ) -> i32;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationProcess(
            process: Handle,
            class: u32,
            information: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(visit: extern "system" fn(Handle, isize) -> i32, data: isize) -> i32;
        fn GetWindowThreadProcessId(window: Handle, process_id: *mut u32) -> u32;
        fn GetClassNameW(window: Handle, name: *mut u16, capacity: i32) -> i32;
        fn PostMessageW(window: Handle, message: u32, wparam: usize, lparam: isize) -> i32;
    }

    /// One process of the list: `working_set` in bytes, 0 for the idle process and for one this user may not open;
    /// `image` its executable's file name (`conhost.exe`).
    pub struct ProcessEntry {
        pub pid: u32,
        pub parent: u32,
        pub working_set: u64,
        pub image: String,
        /// When it started, in ms since the Unix epoch; read only when `processes` was asked to open each one.
        pub started_ms: Option<u64>,
        /// The process opened to read and end it, when asked for and this user may.
        pub process: Option<Process>,
    }

    /// A process opened to read its memory and to end it (`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ |
    /// PROCESS_TERMINATE | SYNCHRONIZE`). Windows gives no other process its id while this handle is open, so what is
    /// read and ended through it is that one process, never a later one with the same id.
    #[derive(Debug)]
    pub struct Process(OwnedHandle);

    fn open_handle(pid: u32, access: u32) -> Option<OwnedHandle> {
        // SAFETY: the call takes three integers and returns a new handle or null.
        let handle = unsafe { OpenProcess(access, 0, pid) };
        if handle.is_null() {
            return None;
        }
        // SAFETY: `handle` is the open handle OpenProcess just returned; nothing else owns it.
        Some(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    fn working_set(process: &OwnedHandle) -> Option<u64> {
        let size = u32::try_from(size_of::<Counters>()).unwrap_or(u32::MAX);
        let mut counters = Counters {
            size,
            ..Counters::default()
        };
        // SAFETY: `process` is an open handle; `counters` is a `PROCESS_MEMORY_COUNTERS` laid out as C lays it out
        // (`repr(C)`, size checked above), written only during the call, and `size` is its size.
        let read =
            unsafe { K32GetProcessMemoryInfo(process.as_raw_handle(), &raw mut counters, size) };
        (read != 0).then_some(counters.working_set_size as u64)
    }

    fn started_ms(process: &OwnedHandle) -> Option<u64> {
        let mut times: [FileTime; 4] = Default::default();
        let [creation, exit, kernel, user] = &mut times;
        // SAFETY: `process` is an open handle; the four are `FILETIME`s laid out as C lays them out (`repr(C)`, size
        // checked above), written only during the call.
        let read =
            unsafe { GetProcessTimes(process.as_raw_handle(), creation, exit, kernel, user) };
        if read == 0 {
            return None;
        }
        let ticks = (u64::from(times[0].high) << 32) | u64::from(times[0].low);
        (ticks / 10_000).checked_sub(UNIX_EPOCH_MS)
    }

    /// UTF-16 units out of little-endian bytes (Windows runs little-endian only).
    fn units(bytes: &[u8]) -> Vec<u16> {
        bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect()
    }

    fn word(bytes: &[u8], at: usize) -> Option<usize> {
        Some(usize::from_le_bytes(
            bytes.get(at..at + 8)?.try_into().ok()?,
        ))
    }

    impl Process {
        /// Copies bytes from `address` in the process into `into`; how many it could. A read stops at the first page
        /// that is not readable.
        fn read(&self, address: usize, into: &mut [u8]) -> usize {
            let mut read = 0;
            // SAFETY: `into` is valid for writes of its whole length, which is the most the call writes; `read` is a
            // live usize. `address` is the other process's, which the call checks (it is never dereferenced here).
            unsafe {
                ReadProcessMemory(
                    self.0.as_raw_handle(),
                    std::ptr::without_provenance(address),
                    into.as_mut_ptr().cast(),
                    into.len(),
                    &raw mut read,
                );
            }
            read.min(into.len())
        }

        /// The process's `RTL_USER_PROCESS_PARAMETERS`, at least up to `Environment`.
        fn parameters(&self) -> Option<Vec<u8>> {
            let mut information = BasicInformation::default();
            let length = u32::try_from(size_of::<BasicInformation>()).unwrap_or(u32::MAX);
            // SAFETY: the handle is open with PROCESS_QUERY_INFORMATION; `information` is a
            // `PROCESS_BASIC_INFORMATION` laid out as C lays it out (`repr(C)`, size checked above), written only during
            // the call, and `length` is its size; the returned length may be null.
            let status = unsafe {
                NtQueryInformationProcess(
                    self.0.as_raw_handle(),
                    BASIC_INFORMATION,
                    (&raw mut information).cast(),
                    length,
                    std::ptr::null_mut(),
                )
            };
            if status < 0 || information.peb == 0 {
                return None;
            }
            let mut pointer = [0; 8];
            if self.read(information.peb.checked_add(PEB_PARAMETERS)?, &mut pointer) != 8 {
                return None;
            }
            let address = usize::from_le_bytes(pointer);
            if address == 0 {
                return None;
            }
            let mut parameters = vec![0; PARAMETERS_BYTES];
            let read = self.read(address, &mut parameters);
            parameters.truncate(read);
            (read >= ENVIRONMENT + 8).then_some(parameters)
        }

        /// Its command line as the process holds it now.
        pub fn command_line(&self) -> Option<Vec<u16>> {
            let parameters = self.parameters()?;
            let length = usize::from(u16::from_le_bytes([
                parameters[COMMAND_LINE],
                parameters[COMMAND_LINE + 1],
            ]));
            let address = word(&parameters, COMMAND_LINE + 8)?;
            if address == 0 {
                return None;
            }
            let mut bytes = vec![0; length];
            (self.read(address, &mut bytes) == length).then(|| units(&bytes))
        }

        /// Its environment block as the process holds it now (`NAME=value`, each ended by a NUL, the block by one more),
        /// up to `ENVIRONMENT_CAP` bytes and up to the first page that cannot be read.
        pub fn environment(&self) -> Option<Vec<u16>> {
            let parameters = self.parameters()?;
            let address = word(&parameters, ENVIRONMENT)?;
            if address == 0 {
                return None;
            }
            let declared = u32::from_le_bytes(
                parameters[PARAMETERS_LENGTH..PARAMETERS_LENGTH + 4]
                    .try_into()
                    .ok()?,
            );
            let size = if declared as usize >= PARAMETERS_BYTES {
                word(&parameters, ENVIRONMENT_SIZE).unwrap_or(0)
            } else {
                0
            };
            let limit = if size == 0 {
                ENVIRONMENT_CAP
            } else {
                size.min(ENVIRONMENT_CAP)
            };
            // A page at a time, so a page that cannot be read ends the block where it begins rather than failing it,
            // and a block of unknown size is read only up to its end (two NULs in a row).
            let mut bytes = Vec::new();
            while bytes.len() < limit {
                let Some(at) = address.checked_add(bytes.len()) else {
                    break;
                };
                let want = (PAGE - at % PAGE).min(limit - bytes.len());
                let start = bytes.len();
                bytes.resize(start + want, 0);
                let read = self.read(at, &mut bytes[start..]);
                bytes.truncate(start + read);
                if read < want || ends_block(&bytes, start) {
                    break;
                }
            }
            (!bytes.is_empty()).then(|| units(&bytes))
        }

        /// Whether the process has exited.
        pub fn exited(&self) -> bool {
            // SAFETY: the handle is open with SYNCHRONIZE; a wait of 0 ms only looks.
            unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) == WAIT_OBJECT_0 }
        }

        /// Ends the process at once, as `taskkill /f` does; whether Windows took the call.
        pub fn terminate(&self) -> bool {
            // SAFETY: the handle is open with PROCESS_TERMINATE.
            unsafe { TerminateProcess(self.0.as_raw_handle(), 1) != 0 }
        }
    }

    /// Whether two zero UTF-16 units in a row (the block's end) are in `bytes` at or after byte `from`, or straddle it.
    fn ends_block(bytes: &[u8], from: usize) -> bool {
        let units = bytes.len() / 2;
        (((from / 2).max(1))..units).any(|unit| bytes[unit * 2 - 2..unit * 2 + 2] == [0; 4])
    }

    /// Every process of a Toolhelp32 snapshot with its working set (`K32GetProcessMemoryInfo`), as the stock helper's
    /// `process-memory.ts` read them through bun's FFI. With `open`, each process this user may read and end is also
    /// opened for that (`ProcessEntry::process`) and its start read.
    pub fn processes(open: bool) -> io::Result<Vec<ProcessEntry>> {
        let entry_size = u32::try_from(size_of::<Entry>()).unwrap_or(u32::MAX);
        // SAFETY: the call takes two integers and returns a new handle or `INVALID_HANDLE_VALUE`.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `snapshot` is the open handle CreateToolhelp32Snapshot just returned; nothing else owns it.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = Entry {
            size: entry_size,
            usage: 0,
            process_id: 0,
            default_heap_id: 0,
            module_id: 0,
            threads: 0,
            parent_process_id: 0,
            priority_class_base: 0,
            flags: 0,
            exe_file: [0; 260],
        };
        let mut entries = Vec::new();
        // SAFETY: `snapshot` is the open handle above; `entry` is a `PROCESSENTRY32W` laid out as C lays it out
        // (`repr(C)`, size checked above) with its `dwSize` set, written only during the call.
        let mut more = unsafe { Process32FirstW(snapshot.as_raw_handle(), &raw mut entry) };
        while more != 0 {
            let pid = entry.process_id;
            let process = (open && pid != 0)
                .then(|| open_handle(pid, READ_AND_END))
                .flatten();
            let limited = (process.is_none() && pid != 0)
                .then(|| open_handle(pid, PROCESS_QUERY_LIMITED_INFORMATION))
                .flatten();
            let handle = process.as_ref().or(limited.as_ref());
            let name = &entry.exe_file;
            let end = name
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(name.len());
            entries.push(ProcessEntry {
                pid,
                parent: entry.parent_process_id,
                working_set: handle.and_then(working_set).unwrap_or(0),
                image: String::from_utf16_lossy(&name[..end]),
                started_ms: if open {
                    handle.and_then(started_ms)
                } else {
                    None
                },
                process: process.map(Process),
            });
            // SAFETY: as for `Process32FirstW` above.
            more = unsafe { Process32NextW(snapshot.as_raw_handle(), &raw mut entry) };
        }
        Ok(entries)
    }

    /// Posts `WM_CLOSE` to every top-level window of these processes, as `taskkill` without `/f` asks a program to
    /// close; answers the processes that had one. A console's window is left alone: closing it ends every program
    /// attached to that console, not only these, and a console program cannot be asked.
    pub fn ask_to_close(pids: &[u32]) -> Vec<u32> {
        struct Asking<'a> {
            pids: &'a [u32],
            asked: Vec<u32>,
        }

        extern "system" fn visit(window: Handle, data: isize) -> i32 {
            // SAFETY: `data` is the address of the `Asking` that `ask_to_close` lends EnumWindows, which calls this on
            // the same thread, one window at a time, before it returns; nothing else touches it meanwhile.
            let asking =
                unsafe { &mut *std::ptr::with_exposed_provenance_mut::<Asking<'_>>(data as usize) };
            let mut pid = 0;
            // SAFETY: `window` is a handle EnumWindows passed (a window gone since only fails the call); `pid` is a live
            // u32.
            unsafe {
                GetWindowThreadProcessId(window, &raw mut pid);
            }
            // SAFETY: as above; WM_CLOSE carries no pointer.
            if asking.pids.contains(&pid)
                && !console(window)
                && unsafe { PostMessageW(window, WM_CLOSE, 0, 0) } != 0
                && !asking.asked.contains(&pid)
            {
                asking.asked.push(pid);
            }
            1
        }

        let mut asking = Asking {
            pids,
            asked: Vec::new(),
        };
        // SAFETY: `visit` has the callback's signature, and `data` is the address of `asking`, which lives and is used
        // by nothing else until EnumWindows returns.
        unsafe {
            EnumWindows(visit, (&raw mut asking).expose_provenance() as isize);
        }
        asking.asked
    }

    /// Whether `window` is a console's: conhost's, or a pseudoconsole's hidden one.
    fn console(window: Handle) -> bool {
        let mut class = [0u16; 32];
        // SAFETY: `class` is valid for writes of the 32 units the call is told, which it does not exceed.
        let length = unsafe { GetClassNameW(window, class.as_mut_ptr(), 32) };
        let class = &class[..usize::try_from(length).unwrap_or(0).min(class.len())];
        ["ConsoleWindowClass", "PseudoConsoleWindow"]
            .iter()
            .any(|name| name.encode_utf16().eq(class.iter().copied()))
    }
}

#[cfg(windows)]
pub use dir_changes::{DirChange, DirChanges, StopDirChanges};

/// A folder tree's changes straight from `ReadDirectoryChangesW`, which is what node's `fs.watch(dir, {recursive})` is
/// on Windows: one handle for the whole tree, never one per folder.
#[cfg(windows)]
mod dir_changes {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::Path;
    use std::ptr::null_mut;
    use std::sync::Arc;

    type Handle = *mut c_void;

    /// `OVERLAPPED`.
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: Handle,
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(size_of::<Overlapped>() == 32);

    const INVALID_HANDLE: Handle = std::ptr::without_provenance_mut(usize::MAX);
    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    /// Read, write and delete: the folder stays free to change, rename and remove while it is watched.
    const FILE_SHARE_ALL: u32 = 0x0001 | 0x0002 | 0x0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
    /// File names, folder names, sizes, last writes and creations: every way a file or a folder appears, grows, moves
    /// or goes. Not last access, attributes or security, which change nothing a reader of the tree shows.
    const NOTIFY_FILTER: u32 = 0x0001 | 0x0002 | 0x0008 | 0x0010 | 0x0040;
    const ERROR_IO_PENDING: i32 = 997;
    const ERROR_NOTIFY_ENUM_DIR: i32 = 1022;
    const WAIT_OBJECT_0: u32 = 0;
    const INFINITE: u32 = u32::MAX;
    /// A `FILE_NOTIFY_INFORMATION` before its name: `NextEntryOffset`, `Action`, `FileNameLength`.
    const ENTRY_HEAD_BYTES: usize = 12;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn CreateEventW(
            security: *mut c_void,
            manual_reset: i32,
            signalled: i32,
            name: *const u16,
        ) -> Handle;
        fn SetEvent(event: Handle) -> i32;
        fn ReadDirectoryChangesW(
            directory: Handle,
            buffer: *mut c_void,
            length: u32,
            subtree: i32,
            filter: u32,
            returned: *mut u32,
            overlapped: *mut Overlapped,
            completion: *mut c_void,
        ) -> i32;
        fn GetOverlappedResult(
            file: Handle,
            overlapped: *mut Overlapped,
            transferred: *mut u32,
            wait: i32,
        ) -> i32;
        fn WaitForMultipleObjects(
            count: u32,
            handles: *const Handle,
            wait_all: i32,
            milliseconds: u32,
        ) -> u32;
        fn CancelIoEx(file: Handle, overlapped: *mut Overlapped) -> i32;
    }

    /// What one `next` saw.
    pub enum DirChange {
        /// The entries that changed, relative to the folder, `\` between segments.
        Names(Vec<String>),
        /// More changed than the buffer holds: the system dropped all of it, so anything may have changed.
        Overflow,
        /// `StopDirChanges::stop` was called.
        Stopped,
    }

    /// The changes of one folder tree. The system keeps what changes between two reads, from the first read on, and
    /// `open` makes that read: nothing that changes after `open` returned is lost, it is named or it is an `Overflow`.
    pub struct DirChanges {
        directory: OwnedHandle,
        /// Signalled when the read in flight completes.
        done: OwnedHandle,
        stop: Arc<OwnedHandle>,
        /// Both on the heap, where they stay: the system writes into them while a read is in flight.
        overlapped: Box<Overlapped>,
        /// `u32`s, because the system wants the buffer aligned as a `DWORD`.
        buffer: Box<[u32]>,
        reading: bool,
    }

    // SAFETY: the only raw pointer in it, `overlapped.event`, is a handle value (the name of a kernel object, which any
    // thread may use), not memory; everything else is owned.
    unsafe impl Send for DirChanges {}

    /// Ends a `DirChanges` from another thread.
    pub struct StopDirChanges(Arc<OwnedHandle>);

    impl StopDirChanges {
        /// The `next` that waits, or the next one called, returns `Stopped`.
        pub fn stop(&self) {
            // SAFETY: the event's handle is open for as long as this value holds it.
            unsafe {
                SetEvent(self.0.as_raw_handle());
            }
        }
    }

    fn event() -> io::Result<OwnedHandle> {
        // SAFETY: no security attributes and no name (both may be null); manual reset, not signalled.
        let handle = unsafe { CreateEventW(null_mut(), 1, 0, std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `handle` is the open handle CreateEventW just returned; nothing else owns it.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    impl DirChanges {
        /// Watches `directory` and everything under it with a buffer of `buffer_bytes`.
        pub fn open(
            directory: &Path,
            buffer_bytes: usize,
        ) -> io::Result<(DirChanges, StopDirChanges)> {
            let mut name: Vec<u16> = directory.as_os_str().encode_wide().collect();
            if name.contains(&0) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "a path with a NUL in it",
                ));
            }
            name.push(0);
            // SAFETY: `name` is a NUL-terminated UTF-16 string that lives through the call; the security attributes
            // and the template may be null.
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    FILE_LIST_DIRECTORY,
                    FILE_SHARE_ALL,
                    null_mut(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                    null_mut(),
                )
            };
            if handle == INVALID_HANDLE {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: `handle` is the open handle CreateFileW just returned; nothing else owns it.
            let directory = unsafe { OwnedHandle::from_raw_handle(handle) };
            let done = event()?;
            let stop = Arc::new(event()?);
            let mut changes = DirChanges {
                directory,
                done,
                stop: Arc::clone(&stop),
                overlapped: Box::new(Overlapped {
                    internal: 0,
                    internal_high: 0,
                    offset: 0,
                    offset_high: 0,
                    event: null_mut(),
                }),
                buffer: vec![0; buffer_bytes.div_ceil(4).max(64)].into_boxed_slice(),
                reading: false,
            };
            changes.read()?;
            Ok((changes, StopDirChanges(stop)))
        }

        /// Starts the next read.
        fn read(&mut self) -> io::Result<()> {
            *self.overlapped = Overlapped {
                internal: 0,
                internal_high: 0,
                offset: 0,
                offset_high: 0,
                event: self.done.as_raw_handle(),
            };
            let length = u32::try_from(self.buffer.len() * 4).unwrap_or(u32::MAX);
            // SAFETY: `directory` is open for overlapped I/O; `buffer` (`length` bytes, DWORD-aligned) and `overlapped`
            // are heap allocations this value keeps until the read completed (`next`) or was cancelled and awaited
            // (`drop`); with an OVERLAPPED the byte count and the completion routine may be null.
            let queued = unsafe {
                ReadDirectoryChangesW(
                    self.directory.as_raw_handle(),
                    self.buffer.as_mut_ptr().cast(),
                    length,
                    1,
                    NOTIFY_FILTER,
                    null_mut(),
                    &raw mut *self.overlapped,
                    null_mut(),
                )
            };
            if queued == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_IO_PENDING) {
                    return Err(error);
                }
            }
            self.reading = true;
            Ok(())
        }

        /// Blocks until something under the folder changed or the watch was stopped. An error ends the watch: the
        /// folder is gone (access denied, as the system says it) or the system refused the read.
        pub fn next(&mut self) -> io::Result<DirChange> {
            // The stop first: of two signalled events the wait names the first, and a stopped watch is done even
            // while changes keep coming.
            let handles = [self.stop.as_raw_handle(), self.done.as_raw_handle()];
            // SAFETY: two live event handles this value keeps open, in an array that outlives the call.
            let woke = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
            if woke == WAIT_OBJECT_0 {
                return Ok(DirChange::Stopped);
            }
            if woke != WAIT_OBJECT_0 + 1 {
                return Err(io::Error::last_os_error());
            }
            let mut bytes = 0;
            // SAFETY: `overlapped` is the one the read that just completed was started with; `bytes` is a live u32.
            let read = unsafe {
                GetOverlappedResult(
                    self.directory.as_raw_handle(),
                    &raw mut *self.overlapped,
                    &raw mut bytes,
                    0,
                )
            };
            self.reading = false;
            let change = if read == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_NOTIFY_ENUM_DIR) {
                    return Err(error);
                }
                DirChange::Overflow
            } else if bytes == 0 {
                DirChange::Overflow
            } else {
                DirChange::Names(names(&self.buffer, bytes as usize))
            };
            // The names are copied out: the next read writes over the buffer.
            self.read()?;
            Ok(change)
        }
    }

    impl Drop for DirChanges {
        fn drop(&mut self) {
            if !self.reading {
                return;
            }
            let mut bytes = 0;
            // SAFETY: the read in flight was started on `directory` with `overlapped`. It is cancelled and then waited
            // for (`wait` = 1), so the system writes into neither `buffer` nor `overlapped` once they are freed; a read
            // that had already completed makes the cancel fail and the wait return at once.
            unsafe {
                CancelIoEx(self.directory.as_raw_handle(), &raw mut *self.overlapped);
                GetOverlappedResult(
                    self.directory.as_raw_handle(),
                    &raw mut *self.overlapped,
                    &raw mut bytes,
                    1,
                );
            }
        }
    }

    /// The names in the `bytes` the system wrote: a chain of `FILE_NOTIFY_INFORMATION`, each at a DWORD boundary.
    fn names(buffer: &[u32], bytes: usize) -> Vec<String> {
        let bytes = bytes.min(buffer.len() * 4);
        // UTF-16 units out of the `u32`s: Windows runs little-endian only.
        let unit = |at: usize| (buffer[at / 4] >> ((at % 4) * 8)) as u16;
        let mut names = Vec::new();
        let mut entry = 0;
        while entry + ENTRY_HEAD_BYTES <= bytes {
            let next = buffer[entry / 4] as usize;
            let length = buffer[entry / 4 + 2] as usize;
            let start = entry + ENTRY_HEAD_BYTES;
            let end = (start + length).min(bytes);
            let name: Vec<u16> = (start..end).step_by(2).map(unit).collect();
            names.push(String::from_utf16_lossy(&name));
            if next == 0 {
                break;
            }
            entry += next;
        }
        names
    }
}

/// What `lstat` reports on Windows that std keeps unstable: the volume, the file's index on it and its hard links
/// (libuv's `st_dev`, `st_ino`, `st_nlink`), read from a handle the caller opened on the entry itself.
#[cfg(windows)]
pub fn file_identity(file: &std::fs::File) -> std::io::Result<(u32, u64, u32)> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;

    /// `BY_HANDLE_FILE_INFORMATION`: the three `FILETIME`s are two `u32` each.
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32,
        times: [u32; 6],
        volume_serial: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }

    const _: () = assert!(size_of::<Information>() == 52);

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(file: *mut c_void, information: *mut Information) -> i32;
    }

    let mut information = Information::default();
    // SAFETY: the handle is the open file's and outlives the call; `information` is a `BY_HANDLE_FILE_INFORMATION`
    // laid out as C lays it out (`repr(C)`, size checked above) that the call only writes.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut information) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((
        information.volume_serial,
        (u64::from(information.index_high) << 32) | u64::from(information.index_low),
        information.links,
    ))
}

/// libuv's `lstat` counts a Windows link by the UTF-8 bytes of its target text, not the reparse entry's `EndOfFile`.
#[cfg(windows)]
pub fn file_link_size(file: &std::fs::File) -> std::io::Result<u64> {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn DeviceIoControl(
            device: *mut c_void,
            code: u32,
            input: *mut c_void,
            input_bytes: u32,
            output: *mut c_void,
            output_bytes: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
    }

    const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00a8;
    const IO_REPARSE_TAG_SYMLINK: u32 = 0xa000_000c;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xa000_0003;
    let mut buffer = [0u16; 8_192];
    let mut returned = 0;
    // SAFETY: `file` is a live handle opened on the reparse point itself. The aligned output buffer has the
    // advertised 16 KiB capacity, `returned` is writable, and neither pointer outlives this synchronous call.
    if unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_GET_REPARSE_POINT,
            std::ptr::null_mut(),
            0,
            buffer.as_mut_ptr().cast(),
            16_384,
            &raw mut returned,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "invalid link reparse data");
    let units = usize::try_from(returned).map_err(|_| invalid())? / 2;
    let buffer = buffer.get(..units).ok_or_else(invalid)?;
    if buffer.len() < 8 {
        return Err(invalid());
    }
    let tag = u32::from(buffer[0]) | (u32::from(buffer[1]) << 16);
    let base = match tag {
        IO_REPARSE_TAG_SYMLINK => 10,
        IO_REPARSE_TAG_MOUNT_POINT => 8,
        _ => return Err(invalid()),
    };
    if buffer[4] % 2 != 0 || buffer[5] % 2 != 0 {
        return Err(invalid());
    }
    let start = base + usize::from(buffer[4]) / 2;
    let end = start + usize::from(buffer[5]) / 2;
    let target = buffer.get(start..end).ok_or_else(invalid)?;
    let nt = target.starts_with(&[92, 63, 63, 92]);
    let drive = nt
        && target.len() >= 6
        && ((65..=90).contains(&target[4]) || (97..=122).contains(&target[4]))
        && target[5] == 58
        && (target.len() == 6 || target[6] == 92);
    if tag == IO_REPARSE_TAG_MOUNT_POINT && !drive {
        return Err(invalid());
    }
    let unc = nt
        && target.len() >= 8
        && target[4] | 32 == 117
        && target[5] | 32 == 110
        && target[6] | 32 == 99
        && target[7] == 92;
    let (target, prefix) = if drive {
        (&target[4..], 0)
    } else if unc {
        (&target[8..], 2)
    } else {
        (target, 0)
    };
    Ok(prefix
        + char::decode_utf16(target.iter().copied())
            .map(|character| character.map_or(3, |character| character.len_utf8() as u64))
            .sum::<u64>())
}
