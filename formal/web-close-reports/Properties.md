# Properties (frozen)

Definitions live between the banners in `tla/WebCloseReports.tla`.

| Property | Statement | Source |
|---|---|---|
| `StoreOnlyLive` | Only a live connection holds a report; an ended one never counts again. | `file-edit-reports.ts` doc; fb2f902 ("forget a paired page's Files-edit report when its last connection drops"); `.omp/rules/control-tools.md` "Unsaved Files edits stay protected" |
| `QuiescentAgreement` | A live, greeted connection with nothing in flight holds exactly its page's editor state: no other connection's report or drop changed it. | 09f8b6af ("keep Files-edit reports per connection"); `.omp/rules/multi-viewer-web.md` "a device's up to four connections share one window" |
| `NoReleaseOfKnownDirty` | A close never decides to release a tab a settled live page holds unsaved edits in. | b2c22f84, 0f9382b8; `.omp/rules/control-tools.md` "Only `dirty` keeps the tab" |

Sanity (must be violated): `NeverReleases`, `NeverRefuses`. Documented gap (must be violated until the code changes on purpose): `NoLateDirtyRelease`.
