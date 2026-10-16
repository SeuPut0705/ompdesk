/**
 * Renderer build step of the installed web app: emits `sw.js` (src/renderer/web/sw.ts bundled as one script)
 * with the shell's precache list and a build id baked in.
 *
 * The precache is the files `web.html` loads at once (its entry chunk, the chunks and styles it preloads) plus
 * what the entry imports dynamically one level down (the app itself, `../main`), in that order, cut by
 * `PRECACHE_LIMITS` (bytes and count). Lazy chunks (mermaid, CodeMirror, Settings…) stay on the network. The
 * build id hashes the list and the page, so a new build makes a new cache and the old one is deleted when
 * the new worker activates. This file is a `BUILD_SCRIPTS` input of scripts/build-cache.ts.
 */
import { createHash } from "node:crypto";
import { build, type Plugin, type Rollup } from "vite";
import { PRECACHE_LIMITS, type PrecacheEntry, selectPrecache } from "../src/renderer/web/sw-core";

type BundleEntry = Rollup.OutputAsset | Rollup.OutputChunk;

const ASSET_URL = /(?:src|href)="(?:\.\/|\/)?(assets\/[^"]+)"/g;

const sizeOf = (entry: BundleEntry): number => Buffer.byteLength(entry.type === "chunk" ? entry.code : entry.source);

/** Chunk files `chunk` needs at load: itself, its static imports (recursively) and the styles of each. */
function staticClosure(bundle: Record<string, BundleEntry>, fileName: string, into: Set<string>): void {
	if (into.has(fileName)) return;
	const entry = bundle[fileName];
	if (entry?.type !== "chunk") return;
	into.add(fileName);
	for (const css of entry.viteMetadata?.importedCss ?? []) into.add(css);
	for (const imported of entry.imports) staticClosure(bundle, imported, into);
}

/** The shell's precache candidates in priority order, before the limits. Exported for the unit test. */
export function precacheCandidates(bundle: Record<string, BundleEntry>, html: string): PrecacheEntry[] {
	const loaded = new Set<string>();
	for (const match of html.matchAll(ASSET_URL)) {
		const fileName = match[1];
		if (!fileName) continue;
		if (bundle[fileName]?.type === "chunk") staticClosure(bundle, fileName, loaded);
		else loaded.add(fileName);
	}
	const eager = [...loaded];
	// One level of dynamic imports from the entry: web-boot loads the app with `import("../main")`.
	for (const fileName of eager) {
		const entry = bundle[fileName];
		if (entry?.type !== "chunk" || !entry.isEntry) continue;
		for (const dynamic of entry.dynamicImports) staticClosure(bundle, dynamic, loaded);
	}
	return [...loaded].flatMap(fileName => {
		const entry = bundle[fileName];
		return entry ? [{ url: `/${fileName}`, size: sizeOf(entry) }] : [];
	});
}

export function buildIdOf(precache: readonly PrecacheEntry[], html: string): string {
	const hash = createHash("sha256").update(html);
	for (const entry of precache) hash.update(`\n${entry.url}:${entry.size}`);
	return hash.digest("hex").slice(0, 12);
}

export interface PwaPluginOptions {
	/** Absolute path of src/renderer/web/sw.ts. */
	entry: string;
	/** The HTML entry whose loads are precached. */
	page?: string;
}

export function pwaPlugin(options: PwaPluginOptions): Plugin {
	const page = options.page ?? "web.html";
	return {
		name: "omp-pwa-service-worker",
		apply: "build",
		async generateBundle(_output, bundle) {
			const html = bundle[page];
			if (html?.type !== "asset") return;
			const source = typeof html.source === "string" ? html.source : Buffer.from(html.source).toString("utf8");
			const precache = selectPrecache(precacheCandidates(bundle, source), PRECACHE_LIMITS);
			const result = await build({
				configFile: false,
				logLevel: "silent",
				publicDir: false,
				define: {
					__SW_BUILD__: JSON.stringify(buildIdOf(precache, source)),
					__SW_PRECACHE__: JSON.stringify(precache),
				},
				build: {
					write: false,
					minify: "esbuild",
					target: "es2020",
					lib: { entry: options.entry, formats: ["iife"], name: "ompServiceWorker", fileName: () => "sw.js" },
				},
			});
			const outputs = (Array.isArray(result) ? result : [result]).flatMap(item =>
				"output" in item ? item.output : [],
			);
			const worker = outputs.find(item => item.type === "chunk");
			if (worker?.type !== "chunk") throw new Error("The service worker build produced no script");
			this.emitFile({ type: "asset", fileName: "sw.js", source: worker.code });
		},
	};
}
