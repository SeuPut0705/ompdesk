//! Phone HTTP/WebSocket transport and native application policy. `application::Application` owns
//! the existing edge/stores, quota receipts, approvals and notification lifecycle. The common
//! NativeApp graph supplies authenticated callers and canonical pool, file/model and shell effects.

pub mod actions;
pub mod archive;
pub mod application;
pub mod assets;
pub mod auth;
pub mod blobs;
pub mod body;
pub mod bytes;
pub mod deps;
pub mod desktop;
pub mod devices;
pub mod effects;
pub mod host;
pub mod limits;
pub mod models;
pub mod native;
pub mod notification_batch;
pub mod notifier;
pub mod pairing;
pub mod paths;
pub mod push;
pub mod quota;
pub mod refusal;
pub mod relay;
pub mod router;
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

#[cfg(test)]
mod notification_fixture;
