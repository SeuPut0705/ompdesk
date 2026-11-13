// UNVERIFIED on macOS: written on Windows without a compiler for this target.
//! macOS side of `childwatch`: the shell's child processes, a child's arguments and whether a pid is alive. The helpers
//! are the shell's own children and Chromium reaps them, so there is no exit status to read (`waitpid` would steal it
//! from CEF): they are listed with `proc_listpids(PROC_PPID_ONLY)`, identified once from `KERN_PROCARGS2` and polled
//! with `kill(pid, 0)`.

use std::ffi::c_void;

use crate::childproc::procargs_arguments;

unsafe extern "C" {
    fn proc_listpids(kind: u32, info: u32, buffer: *mut c_void, size: i32) -> i32;
    fn sysctl(
        name: *mut i32,
        namelen: u32,
        old: *mut c_void,
        oldlen: *mut usize,
        new: *mut c_void,
        newlen: usize,
    ) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
}

const PROC_PPID_ONLY: u32 = 6;
const CTL_KERN: i32 = 1;
const KERN_ARGMAX: i32 = 8;
const KERN_PROCARGS2: i32 = 49;

/// The pids whose parent is `parent`.
pub fn children_of(parent: u32) -> Vec<u32> {
    let mut pids = [0i32; 1024];
    // SAFETY: `pids` is valid for the `size` bytes given; the call fills at most that and returns the bytes written.
    let written = unsafe {
        proc_listpids(
            PROC_PPID_ONLY,
            parent,
            pids.as_mut_ptr().cast(),
            std::mem::size_of_val(&pids) as i32,
        )
    };
    let count = usize::try_from(written).unwrap_or(0) / std::mem::size_of::<i32>();
    pids[..count.min(pids.len())]
        .iter()
        .filter_map(|p| u32::try_from(*p).ok().filter(|p| *p != 0))
        .collect()
}

fn argmax() -> usize {
    let mut name = [CTL_KERN, KERN_ARGMAX];
    let mut value: i32 = 0;
    let mut size = std::mem::size_of::<i32>();
    // SAFETY: two ints of name, and `value`/`size` describe a live i32 the call writes.
    let read = unsafe {
        sysctl(
            name.as_mut_ptr(),
            2,
            (&raw mut value).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read == 0 {
        usize::try_from(value).unwrap_or(1 << 20)
    } else {
        1 << 20
    }
}

/// The arguments of `pid` as they were at its exec; None for a process this user may not read, a zombie or one gone.
pub fn arguments(pid: u32) -> Option<Vec<String>> {
    let mut buffer = vec![0u8; argmax()];
    let mut name = [CTL_KERN, KERN_PROCARGS2, i32::try_from(pid).ok()?];
    let mut size = buffer.len();
    // SAFETY: `name` is three live ints; `buffer` is valid for writes of `size` bytes, the most the call writes, and it
    // sets `size` to what it wrote; nothing is set (null, 0).
    let read = unsafe {
        sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    procargs_arguments(&buffer[..size.min(buffer.len())])
}

/// Whether `pid` still exists: signal 0 only checks that the process may be signalled.
pub fn alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 sends nothing.
    unsafe { kill(pid, 0) == 0 }
}
