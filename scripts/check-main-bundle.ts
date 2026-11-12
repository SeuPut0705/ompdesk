/**
 * Guards for the packaged app's launch, run after `electron-vite build`:
 * - every bare specifier the main bundle still imports at runtime has to exist
 *   inside the .app. In this nested checkout bun hoists most packages to the
 *   monorepo root, so electron-builder's node_modules traversal misses them and
 *   the installed app dies with ERR_MODULE_NOT_FOUND before the window appears.
 *   The bundle is minified, so its imports are read by a parser, not a line regex.
 * - no bundled package reaches an optional peer dependency that is not installed.
 *   Vite resolves such a `require` (ws's `bufferutil`, `utf-8-validate`) to an empty
 *   object instead of a require that throws, so the package's `try { require(…) }`
 *   fallback never runs and it calls methods the object lacks: v0.34.0 crashed main
 *   on a paired phone's first WebSocket frame (`bufferUtil.unmask is not a function`).
 *   Every such stub is refused, and the bundled `ws` must carry a real round trip of
 *   masked frames: `scripts/ws-bundle-probe.ts` is bundled with the main process's
 *   own Vite config and run in Node.
 * - axe-core (the e2e accessibility audit's engine, a devDependency) never ships
 *   in the renderer.
 * - the renderer ships no .woff or .ttf font: Electron's Chromium always takes the
 *   .woff2, and the renderer's `woff2OnlyFonts` plugin drops the older fallbacks.
 * - the JavaScript a paired phone loads before its first screen (`web.html`'s entry,
 *   the app it imports, `../main`, and their static imports) stays within
 *   WEB_FIRST_SCREEN_JS_BYTES; the side panel's views (PanelViews.tsx) are never in
 *   it. e2e/web-perf.e2e.ts measures what that costs a phone.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_LIST_META } from "../src/renderer/web/session-list-preload";

// `URL.pathname` keeps a leading slash on Windows (`/E:/…`), which no API opens.
const BUNDLE = fileURLToPath(new URL("../out/main/index.js", import.meta.url));
const RENDERER = fileURLToPath(new URL("../out/renderer/", import.meta.url));
const RENDERER_ASSETS = fileURLToPath(new URL("../out/renderer/assets/", import.meta.url));
const WS_PROBE_CONFIG = fileURLToPath(new URL("./ws-bundle-probe.config.ts", import.meta.url));
/** Vite's stand-in for a missing optional peer dependency: `__viteOptionalPeerDep_<dep>_<importer>`. */
const OPTIONAL_PEER_STUB = /__viteOptionalPeerDep_\w+/g;
/** A property name only axe-core's source carries; it survives minification. */
const AXE_MARKER = "_thisWillBeDeletedDoNotUse";
/**
 * The phone's first-screen JavaScript, raw bytes (18 Oct 2026: 4.17 MB, 3.79 MB once the side panel's views went
 * lazy, 3.10 MB once each UI language became its own lazy chunk, 3.255 MB with the remembered sidebar state: the
 * fold stores and their saved-state parsing, 5 KB; 19 Oct 2026: 3.271 MB with the sidebar rows of the sessions
 * paired devices run on the host, 2.7 KB; 3.278 MB (3,278,281) with the family rows of the sessions this computer's
 * agents opened on a paired device, 3.4 KB; 20 Oct 2026: 3.281 MB (3,281,057) with a phone's work strip counting the
 * sessions a viewed session's agent opened, a notification click that waits for its tab and the touch session
 * sheet's order, 2.3 KB; 3.285 MB (3,284,838) with the transcript's waiting lines for the reports a bridge holds until
 * the running turn ends, 3.8 KB; 3.289 MB (3,289,072) with stock's "Ask and remember" approval: its remembering
 * answers on the approval card (`approvalChoices`) and the mode in the composer's approval row; 3.292 MB (3,292,441)
 * with the work board's strip wherever the board cannot dock (`workBoardForm`, `workBoardWidth`), its capped
 * sections (`CappedRows`) and the `checkout_peers` frame in the session store (the session rows themselves are a
 * lazy chunk), 3.4 KB; 3.294 MB (3,293,964) with the composer's one Send/Stop button (its state rule and the
 * long-press Stop menu that keeps the draft) and the model chip's short name and plain Auto, 1.5 KB; 3.295 MB
 * (3,295,059, the merged main) with the drawer's edge strip handing a tap to the control under it (`tapThrough` in
 * SidebarDrawer.tsx: the strip is on the first screen, so its tap must be), 0.8 KB; 3.297 MB (3,297,321 on the
 * merged main, 3,295,148 before) with the transcript holding a scrolled-up reader's row while a commit's changed rows
 * are measured (`contentAnchor`, ChatStream.tsx), 2.2 KB; 3.299 MB (3,298,084, 3,297,610 on main before) with a
 * paired host's sidebar rows and focused tab taking that host's own Chat/Code lane (`useHostWorkspace`, both lists
 * are on the first screen), 0.5 KB; 3.300 MB (3,299,739 on the merged main) with the composer asking the automatic
 * mode choice's question while the user types (`useAutoModePrefetch`, `prefetchAutoMode`; the web page skips it, but
 * the composer is the first screen), 0.7 KB; 3.301 MB (3,300,809, 3,299,739 before) with the disconnect notice's grace
 * (`useHostLinkLost` in stores/remote.ts and `connection-banner.ts`: the phone's bar is on the first screen and the
 * pane's banner is in the shared app chunk), 1.1 KB; 3.301 MB (3,301,397, 3,300,809 before) with a stored session's
 * gone folder: `openTab`'s folder-missing toast and its Restore re-open, and the session picker's gone mark that opens
 * such a row as a tab, 0.6 KB; 3.302 MB (3,302,253 on the merged main) with a pick of another folder's session opening
 * as its own tab instead of stock's refused in-place switch (`opensInOwnTab` in use-session-switch.ts, which the
 * sidebar and picker share), 0.9 KB; 3.311 MB (3,310,352 on the merged main of v0.49.0; 6.6 KB over the 3.303 MB
 * budget on its own base) with the sidebar's own project list: an empty or missing project's group, Remove from
 * sidebar on this device's and each host's section, the list's store and its parse (`stores/sidebar-projects.ts`,
 * `shared/sidebar-projects.ts`; the sidebar is the first screen)): a build that grows past it fails,
 * so the next eager import is a decision, not an accident. The language chunk the entries load before rendering is
 * not in it.
 */
// R3-4 intent rows add 7,595 bytes to the eager main chunk (trunk 9d1a7d055 3,303,582 → 3,311,177).
// R3-3's same-call verdict (the work card's settle and step list, the board's newest-turn check) adds 7,234 bytes over
// its base (main 7dfaf5a13 3,315,869 → 3,323,103).
// R3-1's one attention rule (lib/attention.ts, the per-tab failed-check store, the title bar's and the sidebar row's
// kinds) adds 1,656 bytes over its base (main 23cc62bd1 3,323,103 → 3,324,759).
// R3-6's strip summary (the per-open zone state and fold snapshot in WorkBoardChip, SummaryBoard and the summary line
// in board-parts.tsx, the sessions-opened chunk's preload) adds 3,155 bytes over its base (main 5c542e92b 3,324,759 →
// 3,327,914); the session rows' chunk stays off the first screen.
// The phone page's Files-edit report (web/FileEditReporter.tsx: which tab's editor holds unsaved edits, so the computer
// never closes it for an agent) adds 720 bytes over its base (main ad86fb309 3,327,914 → 3,328,634).
// The memory recall line's rows (`MemoryRecallNote` in CustomMessageCard.tsx: kind, title, date, excerpt, Open in Memory,
// Not helpful, and `parseRecallText` with its kind table in memory-recall-contracts.ts; the transcript is the first
// screen) add 6,002 bytes over its base (3,328,634 → 3,334,636).
// The recall line's per-item scope, its remembered Not helpful (`lib/recall-rated.ts`), and the page's own grants from
// the hello frame (`pageMayUse`, so a page without host-admin hides the action) add 3,601 bytes (3,334,636 → 3,338,237).
// 26 Oct 2026: every window hears what this computer works on now (`sessions.live`, `onLiveSessionsChanged`, the
// store's `live` list and the sidebar's read of it) so a row another window works on lights unopened: 620 bytes over
// the old budget (measured 3,339,620).
// omp's advisor notices read in the UI's language (`lib/notice-toast.ts`: its rule table and two shapes): 312 bytes
// more (measured 3,340,312).
// The agents' default browser (`sessions`/`prefs` API members, the relay-extension install action and the bridge
// feature label; the Settings row itself is lazy): 301 bytes more (measured 3,340,613).
// The transcript's scroll writer that tells the virtualizer the offset it wrote and remembers it (`transcriptScrollTo`,
// `readerMoved`, `compensateRowsAbove`), so a fling is never pulled back: 1,056 bytes more (measured 3,341,756).
// The work card names what the run leaned on (27 Oct 2026, the user's ask): the skills it read (`WorkOutcomes.skills`)
// and the files a live peer in the same worktree also changed (`open-peer.ts`, kept out of the board's lazy rows), with
// an `ls` of a missing path read as an answer: 2,965 bytes more (measured 3,344,721).
// A listing counts as a missing-path answer only when every `ls:` complaint it printed says so: 252 bytes more
// (measured 3,344,973).
// Round 2 of the card's facts (27 Oct 2026): skills from every source, the Protected chip and the held-back row, a
// check rerun inside a wider run resolving it (`coveredBy`), probes through read-only pipes and loopback curl; the
// failed-check attention it replaced is gone: 4,289 bytes more (measured 3,349,289).
// The card's verdicts on real journals (background jobs keyed by the call that opened them, mixed and setup-led checks,
// stops and restarts), revived subagents' resuming lane, a remote host's working rows under asleep tabs and session
// drag reordering in the sidebar (27 Oct 2026, one batch): 11,595 bytes more (measured 3,360,884).
// The dialogs only the person opens (OnDemandDialogs.tsx: the command palette, model and session pickers, rename,
// worktree, quick open, tab overview, branch picker, voice, copy, active tools, share, force tool, handoff) and the
// first-run setup's provider steps (FirstRunSlot.tsx) left the first screen (28 Oct 2026): 165,380 bytes less
// (measured 3,195,504 against 3,360,884 on the same main).
// Streaming restyle (28 Oct 2026): the shell, the session pane and the side panel's sheet carry marks the stylesheet
// reads instead of `:has()` (AppShell `data-panel`, WorkBoardChip `data-work-board-strip`, Sheet `data-sheet-kind`)
// and `checkKinds` answers a command once: 554 bytes more (measured 3,361,438 against 3,360,884 on the same main).
// The on-demand dialogs retry a failed load at the next touch or key and load at the first idle moment
// (lib/deferred-chunk.ts), and the first-run slot draws a still skeleton while its setup loads (28 Oct 2026): 1,382
// bytes more (measured 3,197,482).
// A paired host's section folds the closed sessions its agents opened that the host knows no opener of, as the host
// does (`foldsIntoProject`, its loose children), and its list keeps no row whose listing changed while its journal
// did not (`sameRow`; 28 Oct 2026): 1,446 bytes more (measured 3,198,928).
// Agent powers on by default and the new agent app actions (sidebar projects, pins, order, updates, privacy panes)
// in the shared app-action client (`lib/agent-app.ts`; 29 Oct 2026): 983 bytes more (measured 3,199,911).
// A tab's subagent transcripts held and read on by byte cursor, shared by the lanes', work cards' and Subagent view's
// reads, and no read while the window is hidden (`stores/subagent-transcripts.ts`, `whenVisible`; 29 Oct 2026: a
// paired device re-read whole journals, 11.5 MB in a minute): 1,513 bytes more (measured 3,201,424).
// The working cue says a request the model has not answered for 30 s as that wait (`lib/model-wait.ts`, the turn
// meter's `modelWaitSince` from the bridge's `model_request`; the work card's head, the board row and the strip; 29 Oct
// 2026, turns sat on "Thinking…" for minutes on a broken connection): measured 3,202,448 with the other changes of
// 29 Oct in the tree, 1,024 bytes over the measure above.
// A finished worktree's session listed only for a tab the person uses (`tabInUse`, `inUseByTab` in the host's sidebar
// and the device section; 29 Oct 2026: a device's restored asleep tabs listed two landed worktrees' sessions):
// measured 3,203,418 with the other changes of 29 Oct in the tree, 970 bytes over the measure above.
// A finished child with unmerged work is its own status, ready to merge, apart from a failed ending (`unmerged` in
// `sidebar-family.ts`, the `GitMerge` token and its words in the sidebar family row and the work board's child row; 29
// Oct 2026: it read as a failure): 1,155 bytes more (measured 3,204,573).
// The UI polish pass of 30 Oct 2026 (shorter wording in both languages, sidebar rows that keep their titles, toasts
// and What's new laid out in the flow, the palette's group icons, the phone composer's model chip): measured
// 3,206,471, 1,898 bytes over the measure above. The phone judge's follow-up (toasts under the work strip, a touch
// sheet's focus on its panel, the disabled primary button, the ask card's header once; others' edits to the same
// bundle in the tree: the composer, the palette): measured 3,207,596.
// One session menu for every device's rows (`session-menu.ts`; 30 Oct 2026): a paired host's rows now rename, pin,
// archive, move to a project and open in a split or window, with their own Archived section: measured 3,213,335,
// 5,739 bytes over the measure above.
// The working cues step at ten frames a second while the window is unfocused (`lib/cue-clock.ts`, loaded after the
// first screen by one dynamic import in main.tsx; 30 Oct 2026): measured 3,214,065 on c7f5901ab, 730 bytes more.
// The window pollers (30 Oct 2026): ToastStack measures on observers instead of a 250 ms timer, the jobs poll follows
// its tab's turn and subagents: measured 3,216,397 on d2f2af50f (this check's own count), 1,397 bytes over the budget.
// The session list read once per change and shared (30 Oct 2026): the global feed keeps main's numbered copy and
// applies what each change carries (`stores/session-list.ts`, `shared/session-list-delta.ts`, `sessions.listShared`)
// instead of reading the whole list after every change: measured 3,218,041, 1,278 bytes over its parent 51f0e312f
// (3,216,763).
// A click then a modifier pressed alone shows no focus style (`lib/focus-modality.ts`, loaded after the first screen by
// one dynamic import in main.tsx; 31 Oct 2026): 1,548 bytes (its 1,346-byte chunk and the 202-byte import), measured
// 3,220,084 with the other changes of 31 Oct in the tree.
// A retry saga rides the tab status (`retrySaga`; 31 Oct 2026): the tabs store and session hydration, both on the first
// screen, put stock's open retry on a tab shown after it started, so its failed attempt shows no failure card: measured
// 3,220,084 with it and the other changes of 31 Oct in the tree.
// The email trigger (1 Nov 2026): the `email` event in the schedule schema the desk store reads, its summary line and
// the Email accounts strings; the accounts block itself stays in the lazy Settings chunk: measured 3,252,153, 1,487
// bytes over the measure above.
// A failed pipeline named after its last stage (1 Nov 2026): `pipelineProgram`, the `pipefail` test and
// `firstStageProgram` in command-verdict-core.ts, which the work card reads: measured 3,257,009, 579 bytes over the
// tree before it (3,256,430).
// A host's browser sign-in coming back through this computer (1 Nov 2026): the `signInRelay` state in the extension-UI
// store every tab reads, its `SIGN_IN_RELAY` subscription and the API member; the panel stays in the lazy Settings
// chunk: measured 3,257,562, 553 bytes over the measure above.
// A typed session name shown with its automatic title (2 Nov 2026): the shared `SessionTitle` (name, muted automatic
// title truncated first), the parts helpers in `lib/session-title.ts` and the tabs store, and the tab-to-row lookup
// (`hooks/use-tab-list-rows.ts`) the title bar, panes and sidebar rows draw on the first screen: measured 3,261,772,
// 4,210 bytes over the measure above.
// Published palettes kept as published (2 Nov 2026): each well-known theme's own bright ANSI row, text selection and
// diff washes in theme-palettes.ts (the per-role source colors stay in the test-only theme-sources.ts): measured
// 3,262,745, 719 bytes over the same tree with the palettes before (3,262,026).
// A subagent the restart ended reads as interrupted, not failed (2 Nov 2026): `restartCuts`/`cutRunAgents` in
// `chat/work/work-run.ts`, the transcript hook (`use-restart-cuts.ts`) the async-result card and the work lanes read, and
// the new strings: measured 3,267,056, 4,311 bytes over the measure above.
// The same rule on every surface (2 Nov 2026): `lib/restart-cuts.ts` (moved out of the work card), the tab runtime's
// binding of the transcript to the subagents store, the `restart-cut` status and its strings: measured 3,269,220,
// 2,164 bytes over the measure above.
// A lost link shown in the title bar, not over it (2 Nov 2026): the bar's `offline` status (its WifiOff glyph and
// `web/link-status.ts`) on the session and page bars, and the transport's liveness question and attempt deadlines; the
// full-width `connection-banner.ts` is gone: measured 3,270,423, 1,203 bytes over the measure above.
// New agent work waits for memory (2 Nov 2026): the tab's `memoryWait` in the tabs store, tab signal, sidebar and
// device rows, the work board's child line and the chat pane's waiting row with Start now (`MemoryWaitRow`, its
// MemoryStick glyph) and `window.omp.memory`: measured 3,273,813, 3,390 bytes over the measure above.
// A family row says it waits for memory in words, with Start now (`FamilyRow` `memoryWait`, status `queued`):
// measured 3,275,138, 1,325 bytes over the measure above.
// What a person sends while the computer is out of reach waits (2 Nov 2026): the outbox store and its delivery
// (`stores/outbox.ts`, `lib/outbox-delivery.ts`), the composer's "Will send when connected" row (`ComposerOutbox`, its
// glyphs) and the strings. It stays in the first screen: a page reloaded offline must show and send what waits
// without fetching a chunk: measured 3,288,191, 13,053 bytes over the measure above.
// The restart-cut mark keyed to the run it cut (the subagents store's `run` count and `deliveredBy`) and the automatic
// install's waiting notice (the sidebar card's waiting row, `waitingWhat`, the phone sheet's line naming the work and the
// new strings) (2 Nov 2026): measured 3,278,050 on the tree before the outbox, 2,912 bytes over its own base.
// Composer dictation shows the download of its language's speech model (3 Nov 2026): the dictation bar's preparing
// line and its `ProgressBar`, the take's `onPreparing` and the strings; the prepare loop itself loads with the
// `stt-prepare` module on the take's first wait: measured 3,310,945, 1,597 bytes over the budget above. The take's
// `onPreparing(null)` once the model is here, so the bar says "Transcribing…" again (3 Nov 2026): measured 3,310,970.
// Local names shortened in the renderer (3 Nov 2026): its esbuild minify pass went from `minifyIdentifiers: false` to
// `keepNames: true` (electron.vite.config.ts), so locals and parameters read short while every function and class keeps
// its `name` for stacks and React's component stacks; main and preload keep their names. The phone parses ~29% less
// before its first frame (14 files, 3,310,970 → 2,349,974, 960,996 bytes less; brotli on the wire 674,087 → 615,573):
// measured 2,349,974.
// The session list is one chunk of its own (3 Nov 2026, components/layout/sidebar-chunk.ts, the `session-list` manual
// chunk in electron.vite.config.ts): a phone keeps it in a closed drawer. This budget counts the static closure, which is
// what a later visit (a page the service worker controls) loads before its first frame; the list loads after it, from
// the worker's cache. A first visit (no worker yet) and a page that docks the list also wait for the list's one file,
// checked below and printed with the total. Sidebar.tsx, its device sections, subagents and update card, the icons only
// it draws and dnd-kit leave the static closure, sidebar.css stays (14 files 2,349,974 → 13 files 2,155,282; brotli
// 615,171 → 567,205; the list's file 197,360, brotli 53,932): measured 2,155,282.
// Markdown keeps a single `~` as text (3 Nov 2026, remark-gfm `singleTilde: false` in lib/markdown.tsx), so two Korean
// ranges like `170~230초` on one line no longer strike everything between them: measured 2,155,315.
// The Windows caption band (4 Nov 2026, global.css `--sc-caption-band`, components.css `--sc-dialog-room`, and
// `chromePlatform` keeping a mark the page set): measured 2,155,355. The same day: the cue clock holding the loops
// under software compositing, a failed history page's pill and its retry on `ready`, its runtime-log line: 2,155,734.
// A tail read's runtime-log line with its response code (session-hydration.ts `transcript-tail`): 2,155,854.
// Local inference engine detection (4 Nov 2026): the `models-config:changed` event and its focused-tab catalog re-read
// (use-rpc-events.ts), the `localEngines` get/set of the API (a paired host has its own switch) and the Custom
// endpoints switch's two strings in the English catalog: measured 2,156,302, 448 bytes over the budget above.
// A reply's paragraph of pictures as one captioned figure row (5 Nov 2026, markdown.tsx `FigureRow`, `useImageReads`;
// replies are the first screen): measured 2,157,926, 1,624 bytes over the budget above.
// A paragraph holding a player or a document card renders as a block of its own (`rendersAsBlock`): 2,158,239.
// What a reply writes beside its tool calls stays a row of its own under its work card (6 Nov 2026,
// chat-stream-utils.ts `buildHistoryRows` narration, `liveWorkTail`; the transcript is the first screen): 2,158,572.
// agent-desktop as the default computer use (6 Nov 2026): its tool rows' header and summary (`agent-desktop-name.ts`),
// the fallback note (`ComputerUseNote.tsx`) and their strings in the English catalog; the renderer and its result
// parser are a chunk of their own (tools/index.tsx `LazyAgentDesktopRenderer`, 5,255 bytes kept out): 2,160,895.
// An agent-desktop row's own state (6 Nov 2026, ToolCard `isAgentDesktopNoMatch`, "Nothing matched": a look that matched
// nothing reads so on the row of the transcript, the first screen) and its target key naming `ref` as `ref_id`: 2,161,237.
// The macOS permissions computer use needs (6 Nov 2026): the matcher for stock's "… permission is not granted"
// (`lib/mac-permission-error.ts`, the eager `ComputerRenderer`/`EvalRenderer` ask it), their strings in the English
// catalog and the lazy fix's wrapper; the fix itself is a chunk of its own (`LazyMacPermissionFix`): 2,162,145.
// A row hears its session's subagents while no window shows it (6 Nov 2026, use-rpc-events.ts `openTabFrame`; a hidden
// running tab a tab list makes a runtime for reads its roster once, tabs.ts `reconcileTabs`): 2,162,311.
// The same read once per runtime whichever names a hidden running tab first, its status push or the tab list
// (`rosterRead`), and stock 18.17's two Devin sign-ins with the Devin mark (provider-marks.ts): 2,162,456.
// A work card is red only when the work ended in an error (6 Nov 2026): each card's failures judged in its turn
// (chat-stream-utils.ts `workTurns`, `useTurnScope`, work-findings.ts `turnScope`, work-checks.ts `TurnScope`), the
// "Errors along the way" note and its strings in the English catalog; the work card is the first screen: 2,166,852.
// A hidden tab's roster read again when its pushes may have been lost (7 Nov 2026, tabs.ts: a page's catch-up after it
// was hidden or lost its link, `reconcileTabs({resync})`; a hidden tab's omp up again, `useSessionTabs`): 2,167,109.
// A paired host's refusal of a tab another tab holds shows that tab or says where it is open, and every tab's banner
// reads its failure's reason from the tab list (7 Nov 2026, tabs.ts `applyTabList` `shown`, `applyTabFailure`, no
// switch-failure toast for a tab main let go; the visible-only route in use-rpc-events.ts went): 2,167,482.
// A tab main closed while the window still routed to it leaves quietly, with no switch-failure toast, when main's list
// no longer names it (8 Nov 2026, tabs.ts `focusTab`: a paired host's refusal answered before its tab list): 2,167,699.
// One summary per session, built in main, the only source of every row's live state (8 Nov 2026: hosted-sessions.ts
// holds each computer's summaries at a version and applies deltas, `summaryRowState`; the per-view re-reads deleted),
// and a project's one menu builder and Delete dialog (project-menu.ts, ProjectDeleteDialog.tsx), on top of v0.118.7's
// banner reason, whose failure rule is now shared with the summaries (`failureOf`), and a tab with no session file
// read from its own summary (`unsavedSessionKey`, `hostedSummaries`), on top of v0.118.8's quiet close: 2,168,705.
// Every other surface that says what a session does reads that summary by the row's rule (8 Nov 2026,
// lib/session-run.ts `sessionRun`, hooks/use-tab-run.ts: the title bar and the window title are the first screen;
// their own derivations from the runtime stores went): 2,169,204.
// A page behind the build its host serves moves to it at its next unused moment (8 Nov 2026, web-boot.ts
// `hello.build` against the page's `omp-build` meta; the `web-reload` line names both builds, noted at the reload),
// less the per-view summary reads (`ensureHostSummaries`) the one boot read replaced: 2,169,501.
// The move recorded only as the page reloads, one at a time (8 Nov 2026, sw-update.ts `HostBuildMove`): 2,169,691.
// A session whose folder is gone wears "Folder missing" on its row and opens read-only (8 Nov 2026,
// `SidebarRows.folderMissing`, `SidebarFolderMissingMark`, the `missingFolder` request and its lazy sheet's host),
// and a child opened in another folder is a row of its own project too (`openedElsewhere`): 2,170,453.
// Every model list beside a provider's mark reads its compact name, a suffix only where two would read alike (8 Nov
// 2026, provider-marks.ts `compactModelLabels`; the composer's model picker is on the first screen): 2,171,893.
// The model "Find more evidence" researches with is picked beside it and kept on the machine it runs on (8 Nov 2026,
// ModelSetupDialog.tsx; its strings in the English catalog and omp-api.ts `modelSetup.researchPick|setResearchPick`
// with their two channels reach the first screen): 2,172,134.
// The remaining long model names read the same compact label (8 Nov 2026, provider-marks.ts `compactModelText`,
// `modelRefOf`, `modelTextAmong`, `ModelLabel`; the usage row under a reply is on the first screen): 2,173,209.
// Every model list groups its models by provider (9 Nov 2026, provider-marks.ts `groupModelsByProvider`; the composer's
// model picker is on the first screen): 2,173,524.
// The sidebar prefs have one owner, main (9 Nov 2026, src/shared/sidebar-prefs.ts `sidebarPatch` and `readSidebarPrefs`
// the store applies at once, omp-api.ts `prefs.updateSidebar` and its channel, the store's re-read on PREFS_CHANGED;
// its whole-blob writer went), and a sidebar pick's runtime-log line: 2,174,377.
// A family child's review verdict by its computer and session file (9 Nov 2026, sidebar-family.ts `reviewKey`, read by
// the eager family rule): 2,174,446.
// The split the window shows, one rule for the workspace and the sidebar's selected rows (9 Nov 2026,
// hooks/use-shown-split.ts): 2,174,534.
// An omp slow to start reads as a wait on its tab's banner (9 Nov 2026, SidecarBanner's slow title, text and stderr
// tail, the session store's `sidecarSlow`, `applyTabFailure`'s slow branch; the banner is the first screen): 2,174,908.
// A start that waits its turn reads "Waiting to start" (9 Nov 2026, tab-signal.ts `queued`, the tab's projection of
// it, use-rpc-events keeping the page through a queued re-send, session-run.ts passing the summary's `queued`):
// 2,175,035.
// A session row holds its family chip's slot only while the chip draws (9 Nov 2026, sidebar-family.ts
// `familyChipCounts`/`hasFamilyChip`, read with the family hide state by both session lists): 2,175,243.
// The usage row under a reply stays one line, dropping its least useful segments as it narrows (9 Nov 2026,
// UsageRow.tsx `DROP`, every value named in its tooltip; the transcript is the first screen): 2,176,219.
// The answer to a steer reads right under it, above the card of its calls, streaming as finalized (10 Nov 2026,
// chat-stream-utils.ts `endsOnSteer`, ChatStream.tsx `ProcessGroup` `answerFirst`; the transcript is the first
// screen): 2,176,541.
// The design pass over every menu and the kit's new parts (10 Nov 2026): a dialog's first focus on its first field
// (`use-modal-layer.ts`), `StatusDot` and the segmented `ProgressBar`, the question card titled by its question, the
// plan sheet's review footer and numbering, the composer's Mode rows as tiles, the pickers' `EmptyState`s and the
// work tree rows' fixed columns, all on surfaces the first screen holds: 2,184,833, 8,292 bytes over the measure above.
// The first screen's private dots, frames, notices and labels moved onto the kit, whose `Tabs` carries a tab's marks
// and tooltip and whose `Banner`, `Sheet`, `ListRow` and menu items took the options their private copies had
// (10 Nov 2026): 2,185,228, 395 bytes more.
// The last private controls moved onto the kit and what sat only in a native `title` became reachable (11 Nov 2026):
// `Chip` (composer attachments, outbox and queue), the kit `ChoiceList` (prompt cards), `KeyHints` (the model picker),
// `Tabs` with closable tabs and a kit tooltip, menu items' tooltip and reason, `Button`/`IconButton` `disabledReason`,
// `ListRow` tooltip and small size, `Card as`, a todo's state as a shape (`TodoStatusIcon`), a repeated minute's
// clock shown on hover (`repeatedClockRows`), the run section's in-view rule (`runSectionShown`), a table cell's text
// length, a file card's `data-file-path`, the model picker's line for the highlighted model, a menu's reason reachable
// by the arrows and segments that shrink to fit their track, all on surfaces the first screen holds: 2,197,597,
// 12,369 bytes more (0.6 %).
// A reset pass dialog's choice between an account's kinds of pass (11 Nov 2026): its two strings in the English
// catalog, which the first screen loads; the dialog itself is Settings', off it: 2,197,603.
// A message between sessions carries its sender's saved id (12 Nov 2026, `shared/agent-control.ts`: the wrapper's
// pattern reads the `session` attribute and `parseAgentMessage` returns it; the transcript, which shows such a message
// as "sent by an agent", is the first screen): measured 2,197,692 on c47f87fc by ci.yml's build, 89 bytes over.
// Fallback models in Settings › Models & accounts (12 Nov 2026): their strings in the English catalog, which the first
// screen loads (the block itself is Settings', off it), less the Agent row they replace: measured 2,197,738 on the
// working tree beside other uncommitted Settings strings, 46 bytes over.
const WEB_FIRST_SCREEN_JS_BYTES = 2_197_738;

// Bun's `builtinModules` also lists its own modules and stand-ins (`bun:*`, `ws`, `undici`), which Electron's
// Node does not have: a bundle importing `ws` at runtime must fail here, not pass because Bun runs this check.
const nodeBuiltins = builtinModules.filter(m => !m.startsWith("bun") && m !== "ws" && m !== "undici");
// `original-fs` is not in `builtinModules` but Electron always resolves it: it is
// the asar-bypassing alias of `fs`, which is exactly what reads app files.
const allowed = new Set<string>([
	"electron",
	"original-fs",
	"node:original-fs",
	...nodeBuiltins,
	...nodeBuiltins.map(m => `node:${m}`),
]);

const external = new Set<string>();
const source = await fs.readFile(BUNDLE, "utf8");
for (const { path: specifier } of new Bun.Transpiler({ loader: "js" }).scanImports(source)) {
	if (allowed.has(specifier) || specifier.startsWith("./") || specifier.startsWith("../")) continue;
	external.add(specifier);
}

if (external.size > 0) {
	console.error(
		`out/main/index.js still imports ${[...external].join(", ")} at runtime. ` +
			"Add each to MAIN_BUNDLED_DEPS in electron.vite.config.ts so the packaged app needs no node_modules.",
	);
	process.exit(1);
}

// The bundled ws, built the way out/main is (electron-vite under Node, as scripts/build-cache.ts runs it),
// carries masked frames both ways.
const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-ws-probe-"));
let probeFailure: string | null = null;
try {
	const build = spawnSync(
		process.execPath,
		["x", "electron-vite", "build", "-c", WS_PROBE_CONFIG, "--outDir", probeDir, "--logLevel", "warn"],
		{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
	);
	if (build.status !== 0) {
		probeFailure = `Building the ws probe failed (exit ${build.status ?? build.signal}):\n${build.stdout}${build.stderr}`;
	} else {
		// The main bundle is ESM; outside the repo nothing else says so.
		await fs.writeFile(path.join(probeDir, "main", "package.json"), '{ "type": "module" }\n');
		const run = spawnSync("node", [path.join(probeDir, "main", "ws-probe.js")], {
			encoding: "utf8",
			timeout: 30_000,
		});
		if (run.status !== 0 || !run.stdout.includes("ws round trip ok")) {
			probeFailure =
				`The bundled ws failed a WebSocket round trip in Node (exit ${run.status ?? run.signal ?? run.error?.message}):\n` +
				`${run.stdout}${run.stderr}`;
		}
	}
} finally {
	await fs.rm(probeDir, { recursive: true, force: true });
}
if (probeFailure) {
	console.error(probeFailure);
	process.exit(1);
}

const stubs = new Set(source.match(OPTIONAL_PEER_STUB));
if (stubs.size > 0) {
	console.error(
		`out/main/index.js bundles Vite's empty stand-in for a missing optional peer dependency (${[...stubs].join(", ")}): ` +
			"the package's `try { require(…) } catch` fallback never runs and it calls methods the empty object lacks. " +
			"Turn that branch off in the main build (the `define`s in electron.vite.config.ts) or install the dependency.",
	);
	process.exit(1);
}

for (const name of await fs.readdir(RENDERER_ASSETS)) {
	if (!/\.m?js$/.test(name)) continue;
	if ((await fs.readFile(RENDERER_ASSETS + name, "utf8")).includes(AXE_MARKER)) {
		console.error(`out/renderer/assets/${name} bundles axe-core, which is for the e2e audit only.`);
		process.exit(1);
	}
}

const legacyFonts = (await fs.readdir(RENDERER, { recursive: true })).filter(name => /\.(woff|ttf)$/i.test(name));
if (legacyFonts.length > 0) {
	console.error(
		`out/renderer ships ${legacyFonts.length} .woff/.ttf fonts (${legacyFonts.slice(0, 3).join(", ")}…); ` +
			"Electron only loads .woff2. Add the package to WOFF2_ONLY_FONT_PACKAGES in electron.vite.config.ts.",
	);
	process.exit(1);
}

// The phone's first screen: web.html's entry chunk, the app chunk it imports (`main-*`), and their static imports.
const transpiler = new Bun.Transpiler({ loader: "js" });
const webHtml = await fs.readFile(path.join(RENDERER, "web.html"), "utf8");
const webEntry = /<script type="module"[^>]*src="\.\/assets\/([^"]+)"/.exec(webHtml)?.[1];
if (!webEntry) {
	console.error("out/renderer/web.html names no module entry under ./assets/.");
	process.exit(1);
}
const firstScreen = new Map<string, number>();
const addChunk = async (name: string, followDynamic: boolean): Promise<void> => {
	if (firstScreen.has(name)) return;
	const code = await fs.readFile(RENDERER_ASSETS + name, "utf8");
	firstScreen.set(name, Buffer.byteLength(code));
	for (const { path: specifier, kind } of transpiler.scanImports(code)) {
		const file = specifier.startsWith("./") ? specifier.slice(2) : null;
		if (!file?.endsWith(".js")) continue;
		if (kind === "import-statement") await addChunk(file, false);
		else if (followDynamic && kind === "dynamic-import" && file.startsWith("main-")) await addChunk(file, false);
	}
};
await addChunk(webEntry, true);
const firstScreenBytes = [...firstScreen.values()].reduce((total, size) => total + size, 0);
const panelChunk = [...firstScreen.keys()].find(name => name.startsWith("PanelViews-"));
if (panelChunk || firstScreenBytes > WEB_FIRST_SCREEN_JS_BYTES) {
	console.error(
		`The paired phone's first screen loads ${firstScreenBytes.toLocaleString("en-US")} bytes of JavaScript in ${firstScreen.size} files ` +
			`(budget ${WEB_FIRST_SCREEN_JS_BYTES.toLocaleString("en-US")})${panelChunk ? `, the side panel's views (${panelChunk}) among them` : ""}. ` +
			"Load what the first screen does not show lazily (React.lazy / import()), or raise the budget in scripts/check-main-bundle.ts with numbers from e2e/web-perf.e2e.ts.",
	);
	process.exit(1);
}

// The session list's files beside the first screen (web.html's meta, scripts/pwa-plugin.ts): one chunk, so a page that
// waits for it pays one round trip, not one per file (Rollup had split it into 16 by who else imports them).
const sessionListFiles =
	new RegExp(`<meta name="${SESSION_LIST_META}" content="([^"]*)"`)
		.exec(webHtml)?.[1]
		?.split(" ")
		.filter(file => file.endsWith(".js")) ?? [];
if (sessionListFiles.length !== 1) {
	console.error(
		`out/renderer/web.html names ${sessionListFiles.length} JavaScript files for the session list (${sessionListFiles.join(", ")}), ` +
			"not one: a module only it needs was left out of the `session-list` chunk (electron.vite.config.ts).",
	);
	process.exit(1);
}
const sessionListBytes = (await fs.stat(path.join(RENDERER, sessionListFiles[0] as string))).size;

console.log(
	"main bundle is self-contained: no un-bundled runtime imports, no optional-peer stubs, the bundled ws carries " +
		`masked frames; the renderer ships no axe-core and no .woff/.ttf fonts; the phone's first screen loads ` +
		`${(firstScreenBytes / 1e6).toFixed(2)} MB of JavaScript, a first visit ` +
		`${((firstScreenBytes + sessionListBytes) / 1e6).toFixed(2)} MB with the session list`,
);
