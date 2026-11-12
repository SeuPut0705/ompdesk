//! The only unsafe code: asking a child process to end, as node's `child.kill()` does with SIGTERM, and (Windows) the
//! job object that ends this process's children with it, the computer's physical memory and its process list.
#![allow(unsafe_code)]

/// Sends SIGTERM to `pid`, a child this process has not reaped yet (so the id still names it).
#[cfg(unix)]
pub fn terminate(pid: u32) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SAFETY: kill only reads its two integer arguments; a failure (the child already exited) is ignored.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}

/// Puts this process in a new job object that kills every process in it once its last handle closes, which is when
/// this process ends, however it ends: the gits it starts join the job and cannot outlive it. The handle is never
/// closed. Jobs nest (Windows 8 and later), so a job main put this process in does not prevent it.
#[cfg(windows)]
pub fn end_children_with_this_process() -> std::io::Result<()> {
    use std::ffi::c_void;

    type Handle = *mut c_void;

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
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
    }

    // SAFETY: both pointers may be null (default security, no name); the call returns a new handle or null.
    let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let mut limits = ExtendedLimits::default();
    limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let length = u32::try_from(size_of::<ExtendedLimits>()).unwrap_or(u32::MAX);
    // SAFETY: `job` is the live handle above; `limits` is a `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` laid out as C lays it
    // out (`repr(C)`, size checked above), read only for the call, and `length` is its size.
    let set = unsafe {
        SetInformationJobObject(
            job,
            EXTENDED_LIMIT_INFORMATION,
            std::ptr::from_ref(&limits).cast(),
            length,
        )
    };
    if set == 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `job` is the live handle above; `GetCurrentProcess` returns a pseudo-handle that needs no closing.
    if unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
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

/// One process of the list: `working_set` in bytes, 0 for the idle process and for one this user may not open;
/// `image` its executable's file name (`conhost.exe`).
#[cfg(windows)]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent: u32,
    pub working_set: u64,
    pub image: String,
}

/// Every process of a Toolhelp32 snapshot with its working set (`K32GetProcessMemoryInfo`), as the stock helper's
/// `process-memory.ts` read them through bun's FFI.
#[cfg(windows)]
pub fn processes() -> std::io::Result<Vec<ProcessEntry>> {
    use std::ffi::c_void;

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

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(size_of::<Entry>() == 568 && size_of::<Counters>() == 72);

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    /// `INVALID_HANDLE_VALUE`.
    const INVALID_HANDLE: Handle = usize::MAX as Handle;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn K32GetProcessMemoryInfo(process: Handle, counters: *mut Counters, size: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// A handle this function opened, closed when it goes.
    struct Owned(Handle);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: the handle came from `CreateToolhelp32Snapshot` or `OpenProcess`, was checked to be one, and
            // is closed only here.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let entry_size = u32::try_from(size_of::<Entry>()).unwrap_or(u32::MAX);
    let counters_size = u32::try_from(size_of::<Counters>()).unwrap_or(u32::MAX);
    // SAFETY: the call takes two integers and returns a new handle or `INVALID_HANDLE_VALUE`.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE {
        return Err(std::io::Error::last_os_error());
    }
    let snapshot = Owned(snapshot);
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
    // SAFETY: `snapshot` is the live handle above; `entry` is a `PROCESSENTRY32W` laid out as C lays it out (`repr(C)`,
    // size checked above) with its `dwSize` set, written only during the call.
    let mut more = unsafe { Process32FirstW(snapshot.0, &raw mut entry) };
    while more != 0 {
        let pid = entry.process_id;
        let mut working_set = 0;
        if pid != 0 {
            // SAFETY: the call takes three integers and returns a new handle or null.
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if !process.is_null() {
                let process = Owned(process);
                let mut counters = Counters {
                    size: counters_size,
                    ..Counters::default()
                };
                // SAFETY: `process` is the live handle above; `counters` is a `PROCESS_MEMORY_COUNTERS` laid out as
                // C lays it out (`repr(C)`, size checked above), written only during the call, and `counters_size`
                // is its size.
                let read =
                    unsafe { K32GetProcessMemoryInfo(process.0, &raw mut counters, counters_size) };
                if read != 0 {
                    working_set = counters.working_set_size as u64;
                }
            }
        }
        let name = &entry.exe_file;
        let end = name
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(name.len());
        entries.push(ProcessEntry {
            pid,
            parent: entry.parent_process_id,
            working_set,
            image: String::from_utf16_lossy(&name[..end]),
        });
        // SAFETY: as for `Process32FirstW` above.
        more = unsafe { Process32NextW(snapshot.0, &raw mut entry) };
    }
    Ok(entries)
}
