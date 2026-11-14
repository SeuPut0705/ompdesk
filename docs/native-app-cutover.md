# Native application cutover inventory

Status: 14 Nov 2026. Integration branch `omp/agent/shell-native-integration` combines S `f2ca2c8ce`, main `cdfe86e8f`, organization transfer `facc97ae3` and the five preserved SX implementations. This is **not a Node-free application**. The original Electron-dependent subset in `rust-remaining-units.md` §4 is not the complete application boundary.

## Remaining production entry

`crates/shell/src/main.rs` locates `out/main/index.js` and `node::spawn` starts it; `src/main/index.ts` composes the app and `src/main/ipc.ts` registers its command handlers. `src/main/core/process.ts` still owns the core process. `Ctx::core` still relays through Node. Core `ipc::OWNED` is empty. These are executable dependencies, not intentional TypeScript and not completed native plumbing.

Run `bun scripts/shell-port/runtime-inventory.ts` from the checkout to emit the per-file static runtime graph. It scans imports without loading app modules, follows the shell build's Electron alias, and excludes type-only imports. Unresolved imports fail the command. Computed imports, filesystem-loaded resources and embedded worker programs require separate review; physical source lines are not an implementation-size or completion metric.

## Domain residuals and observable completion

Paths below are relative to `src/main` (TS) and `native/ompdesk/crates/core/src` (Rust). Every row still requires native application composition. Existing engines must be reused, not copied.

| Domain | Existing Rust implementation | Remaining TS policy/effects | Native completion observation |
|---|---|---|---|
| Web | `web::{Edge,router::Host,uploads,push,store}` | `web/web-host.ts` lifecycle/VAPID invalidation; `server.ts::answerAsk`; `ws-router.ts` quota, shaping, binary/media/upload landing; pairing approval and push notification privacy/deduplication | Without Node: phone pairing, invoke/send, upload/media, reconnect/resync and immediate revoke; pushes still precede replies; foreground/Stop/privacy notification rules remain. |
| Remote | `remote::devices` gate/dial/retry; link crypto and event codecs | `remote/devices.ts` application receive dispatch; `host-services.ts` tab/session/terminal/preview operations; `remote-sidecar.ts` offline replay/read-delta recovery; peer quota reserve/refund | Two Rust-only desktops share one omp per session; disconnect/restart preserves run/asks/transcript, answer and quota apply once, deleted sessions never revive, phone and both desktops receive changes. Execution host is not inferred from view host. |
| Sidecar/pool | `sidecar::Lane`; `pool::{api,windows,listen,persist}` ownership/claim/process state machines | `sidecar.ts` resolve/settings/launch/gate/session-wait effects; `sidecar-pool.ts` application ask executor, tool dispatch, settings, event/binary batching and flush | Native local/web/remote tab start/restart/sleep/close, previous process exit before replacement, viewer close only detaches, reconnect starts whole, transcript reply follows earlier events. Existing receipt/generation/claim owners remain authoritative. |
| Setup | `setup` verified downloads/archive resolution; `supervise` process tree | `setup/service.ts` required/optional ordering, Bun floor, installer selection, compiled-launcher recovery, retry/backoff ledger; plans/env; Windows isolated handle-list launch | Fresh machine reaches required installs → usable omp → first tab → optional installs; retry/cancel/restart records remain correct, Bun upgrade preserves a working launcher, isolated memory setup retains no app pipe handles. |
| Memory | `aimemory::service::{queue,pass}`, upkeep/care/client/root/healing | `ai-memory/service.ts` agent directory, terminal preference, Bun/first-tab/env/isolated-run callbacks; valid disabledExtensions YAML; `core-asks.ts` omp launch selection | Native packaged stage/setup/ready and repair; terminal capture is not duplicated; old-generation callbacks cannot settle new requests; actual journal upkeep/backfill and protected purge/reconnect work. |
| Schedules/routines | `schedules::Engine` and journal; routines source primitives | `schedules.ts` draft coercion, quota reserve/refund, authenticated wake and launch environment; `routines/triggers.ts` live source/quiet-window/mark lifecycle | Native local/paired create/run-now/timed/webhook/events, quota failure refund, no late fire after pause/edit/delete, no duplicate restart run, journal closes and launch uses the same memory/MCP environment. |
| Autopilot | coordinator, cycle, audit, ship and land-check engines | `autopilot-approver.ts` permission policy; release detection; quota reset facts; `autopilot.ts` actual bridge/tab/worktree/dispatch/land-shell effects | Start creates real tab/worktree and arms the bridge; four existing frames drive audits/ship; human-only approval exceptions survive; quota/restart resumes once; Stop drains children/queue and starts no new work. |
| Machine services | model research execution, existing stock/core services | `machine-services.ts` host/pref/remote-update ordering; benchmark argument/process/timeout policy; model prompt/plan validation; canonical runtime/Bun/omp/login environment selection | Desktop/phone/paired calls affect only the selected authenticated host's settings/jobs/quota; real progress/failure/cancel reaches the original caller; no benchmark depends on bundled Node. |

## Base-owned shared integration

- `PROTOCOL.md` §15.4.1 is the frozen native boundary. `ompdesk-app-contract` owns the non-deserializable caller and the page request/reply contract. Domain `Host`/`Deps` values inject typed `Arc<domain Service>` APIs; internal calls do not become another JSON RPC layer.
- Base alone constructs the service graph, admits/dispatches page IPC, binds existing external hub surfaces, routes native effects, and owns process/callback generation and shutdown ordering. Domain owners provide leaf implementation and registration requirements, not concurrent edits to shared files.
- Core remains a supervised child. App callbacks cannot queue behind the command awaiting them. Callback completion, snapshots and pushes preserve the existing ordering/generation contracts.
- Runtime log writer, full-disk retained saves, CEF first-page notification, Boot owner revocation, native quit/update ordering, authenticated dialogs/notifications and the CEF UI heartbeat are part of this integration, not optional polish.
- Windows isolated supervisor handle inheritance is still a common platform effect, not proven by the existing `isolated` flag alone.

### Native source intake, 14 Nov 2026

The source units below are present in `omp/agent/shell-native-common`. A domain's native constructor and tests are not evidence that the production application invokes it.

| Source unit | Integrated implementation | Remaining composition gate |
|---|---|---|
| Machine/models | Canonical runtime, shell, detection, REA cache and typed application; closed runners fence child admission after runtime resolution. | Authenticated target resolution must reject a revoked owner before the domain is polled again. `close_owner` signals cancellation; it is not a joined global teardown. |
| Pool/sidecar | Existing Lane and hub engine through native handles; same-tick activity/snapshot and intrinsic outcome identity. | Real native Host, owner reservations, release receipts, platform effects and strong per-tab/generation/outcome Arc retention. |
| Schedules/routines | Native source actors reuse OS watches, Git/GitHub reads, pool subscriptions and read-only TLS IMAP/MIME. | The actual authenticated pool activity channel and native account/credential capability; no Node source callback. |
| Memory | One Rust policy compiled into tracked WASM, embedded terminal extension and native supervised capture Host. | Production upkeep/care clients and the CEF entry remain unbound. The isolated-run refusal was removed only after Main accepted Setup's bounded Windows runner/handle-list proof; integrated Windows strict and artifact gates remain open. |
| Autopilot | Native typed service, existing coordinator, canonical Machine shell and stock approval guard. | Actual Pool/Machine/worktree/resume/permission ports and application frame delivery. |
| Caller admission/preferences/logging | Native generation/owner/request registry, retained shared preferences and UTF-16-compatible runtime log writer. | Authenticated transport admission, real IPC registration and replacement of the existing Node writer, never two simultaneous writers. |

`application::Services` constructs the shared Machine, Setup runner, stock lanes, Memory Host, OS-backed credential bridge, session index, shared tombstones and first-tab barrier directly. It is not yet wired into the shell's production startup. The Node entry in the section above remains reachable. Setup close is joined before readiness and Memory are released; caller admission is revoked before shutdown.

Current local evidence uses explicit Rust/compiler/toolchain-subcommand 1.95. Common source tests `20261114-082526-2df4` passed 174 cases; actual supervised setup adapters `20261114-082635-1cff` passed 20. The direct shell/core transport `20261114-090214-c65e` passed six executable tests (two child fixtures are ignored as standalone tests), including binary/bidirectional calls, owner death, EOF, cancellation and thread-spawn failure cleanup. Session index/feed tests `20261114-090718-e5d0` passed 21 cases, including a 2,112-command corpus captured from the actual TypeScript pace classifiers. These checks do not execute CEF, paired desktops or the final application artifact.

Additional launch-policy gaps are not hidden behind the native Host traits: the authenticated MCP hub and builtin-root composition, session process-tag/scratch ownership, worktree start lifecycle and the main local-RPC dispatcher still have production TypeScript decisions. Pool/sidecar engines, OS process reads and stock bridge methods are reused; their existence does not replace these decisions.

Independent hosted source-unit runs retain their observed failures. The Memory run's missing limit-wait log followed an observed hub timeout and core termination; its underlying transport stall is unconfirmed. No deadline or assertion has been relaxed. Canonical Electron-baseline notices are regenerated from that baseline's frozen dependencies; a CEF candidate or changed Cargo lock requires its own generated notices, not a copied expected string.

## Intentionally TypeScript

Renderer UI and its shared page contracts; the stock omp bridge/extensions and SDK-facing stock workers; build/test/capture tooling. A stock worker may load installed omp session storage. Application decisions performed around that SDK read are not automatically exempt from native migration. Runtime-loaded probes and embedded worker scripts require explicit inventory before deleting Node.

## Proof ledger

- Static source inventory has no unresolved imports on the integrated SX tree. This establishes reachability only.
- The five original slices and continuation commits are integration inputs. Their prior unit/compiler results do not prove the combined native runtime or CEF/macOS/Windows behavior.
- Narrow common crate, shell compiler and TypeScript checks are run locally through the official pool. No full build, macOS runner dispatch or user app restart is part of this worktree's current proof.
- Final artifact must launch without the Node main child and exercise desktop, paired-computer and phone behavior. Only then remove `out/main/index.js`, bundled Node, shim production methods and their build/packaging paths together.
- Affected formal coverage includes turn-resume, session-listing, tab-session, session-processes, web-close-reports and repo-lock-core where its covered process/lock paths change. Current inherited stamps are not proof of this integration; Main coordinates runner verification and mutations before landing.
