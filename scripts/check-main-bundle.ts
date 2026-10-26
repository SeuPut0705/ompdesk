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
const WEB_FIRST_SCREEN_JS_BYTES = 3_335_000;

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
