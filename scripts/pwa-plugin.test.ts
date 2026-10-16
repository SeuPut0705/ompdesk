import { readFileSync } from "node:fs";
import path from "node:path";
import type { Rollup } from "vite";
import { describe, expect, it } from "vitest";
import { selectPrecache } from "../src/renderer/web/sw-core";
import { PWA_ICON_FILES } from "./brand-svgs";
import { buildIdOf, precacheCandidates, pwaPlugin } from "./pwa-plugin";

const PUBLIC_DIR = path.join(import.meta.dirname, "..", "src", "renderer", "public");

function chunk(fileName: string, code: string, extra: Partial<Rollup.OutputChunk> = {}): Rollup.OutputChunk {
	return {
		type: "chunk",
		fileName,
		code,
		imports: [],
		dynamicImports: [],
		isEntry: false,
		viteMetadata: { importedCss: new Set(), importedAssets: new Set() },
		...extra,
	} as unknown as Rollup.OutputChunk;
}

const HTML = `<script type="module" crossorigin src="./assets/web-aaa.js"></script>
<link rel="modulepreload" crossorigin href="./assets/react-bbb.js">
<link rel="stylesheet" crossorigin href="./assets/index-ccc.css">
<script src="./pre-paint.js"></script>`;

function bundle(): Record<string, Rollup.OutputAsset | Rollup.OutputChunk> {
	return {
		"assets/web-aaa.js": chunk("assets/web-aaa.js", "web".repeat(10), {
			isEntry: true,
			imports: ["assets/react-bbb.js"],
			dynamicImports: ["assets/main-ddd.js"],
		}),
		"assets/react-bbb.js": chunk("assets/react-bbb.js", "r".repeat(100)),
		"assets/main-ddd.js": chunk("assets/main-ddd.js", "m".repeat(1000), {
			imports: ["assets/markdown-eee.js"],
			dynamicImports: ["assets/mermaid-fff.js"],
			viteMetadata: { importedCss: new Set(["assets/main-ggg.css"]), importedAssets: new Set() },
		}),
		"assets/markdown-eee.js": chunk("assets/markdown-eee.js", "k".repeat(50)),
		"assets/mermaid-fff.js": chunk("assets/mermaid-fff.js", "x".repeat(5000)),
		"assets/index-ccc.css": {
			type: "asset",
			fileName: "assets/index-ccc.css",
			source: "c".repeat(20),
		} as Rollup.OutputAsset,
		"assets/main-ggg.css": {
			type: "asset",
			fileName: "assets/main-ggg.css",
			source: "g".repeat(30),
		} as Rollup.OutputAsset,
	};
}

describe("precache list", () => {
	it("is what the page loads plus the app's static closure, never lazy chunks or unhashed files", () => {
		const urls = precacheCandidates(bundle(), HTML).map(entry => entry.url);
		expect(urls).toEqual([
			"/assets/web-aaa.js",
			"/assets/react-bbb.js",
			"/assets/index-ccc.css",
			"/assets/main-ddd.js",
			"/assets/main-ggg.css",
			"/assets/markdown-eee.js",
		]);
		expect(urls).not.toContain("/assets/mermaid-fff.js");
		expect(urls.some(url => url.includes("pre-paint"))).toBe(false);
	});

	it("measures bytes and honors the byte and count caps", () => {
		const candidates = precacheCandidates(bundle(), HTML);
		expect(candidates.find(entry => entry.url === "/assets/main-ddd.js")?.size).toBe(1000);
		expect(selectPrecache(candidates, { maxBytes: 200, maxCount: 10 }).map(entry => entry.url)).toEqual([
			"/assets/web-aaa.js",
			"/assets/react-bbb.js",
			"/assets/index-ccc.css",
			"/assets/main-ggg.css",
		]);
		expect(selectPrecache(candidates, { maxBytes: 1e9, maxCount: 2 })).toHaveLength(2);
	});

	it("has a build id that changes with the files and the page", () => {
		const list = precacheCandidates(bundle(), HTML);
		expect(buildIdOf(list, HTML)).toMatch(/^[0-9a-f]{12}$/);
		expect(buildIdOf(list, HTML)).toBe(buildIdOf(list, HTML));
		expect(buildIdOf(list, `${HTML}<!-- -->`)).not.toBe(buildIdOf(list, HTML));
		expect(buildIdOf(list.slice(1), HTML)).not.toBe(buildIdOf(list, HTML));
	});
});

describe("the service worker bundle", () => {
	it("emits sw.js as one script with the build id and precache list baked in", async () => {
		const plugin = pwaPlugin({ entry: path.join(import.meta.dirname, "..", "src", "renderer", "web", "sw.ts") });
		const emitted: { fileName?: string; source?: string | Uint8Array }[] = [];
		const hook = plugin.generateBundle;
		const run = typeof hook === "function" ? hook : hook?.handler;
		const files = {
			...bundle(),
			"web.html": { type: "asset", fileName: "web.html", source: HTML } as Rollup.OutputAsset,
		};
		await run?.call(
			{ emitFile: (file: (typeof emitted)[number]) => emitted.push(file) } as never,
			{} as never,
			files,
			false,
		);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.fileName).toBe("sw.js");
		const code = String(emitted[0]?.source);
		const id = buildIdOf(precacheCandidates(bundle(), HTML), HTML);
		expect(code).toContain(id);
		expect(code).toContain("/assets/main-ddd.js");
		expect(code).not.toContain("/assets/mermaid-fff.js");
		expect(code).not.toMatch(/\b__SW_(BUILD|PRECACHE)__\b/);
		expect(code).not.toMatch(/^\s*(import|export)\s/m);
		expect(code).toContain("notificationclick");
	});
});

interface ManifestIcon {
	src: string;
	sizes: string;
	type: string;
	purpose?: string;
}

function pngSize(file: string): { width: number; height: number } {
	const bytes = readFileSync(path.join(PUBLIC_DIR, file));
	expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("web manifest", () => {
	const manifest = JSON.parse(readFileSync(path.join(PUBLIC_DIR, "manifest.webmanifest"), "utf8")) as {
		name: string;
		display: string;
		start_url: string;
		scope: string;
		theme_color: string;
		background_color: string;
		icons: ManifestIcon[];
	};

	it("installs as a standalone OMPdesk app starting at /", () => {
		expect(manifest).toMatchObject({ name: "OMPdesk", display: "standalone", start_url: "/", scope: "/" });
		expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
		expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
	});

	it("lists 192 and 512 icons and a maskable one, each a real PNG of its declared size", () => {
		const purposes = manifest.icons.map(icon => `${icon.sizes}:${icon.purpose ?? "any"}`).sort();
		expect(purposes).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
		for (const icon of manifest.icons) {
			expect(icon.type).toBe("image/png");
			const [width, height] = icon.sizes.split("x").map(Number);
			expect(pngSize(icon.src.slice(1))).toEqual({ width, height });
		}
	});

	it("has the 180px apple-touch-icon the page links, and every generated icon exists", () => {
		expect(pngSize("apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
		for (const { file, size } of PWA_ICON_FILES) expect(pngSize(file)).toEqual({ width: size, height: size });
		const page = readFileSync(path.join(import.meta.dirname, "..", "src", "renderer", "web.html"), "utf8");
		expect(page).toContain('rel="manifest" href="/manifest.webmanifest"');
		expect(page).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
	});
});
