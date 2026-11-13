//! Every raw Windows call of the library, in one place. `unsafe_code` is denied crate-wide and allowed here; each
//! block carries its `// SAFETY:` line.
#![allow(unsafe_code)]

pub mod caption;
pub mod childproc;
pub mod clipboard;
pub mod comthread;
mod crypt;
pub mod desk;
pub mod dialogs;
pub mod menu;
mod pipe;
pub mod shellops;
pub mod system;
pub mod toast;
pub mod winops;

pub use crypt::{dpapi_protect, dpapi_unprotect, known_folder};
pub use pipe::{PipeConn, PipeListener, pipe_connect};
