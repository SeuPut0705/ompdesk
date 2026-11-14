# Session deletion ordering correspondence

Unstamped source checkpoint. No model-checking or runtime-integration verdict is recorded yet.

| Model actions | Native coordinator operation | Atomicity |
|---|---|---|
| `Begin` | Begin Base's canonical RAII guard before `capture`. | One synchronous guard operation. |
| `Preflight` | Reject any captured busy or compacting holder. | The captured host snapshot is immutable. |
| `Release`, `ReleaseFailed` | Release each exact captured holder and retain all returned exit receipts, even a partial failure. | Each native release operation rechecks incarnation and busy/compaction atomically. |
| `Exit` | OS child termination. | Environment event, not a kill signal acknowledgment. |
| `Confirm`, `ReceiptFailed` | Join exact immutable exit receipt. | Each awaited receipt either confirms exit or fails. |
| `ReleasedAll`, `JoinFailed` | Finish release loop and propagate any failure only after earlier receipts settle. | Every await is separate. |
| `Store`, `StorageFailed` | Call installed stock storage through the actual native stock service. | External operation succeeds or fails. |
| `Commit` | Record Base canonical in-memory tombstone after successful storage. | Save diagnostics do not reverse memory or skip invalidation. |
| `Notify` | Invalidate the index and deliver deletion notices. | Abstracted together for the no-premature-notice invariant only. Runtime tests must exercise failure of either effect independently. |
| `Finish` | Drop Base canonical guard after notification or failure unwind. | Each guard releases only its own counted hold. |

The model abstracts the two runtime exit receipts as identities `local` and `hosted`. It never looks them up again by a possibly reused tab ID. Base's sole SessionAuthority is assumed to reject new registrations while this guard is held and tombstoned registrations afterward. The ordering model is not proof of that admission implementation.

The model abstracts stock's artifact rules, remote authorization, runtime start/restart, persistence retries, process crashes and lost notifications. It does not establish that the concrete adapter actually uses these services. That requires consumer regressions with real child exit, isolated stock sample records and Base's shared hook. The source boundary is not whole-application completion.

A receipt failure may leave a child alive. It is propagated and storage is not touched. The model makes no claim that signal delivery proves exit or that a failed receipt can be retried safely. Partial view-close errors remain errors and do not turn a saved-file deletion into a successful close-only action.
