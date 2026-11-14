# Frozen properties: session delete fences

Status: proposed with this model. No TLC run, mutation run, or property freeze by a separate reviewer has occurred. The definitions between the `FROZEN PROPERTIES` banners in `tla/SessionDeleteFences.tla` are the corresponding executable statements. Do not weaken them, change the state space, or add fairness merely to obtain a pass. Record any intentional change and its evidence.

| Property | Promise and source | Level |
|---|---|---|
| `NoFeedReinsert` | Once this consumer's successful delete continuation has forgotten the ID in both scopes, neither its feed nor its snapshot may contain the ID again. `src/renderer/stores/session-list.ts:255-285` explicitly forgets both and invalidates outstanding generations. | Protocol, scoped to this consumer's acknowledged delete. |
| `NoOpenDuringDelete` | An open that passed the first check must not publish a host tab, view, or new sidecar while the session has a tombstone or any delete is in flight. `src/main/remote/host-services.ts:1864-1871,1927-1937,1954-1990`; `src/main/session-mutations.ts:34-38`. | Protocol at the publication boundary. |
| `FenceCount` | The in-flight count equals the number of delete instances that entered but have not completed or failed. `src/main/session-mutations.ts:53-72`. | Code-level invariant. |
| `ReconnectReadAbsent` | After an acknowledged delete, an accepted read of the rebuilt consumer does not contain the deleted ID. `src/main/session-list-share.ts:34-49`; `src/main/remote/devices.ts:1052-1054`; `src/renderer/stores/session-list.ts:255-285`. | Protocol under the correspondence assumptions. |
| `RestoredDeletedAbsent` | A layout restore that consults an existing tombstone does not retain that session path. `src/main/tab-layout.ts:80-82,113-123`; `src/main/deleted-sessions.ts:1-4`. | Protocol for the sampled path. |

`NeverOldReadAfterDelete`, `NeverStorageGap`, `NeverOverlap`, `NeverFailed`, `NeverRebuilt`, and `NeverLateReplyAndFreshRead` are deliberately false sanity invariants. The last requires an old pre-delete reply to arrive and be dropped after the rebuild, followed by a fresh accepted read. Their matrix entries require a counterexample. The bug configurations deliberately disable feed invalidation or the final open recheck and require the named invariant to fail. All expected results are hypotheses until the GitHub runner runs them.
