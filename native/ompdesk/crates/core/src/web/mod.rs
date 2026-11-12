//! The web edge (unit 8a): the HTTP server of the phone page, built here and not yet serving.

pub mod archive;
pub mod assets;
pub mod auth;
pub mod blobs;
pub mod body;
pub mod bytes;
pub mod deps;
pub mod devices;
pub mod host;
pub mod limits;
pub mod push;
pub mod refusal;
pub mod relay;
pub mod server;
pub mod store;
pub mod uploads;
pub mod ws;

pub(crate) use crate::hex;

#[cfg(test)]
mod ws_wire;

#[cfg(test)]
mod matrix_replay;

#[cfg(test)]
mod edge_ws;

#[cfg(test)]
mod proof_browsers;
