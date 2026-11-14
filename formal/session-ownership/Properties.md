# Frozen properties

The first four statements are the protocol promises frozen in `formal/session-processes/Properties.md`. Their definitions in `SessionOwnership.tla` use the native model's owners and explicit pending work. Do not weaken them to make a run pass. The additional properties cover the native admission and wait boundaries and hosted grace.

| Property | Promise | Source |
|---|---|---|
| `OnlyGoneTagsEnd` | An in-flight end has independent authorization from a non-quit close or from a sweep that found no returned owner. Takeover revokes authorization. | `formal/session-processes/Properties.md`; `src/main/session-processes.ts:270-313` |
| `OpenTabsKeepTheirProcesses` | No started owner's tag or leftover for a restored, not-yet-started owner is in an end. | `formal/session-processes/Properties.md` |
| `NoLeakAtRest` | Once the launch sweep and grace have completed, all queued releases and closes have settled, and no end failed, each entry belongs to an open owner or a kept local session. A kept interrupted-work marker is a restored-session obligation even before a tab exists. | `formal/session-processes/Properties.md`; `src/main/session-processes.ts:183-190` |
| `NoForgottenTag` | A tag carried by any represented running process remains in the journal. | `formal/session-processes/Properties.md` |
| `NoLateAdmission` | A close tombstone prevents later acquisition under the same opaque owner, including when close precedes the first acquisition. | Native integration contract from Main. |
| `PendingCloseProtected` | An end associated with an owner cannot begin before Base reports the captured exit receipt complete. | `native/ompdesk/crates/core/src/sidecar/lane.rs` `dispose` and `when_all_exited`; native integration contract from Main. |
| `HostedGraceProtected` | A hosted leftover without separate close authorization cannot enter an end while the launch grace remains pending. | `src/main/session-processes.ts:287-313` |

The original `NoLeakAtRest` folded all disposal work and hosted grace into one step. The stated resting condition here excludes pending close receipts, queued work, and the hosted grace. The extra kept-session disjunct represents interrupted-work markers already named by the original promise. It does not authorize deleting a kept tag. The model does not claim eventual completion of pending operations.

`NeverEnds`, `NeverTakesOver`, `NeverClosing`, `NeverHostedGrace`, and `NeverRetryOvertaken` are intentionally false reachability checks, not promises. `NeverHostedReleasedAfterGrace` is checked under `HostedTraceSpec`, which restricts the trace to open a hosted owner, crash, restore it, let grace see it held, and close it before acquisition. Its expected violation witnesses a queued release. This scenario does not replace the unrestricted safety check. Mutation and matrix expectations are unverified until the hosted runner records their results.
