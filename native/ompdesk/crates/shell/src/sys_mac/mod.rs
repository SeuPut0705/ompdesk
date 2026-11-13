//! macOS counterparts of `sys` (UNVERIFIED on macOS).
#![allow(unsafe_code)]

pub mod app;
pub mod clipboard;
pub mod desk;
pub mod dialogs;
pub mod keychain;
pub mod menu;
pub mod proxy;
pub mod shellops;
pub mod system;
pub mod toast;
pub mod window;

pub use system::{displays, on_battery, preferred_languages, reduced_motion, system_locale, theme};
