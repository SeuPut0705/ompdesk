# Frozen session deletion ordering properties

Frozen on 2026-11-14 for Main AUTHORITY-v2. This model does not implement or duplicate Base's canonical authority.

| Property | Promise | Contract source |
|---|---|---|
| `DeleteAfterConfirmedExit` | Stock deletion runs only after every captured local and hosted runtime confirms its actual exit. | `src/main/session-mutations.ts:1-11`; Relay exact-exit policy packet. |
| `NoFalseDeletion` | A failed stored delete records no tombstone. | `src/main/session-mutations.test.ts:61-68`. |
| `NoPrematureNotice` | Deleted notifications require successful storage and canonical memory commit. | `src/main/session-mutations.ts:49-57`; hosted deletion contract. |
| `BusyKeepsHolders` | A busy or compacting holder prevents closing any holder in the preflight snapshot. | `src/main/session-mutations.test.ts:51-59,100-111`. |
| `GuardCoversEffects` | Base's counted deletion guard stays alive from capture through notification or failure cleanup. | Relay two-file counted fence packet `2e0b7a34cf87c8a08013ef5652abd9642440a1fd`. |
| `NoStorageAfterExitFailure` | A rejected runtime exit receipt never authorizes storage deletion. | Main initial actual-native session-ops assignment and Relay whenExited failure contract. |

All are safety invariants. No fairness or state constraint is used. The bounds are two captured runtimes and one deletion. Reconnect, restoration and same-saved-ID late writes require Base authority integration tests, not this ordering model. Changing a frozen property, a bound, or fairness is a model change and must be reported.
