import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { normalizePath, type Plugin, type Rollup } from "vite";
import { precompressPlugin } from "./scripts/precompress-plugin";
import { pwaPlugin } from "./scripts/pwa-plugin";

/**
 * Main runs under Node, as a child of the Rust shell (docs: native-rust › Ledger › S): the `electron` it imports, and
 * the one electron-store and electron-updater `require`, is `src/main/shell-host/electron`, which speaks the host
 * protocol to the shell. It is bundled like any other module, so there is no `electron` left to resolve at runtime.
 */
const ELECTRON_SHIM = resolve(__dirname, "src/main/shell-host/electron/index.ts");

/**
 * electron-vite's main and preload presets list `electron` (and `electron/*`) as external; this drops them again so
 * the alias to the shim wins (Rollup asks `external` before any resolver runs).
 */
function bundleElectronShim(): Plugin {
	const isElectron = (entry: unknown): boolean =>
		entry === "electron" || (entry instanceof RegExp && entry.source.startsWith("^electron"));
	return {
		name: "ompdesk:bundle-electron-shim",
		enforce: "post",
		config(config) {
			const external = config.build?.rollupOptions?.external;
			if (!Array.isArray(external) || !config.build?.rollupOptions) return;
			config.build.rollupOptions.external = external.filter(entry => !isElectron(entry));
		},
	};
}

/**
 * Main-process packages bundled into out/main/index.js so packaged apps need no node_modules.
 * Anything the main entry imports that is NOT listed here stays a bare `import` in the
 * bundle, and the installed app only resolves it if the packaged app happened to carry
 * that package — in this nested checkout bun hoists most deps to the monorepo root, so a
 * traversal misses them and the app dies at launch with ERR_MODULE_NOT_FOUND.
 */
const MAIN_BUNDLED_DEPS = ["electron-store", "electron-updater", "jszip", "ws", "yaml", "zod"];

/**
 * Optional native addons of bundled packages, switched off at build time. Vite resolves an optional peer
 * dependency that is not installed (ws's `bufferutil` and `utf-8-validate`) to an empty object instead of a
 * `require` that throws, so ws's `try { require("bufferutil") } catch {}` took that object for the addon and the
 * first masked frame a paired phone sent crashed v0.34.0's main process (`bufferUtil.unmask is not a function`).
 * ws's own documented switches make those branches dead code, so no stand-in is bundled and ws runs its pure-JS
 * masking and Node's `buffer.isUtf8`: the code the unbundled tests run, since neither addon is installed.
 * scripts/check-main-bundle.ts refuses any such stand-in in out/main and runs a WebSocket round trip through
 * the bundled ws.
 */
const MAIN_DEFINES = {
	"process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
	"process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
};

/**
 * Heavy renderer vendor libs split out of the eager main chunk. Patterns match
 * node_modules path segments; the first matching rule names the chunk. A chunk
 * also takes its modules' static deps no rule names (`chunkByModule`, as Rollup
 * does by default), so a lazily imported family must name its own deps explicitly
 * (above any eager rule whose prefix would match them), or they ride along with
 * an eager chunk.
 */
const VENDOR_CHUNK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
	// React core: every chunk depends on it, so shared interop helpers land
	// here — keeping cross-chunk imports one-way (no circular chunks).
	[/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, "react"],
	// Raw-HTML step of the markdown pipeline (rehype-raw + parse5), imported
	// lazily by lib/markdown.tsx only for content that contains HTML.
	[
		/[\\/]node_modules[\\/](rehype-raw|hast-util-raw|hast-util-from-parse5|hast-util-to-parse5|parse5|entities)[\\/]/,
		"markdown-html",
	],
	// KaTeX + rehype-katex, imported lazily by lib/markdown.tsx only for content with math.
	[
		/[\\/]node_modules[\\/](katex|rehype-katex|hast-util-from-html-isomorphic|hast-util-from-dom|hast-util-from-html)[\\/]/,
		"katex",
	],
	// Office previews (lazy-imported by the Files drawer viewers): docx-preview for
	// Word, JSZip (its self-contained browser build) for every OOXML package.
	[/[\\/]node_modules[\\/]docx-preview[\\/]/, "docx-preview"],
	[/[\\/]node_modules[\\/]jszip[\\/]/, "jszip"],
	// Markdown pipeline (eager: transcripts render on the first screen):
	// react-markdown + the unified/remark/rehype/mdast/hast ecosystem.
	[
		/[\\/]node_modules[\\/](react-markdown|lowlight|remark-|rehype-|mdast-|hast-|hastscript|unist-|unified|micromark|vfile|devlop|trough|bail|extend|zwitch|ccount|comma-separated-tokens|space-separated-tokens|decode-named-character-reference|character-entities|property-information|html-url-attributes|trim-lines|markdown-table|longest-streak|is-plain-obj|estree-util-|estree-walker|stringify-entities|web-namespaces)/,
		"markdown",
	],
	// Mermaid + its rendering stack (lazy-imported by chat/MermaidBlock).
	[
		/[\\/]node_modules[\\/](mermaid|@mermaid-js|d3[^\\/]*|dagre[^\\/]*|@dagrejs|elkjs|dompurify|khroma|cytoscape|stylis|ts-dedent|marked|lodash-es|dayjs|uuid|robust-predicates|topojson-client)[\\/]/,
		"mermaid",
	],
	// chart.js + react-chartjs-2.
	[/[\\/]node_modules[\\/](chart\.js|react-chartjs-2|@kurkle)[\\/]/, "charts"],
	// xterm terminal.
	[/[\\/]node_modules[\\/]@xterm[\\/]/, "xterm"],
	// CodeMirror editor.
	[/[\\/]node_modules[\\/](@codemirror|@lezer)[\\/]/, "codemirror"],
	// highlight.js core + common grammars, shared by rehype-highlight (static,
	// via lowlight in the markdown chunk) and CodeBlock (dynamic import of
	// highlight.js/lib/common). Kept lowlight-free so chunk imports stay one-way.
	[/[\\/]node_modules[\\/]highlight\.js[\\/]/, "highlight"],
];

/**
 * Rollup helpers every chunk may need (Vite's dynamic-import preload helper,
 * the CommonJS interop helpers). Left unassigned, Rollup co-locates them with
 * an arbitrary vendor chunk — once that was mermaid, so the entry statically
 * imported (and modulepreloaded) all 6 MB of it just to get `__vitePreload`.
 * Pinned to the always-eager react chunk instead.
 */
const RUNTIME_HELPER = /^\0(vite\/preload-helper|commonjsHelpers)/;

/** The session list's module (components/layout/sidebar-chunk.ts loads it as a chunk of its own). */
const SESSION_LIST_MODULE = resolve(__dirname, "src/renderer/components/layout/sidebar/Sidebar.tsx");
/** What every first screen evaluates: the app, and the paired web page's boot in front of it. */
const FIRST_SCREEN_MODULES = [
	resolve(__dirname, "src/renderer/main.tsx"),
	resolve(__dirname, "src/renderer/web/web-boot.ts"),
];

type ModuleNode = Rollup.ProgramNode["body"][number];
type ModuleName = { type: "Identifier"; name: string } | { type: "Literal"; value: unknown };

const nameOf = (node: ModuleName): string => (node.type === "Identifier" ? node.name : String(node.value));

/** The module ids of `info`'s import and re-export sources, by source: Rollup lists `importedIds` in that order. */
function idsBySource(info: Rollup.ModuleInfo): Map<string, string> | null {
	const sources: string[] = [];
	for (const node of info.ast?.body ?? []) {
		const source = "source" in node && node.source ? String(node.source.value) : null;
		if (source !== null && !sources.includes(source)) sources.push(source);
	}
	if (!info.ast || sources.length !== info.importedIds.length) return null;
	return new Map(sources.map((source, index) => [source, info.importedIds[index] as string]));
}

/** A module with no code of its own: imports and re-exports only (lucide-react's, components/common/index.ts). */
const reexportsOnly = (body: readonly ModuleNode[]): boolean =>
	body.every(
		node =>
			node.type === "ImportDeclaration" ||
			node.type === "ExportAllDeclaration" ||
			(node.type === "ExportNamedDeclaration" && !node.declaration),
	);

/**
 * The modules that define the `names` module `id` exports: through re-export-only modules to the ones with code, or
 * `id` itself (also when a name comes from `export *`, which this does not follow).
 */
function definersOf(id: string, names: readonly string[], getModuleInfo: Rollup.GetModuleInfo): string[] {
	const info = getModuleInfo(id);
	const ids = info && idsBySource(info);
	if (!info?.ast || !ids || !reexportsOnly(info.ast.body)) return [id];
	const missing = new Set(names);
	const definers: string[] = [];
	for (const node of info.ast.body) {
		if (node.type !== "ExportNamedDeclaration" || !node.source) continue;
		const target = ids.get(String(node.source.value));
		const inner = node.specifiers.flatMap(specifier =>
			missing.delete(nameOf(specifier.exported)) ? [nameOf(specifier.local)] : [],
		);
		if (target && inner.length > 0) definers.push(...definersOf(target, inner, getModuleInfo));
	}
	return missing.size > 0 ? [id] : definers;
}

/**
 * `id`'s static imports as Rollup includes them. `importedIds` names every module a re-export-only module re-exports
 * (lucide-react's barrel names all its icons), so a named import from one counts the modules that define the names.
 */
function includedImports(id: string, getModuleInfo: Rollup.GetModuleInfo): readonly string[] {
	const info = getModuleInfo(id);
	const ids = info && idsBySource(info);
	if (!info?.ast || !ids) return info?.importedIds ?? [];
	const imports = new Set<string>();
	for (const node of info.ast.body) {
		if (!("source" in node) || !node.source) continue;
		const target = ids.get(String(node.source.value));
		if (!target) continue;
		const named =
			node.type === "ImportDeclaration" &&
			node.specifiers.length > 0 &&
			node.specifiers.every(specifier => specifier.type === "ImportSpecifier");
		const definers = named
			? definersOf(
					target,
					node.specifiers.map(specifier =>
						specifier.type === "ImportSpecifier" ? nameOf(specifier.imported) : "",
					),
					getModuleInfo,
				)
			: [target];
		for (const definer of definers) imports.add(definer);
	}
	return [...imports];
}

/** The chunk a module's own rule names: Rollup's helpers, the session list, a vendor package. */
function namedChunk(id: string, sessionList: Set<string>): string | undefined {
	if (RUNTIME_HELPER.test(id)) return "react";
	if (sessionList.has(id)) return "session-list";
	// A vendor stylesheet stays with the module that imports it. Assigned to its
	// package's chunk, TerminalPanel's static `@xterm/xterm/css/xterm.css` import
	// made the entry import the whole lazy xterm chunk (416 KB) on every launch.
	if (!id.includes("node_modules") || id.endsWith(".css")) return undefined;
	for (const [pattern, chunk] of VENDOR_CHUNK_RULES) {
		if (pattern.test(id)) return chunk;
	}
	return undefined;
}

/**
 * Every module's manual chunk, computed once per build output (Rollup hands each call of one output the same
 * `getModuleInfo`). The session list's modules are its static closure less the first screen's: one chunk, so a page
 * that waits for the list fetches one file, not the 16 Rollup split it into by who else imports them (3 Nov 2026).
 * The output sets `onlyExplicitManualChunks`, so the pull Rollup does by default (a named module's static imports no
 * rule names join its chunk) is done here for the other chunks; the session list's closure needs none.
 */
const chunkByModuleByBuild = new WeakMap<Rollup.GetModuleInfo, Map<string, string>>();
function chunkByModule({ getModuleIds, getModuleInfo }: Rollup.ManualChunkMeta): Map<string, string> {
	const known = chunkByModuleByBuild.get(getModuleInfo);
	if (known) return known;
	const closure = (roots: string[]): Set<string> => {
		const seen = new Set<string>();
		const pending = [...roots];
		for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
			if (seen.has(id)) continue;
			seen.add(id);
			pending.push(...includedImports(id, getModuleInfo));
		}
		return seen;
	};
	const firstScreen = closure(FIRST_SCREEN_MODULES.map(normalizePath));
	const sessionList = new Set([...closure([normalizePath(SESSION_LIST_MODULE)])].filter(id => !firstScreen.has(id)));
	const chunks = new Map<string, string>();
	for (const id of getModuleIds()) {
		const name = namedChunk(id, sessionList);
		if (name) chunks.set(id, name);
	}
	for (const [id, name] of [...chunks]) {
		if (name === "session-list") continue;
		const pending = [...(getModuleInfo(id)?.importedIds ?? [])];
		for (let dependency = pending.pop(); dependency !== undefined; dependency = pending.pop()) {
			if (chunks.has(dependency)) continue;
			chunks.set(dependency, name);
			pending.push(...(getModuleInfo(dependency)?.importedIds ?? []));
		}
	}
	chunkByModuleByBuild.set(getModuleInfo, chunks);
	return chunks;
}

function manualChunks(id: string, meta: Rollup.ManualChunkMeta): string | undefined {
	return chunkByModule(meta).get(id);
}

/**
 * electron-vite ships every target unminified. Whitespace and syntax minification
 * (identifiers kept, so stacks in the runtime log and the feedback form still read
 * as source names) cut out/ from 23 to 17 MB; startup changed by ~10 ms, since V8
 * parses lazily — this is about package size.
 */
const KEEP_NAMES = { minifyIdentifiers: false };

/**
 * The renderer is what a paired phone downloads and parses before its first frame, so it also shortens local
 * identifiers. `keepNames` gives every function and class its source `name` back, which V8 prints in stacks
 * (`at sendPrompt`) and React in component stacks; only local variables and parameters read short.
 */
const RENDERER_NAMES = { keepNames: true };

/** Font packages whose @font-face rules list .woff/.ttf fallbacks after their .woff2. */
const WOFF2_ONLY_FONT_PACKAGES = ["katex", "@fontsource/jetbrains-mono"];

/** A non-first `src` entry in the old formats: `, url(…) format("woff"|"truetype")`. */
const LEGACY_FONT_SRC = /,\s*url\(\s*(["']?)([^"')]+)\1\s*\)\s*format\(\s*["'](?:woff|truetype)["']\s*\)/g;

/**
 * Electron's Chromium always takes the .woff2 entry of an @font-face `src` list, so the .woff and .ttf
 * fallbacks KaTeX and JetBrains Mono list after it were dead weight in out/ (55 files, ~1 MB). This drops
 * those entries from the CSS before Vite resolves its `url()`s, so the files are never emitted. It runs
 * after Tailwind's compile (also `pre`), which inlines global.css's @fontsource imports with rebased URLs.
 * scripts/check-main-bundle.ts fails the build if a .woff or .ttf reaches out/renderer.
 */
function woff2OnlyFonts(): Plugin {
	const sep = String.raw`[\\/]`;
	const packageDirs = WOFF2_ONLY_FONT_PACKAGES.map(
		name => new RegExp(`${sep}node_modules${sep}${name.replace("/", sep)}${sep}`),
	);
	return {
		name: "ompdesk:woff2-only-fonts",
		enforce: "pre",
		transform(code, id) {
			if (!/\.css(\?|$)/.test(id) || !code.includes("@font-face")) return null;
			const base = dirname(id.replace(/\?.*$/, ""));
			const stripped = code.replace(LEGACY_FONT_SRC, (entry, _quote: string, url: string) =>
				packageDirs.some(dir => dir.test(resolve(base, url))) ? "" : entry,
			);
			return stripped === code ? null : { code: stripped, map: null };
		},
	};
}

export default defineConfig({
	main: {
		esbuild: KEEP_NAMES,
		define: MAIN_DEFINES,
		resolve: { alias: { electron: ELECTRON_SHIM } },
		plugins: [externalizeDepsPlugin({ exclude: MAIN_BUNDLED_DEPS }), bundleElectronShim()],
		build: {
			minify: "esbuild",
			rollupOptions: {
				// hang-watchdog-worker is the main-thread hang watchdog's worker thread (src/main/hang-watchdog.ts).
				input: {
					index: resolve(__dirname, "src/main/index.ts"),
					"hang-watchdog-worker": resolve(__dirname, "src/main/hang-watchdog-worker.ts"),
				},
			},
		},
	},
	// `window.omp` for the shell's pages: one classic script the shell injects before any page script
	// (src/preload/shell.ts), named `shell.js`. electron-vite accepts only `cjs` and `es` for a preload; a `cjs`
	// bundle with no imports and no exports is a plain script, and the banner and footer make it an IIFE so its
	// top-level names never join the page's global scope (scripts/check-main-bundle.ts checks all of it).
	preload: {
		esbuild: KEEP_NAMES,
		build: {
			minify: "esbuild",
			rollupOptions: {
				input: { shell: resolve(__dirname, "src/preload/shell.ts") },
				output: { format: "cjs", entryFileNames: "[name].js", banner: "(() => {", footer: "})();" },
			},
		},
	},
	renderer: {
		esbuild: RENDERER_NAMES,
		// Builds `sw.js`, the web page's service worker, with the shell precache list (scripts/pwa-plugin.ts), and names
		// the session list's chunk in web.html for a docked list's first frame (src/renderer/web/session-list-preload.ts).
		// woff2OnlyFonts after tailwindcss: both are `pre`, and it must see global.css with its imports inlined.
		// precompressPlugin writes the brotli the web server sends a phone (scripts/precompress-plugin.ts).
		plugins: [
			tailwindcss(),
			woff2OnlyFonts(),
			pwaPlugin({ entry: resolve(__dirname, "src/renderer/web/sw.ts"), sessionList: SESSION_LIST_MODULE }),
			precompressPlugin(),
		],
		resolve: {
			alias: {
				"@renderer": resolve(__dirname, "src/renderer"),
				"@shared": resolve(__dirname, "src/shared"),
			},
		},
		build: {
			minify: "esbuild",
			rollupOptions: {
				// `web` is the page a paired phone loads (src/renderer/web/); it shares every chunk with `index`.
				input: {
					index: resolve(__dirname, "src/renderer/index.html"),
					web: resolve(__dirname, "src/renderer/web.html"),
				},
				// A circular chunk means a module between two of a manual chunk's was left out of it (the session list's
				// closure above), and a chunk can then run before what it imports is defined.
				onwarn(warning, warn) {
					if (warning.code === "CIRCULAR_CHUNK") throw new Error(warning.message);
					warn(warning);
				},
				output: {
					manualChunks,
					// Only the modules manualChunks names go into its chunks; Rollup's default also pulls each named
					// module's unassigned static imports in, which would pull the app modules the session list shares
					// with the first screen into its chunk (and that chunk into the first screen).
					onlyExplicitManualChunks: true,
					// Rollup's default (1) merges code-free re-export chunks into an
					// importer when that looks side-effect-free — which folded the
					// lib/markdown-katex lazy boundary into the entry and made KaTeX
					// eager again. Lazy boundaries must stay separate chunks.
					experimentalMinChunkSize: 0,
				},
				// remark-math's unused HTML compiler (micromark-extension-math/lib/html)
				// imports katex, and katex declares no `sideEffects`, so Rollup kept
				// that bare import and loaded KaTeX with the eager markdown chunk.
				// KaTeX has no import-time effects we rely on; it is included only
				// where its exports are used (rehype-katex, loaded lazily).
				treeshake: { moduleSideEffects: id => !/[\\/]node_modules[\\/]katex[\\/]/.test(id) },
			},
		},
	},
});
