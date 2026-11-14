//! Reading Electron's user-data folder as it is, for the shell that replaces it: the `safeStorage` key (handed to
//! Node in `hello`'s facts) and the `file://` origin's Local Storage, exported once for the new origin. Electron's own
//! files are never written but for one case: a clean profile's `Local State` gets the key Chromium would have made.

pub mod local_storage;
pub mod safe_storage;
