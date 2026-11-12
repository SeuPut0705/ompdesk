//! The only unsafe code: asking a child process to end, as node's `child.kill()` does with SIGTERM, and (Windows) the
//! job object that ends this process's children with it.
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
