# Frozen properties: the formal skill's install lock

Protocol-level: any correct lock with takeover of an abandoned holder must hold them. They are defined in `tla/ToolchainLock.tla` between the `FROZEN PROPERTIES` banners. Do not weaken or drop one without the user's explicit OK; a change is reported as a model change.

| Name | Statement | Source |
|---|---|---|
| `MutualExclusion` | At most one process runs the work at a time. | `withLock` doc ("One installer at a time per name across processes"); `audit-toolchain.test.ts` "lets exactly one of several waiters take over a dead holder's lock" (`overlaps` is 0) and "does not remove a lock another waiter made after a stale judgment". |
| `NoFailure` | No waiter fails because another removed the folder it was making its lock in. | The same test (`stderr of the waiters` is empty, every exit code 0); `withLock` doc ("which two waiters must not both do"). |
| `Termination` | Every waiter gets the lock once and finishes (under weak fairness of each process, and strong fairness of the release's wait for the guard). | The same test (`entered` is `rounds * procs`, each round inside its deadline). |
| `LiveHolderKept` | A live holder on this computer never loses its lock to a takeover, however long its computer slept. | `audit-toolchain.test.ts` "never takes over a live holder on this computer"; the install lock's doc ("a holder that is alive on this computer keeps it"). Added 30 Oct 2026 (the stale branch had condemned live holders). |
| `TypeOK` | Shape of the variables. Waived in the mutation set. | model |

Sanity (must FAIL, in `matrix.json`): `NeverHeld` (somebody does get the lock).

Changed 30 Oct 2026, on purpose: `MutualExclusion` lost its exemption for holders that slept (there are none left: a live local holder is never taken over, so two processes in the work is always a violation); `LiveHolderKept` was added; `TakenOverFails` was drafted and dropped (a holder of another computer is outside `Procs`; its stop is a unit test, see `SCOPE.md`).
