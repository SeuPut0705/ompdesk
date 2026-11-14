# Session operations source checkpoint

Status: UNCOMPILED. This module is not exported by core/lib.rs, registered with NativeApp or enabled beside Electron. It is not the final adapter proof or a Node-removal completion claim.

## Ownership

Main AUTHORITY-v2 assigns canonical SessionAuthority state, tombstones, retained-save behavior, full-await deletion counts and all admission consumers to Base. This directory owns mutation ordering only. It contains no authoritative store, counter, issuer, registry or Node callback. The superseded store/test draft was moved outside the repository into this session's isolated scratch and supplied to Base as evidence.

## Concrete source inputs read

- Base source reference `6d02dc1c8b2f19e5b60086641fc9242ded3b2b01`, exact a973 parent, read with `git show` only. The whole source tree was not imported.
- Exact four-file app-contract input `604f75ec087c5e2cb064147e3b63ff632f8e1f99`, locally cherry-picked as `26ad30d91`.
- Relay counted-fence two-file patch `2e0b7a34cf87c8a08013ef5652abd9642440a1fd` as an attached policy reference, not TS code intake.
- Exact native stock service input `3bf8e72469cb1a6d63296d19196cd4f67f286941`, locally cherry-picked as `091fb61dc`, three stock files only.
- Exact canonical SessionAuthority input `75307aa0dc9f1cbe9f9ac80fa9edd0d6ec84dbcb`, locally cherry-picked as `f9140dd36`, four application/export files only.
- Exact captured services input `5a95ec411f28826e663b9bd67bd70a799e0e7752`, locally cherry-picked as `fa7accd9e`, 28 bounded native service files only. Base labelled this source unverified.

The direct stock service and canonical SessionAuthority are present as exact source units. Coordinator Config receives Base's actual shared authority Arc and directly holds its DeletionGuard through storage, commit and notices. The 5a95 source now has Result-bearing Released receipts and generation-bound SessionTarget. Its close_session_tab still has fallible notification awaits between release and receipt join; an unreproduced source integration risk was reported to Base. The tiny correction and actual hosted-mutation facade remain pending.

## Ordering implementation

`Coordinator` takes the actual admitted app-contract Owner and primitive Host effects. `Activity` and `RuntimeState` distinguish a compacting holder, an unready live process, and a dormant tab. Delete retains Base's guard before capturing holders. Busy/compacting preflight closes nothing. Every successful or partially failed release contributes immutable exit receipts that are joined before storage. Storage or exit errors propagate. Only successful storage records the canonical in-memory tombstone. Index invalidation and deletion notices are both attempted after commit, and their failures remain failures.

Stop dispatches all captured abort effects and retains every idle waiter. Rename prefers the live hosted owner, refuses an unready owner, otherwise runs stock against the saved file and updates dormant holders. Move refuses any captured holder. Native stored rename uses the existing supervised Exec and installed omp RPC, never handwritten stock journal rules. It refuses a missing file and retries only stock's model-restore failure with `--model @default`.

## Required actual adapter input

The actual SessionAuthority and canonical guard are consumed directly. Base must still supply the shared stored-mutation admission lease. Pool primitives capture immutable runtime/incarnation handles and atomically recheck busy/compaction when releasing saved-file holders. A partial release error must preserve and join the receipts of anything already released, including errors after release but before notification finishes. Saved-file delete must not be confused with closing only one protected view.

The concrete NativeHost still needs the corrected partial-release primitive, current Owner/scope checks, authenticated local/remote target resolution, hosted notice tickets, direct index invalidation and direct stock storage wiring. The stored-rename helper and closed-only move must use the same admission authority so an open cannot race their preconditions. No substitute mutex or count belongs here.

Base owns core module exports, Cargo/global files and NativeApp registration. Final native graph intake must instantiate the shared authority once and remove or route every obsolete TS authority consumer in that same wave. No dual writes or simultaneously authoritative TS/native stores are permitted.

## Unwritten live sessions

`live::LiveSource` carries the actual admitted Owner, tab, execution host and canonical local_dispatch::Session. It does not require a saved file. `rename_from_live` uses stock for an omitted or current sessionPath and only routes another saved path through the saved coordinator. `move_live` uses command.path, the canonical Session slash implementation and post-move directory readback, not the closed-file move operation.

Base must route a remote tab.command to the machine running the omp before constructing this local capability. A nonlocal execution host is rejected before any filesystem call. Local directory validation reuses fs::disk::stat; there is no client-side stat of a remote path or invented remote stat callback.

The canonical Session and CommandError helper blobs are not yet a self-contained consumed input. Dispatcher revision dc34640cb10aed71099cdce4597eadfe9f9b51ab was read as a source reference only; its delta changes unrelated diagnostics and was not cherry-picked. Main/Base must package the canonical helper source plus minimal module registration, or compile the actual domains in one fixed cohort. The upcoming Session generation wrapper must use the actual Lane dequeue gates, not the old check-then-send helper.

## Verification limits

No Rust compile, unit test, formatter, SANY parse, TLC matrix, mutation run or actual stock/child integration run has been executed for this checkpoint. Main explicitly requested source preservation before Base's actual hook is available and prohibited mid-flight checks. Normal branch publication hooks are not a Rust proof.

The final Rust proof must prepend the installed 1.95 bin directory to PATH and set RUSTC and RUSTDOC explicitly. Record the actual cargo, rustc, rustdoc and Clippy driver paths and versions; a `rustup run 1.95` label is not provenance when Homebrew binaries remain selected. Do not install or mutate a toolchain.

The ordering model under formal/ is unexecuted source. It abstracts two captured runtimes and one delete. It does not prove Base admission, remote authorization, persistence retries, reconnect/restore, same-saved-ID late writes, rename, move or the concrete native adapter. Its code correspondence must be updated after the real adapter is connected. Formal manifest publication and hosted proof coordination stay with Base/Main.

Acceptance remains open until the real NativeHost is connected and targeted default Rust 1.95 consumer regressions exercise actual isolated storage, child exit, partial errors, reconnect/restore and late writes. Then run the local SANY parse only and coordinate the full hosted formal proof. Do not use real user records or install/change the user's app, accounts, settings or roles.
