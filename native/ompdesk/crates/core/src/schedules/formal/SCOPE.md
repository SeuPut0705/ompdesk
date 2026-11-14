# Native schedule launch fence

This model covers one run identity with one reserved quota receipt, two schedule invalidations, and two source-generation changes. Runtime resolution is a separate step from the final launch commit. A schedule edit, disable, pause or deletion can happen before either step completes. Committed running work remains valid after later schedule changes.

The protocol properties are frozen in `Properties.md`. `MC.cfg` checks the fixed model. `MC_bug.cfg` removes both launch fences and must violate `NoStaleStart`. `MC_sanity.cfg` must violate `NeverStarted`, so the exploration must reach a real launch. `mutations.json` removes the final fence, duplicate-start protection, the abort refund, and source fencing independently.

This is a bounded safety model, not a whole-app proof. It omits filesystem errors, process-tree teardown, calendar quota rollover, external source readers, authenticated native caller construction, crashes and fairness. The consuming `Charge` type prevents multiple refund callbacks; the model checks that unstarted work refunds, not callback multiplicity. Tests exercise the actual Engine and Application lock boundaries and completion journal.

Local evidence is SANY parsing only. Main owns the integrated runner candidate and must run the model matrix and mutations before treating the model as verified. No passing TLC or mutation claim is made here.

The shared formal manifest needs an integration-owner entry pointing at this directory and the owned `schedules/{application,engine,triggers}.rs` code. That registration is outside this leaf's scope.
