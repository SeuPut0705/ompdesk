# Session deletion ordering correspondence

Unstamped source checkpoint. No model-checking or runtime-integration verdict is recorded yet.

| Model actions | Native coordinator operation | Atomicity |
|---|---|---|
| `Begin` | Await Base's canonical scoped deletion claim before `capture`. | Models only after the claim becomes ready; the authority's admission lane is not modeled here. |
| `Preflight` | Reject any captured busy or compacting holder. | The captured host snapshot is immutable. |
| `Release`, `ReleaseFailed` | Release each exact captured holder and retain all returned exit receipts, even a partial failure. | Each native release operation rechecks incarnation and busy/compaction atomically. |
| `Exit` | OS child termination. | Environment event, not a kill signal acknowledgment. |
| `Confirm`, `ReceiptFailed` | Native code joins each exact immutable exit receipt; a rejection settles that receipt without confirming exit. | The frozen model's `ReceiptFailed` instead jumps directly to `failed`. It does not establish the native all-receipts-joined requirement. |
| `ReleasedAll`, `JoinFailed` | Native code propagates failure only after every earlier receipt settles. | Every native await is separate. The frozen model still needs an explicitly approved refinement before it can prove the failed-receipt path. |
| `Store`, `StorageFailed` | Call installed stock storage through the actual native stock service. | External operation succeeds or fails. |
| `Commit` | Record Base canonical in-memory tombstone after successful storage. | Save diagnostics do not reverse memory or skip invalidation. |
| `Notify` | Invalidate the index and deliver deletion notices. | Abstracted together for the no-premature-notice invariant only. Runtime tests must exercise failure of either effect independently. |
| `Finish` | The owned domain task finishes after notification or failure cleanup, then the exact Scope may drain. | The authority may retain the guard longer for supervised effects; the model's release is the earliest permitted release, not an assertion of immediate drop. |

The model abstracts the two runtime exit receipts as identities `local` and `hosted`. It never looks them up again by a possibly reused tab ID. Base's sole SessionAuthority is assumed to reject new registrations while this guard is held and tombstoned registrations afterward. The ordering model is not proof of that admission implementation.

The model abstracts stock's artifact rules, remote authorization, runtime start/restart, persistence retries, process crashes and lost notifications. It does not establish that the concrete adapter actually uses these services. That requires consumer regressions with real child exit, isolated stock sample records and Base's shared hook. The source boundary is not whole-application completion.

A receipt failure may leave a child alive. It is propagated and storage is not touched. The model makes no claim that signal delivery proves exit or that a failed receipt can be retried safely. Partial view-close errors remain errors and do not turn a saved-file deletion into a successful close-only action.

The frozen, unexecuted model is preserved byte-for-byte under Main d20; no property, model, run or stamp is changed. Its `ReceiptFailed` currently skips remaining receipt joins, unlike the native coordinator. The current @code line ranges in that frozen model predate scoped admission and the owned-task correction and are not a current correspondence stamp. This table records the mismatch, not a model-checking verdict. The two-runtime bound and fairness remain unchanged.

The owned task in Coordinator::execute keeps the same Scope alive if its caller drops. Caller lifetime, cancellation before capture/release, queued stock withdrawal and known-success receipts after cancel/timeout are not separate model actions here. Their observed bounded tests are not a formal refinement proof; extending this model to those behaviors requires additional actions and coverage before any such claim.

Current native anchors: `Coordinator::execute` owns the task at mod.rs:150-159; scoped claim/capture is 163-169; preflight is 173-175; release is 178-196; every receipt is joined at 197-201 before fault propagation at 202-204; stored mutation and canonical memory commit are 208-214; invalidation and notices are 217-220. Those source references do not update or validate the frozen model's annotations.
