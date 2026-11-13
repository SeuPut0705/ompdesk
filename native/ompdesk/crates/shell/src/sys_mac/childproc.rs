//! macOS side of `childwatch`: the shell's child processes, a child's arguments and how each one ended. The helpers are
//! the shell's own children and Chromium reaps them (`waitpid` here would steal their status from CEF), so they are
//! listed with `proc_listpids(PROC_PPID_ONLY)`, identified once from `KERN_PROCARGS2`, and their ends come from a
//! `kqueue`: `EVFILT_PROC` with `NOTE_EXIT | NOTE_EXITSTATUS` hands a parent its child's wait status without reaping.

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
    fn kqueue() -> i32;
    fn kevent(
        kq: i32,
        changes: *const KEvent,
        nchanges: i32,
        events: *mut KEvent,
        nevents: i32,
        timeout: *const TimeSpec,
    ) -> i32;
    fn close(fd: i32) -> i32;
}

/// `struct kevent` (`<sys/event.h>`).
#[repr(C)]
#[derive(Clone, Copy)]
struct KEvent {
    ident: usize,
    filter: i16,
    flags: u16,
    fflags: u32,
    data: isize,
    udata: *mut c_void,
}

#[repr(C)]
struct TimeSpec {
    tv_sec: i64,
    tv_nsec: i64,
}

const EVFILT_PROC: i16 = -5;
const EV_ADD: u16 = 0x0001;
const EV_ONESHOT: u16 = 0x0010;
const NOTE_EXIT: u32 = 0x8000_0000;
const NOTE_EXITSTATUS: u32 = 0x0400_0000;

/// The ends of the processes it was told to watch, with their wait statuses. Watch a pid as soon as it is seen: one
/// that ended before `watch` has no status to give (`watch` answers false).
pub struct ExitWatch {
    kq: i32,
}

impl ExitWatch {
    pub fn new() -> Option<Self> {
        // SAFETY: no arguments; a negative answer is an error.
        let kq = unsafe { kqueue() };
        (kq >= 0).then_some(Self { kq })
    }

    /// False when the process is already gone (or is not this process's child).
    pub fn watch(&self, pid: u32) -> bool {
        let change = KEvent {
            ident: pid as usize,
            filter: EVFILT_PROC,
            flags: EV_ADD | EV_ONESHOT,
            fflags: NOTE_EXIT | NOTE_EXITSTATUS,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let none = TimeSpec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: one valid change, no event buffer, a zero timeout.
        unsafe { kevent(self.kq, &change, 1, std::ptr::null_mut(), 0, &none) == 0 }
    }

    /// The watched processes that ended since the last call, each with its wait status. Does not wait.
    pub fn ended(&self) -> Vec<(u32, i32)> {
        let mut out = Vec::new();
        let none = TimeSpec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        loop {
            let mut events = [KEvent {
                ident: 0,
                filter: 0,
                flags: 0,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            }; 16];
            // SAFETY: `events` holds the 16 entries given; a zero timeout returns at once.
            let got =
                unsafe { kevent(self.kq, std::ptr::null(), 0, events.as_mut_ptr(), 16, &none) };
            if got <= 0 {
                return out;
            }
            for event in &events[..got as usize] {
                if event.filter == EVFILT_PROC && event.fflags & NOTE_EXIT != 0 {
                    out.push((event.ident as u32, event.data as i32));
                }
            }
        }
    }
}

impl Drop for ExitWatch {
    fn drop(&mut self) {
        // SAFETY: the descriptor is this value's own.
        unsafe { close(self.kq) };
    }
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

#[cfg(test)]
mod tests {
    use super::ExitWatch;
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn status_of(script: &str) -> i32 {
        let watch = ExitWatch::new().expect("kqueue");
        let mut child = Command::new("/bin/sh")
            .args(["-c", script])
            .spawn()
            .expect("sh starts");
        assert!(watch.watch(child.id()), "the child is still there to watch");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some((_, status)) = watch
                .ended()
                .into_iter()
                .find(|(pid, _)| *pid == child.id())
            {
                child.wait().expect("reaped");
                return status;
            }
            assert!(Instant::now() < deadline, "no exit seen");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_clean_exit_reads_as_status_zero_not_a_crash() {
        let status = status_of("sleep 0.2; exit 0");
        assert_eq!(status, 0);
        let kind = crate::childproc::Kind {
            process_type: "gpu-process".into(),
            service: None,
        };
        assert_eq!(
            crate::childproc::details_from_wait_status(&kind, status)["reason"],
            "clean-exit"
        );
    }

    #[test]
    fn an_exit_code_and_a_signal_read_as_they_are() {
        assert_eq!(status_of("sleep 0.2; exit 3"), 3 << 8);
        assert_eq!(status_of("sleep 0.2; kill -SEGV $$") & 0x7f, 11);
    }
}
