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

#[cfg(test)]
mod ws_wire;

/// Lowercase hex of a digest, as `digest('hex')` writes it.
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

#[cfg(test)]
mod matrix_replay;

#[cfg(test)]
mod edge_ws;

#[cfg(test)]
mod proof_browsers;
