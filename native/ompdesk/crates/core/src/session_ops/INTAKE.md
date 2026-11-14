# Session operations source checkpoint

Status: source checkpoint, not final adapter proof. Core exports this module; NativeApp has not registered or enabled it beside Electron. Base observed the unchanged capture-cancellation regressions fail and the minimal f76 correction pass. The later scoped-claim migration has not run.

## Ownership

Main AUTHORITY-v2 assigns canonical SessionAuthority state, tombstones, retained-save behavior, full-await deletion counts and all admission consumers to Base. This directory owns mutation ordering only. It contains no authoritative store, counter, issuer, registry or Node callback. The superseded store/test draft was moved outside the repository into this session's isolated scratch and supplied to Base as evidence.

## Concrete source inputs read

- Base source reference `6d02dc1c8b2f19e5b60086641fc9242ded3b2b01`, exact a973 parent, read with `git show` only. The whole source tree was not imported.
- Exact four-file app-contract input `604f75ec087c5e2cb064147e3b63ff632f8e1f99`, locally cherry-picked as `26ad30d91`.
- Relay counted-fence two-file patch `2e0b7a34cf87c8a08013ef5652abd9642440a1fd` as an attached policy reference, not TS code intake.
- Exact native stock service input `3bf8e72469cb1a6d63296d19196cd4f67f286941`, locally cherry-picked as `091fb61dc`, three stock files only.
- Exact canonical SessionAuthority input `75307aa0dc9f1cbe9f9ac80fa9edd0d6ec84dbcb`, locally cherry-picked as `f9140dd36`, four application/export files only.
- Exact captured services input `5a95ec411f28826e663b9bd67bd70a799e0e7752`, locally cherry-picked as `fa7accd9e`, 28 bounded native service files only. Base labelled this source unverified.
- Exact generation service input `9385106d1ad2c740735ca4b99525e1edad469e53` and canonical two-helper projection `deb9b27ef6c5557c5c247e37c6b5f2df6ca6bb97`.
- Exact retained-save/quota inputs `610a60b0c4dcdb93bce06b62e88ed0e60f924193` then `01e405f0359830a7c368d38ffc3d8bbee2c166b2`; dependency input `1f4c6b79e656dcd383eb7e0f8fad2c87afd817bb`.
- Exact scoped-authority input `664d13f741e02eb786dc1ac57473d3b2b70c5bfd`, now directly used by the coordinator; its new source tests have not run.
- Exact joined-stock input `3e11af33c123781074f33bf12a7f4d1fe7c2c966`. Mutation adapters must use request_joined so cancellation does not drop the canonical claim before the actual worker receipt.

The direct stock service and canonical SessionAuthority are present as exact source units. Coordinator Config receives Base's actual shared authority Arc. The 938 source captures generation-bound targets and joins Result-bearing Released receipts even if post-release notifications fail. Actual hosted mutation/notice wiring remains pending.

## Ordering implementation

`Coordinator` passes the actual admitted app-contract Owner explicitly to capture and stored effects. There is no mutable current/last-owner side channel. `Activity` and `RuntimeState` distinguish a compacting holder, an unready live process, and a dormant tab. Delete awaits Base's scoped claim before capturing holders. The actual request Scope retains that claim until supervised cleanup drains. Busy/compacting preflight closes nothing. Cancellation after capture starts no mutation; cancellation between releases starts no further release but still joins every receipt already captured. Storage or exit errors propagate. Only successful storage records the canonical in-memory tombstone. Index invalidation and deletion notices are both attempted after commit, and their failures remain failures.

Stop dispatches all captured abort effects and retains every idle waiter. Rename and move await Base's shared stored claim before capturing holders, preventing a concurrent open from bypassing their preconditions. Rename prefers the live hosted owner, refuses an unready owner, otherwise passes ReadyStoredClaim into its stored effect for temporary-holder admission and updates dormant holders. Move refuses any captured holder. Native stored rename uses the existing supervised Exec and installed omp RPC, never handwritten stock journal rules. It refuses a missing file and retries only stock's model-restore failure with `--model @default`.

## Required actual adapter input

Base's scoped deletion and stored-mutation claims are consumed directly; no substitute mutex or count belongs here. The 938 pool source preserves and joins receipts after notification errors. Saved-file delete must not be confused with closing only one protected view.

The concrete NativeHost still needs current Owner/scope checks, authenticated local/remote target resolution, hosted holder/notice tickets, direct index invalidation and direct stock storage wiring. Base confirmed those facades remain unfinished. No empty hosted result, Node fallback or placeholder successful Host is supplied here. The stored-rename helper and closed-only move must bind the admitted claim to actual supervised storage/child work before adapter acceptance.

`runtime::Runtime` binds the captured local Owner/SessionTarget and opaque hosted SessionTicket directly to native pool/HostServices release, stop and full-frame rename effects. It uses the canonical stock_data decoder; a failed RPC response cannot become a successful rename. This leaf is source preparation against actual 06ad and 8a4 APIs, not a substitute Host or an authentication implementation. Its remote imports remain unbound in this checkout until Base supplies the actual bounded HostServices module closure. The local name-note effect still needs a pool primitive that checks the captured incarnation/generation in the same hub step, rather than a separate awaited check followed by note_session_name.

Base owns core module exports, Cargo/global files and NativeApp registration. Final native graph intake must instantiate the shared authority once and remove or route every obsolete TS authority consumer in that same wave. No dual writes or simultaneously authoritative TS/native stores are permitted.

## Unwritten live sessions

`live::LiveSource` carries the actual admitted Owner, tab, execution host and canonical local_dispatch::Session. It does not require a saved file. `rename_from_live` uses stock for an omitted or current sessionPath and only routes another saved path through the saved coordinator. `move_live` uses command.path, the canonical Session slash implementation and post-move directory readback, not the closed-file move operation.

Base must route a remote tab.command to the machine running the omp before constructing this local capability. A nonlocal execution host is rejected before any filesystem call. Local directory validation reuses fs::disk::stat; there is no client-side stat of a remote path or invented remote stat callback.

The canonical Session and CommandError helpers are now consumed through deb9. Session::from_captured takes the generation selected in the same pool hub step; its stock/bridge operations reach the generation checks at actual Lane dequeue through 938. NativeApp must supply this captured capability, not construct Session::new after an await.

## Verification limits

Base ran the unchanged Coordinator plus cancellation source 5222/export e27 and actual 938/deb9 in official check `20261114-115906-4756`, using its existing warm target and explicit cargo/rustc/rustdoc 1.95. Both targeted tests failed: cancellation during capture still released one holder and renamed one live session, each expected zero. Base reported that a concurrent root-manifest edit made that checker result nonreusable. Base then ran minimal correction f76, taken into its root as ca025e4f2, against the unchanged two tests in official check `20261114-120650-092b`: 2 passed, 0 failed, same existing warm target and explicit cargo/rustc/rustdoc 1.95. That result covers only the post-capture cancellation checks, not later scoped claims or actual NativeHost/child/storage integration. This worktree has run no Rust check, formatter, SANY parse, TLC matrix, mutation or actual stock/child integration. Main assigned warm proof to Base and prohibited duplicate/cold-target runs.

The final Rust proof must prepend the installed 1.95 bin directory to PATH and set RUSTC and RUSTDOC explicitly. Record the actual cargo, rustc, rustdoc and Clippy driver paths and versions; a `rustup run 1.95` label is not provenance when Homebrew binaries remain selected. Do not install or mutate a toolchain.

The ordering model under formal/ is unexecuted source. It abstracts two captured runtimes and one delete. It does not prove Base admission, remote authorization, persistence retries, reconnect/restore, same-saved-ID late writes, rename, move or the concrete native adapter. Its code correspondence must be updated after the real adapter is connected. Formal manifest publication and hosted proof coordination stay with Base/Main.

Acceptance remains open until the real NativeHost is connected and targeted default Rust 1.95 consumer regressions exercise actual isolated storage, child exit, partial errors, reconnect/restore and late writes. Then run the local SANY parse only and coordinate the full hosted formal proof. Do not use real user records or install/change the user's app, accounts, settings or roles.
