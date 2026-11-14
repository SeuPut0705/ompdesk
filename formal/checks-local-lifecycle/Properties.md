# Properties (frozen)

Definitions are between the frozen-property banners in `tla/ChecksLocalLifecycle.tla`. These properties do not promise progress.

| Property | Promise | Source |
|---|---|---|
| `NoPausedDestinationStart` | The destination does not admit a paired local request while its owner has paused admission. | `docs/design/check-control.md` §§8, 9.4; `rule://check-control`, owner's pause. |
| `NoFallbackAfterStop` | A stopped hub sends no later GitHub fallback dispatch, including after fallback was prepared before the stop. | Local lifecycle brief, stopped hub no fallback. |
| `NoCheckoutOverlap` | One checkout has at most one active or cleaning-up local worker, including across a core crash and reopen. | `rule://check-control`, placement, one checkout and one run per repository; local lifecycle brief. |
| `NoStaleGenerationWork` | A delayed worker cannot touch a checkout after a newer generation was installed. | Local lifecycle brief, reconcile detached checks before checkout mutation. |
| `NoWrongShaWork` | Setup and test work start only on their requested SHA. | `rule://check-control`, placement; `docs/design/check-control.md` §7.3. |
| `NoReturnBeforeCleanup` | A cancelled request does not return while its spawned local work or cleanup remains. | Local lifecycle brief, request/core cancellation joined with actual process cleanup. |
| `NoWorkOnDamagedEpoch` | A worker refuses to act if the epoch is unreadable. | Local lifecycle brief, fail closed on unrecoverable epoch; `checkout_guard` reads the epoch before work. |
| `NoAutomaticEpochRepair` | An unreadable existing epoch is not replaced or advanced without evidence. | Local lifecycle brief, fail closed on unrecoverable epoch. |
