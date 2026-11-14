# Frozen retained reopen properties

These are target properties, not observed verification results. The scenario and exclusions are in `SCOPE.md`. The source contracts and pending mappings are in `CORRESPONDENCE.md`.

1. `JoinSafety`. The original custody, permission, saved record, and busy execution survive. Within the zero-view scenario, an eligible normal reopen is not refused, an ineligible reopen does not attach, and an actual attachment is classified as joined before setup. Failure of setup must not stop the retained execution. This does not alter the intentional refusal for a matching visible tab.
2. `RuntimeSafety`. There is exactly one execution throughout the scenario. Its count is an observable abstraction of process creation, not a process-level proof.
3. `ViewSafety`. Once B is adopted and before B itself is closed, the visible attachment and renderer runtime remain B. A read from before adoption and A's delayed close result must not remove them.
4. `SerialSafety`. The current close serial equals the independently recorded newest close serial. After A's rollback reconcile await, an older continuation must not overwrite a newer B close serial.
5. `WorkSafety`. Once B is adopted and before B itself is closed, its busy work remains visible. A delayed A starting frame or a frame with missing view metadata cannot reset it.

The `adopted`, `bClosed`, and `expectedSerial` history fields record events independently of the values tested by the invariants. `JoinSafety` records the decision and actual attachment separately. The model does not assert that a request eventually completes.
