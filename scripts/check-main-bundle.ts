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

console.log(
	"main bundle is self-contained: no un-bundled runtime imports, no optional-peer stubs, the bundled ws carries " +
		"masked frames; the renderer ships no axe-core and no .woff/.ttf fonts",
);
