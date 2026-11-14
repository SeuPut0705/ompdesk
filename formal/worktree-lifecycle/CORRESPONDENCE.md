# Code correspondence

| Model action | Runtime boundary | Atomicity and omission |
|---|---|---|
| SettingsReply | Lifecycle::settings | The settings await can time out. Off, malformed and ineligible answers are covered by consumer tests rather than this race model. |
| SelectWindow, RegisterQuestion, CloseWindow | target, ask, window_closed | Selection and registration are separate. Registration and the exact window incarnation's closed record use the same lifecycle state lock. A close either rejects later registration or withdraws the existing question. |
| RevokeOwner, AdmitCreate | native::Hooks::create | Revocation can occur while the captured source stays connected. Base must validate the authenticated owner, view and source and queue the stock bridge mutation in one admitted native step. This is an explicit Base implementation prerequisite, not a property proved about a stub host. |
| Answer, DropWaiter | answer, retained start task | An answer grants only its exact window's question. Dropping the gate waiter never drops a stock mutation already admitted. |
| CreateReply, BindFails, BindReply | start_inner, Host::bind, Completion | Stock creation and the async hub binding are separate awaits. A failed binding keeps an owned record awaiting the real release receipt. A closed source transfers its captured receipt to cleanup. |
| QuitBegin, RefreshQuit, QuitTake | finalize, finalize_one, refresh_owned | Quit marks pending starts and snapshots existing owners. A creation completing later inserts its owner and runs the same finalize_one. Stop and settings refresh occur while ownership can still be taken by a real release. Only the matching Arc owner is taken for quit afterward. |
| Close | released | Owner equality and Arc::ptr_eq reject a different execution source before state or questions are touched. Exactly one owner is removed under the lock. |
| OmpExited | released's exact Work<Result<(), Fault>> | Base captures the actual disposal receipt before forgetting the source. A signal, an absent receipt and an exit fault are not success. Timeout preserves the worktree. |
| Approve, Edit, Remove | plan, exit | Approval includes a clean automatic selection. A second snapshot must match the selected fingerprint. The native git guard and repository gate are reused, not modeled as a new stock rule. Concurrent external edits between that second snapshot and git removal are not claimed atomic. |

## Independent review paths

Main's review of immutable a26b76b9f identified four static, unreproduced paths. The expanded model adds owner revocation, select-close-register, late quit-policy refresh and failed-binding ownership. Consumer regressions name those paths in worktree_lifecycle/tests.rs. A passing model or a fake-host test alone does not establish that Base's actual admission, window delivery or exit receipt implements the required boundary.

The model's one source and one window stand for one captured execution/view incarnation. Multiple unrelated tabs, clipboard or renderer state, git locking internals, crash recovery and stock creation failures are outside these bounds.
