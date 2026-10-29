# Frozen properties: shared-checkout claims

Protocol-level: any correct implementation of claims shared through main must hold them. They are defined in `tla/CheckoutClaims.tla` between the `FROZEN PROPERTIES` banners and asserted on the real code by `src/main/checkout-claims.test.ts`. Do not weaken or drop one without the user's explicit OK; a change is reported as a model change.

| Name | Statement | Source |
|---|---|---|
| `NoEarlyRelease` | Once B was told F is A's while A's call wrote it, B keeps being told so until that call reports back. | The unit's brief (29 Oct 2026: "a file being written by A is never released to B before A's call ends"); `.omp/rules/control-tools.md` "A write still running is never retired"; 323c8ed. |
| `NoLostClaim` | A write of A's that nobody committed is A's claim. | control-tools.md "Claims survive the omp"; `ClaimBook.retire` doc ("a file changed again since stays"); ca16de6. |
| `NoStaleReturn` | No verdict of main's rests on a claim it judged committed: B is never told F is A's on that claim again. | The brief ("a committed file is nobody's claim"); control-tools.md "A committed file is no longer a claim, for good"; 12ef99a. |
| `CommittedIsNobodys` | A's book holds no claim main judged committed once no call writes F and the retire was handled. | Same sources as `NoStaleReturn`, at A's side. |
| `RunningIsPending` | Every call still running is pending in A's book, whichever agent's run ended. | The brief ("a subagent's end releases only its own writes"); 089d329. |
| `TypeOK` | Shape of the variables. Waived in the mutation set. | model |

Sanity (must FAIL, in `matrix.json`): `NeverShownWhileWriting` (B can be told F is A's while A writes), `NeverReleased` (main can judge a claim committed), so the properties above are not vacuous.
