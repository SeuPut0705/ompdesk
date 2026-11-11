//! The only unsafe code: asking a child process to end, as node's `child.kill()` does with SIGTERM.
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
