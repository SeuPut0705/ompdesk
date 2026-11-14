# Session deletion ordering correspondence

Unstamped source checkpoint. No model-checking or runtime-integration verdict is recorded yet.

| Model actions | Native coordinator operation | Atomicity |
|---|---|---|
| `Begin` | Await Base's canonical scoped deletion claim before `capture`. | Models only after the claim becomes ready; the authority's admission lane is not modeled here. |
| `Preflight` | Reject any captured busy or compacting holder. | The captured host snapshot is immutable. |
| `Release`, `ReleaseFailed` | Release each exact captured holder and retain all returned exit receipts, even a partial failure. | Each native release operation rechecks incarnation and busy/compaction atomically. |
| `Exit` | OS child termination. | Environment event, not a kill signal acknowledgment. |
| `Confirm`, `ReceiptFailed` | Join each exact immutable exit receipt; a rejection settles that receipt without confirming exit. | Other receipts remain owed after a rejection. Native pool/hosted release primitives may perform this join internally. |
| `ReleasedAll`, `JoinFailed` | Finish release loop and propagate any failure only after every earlier receipt settles. | Every await is separate; a failed receipt cannot jump straight to guard release. |
| `Store`, `StorageFailed` | Call installed stock storage through the actual native stock service. | External operation succeeds or fails. |
| `Commit` | Record Base canonical in-memory tombstone after successful storage. | Save diagnostics do not reverse memory or skip invalidation. |
| `Notify` | Invalidate the index and deliver deletion notices. | Abstracted together for the no-premature-notice invariant only. Runtime tests must exercise failure of either effect independently. |
| `Finish` | The owned domain task finishes after notification or failure cleanup, then the exact Scope may drain. | The authority may retain the guard longer for supervised effects; the model's release is the earliest permitted release, not an assertion of immediate drop. |

The model abstracts the two runtime exit receipts as identities `local` and `hosted`. It never looks them up again by a possibly reused tab ID. Base's sole SessionAuthority is assumed to reject new registrations while this guard is held and tombstoned registrations afterward. The ordering model is not proof of that admission implementation.

The model abstracts stock's artifact rules, remote authorization, runtime start/restart, persistence retries, process crashes and lost notifications. It does not establish that the concrete adapter actually uses these services. That requires consumer regressions with real child exit, isolated stock sample records and Base's shared hook. The source boundary is not whole-application completion.

A receipt failure may leave a child alive. It is propagated and storage is not touched. The model makes no claim that signal delivery proves exit or that a failed receipt can be retried safely. Partial view-close errors remain errors and do not turn a saved-file deletion into a successful close-only action.

Source correction after the 24-case bounded native proof: the earlier unexecuted model let `ReceiptFailed` skip remaining receipt joins. It now records rejecting receipt identities separately from confirmed exits and waits for both sets to cover every owed receipt. `NoStorageAfterExitFailure` keeps the same safety promise with a nonempty rejection set instead of a Boolean. The two-runtime bound, fairness and other frozen properties are unchanged. No SANY/TLC/mutation verdict is claimed for this corrected source.

The owned task in Coordinator::execute keeps the same Scope alive if its caller drops. Caller lifetime, cancellation before capture/release, queued stock withdrawal and known-success receipts after cancel/timeout are not separate model actions here. Their observed bounded tests are not a formal refinement proof; extending this model to those behaviors requires additional actions and coverage before any such claim.
