# Code correspondence

| Model action | Runtime boundary | Atomicity and omission |
|---|---|---|
| SettingsReply | Lifecycle::settings | The settings await can time out. Off, malformed and ineligible answers are covered by consumer tests rather than this race model. |
| SelectWindow, RegisterQuestion, CloseWindow | target, ask, window_closed | Selection and registration are separate. Registration and the exact window incarnation's closed record use the same lifecycle state lock. A close either rejects later registration or withdraws the existing question. |
| RevokeOwner, AdmitCreate | native::Captured, native::Hooks::create | Revocation can occur while the captured source stays connected. The actual start gate captures its raw Arc and Lane generation once. Base validates the authenticated owner, view, exact source and captured generation and queues the mutation in one native hub step; the Lane fences dequeue too. Settings and create never reread that generation after an await. Root composition is still a prerequisite, not a property proved about a stub host. |
| Answer, DropWaiter | answer, retained start task | An answer grants only its exact window's question. Dropping the gate waiter never drops a stock mutation already admitted. |
| CreateReply, BindFails, BindReply | start_inner, Host::bind, Completion | Stock creation and the async hub binding are separate awaits. A failed binding keeps an owned record awaiting the real release receipt. A closed source transfers its captured receipt to cleanup. |
| QuitBegin, RefreshQuit, QuitTake | finalize, finalize_one, refresh_owned | Quit marks pending starts and snapshots existing owners. A creation completing later inserts its owner and runs the same finalize_one. Root admits Stop and the exit-policy read against a freshly captured current run, rather than reusing the creation generation. Ownership can still be taken by a real release during those awaits. Only the matching Arc owner is taken for quit afterward. |
| Close | released | Owner equality and Arc::ptr_eq reject a different execution source before state or questions are touched. Exactly one owner is removed under the lock. |
| OmpExited | released's exact Work<Result<(), Fault>> | Base captures the actual disposal receipt before forgetting the source. A signal, an absent receipt and an exit fault are not success. Timeout preserves the worktree. |
| Approve, Edit, Remove | plan, exit | Approval includes a clean automatic selection. A second snapshot must match the selected fingerprint. The native git guard and repository gate are reused, not modeled as a new stock rule. Concurrent external edits between that second snapshot and git removal are not claimed atomic. |

## Independent review paths

Main's review of immutable a26b76b9f identified four static, unreproduced paths. The expanded model adds owner revocation, select-close-register, late quit-policy refresh and failed-binding ownership. Consumer regressions name those paths in worktree_lifecycle/tests.rs. A passing model or a fake-host test alone does not establish that Base's actual admission, window delivery or exit receipt implements the required boundary.

The model's one source and one window stand for one captured execution/view incarnation. Multiple unrelated tabs, clipboard or renderer state, git locking internals, crash recovery and stock creation failures are outside these bounds. Lane generation changes and dequeue fencing belong to the actual shared native kernel; this model does not claim to prove them. Root must retain the same Arc<Captured<S>> wrapper through release while matching its exact raw Source and Owner; creating a replacement wrapper at close does not satisfy the runtime identity check.

## ManualPolicy correspondence

| Model action | Runtime boundary | Atomicity and omission |
|---|---|---|
| SelectFolders, Claim, Open | manual::orphans::listing; RemovalClaims::try_claim / holds | Listing yields. Base must read its actual current local folders and call try_claim in the same hub admission that acquire/host-open's holds check shares. No copied open-folder registry is permitted. The actual Root facade is not in this checkpoint. |
| BeginEffect, EndEffect, Release | manual::orphans::remove; repo_lock::run; RemovalGuard::drop | The retained repository task owns the guard through archive, git removal and archive settlement. The supplied Scope holds already-issued process/file effects through their actual completion. Caller-waiter cancellation alone cannot drop that task's guard early. |
| BeginWrite, QuotaWrite, FailedWrite | Saves::write_if; SavedStore::update | One canonical save mutex covers predicate admission, the writer and pending bookkeeping. A quota-pending version is accepted desired state. A new non-quota error is rejected and leaves prior desired state available. Both writer and store keep prior admitted versions until a newer actual commit. |
| Cancel | Cancellation::cancel / cancelled | The predicate retains only a watch sender, never Scope's alive receipt. Cancellation can happen while the writer holds its mutex. |
| BeginRetry, RetryBlocked, RetryCancelled | Saves::retry_once | A retry temporarily owns the pending stack while still holding the save mutex. It chooses the newest valid version. A cancelled version falls back; an admitted scoped version stays desired after a retry error. Legacy unscoped behavior remains unchanged. |
| Commit | disk::tree::write_atomic_if | Every actual rename checks the predicate. The same save mutex excludes newer writes and canonical removal while a retry writes or retries a blocked rename. The model does not treat temp-file creation as a metadata commit. |
| Remove | Saves::remove / remove_kept | File deletion and withdrawal of every pending version use the writer's same mutex. A captured older retry cannot recreate the removed metadata file. |

The instance-harness cases in disk/saves.rs exercise cancellation, quota fallback,
new-write errors, successful supersession and removal without wall-clock waits.
The saved-store consumer case also waits for the request's actual Scope exit before
quota recovery. These cases are authored but unrun here. Root acquire/host-open
consumer barriers, parse, matrix, mutation and hosted stamp remain separate gates.
