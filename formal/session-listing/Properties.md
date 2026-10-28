# Frozen properties: session listing

Protocol-level: any correct implementation of "a device's list follows the host's listing" must hold them. They are defined next to the model in `tla/SessionListing.tla` (a TLA+ property needs the model's variables, so it cannot live in a separate module without a refinement mapping; see the skill gaps in `formal/findings.json`). Do not weaken or drop one without the user's explicit OK; a change is reported as a model change.

| Name | Statement | Source |
|---|---|---|
| `HeldConverges` | Whenever nothing is in flight (no pending read, reply, event, debounce or id-change handoff), every device's rows say `heldOnHost` for exactly the sessions a tab on the host holds. | `src/shared/ipc-types.ts:1773-1778` (`heldOnHost`: "a tab on that host holds [the session]"), `src/main/remote/host-services.ts:1263-1267` (listingChanged doc: "the devices read the list again when that changed what their last read said, since no journal moved"), the existing test `host-services.test.ts` "tells devices to read the list again when a tab here takes or lets go of a session, and only then". |
| `OpenersConverge` | Under the same condition, every device's `openedBySession` equals the host's opener map (tab opener files and the closed-child record). | `src/shared/ipc-types.ts:1760-1766` (`openedBySession`), `host-services.ts:1277` (`#listing`), `host-services.test.ts` "names who opened each session it lists to a device". |
| `TypeOK` | Shape of the model's variables. Waived in the mutation set (shape only). | model |

Sanity (must FAIL, in `matrix.json`): `NeverHeld`, `NeverOpener`: a device can show a held row and an opener row, so the convergence properties are not vacuous.

Bug toggles in the model (constants, not properties): `IdChangeAnnounces` (FALSE = the code as written; TRUE = `sidecar-pool.ts:962` also calls `listingChanged`, a proposed fix, not applied), `Ordered` (TRUE = the link delivers replies and events in send order; FALSE = any order, because the code does not enforce one).
