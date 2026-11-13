//! What keeps long checks from eating hours: the computer's heavy slots (`heavy`), checks that rerun only what their
//! changed inputs require and survive a restart (`check`), and the local commands of the `ompdesk` CLI (`cli`).

pub mod check;
pub mod cli;
mod flaky;
pub mod heavy;
mod inputs;
mod runner;
mod store;
mod sys;
mod watch;
