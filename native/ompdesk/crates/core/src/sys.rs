//! The only unsafe code: asking a child process to end with SIGTERM and (Windows) the job object that ends its
//! children with it, physical memory and process reads, `ReadDirectoryChangesW`, and the system random generator.
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
