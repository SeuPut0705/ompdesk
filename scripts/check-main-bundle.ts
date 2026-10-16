/**
 * Guards for the packaged app's launch, run after `electron-vite build`:
 * - every bare specifier the main bundle still imports at runtime has to exist
 *   inside the .app. In this nested checkout bun hoists most packages to the
 *   monorepo root, so electron-builder's node_modules traversal misses them and
 *   the installed app dies with ERR_MODULE_NOT_FOUND before the window appears.
 *   The bundle is minified, so its imports are read by a parser, not a line regex.
 * - axe-core (the e2e accessibility audit's engine, a devDependency) never ships
 *   in the renderer.
 * - the renderer ships no .woff or .ttf font: Electron's Chromium always takes the
 *   .woff2, and the renderer's `woff2OnlyFonts` plugin drops the older fallbacks.
 */

import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

// `URL.pathname` keeps a leading slash on Windows (`/E:/…`), which no API opens.
const BUNDLE = fileURLToPath(new URL("../out/main/index.js", import.meta.url));
const RENDERER = fileURLToPath(new URL("../out/renderer/", import.meta.url));
const RENDERER_ASSETS = fileURLToPath(new URL("../out/renderer/assets/", import.meta.url));
/** A property name only axe-core's source carries; it survives minification. */
const AXE_MARKER = "_thisWillBeDeletedDoNotUse";

// `original-fs` is not in `builtinModules` but Electron always resolves it: it is
// the asar-bypassing alias of `fs`, which is exactly what reads app files.
const allowed = new Set<string>([
	"electron",
	"original-fs",
	"node:original-fs",
	...builtinModules,
	...builtinModules.map(m => `node:${m}`),
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
	"main bundle is self-contained: no un-bundled runtime imports; the renderer ships no axe-core and no .woff/.ttf fonts",
);
