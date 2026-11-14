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
