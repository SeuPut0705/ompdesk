//! `ompdesk-core`: the Rust process OMPdesk's main process moves into piece by piece. Main spawns it with open
//! stdio and speaks JSON lines to it (`wire`); each subsystem registers its methods (`server`). It is a library over
//! any `AsyncRead`/`AsyncWrite`, so tests drive it in process; the binary serves stdio.

pub mod agentctl;
pub mod aimemory;
pub mod autopilot;
pub mod browsers;
pub mod care;
pub mod clock;
pub mod control;
pub mod disk;
pub mod ext;
pub mod fs;
pub mod gh;
pub mod git;
mod http;
pub mod hub;
pub mod ipc;
mod json;
pub mod keepawake;
pub mod memory;
mod memsync;
pub mod models;
pub mod omp;
pub mod pool;
pub mod ports;
pub mod procs;
pub mod remote;
pub mod remotebytes;
pub mod resume;
pub mod routines;
mod run;
pub mod schedules;
pub mod server;
pub mod sessions;
pub mod setup;
pub mod sidecar;
pub mod ssh;
pub mod stock;
pub mod supervise;
mod sys;
pub mod tailscale;
pub mod upkeep;
pub mod web;
pub mod wire;

pub use server::{registry, serve};

/// Lowercase hex of a digest, as node's `digest('hex')` writes it (RustCrypto's 0.11 digests have no `LowerHex`).
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

#[cfg(windows)]
pub use sys::end_children_with_this_process;
