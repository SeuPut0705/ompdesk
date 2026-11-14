# Worktree lifecycle race scope

The model covers one fresh local tab, one stock creation, one question and one native source. It includes owner or view revocation while the source stays connected, window close between selection and question registration, create and hub-bind completion after quit begins, a failed binding, the exact disposed omp's exit, final exit-policy refresh, removal approval and one later file or ref change.

The model excludes git internals, stock clone backends, filesystem symlinks, native window transport, process death and unbounded tab identities. It makes no liveness claim. A person may never answer and stock may never complete. A hung omp is kept by the runtime's timeout rather than assumed to exit eventually.

## Frozen protocol properties

- SingleCleanupOwner: close and quit take cleanup ownership at most once.
- NoBindAfterClose: late creation never binds a closed tab.
- NoRemoveWhileOmpAlive: removal waits for the exact disposed omp, not a later tab lookup.
- OnlyApprovedFingerprint: removal requires an approved, unchanged snapshot.
- NoLostCreatedWorktree: an admitted creation is retained by its start task until hub binding completes, then by the live tab or cleanup owner, including binding errors.
- NoUnauthorizedCreate: Base admits and queues creation in the same native step that checks the captured owner, view and source incarnation.
- NoUnanswerableQuestion: a closed window incarnation never holds a pending question.
- QuitUsesFinalPolicy: a worktree created during quit joins the same stop, refresh and ownership-take path as an existing owned worktree.

The first five properties come from src/main/worktree-lifecycle.ts start, close, quit and fingerprint contracts. The final three and the binding-error case were added for Main's independent static review of checkpoint a26b76b9f. That review reported unexecuted consumer paths, not reproduced runtime failures.

## Verification state

A prior, narrower model passed local SANY parse and TLC configuration load in check 20261114-095535-45ab. The expanded model has not been parsed or explored after Main's d4 instruction not to start another local check. No hosted matrix, mutation result or formal stamp is claimed.

Base owns the global manifest and the hosted run. This directory is the only model copy. Runtime proof still requires Base's actual native source, admission, identity-bound bind, exact exit receipt and existing native git facade.

## ManualPolicy model

`ManualPolicy.tla` adds one local folder, one removal guard and up to two or three
scoped metadata versions. It separates an open-folder listing from final claim
admission, cancellation from the save mutex, and a temp-file write from its actual
rename. A rejected newer mutation must not discard accepted pending metadata; a
cancelled newer pending version must leave the prior admitted version available.
Removal and retry use the same writer lock.

The frozen manual properties are `NoOpenDuringRemoval`, `NoCancelledCommit`,
`NoRetryAfterRemoval` and `AcceptedPendingIsRetained`. Their sources are
`worktree-removals.ts`'s check-and-claim/acquire contract, `saved-worktrees.ts`'s
scoped atomic saved.json update, the canonical retained writer and Main/Base d70's
explicit cancellation and pending-version contract.

The manual model excludes archive bytes, filesystem symlink races, git internals,
disk exhaustion duration, multiple repository identities and unbounded metadata.
It makes no fairness or eventual-save claim. Snapshot versions abstract whole
record arrays, not individual fields or independent concurrent record edits.

The model, manual matrix and mutations are source only. No SANY, TLC, mutation run
or stamp has been executed for them. Base owns registration and one hosted run.
The actual Root same-hub folders/claim admission and the same Claims Arc in every
pool/host-open consumer remain integration prerequisites, not assumptions already
verified about the application.
