//! The web edge (unit 8a): the HTTP server of the phone page, built here and not yet serving.

pub mod assets;
pub mod auth;
pub mod body;
pub mod deps;
pub mod devices;
pub mod limits;
pub mod refusal;
pub mod server;
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
