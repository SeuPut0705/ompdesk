//! The updater's pure rules (batch SX4, PROTOCOL.md §15.8): the release metadata, the version rule, the small
//! decisions of the check and the download, the token's cipher and the state Node mirrors. `modules/updater/` does
//! the network, the files and the processes around them. `captured.json` holds the TypeScript's answers to the same
//! inputs, taken before it was deleted (`scripts/shell-port/capture-updater.ts`); `tests.rs` replays it.

pub mod release;
pub mod rules;
pub mod secret;
pub mod semver;
pub mod spawn;
pub mod status;

#[cfg(all(test, unix))]
mod swap_tests;
#[cfg(test)]
mod tests;
