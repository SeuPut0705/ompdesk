# Frozen relay close properties

These are the acceptance properties for one exact-view close, not claims of a successful check. The source contracts are `stop.rs:293-465`, `view-control.ts:267-305,346-436`, `view-host.ts:49-58,101-108`, `sidecar-pool.ts:1455-1567`, and `pool/windows.rs:536-628`.

1. `ReceiptValid`. A native receipt used to produce the final authorization must name the authorized exact view, still be unexpired, be unconsumed, and match the source caller, permissions and source core at the source validation checks.
2. `ExactCommit`. A commit must name the original view incarnation and use the same still-connected target channel. The local guard and synchronous local commit have no intervening await.
3. `RefusalKeeps`. A local refusal does not detach the selected view or send its prepared upstream leave.
4. `NoFalseClosed`. An unconfirmed cleanup following a local close never becomes a `Closed` result.
5. `OthersPreserved`. Closing one exact view leaves the other view, its execution and its saved record intact. The selected view's last idle execution may exit.
6. `ReceiptValid` also detects reuse of the consumed receipt. `ExactCommit` also rejects replay after the target core generation changes. The replay stimuli are abstract and their mutation results remain unobserved.
7. `NoPrematureAck`. A local or hosted leave that closes its last idle execution cannot be acknowledged before that exact execution exits. A protected remaining view or run does not require that wait.
8. A synchronous hub call with an unknown outcome must not report `Closed` or replay the commit.

A source can expire or change immediately after its final acknowledgement and before the target commits. No distributed atomic cut is promised. The frozen requirements do not require source freshness at the later target commit.
