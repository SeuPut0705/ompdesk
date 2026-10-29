# Frozen properties: the formal skill's install lock

Protocol-level: any correct lock with takeover of a dead holder must hold them. They are defined in `tla/ToolchainLock.tla` between the `FROZEN PROPERTIES` banners. Do not weaken or drop one without the user's explicit OK; a change is reported as a model change.

| Name | Statement | Source |
|---|---|---|
| `MutualExclusion` | At most one process runs the work at a time. | `withLock` doc ("One installer at a time per name across processes"); `audit-toolchain.test.ts` "lets exactly one of several waiters take over a dead holder's lock" (`overlaps` is 0). |
| `NoFailure` | No waiter fails because another removed the folder it was making its lock in. | The same test (`stderr of the waiters` is empty, every exit code 0); `withLock` doc ("which two waiters must not both do"). |
| `Termination` | Every waiter gets the lock once and finishes (under weak fairness of each process). | The same test (`entered` is `rounds * procs`, each round inside its deadline). |
| `TypeOK` | Shape of the variables. Waived in the mutation set. | model |

Sanity (must FAIL, in `matrix.json`): `NeverHeld` (somebody does get the lock).
