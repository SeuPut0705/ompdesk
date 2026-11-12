//! Family 1, sessions: listing, opening, stopping, reading and waiting for sessions.
//!
//! Owns these TypeScript methods (service.ts line numbers as of the port): `#list` and `#listStored` and
//! `#storedStep` and `#paceOf` (2026-2210), `#openCommands` (2241), `#resolveModel` (2303), `#openMany` (2344),
//! `#openOne` (2377), `#openText` (2546), `#ensureStarted` (2564), `#result` (2965), `#resultUntil` (3003), `#read`
//! (3046), `#readStored` (3094), `#currentRow` (3122), `#stop` (3513), `#personTurn` (3600), `#abort` (3609),
//! `#deleteWhenIdle` (3632), `#stopStored` (3857), `#dropWorktree` (3895), `#journalClose` (3912), `#whenGone`
//! (4457), `#closeTab` (4471), `#rememberClosed` and `#fated` (4696-4720), `#sessionSummary` (2946), `#cost` and
//! `#split` (4421-4456) and the public `openSessions` (1458). Also `OpenResult`, `TabClose` and `OpenCommand`.
//!
//! Already shared (do not port again): `find`, `open`, `join`, `when_ready`, `reach`, `reach_tab`, `session_state`,
//! `state_line`, `with_pickup`, `opened_by`, `open_elsewhere`, `devices_line`, `refuse_in_use`, `folder_gone`.

use super::AgentControl;
use super::fail::{Fail, R};
use super::types::{
    ControlTab, ListArgs, OpenArgs, OpenOne, ReadArgs, ResultArgs, StopArgs, StoredSession, Target,
};

impl AgentControl {
    /// `ompdesk_sessions` (`#list`).
    pub(super) async fn list(
        &self,
        _caller: &ControlTab,
        _tabs: &[ControlTab],
        _args: ListArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_sessions"))
    }

    /// `ompdesk_session_open`: the `T.open` arm of `#dispatch` (`#openMany`, `#openText`, and a failure naming every
    /// result when no session opened).
    pub(super) async fn open_tool(
        &self,
        _caller: &ControlTab,
        _tabs: &[ControlTab],
        _args: OpenArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_open"))
    }

    /// `openSessions`: the programmatic open (Autopilot): the same path as the tool, with a tag the tool never sets.
    pub async fn open_sessions(
        &self,
        _caller_tab_id: &str,
        _sessions: Vec<OpenOne>,
        _tag: Option<String>,
    ) -> R<Vec<String>> {
        Err(Fail::not_ported("openSessions"))
    }

    /// `ompdesk_session_result` (`#result`, `#resultUntil`). `several`: `sessions` was given.
    pub(super) async fn result(
        &self,
        _caller: &ControlTab,
        _targets: Vec<Target>,
        _args: ResultArgs,
        _several: bool,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_result"))
    }

    /// `ompdesk_session_read` of an open session (`#read`).
    pub(super) async fn read(&self, _target: &ControlTab, _args: &ReadArgs) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_read"))
    }

    /// `ompdesk_session_read` of a saved session (`#readStored`).
    pub(super) async fn read_stored(&self, _row: &StoredSession, _args: &ReadArgs) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_read"))
    }

    /// `ompdesk_session_stop` of an open session (`#stop`).
    pub(super) async fn stop(
        &self,
        _caller: &ControlTab,
        _tabs: &[ControlTab],
        _target: &ControlTab,
        _args: &StopArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_stop"))
    }

    /// `ompdesk_session_stop` of a saved session no tab holds (`#stopStored`).
    pub(super) async fn stop_stored(
        &self,
        _caller: &ControlTab,
        _row: &StoredSession,
        _args: &StopArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_stop"))
    }
}
