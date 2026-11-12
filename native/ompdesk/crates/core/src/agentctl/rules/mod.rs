//! The service's small rules (9g; was `mail.ts`, `custody.ts`, `pickup.ts`, `auto-close.ts` and `tab-close.ts` in
//! `src/main/agent-control/`). Built, not yet called: the TypeScript service still uses its own copies until the
//! service cutover. Every rule but the mailbox's timers is a pure function of the facts its caller gathers; each
//! module's header names its seams.

pub mod auto_close;
pub mod custody;
pub mod mail;
pub mod pickup;
pub mod tab_close;

#[cfg(test)]
mod tests;
