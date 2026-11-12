//! `ompdesk-core`: the Rust process OMPdesk's main process moves into piece by piece. Main spawns it with open
//! stdio and speaks JSON lines to it (`wire`); each subsystem registers its methods (`server`). It is a library over
//! any `AsyncRead`/`AsyncWrite`, so tests drive it in process; the binary serves stdio.

pub mod aimemory;
pub mod browsers;
pub mod care;
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
pub mod memory;
pub mod models;
pub mod omp;
pub mod procs;
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
pub mod wire;

pub use server::{registry, serve};
#[cfg(windows)]
pub use sys::end_children_with_this_process;
