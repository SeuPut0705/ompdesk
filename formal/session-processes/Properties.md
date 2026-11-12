# Properties (frozen)

Definitions live between the banners in `tla/SessionProcesses.tla`.

| Property | Statement | Source |
|---|---|---|
| `OnlyGoneTagsEnd` | A tag is ended only when its tab was closed outside a quit, or its session did not come back at a launch, and no tab has taken it over since. | The owner's requirements of 12 Nov 2026: "never one of another live session"; a quit is not a close (`.omp/rules/control-tools.md` › Session processes, "A quit ends nothing") |
| `OpenTabsKeepTheirProcesses` | The tag a started tab holds is never in an end in flight, and neither is what the last launch left for a restored tab that has not started yet. | Same: "an idle session's processes are left alone while its tab is open"; "the markers of interrupted work decide which sessions continue: theirs stay" |
| `NoLeakAtRest` | At rest in a launch where no end failed, every tag in the file is held by a started tab or left for a session whose tab is open. | The owner's report: "nothing cleans up after itself"; the user's rule "a computer does not fill up with what finished work left behind" |
| `NoForgottenTag` | A tag some running process carries is in the file, so a later close or launch can still end it. | `session-processes.ts` `#endEntry`: "a failed end puts it back as left" |

Sanity (must be violated): `NeverEnds`, `NeverTakesOver`.
