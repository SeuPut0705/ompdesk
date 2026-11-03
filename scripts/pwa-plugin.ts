/**
 * Renderer build step of the installed web app: emits `sw.js` (src/renderer/web/sw.ts bundled as one script)
 * with the shell's precache list and a build id baked in, and names the session list's files in `web.html`.
 *
 * The precache is the files `web.html` loads at once (its entry chunk, the chunks and styles it preloads) plus
 * what the entry imports dynamically one level down (the app itself, `../main`), then the session list's chunk
 * (`sessionList`, which a phone loads once the page idles and a docked list needs at the first frame), in that
 * order, cut by `PRECACHE_LIMITS` (bytes and count). Other lazy chunks (mermaid, CodeMirror, Settings…) stay on the
 * network. The build id hashes the list and the page, so a new build makes a new cache and the old one is deleted
 * when the new worker activates. This file is a `BUILD_SCRIPTS` input of scripts/build-cache.ts.
 */
import { createHash } from "node:crypto";
import { build, type Plugin, type Rollup } from "vite";
import { SESSION_LIST_META } from "../src/renderer/web/session-list-preload";
import { PRECACHE_LIMITS, type PrecacheEntry, selectPrecache } from "../src/renderer/web/sw-core";

type BundleEntry = Rollup.OutputAsset | Rollup.OutputChunk;

const ASSET_URL = /(?:src|href)="(?:\.\/|\/)?(assets\/[^"]+)"/g;
const SESSION_LIST_FILES = new RegExp(`<meta name="${SESSION_LIST_META}" content="([^"]*)"`);

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

/** What `web.html` loads before its first screen: its own loads and the entry's dynamic imports, one level down. */
function firstScreenFiles(bundle: Record<string, BundleEntry>, html: string): Set<string> {
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
	return loaded;
}

/**
 * `html` with a `<meta>` naming the files of the chunk that holds the module `sessionList` that the first screen does
 * not load already (src/renderer/web/session-list-preload.ts preloads them where the page waits for the list).
 */
export function withSessionListMeta(bundle: Record<string, BundleEntry>, html: string, sessionList: string): string {
	const id = sessionList.replaceAll("\\", "/");
	const chunk = Object.values(bundle).find(
		entry => entry.type === "chunk" && entry.moduleIds.some(moduleId => moduleId.replaceAll("\\", "/") === id),
	);
	if (!chunk) throw new Error(`No chunk holds ${sessionList}`);
	const firstScreen = firstScreenFiles(bundle, html);
	const closure = new Set<string>();
	staticClosure(bundle, chunk.fileName, closure);
	const files = [...closure].filter(fileName => !firstScreen.has(fileName)).map(fileName => `./${fileName}`);
	return html.replace("</head>", `  <meta name="${SESSION_LIST_META}" content="${files.join(" ")}" />\n  </head>`);
}

/** The shell's precache candidates in priority order, before the limits. Exported for the unit test. */
export function precacheCandidates(bundle: Record<string, BundleEntry>, html: string): PrecacheEntry[] {
	const loaded = firstScreenFiles(bundle, html);
	for (const url of SESSION_LIST_FILES.exec(html)?.[1]?.split(" ") ?? []) {
		if (url) loaded.add(url.replace(/^\.\//, ""));
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
	/** Absolute path of the session list's module (components/layout/sidebar/Sidebar.tsx), a chunk of its own. */
	sessionList?: string;
}

export function pwaPlugin(options: PwaPluginOptions): Plugin {
	const page = options.page ?? "web.html";
	return {
		name: "omp-pwa-service-worker",
		apply: "build",
		enforce: "post",
		async generateBundle(_output, bundle) {
			const html = bundle[page];
			if (html?.type !== "asset") return;
			const built = typeof html.source === "string" ? html.source : Buffer.from(html.source).toString("utf8");
			const source = options.sessionList ? withSessionListMeta(bundle, built, options.sessionList) : built;
			html.source = source;
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
