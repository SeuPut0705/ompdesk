# Session delete safety projections

This source-only model separates the five safety predicates of `../session-delete-fences/tla/SessionDeleteFences.tla` into open, list, and restore projections. Each retains the full delete state machine, including both delete instances, independent count releases, failure, and the distinct removal, notification, tombstone, and acknowledgement steps. `CORRESPONDENCE.md` states the required trace and predicate obligations.

The baseline configurations retain `Scopes = {local, global}`, `Opens = {o1, o2}`, `Deletes = {d1, d2}`, `Slots = {r1, r2}`, `InvalidateReads = TRUE`, and `RecheckOpen = TRUE`. The open negative changes only `RecheckOpen` to `FALSE`; it is expected to violate `NoOpenDuringDelete`, not to pass. No run has established that outcome here. No fairness, symmetry, additional actor bound, state constraint, or timeout change is introduced.

The list model retains separate source-read start and finish, renderer answer and finish, snapshot, and reconnect actions. It retains wanted generations, captured generations and connections, and both delete notification and acknowledgement effects. The original late-reply diagnostic observers are omitted only from this safety model. The original reachability scenario remains unchanged.

The original scope and exclusions in `../session-delete-fences/SCOPE.md` apply, including the one saved ID, abstract storage, assumed shared-source freshness, and absence of network delivery and ordering details, crash behavior, and operating-system durability. No liveness or production correspondence follows from these projections alone. The original hosted run `43573249638` remains a failed, unstamped artifact. No whole-original-model pass, performance improvement, or observed mutation coverage is claimed.

## Matrix and mutation plan

`matrix.json` contains three safety baselines, one deliberate open negative, and four diagnostic negatives. Every row retains the existing 7,200-second limit and all declared actor bounds. The diagnostic operators observe overlap, failure, the physical-remove/tombstone gap, and an acknowledged accepted rebuilt read. They do not constrain state. `acknowledged-rebuilt-read-reachable` checks `NeverRebuilt`; it does not establish that reconnect happened after deletion or that an old reply was dropped before a fresh read. The original late-reply scenario remains unchanged.

`mutations.json` proposes sixteen independent mutations targeting the five frozen properties. Admission counting, the full await lifetime, successful and failed count release, feed and snapshot removal, read acceptance and source freshness, final publication, and restore filtering are separate targets. All proposed kills remain unobserved hypotheses. `INVALID`, error, timeout, `MISSED`, and missing evidence are not detection.

The connection guard alone can be masked by generation and wanted-generation checks; the joint mutation does not prove either guard's independent necessity. Removing a kind or cwd recheck alone is masked by the final publication check. Mutations leave the shared `OpenAllowed` oracle and all frozen predicate definitions unchanged. The snapshot-save mutant models a wrong saved result, not the real timer scheduler.

Tombstone insertion itself is an assumption of the modeled delete transition, not a coverage claim: omitting it can escape these frozen predicates because publication and restore consult the current tombstone. Removing Restore's tombstone guard can admit a pre-delete Restore followed by deletion; that is outside this post-delete restore scenario and is not proposed as a legitimate guard kill. Persistence and successful-response durability remain separate obligations.

## Registration boundary

No manifest record or stamp is added here. Base owns registration after explicit handoff. Source, parser applicability, or SANY success is not TLC baseline success or a mutation verdict. No run has checked this namespace. The original full timeout, mutation failure, reachability records, and deliberately broken open observation remain at their original provenance and are not relabeled as passing executions.

