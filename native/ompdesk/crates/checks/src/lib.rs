//! What keeps long checks from eating hours: the computer's heavy slots (`heavy`) and the local commands of the
//! `ompdesk` CLI that use them (`cli`).

pub mod cli;
pub mod heavy;
mod sys;
