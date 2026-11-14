# Session operations source checkpoint

Status: UNCOMPILED. This module is not exported by core/lib.rs, registered with NativeApp or enabled beside Electron. It is not the final adapter proof or a Node-removal completion claim.

## Ownership

Main AUTHORITY-v2 assigns canonical SessionAuthority state, tombstones, retained-save behavior, full-await deletion counts and all admission consumers to Base. This directory owns mutation ordering only. It contains no authoritative store, counter, issuer, registry or Node callback. The superseded store/test draft was moved outside the repository into this session's isolated scratch and supplied to Base as evidence.

## Concrete source inputs read

- Base source reference `6d02dc1c8b2f19e5b60086641fc9242ded3b2b01`, exact a973 parent, read with `git show` only. The whole source tree was not imported.
- Exact four-file app-contract input `604f75ec087c5e2cb064147e3b63ff632f8e1f99`, locally cherry-picked as `26ad30d91`.
- Relay counted-fence two-file patch `2e0b7a34cf87c8a08013ef5652abd9642440a1fd` as an attached policy reference, not TS code intake.

The published Base source has a concrete stock::native::Service and application::sessions::SessionIndex. Its published sidecar.when_exited, Released.exited and when_released still return void futures and swallow channel closure. Those are not successful exact-exit proof. Base's tiny upgraded source/API was requested and is not available in this checkpoint.

## Ordering implementation

`Coordinator` takes the actual admitted app-contract Owner and primitive Host effects. `Activity` and `RuntimeState` distinguish a compacting holder, an unready live process, and a dormant tab. Delete retains Base's guard before capturing holders. Busy/compacting preflight closes nothing. Every successful or partially failed release contributes immutable exit receipts that are joined before storage. Storage or exit errors propagate. Only successful storage records the canonical in-memory tombstone. Index invalidation and deletion notices are both attempted after commit, and their failures remain failures.

Stop dispatches all captured abort effects and retains every idle waiter. Rename prefers the live hosted owner, refuses an unready owner, otherwise runs stock against the saved file and updates dormant holders. Move refuses any captured holder. Native stored rename uses the existing supervised Exec and installed omp RPC, never handwritten stock journal rules. It refuses a missing file and retries only stock's model-restore failure with `--model @default`.

## Required actual adapter input

Base must supply the actual typed SessionAuthority, canonical guard and stored-mutation admission lease. Pool primitives must capture immutable runtime/incarnation handles, atomically recheck busy/compaction when releasing saved-file holders, and return Result exit receipts captured before disposal. A partial release error must preserve the receipts of anything already released. Saved-file delete must not be confused with closing only one protected view.

The concrete NativeHost still needs Base's tiny pool/authority/stock exports, current Owner/scope checks, authenticated local/remote target resolution, hosted notice tickets, direct index invalidation and direct stock storage wiring. The stored-rename helper and closed-only move must use the same admission authority so an open cannot race their preconditions. No substitute mutex or count belongs here.

Base owns core module exports, Cargo/global files and NativeApp registration. Final native graph intake must instantiate the shared authority once and remove or route every obsolete TS authority consumer in that same wave. No dual writes or simultaneously authoritative TS/native stores are permitted.

## Verification limits

No Rust compile, unit test, formatter, SANY parse, TLC matrix, mutation run or actual stock/child integration run has been executed for this checkpoint. Main explicitly requested source preservation before Base's actual hook is available and prohibited mid-flight checks. Normal branch publication hooks are not a Rust proof.

The ordering model under formal/ is unexecuted source. It abstracts two captured runtimes and one delete. It does not prove Base admission, remote authorization, persistence retries, reconnect/restore, same-saved-ID late writes, rename, move or the concrete native adapter. Its code correspondence must be updated after the real adapter is connected. Formal manifest publication and hosted proof coordination stay with Base/Main.

Acceptance remains open until the real NativeHost is connected and targeted default Rust 1.95 consumer regressions exercise actual isolated storage, child exit, partial errors, reconnect/restore and late writes. Then run the local SANY parse only and coordinate the full hosted formal proof. Do not use real user records or install/change the user's app, accounts, settings or roles.
