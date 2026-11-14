# Frozen schedule launch properties

Frozen on 2026-11-14 for Main dispatch d3. Source contract: no late launch after pause/edit/delete, run once, refund every pre-launch failure, preserve committed running work. Tests reproduce the late reservation on the unchanged Engine (official check 20261114-045745-fe36).

- `NoStaleStart`: no process or wake commits after its reservation or async preparation was invalidated. Protocol invariant. Covers reservation reply and final launch commit separately.
- `AtMostOnce`: one run identity commits at most one process/wake. Protocol invariant. Repeated started acknowledgements do not commit another effect.
- `RefundUnstarted`: a run that settles without committing has no spent quota. Protocol invariant. Refused reservations charge nothing; successful but invalidated reservations refund once.
- `NoStalePublish`: a retired trigger instance never saves its mark or fires a run, including pause followed by resume with the same JSON settings. Protocol invariant.

No liveness claim. No fairness or state constraints. Filesystem failure, crash recovery, quota calendar accounting, OS process-tree teardown, NativeCaller authentication and external source algorithms are outside this model. Application/Engine regression tests cover concrete lock boundaries and journal completion. Platform and integrated application checks remain Main/Base gates.
