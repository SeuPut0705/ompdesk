//! The shell's pure parts: no CEF in here, so `cargo test` runs them in an executable that never imports libcef.dll.

pub mod accelerator;
pub mod chunks;
pub mod color;
pub mod conn;
pub mod desk_state;
pub mod dialog_spec;
pub mod facts;
pub mod frame;
pub mod hotkey;
pub mod marker;
pub mod menu_model;
pub mod migrate;
pub mod netmap;
pub mod notify_spec;
pub mod proxy_rules;
pub mod range;
pub mod shell_args;
pub mod startup;
pub mod transition;
pub mod tray_image;
pub mod wire;

#[cfg(windows)]
pub mod sys;

#[cfg(target_os = "macos")]
pub mod sys_mac;
