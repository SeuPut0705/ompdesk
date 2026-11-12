//! `ompdesk_app` and `ompdesk_app_list` (9l; was `src/main/agent-control/app-*.ts`): everything an agent may do to
//! OMPdesk itself, checked and run in one place.
//!
//! - `schema`: the argument schemas and their validation.
//! - `guard`: the agent's risk table (tiers, refusals) for preferences, stock settings and omp commands.
//! - `channels`: the same table over every IPC channel.
//! - `settings`: the Settings rows an agent may write, and the rows it may not.
//! - `catalog`: the actions.
//! - `control`: `AppControl` (list, run, undo, sign-ins) and the context an action runs through.
//! - `ports`: `AppPorts`, what the app answers the control with, and its form over a port to main.
//! - `wire`: the `app.*` requests.
//!
//! Main keeps `AppControl` (`app-control.ts`) as the typed client: it opens an instance over a `CorePort` whose
//! snapshot is `AppState` and whose handlers answer the asks `PortPorts` makes.

pub mod catalog;
pub mod channels;
pub mod control;
pub mod guard;
pub mod ports;
pub mod schema;
pub mod settings;
mod text;
mod wire;

#[cfg(test)]
mod tests;

pub use control::{AppControl, REFUSAL};
pub use ports::{AppPorts, AppState, PortPorts};

use crate::server::Registry;

pub fn register(registry: &mut Registry) {
    wire::register(registry);
}
