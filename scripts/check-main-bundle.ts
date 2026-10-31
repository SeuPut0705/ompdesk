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
// The bot (31 Oct 2026): the session menu's Set as bot item, the row's bot mark and the sidebar prefs
// field that names it (`bot`): measured 3,219,374 on eb8409752 with it in the tree, 1,333 bytes over the measure
// above.
// A click then a modifier pressed alone shows no focus style (`lib/focus-modality.ts`, loaded after the first screen by
// one dynamic import in main.tsx; 31 Oct 2026): 1,548 bytes (its 1,346-byte chunk and the 202-byte import), measured
// 3,220,084 with the other changes of 31 Oct in the tree.
// A retry saga rides the tab status (`retrySaga`; 31 Oct 2026): the tabs store and session hydration, both on the first
// screen, put stock's open retry on a tab shown after it started, so its failed attempt shows no failure card: measured
// 3,220,084 with it and the other changes of 31 Oct in the tree.
// The bot is always in the sidebar (31 Oct 2026): the fixed bot row and its store (`stores/bot.ts`, the row's stand-in
// and click) replace the session menu's Set as bot item and the sidebar prefs field: measured 3,220,755 on a922320b3
// with it in the tree, 121 bytes over the measure above.
// The bot's family (31 Oct 2026): what the bot opened nests under its fixed row (`botKids` in `Sidebar.tsx`: one pass of
// the opener rule over the rows with the bot as a candidate, then the rows again without that family): measured
// 3,221,805 with it and the Bot rules screen's settings in the tree, 905 bytes over the measure above.
// The bot is off until the owner turns it on, and a paired host's bot is a fixed row in its section (31 Oct 2026): the
// store's enable pref and `SidebarDevices.tsx`'s bot row: measured 3,222,863, 1,058 bytes over the measure above.
// The bot's desk (31 Oct 2026): its home is loaded on demand (`preloadBotHome`, 18.8 kB kept off the first screen),
// while the pane's Home/Chat switch, the desk store, the row's decision count and their strings stay: measured
// 3,231,571, 7,571 bytes over the measure above.
const WEB_FIRST_SCREEN_JS_BYTES = 3_232_000;

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

console.log(
	"main bundle is self-contained: no un-bundled runtime imports, no optional-peer stubs, the bundled ws carries " +
		`masked frames; the renderer ships no axe-core and no .woff/.ttf fonts; the phone's first screen loads ` +
		`${(firstScreenBytes / 1e6).toFixed(2)} MB of JavaScript`,
);
