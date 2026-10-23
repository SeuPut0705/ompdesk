import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inputFiles, inputHash, isBuildInput, rebuildReason, STAMP, writeStamp } from "./build-cache";

const ENV: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: "/usr/bin", HOME: "/home/a" };

let root: string;

function put(file: string, text: string): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), text);
}

/** A built checkout: inputs, out/ and a stamp for both. */
function built(env = ENV): string {
	put("out/main/index.js", "main();\n");
	put("out/preload/index.cjs", "preload();\n");
	put("out/renderer/index.html", "<html></html>\n");
	const hash = inputHash(root, env);
	writeStamp(root, hash);
	return hash;
}

const reason = (env = ENV) => rebuildReason(root, inputHash(root, env), env);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-build-cache-"));
	put("package.json", '{"name":"x","version":"1.0.0"}\n');
	put("bun.lock", "{}\n");
	put("electron.vite.config.ts", "export default {};\n");
	put("tsconfig.json", "{}\n");
	put("scripts/check-main-bundle.ts", "check();\n");
	put("src/main/index.ts", "export const a = 1;\n");
	put("src/main/index.test.ts", "test();\n");
	put("src/renderer/App.tsx", 'export const App = () => <div className="p-2" />;\n');
	put("src/renderer/App.test.tsx", 'render(<div className="p-4" />);\n');
	put("resources/gui-bridge/index.ts", "bridge();\n");
	put("README.md", "docs\n");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("build cache", () => {
	it("reuses an untouched tree", () => {
		built();
		expect(reason()).toBeUndefined();
	});

	it.each([
		"src/main/index.ts",
		"src/renderer/App.tsx",
		// Tailwind scans renderer tests for class names.
		"src/renderer/App.test.tsx",
		"resources/gui-bridge/index.ts",
		"package.json",
		"bun.lock",
		"electron.vite.config.ts",
		"tsconfig.json",
		"scripts/check-main-bundle.ts",
	])("rebuilds after %s is edited", file => {
		const before = built();
		put(file, `${fs.readFileSync(path.join(root, file), "utf8")}// edit\n`);
		expect(inputHash(root, ENV)).not.toBe(before);
		expect(reason()).toBe("inputs changed since out/ was built");
	});

	it("rebuilds after a source file is added, removed or renamed", () => {
		built();
		put("src/renderer/New.tsx", "new();\n");
		expect(reason()).toBe("inputs changed since out/ was built");
		built();
		fs.renameSync(path.join(root, "src/renderer/New.tsx"), path.join(root, "src/renderer/Renamed.tsx"));
		expect(reason()).toBe("inputs changed since out/ was built");
		built();
		fs.rmSync(path.join(root, "src/renderer/Renamed.tsx"));
		expect(reason()).toBe("inputs changed since out/ was built");
	});

	it("ignores files no build reads", () => {
		built();
		put("README.md", "other docs\n");
		put("src/main/index.test.ts", "other test();\n");
		put("e2e/smoke.e2e.ts", "e2e();\n");
		expect(reason()).toBeUndefined();
	});

	it("rebuilds when a file under out/ was removed, added or rewritten", () => {
		built();
		fs.rmSync(path.join(root, "out/renderer/index.html"));
		expect(reason()).toBe("out/renderer/index.html was removed");
		built();
		put("out/renderer/extra.js", "extra();\n");
		expect(reason()).toBe("out/renderer/extra.js was added after the build");
		built();
		put("out/main/index.js", "patched();\n");
		expect(reason()).toBe("out/main/index.js changed after the build");
	});

	it("rebuilds without out/ or without a stamp", () => {
		expect(reason()).toBe("no out/");
		built();
		fs.rmSync(path.join(root, STAMP));
		expect(reason()).toBe("out/ has no build stamp");
		built();
		fs.rmSync(path.join(root, "out"), { recursive: true });
		expect(reason()).toBe("no out/");
	});

	it("rebuilds when the build env changes, not when unrelated env does", () => {
		built();
		expect(reason({ ...ENV, PATH: "/other", TERM: "xterm" })).toBeUndefined();
		expect(reason({ ...ENV, NODE_ENV: "development" })).toBe("inputs changed since out/ was built");
		expect(reason({ ...ENV, RENDERER_VITE_API: "x" })).toBe("inputs changed since out/ was built");
		expect(reason({ ...ENV, MODE: "staging" })).toBe("inputs changed since out/ was built");
	});

	it("rebuilds when an .env file appears", () => {
		built();
		put(".env.production", "VITE_FLAG=1\n");
		expect(reason()).toBe("inputs changed since out/ was built");
	});

	it("OMPDESK_FORCE_BUILD=1 always rebuilds", () => {
		built();
		expect(reason({ ...ENV, OMPDESK_FORCE_BUILD: "1" })).toBe("OMPDESK_FORCE_BUILD=1");
	});
});

describe("isBuildInput", () => {
	it("says yes for every file this checkout's build hashes, and no for a test or doc outside them", () => {
		const root = path.resolve(__dirname, "..");
		for (const file of inputFiles(root)) expect(isBuildInput(file), file).toBe(true);
		expect(isBuildInput("src/main/ipc.test.ts")).toBe(false);
		expect(isBuildInput("AGENTS.md")).toBe(false);
		expect(isBuildInput("e2e/smoke.e2e.ts")).toBe(false);
	});
});
