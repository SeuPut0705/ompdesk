import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import { pwaPlugin } from "./scripts/pwa-plugin";

/**
 * Main-process packages bundled into out/main/index.js so packaged apps need no node_modules.
 * Anything the main entry imports that is NOT listed here stays a bare `import` in the
 * bundle, and the installed app only resolves it if electron-builder happened to collect
 * that package — in this nested checkout bun hoists most deps to the monorepo root, so the
 * traversal misses them and the app dies at launch with ERR_MODULE_NOT_FOUND.
 */
const MAIN_BUNDLED_DEPS = ["electron-store", "electron-updater", "web-push", "ws", "yaml", "zod"];

/**
 * Heavy renderer vendor libs split out of the eager main chunk. Patterns match
 * node_modules path segments; the first matching rule names the chunk. Rollup
 * also pulls a chunk's unassigned static deps into it, so a lazily imported
 * family must name its own deps explicitly (above any eager rule whose prefix
 * would match them), or they ride along with an eager chunk.
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
	// dnd-kit drag and drop.
	[/[\\/]node_modules[\\/]@dnd-kit[\\/]/, "dnd-kit"],
];

/**
 * Rollup helpers every chunk may need (Vite's dynamic-import preload helper,
 * the CommonJS interop helpers). Left unassigned, Rollup co-locates them with
 * an arbitrary vendor chunk — once that was mermaid, so the entry statically
 * imported (and modulepreloaded) all 6 MB of it just to get `__vitePreload`.
 * Pinned to the always-eager react chunk instead.
 */
const RUNTIME_HELPER = /^\0(vite\/preload-helper|commonjsHelpers)/;

function manualChunks(id: string): string | undefined {
	if (RUNTIME_HELPER.test(id)) return "react";
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
 * electron-vite ships every target unminified. Whitespace and syntax minification
 * (identifiers kept, so stacks in the runtime log and the feedback form still read
 * as source names) cut out/ from 23 to 17 MB; startup changed by ~10 ms, since V8
 * parses lazily — this is about package size.
 */
const KEEP_NAMES = { minifyIdentifiers: false };

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
		plugins: [externalizeDepsPlugin({ exclude: MAIN_BUNDLED_DEPS })],
		build: {
			minify: "esbuild",
			rollupOptions: {
				input: { index: resolve(__dirname, "src/main/index.ts") },
				// original-fs: Electron's asar-unaware fs (updater.ts); a runtime builtin, never a package.
				external: ["electron", "original-fs"],
			},
		},
	},
	preload: {
		esbuild: KEEP_NAMES,
		plugins: [externalizeDepsPlugin()],
		build: {
			minify: "esbuild",
			rollupOptions: {
				input: { index: resolve(__dirname, "src/preload/index.ts") },
				external: ["electron"],
				output: { format: "cjs" },
			},
		},
	},
	renderer: {
		esbuild: KEEP_NAMES,
		// Builds `sw.js`, the web page's service worker, with the shell precache list (scripts/pwa-plugin.ts).
		// woff2OnlyFonts after tailwindcss: both are `pre`, and it must see global.css with its imports inlined.
		plugins: [tailwindcss(), woff2OnlyFonts(), pwaPlugin({ entry: resolve(__dirname, "src/renderer/web/sw.ts") })],
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
				output: {
					manualChunks,
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
