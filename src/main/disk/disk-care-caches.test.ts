import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bunTranspilerCacheDir, type CacheTools, REGENERABLE_CACHES } from "./caches";
import { diskCareWorld, exists, SLOW, write } from "./disk-care-fixture";

// The tools' caches (caches.ts): each cleared past its bound, kept while a process that needs it runs.
const w = diskCareWorld();

/** The real table with bounds a test can fill. */
const caches = REGENERABLE_CACHES.map(cache => ({ ...cache, maxBytes: 20_000 }));
const BIG = "x".repeat(60_000);

interface Tools {
	env?: NodeJS.ProcessEnv;
	/** Where the stand-in bun and npm are; absent: not installed. */
	bun?: string;
	npm?: string;
	/** What `npm config get cache` prints. */
	npmCache?: string;
	processes?: string | null;
}

/** Stand-ins for the tools: `bun pm cache rm` deletes the install cache as Bun does. */
function tools(options: Tools): CacheTools {
	const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...options.env };
	return {
		env: async () => env,
		find: async name => options[name] ?? null,
		run: async (bin, args) => {
			if (bin === options.npm && args.join(" ") === "config get cache") return `${options.npmCache}\n`;
			if (bin === options.bun && args.join(" ") === "pm cache rm") {
				await fs.rm(path.join(w.root, "home", ".bun", "install", "cache"), { recursive: true });
				return "";
			}
			return null;
		},
		processes: async () => (options.processes === undefined ? "" : options.processes),
	};
}

const run = (options: Tools) => w.care(undefined, { caches, cacheTools: tools(options) }).run("user");
const actions = (state: Awaited<ReturnType<typeof run>>) => state.lastRun?.actions.map(action => action.kind);
const keptReasons = () =>
	w.logs.filter(([message]) => message === "kept").map(([, details]) => `${details.path}: ${details.reason}`);

describe("disk care: the tools' caches", () => {
	it(
		"clears Bun's transpiler cache past its bound while Bun runs, and only Bun's own files of it",
		async () => {
			const dir = path.join(w.root, "transpiled");
			await write(dir, "13d26ba104094bb1.pile", BIG);
			await write(dir, "notes.txt", "mine\n");
			const state = await run({
				env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: dir },
				processes: "/Users/me/.bun/bin/bun /Users/me/.bun/bin/omp --mode rpc-ui\nbun install\n",
			});
			expect(await exists(path.join(dir, "13d26ba104094bb1.pile"))).toBe(false);
			expect(await fs.readFile(path.join(dir, "notes.txt"), "utf8")).toBe("mine\n");
			expect(actions(state)).toEqual(["bun-transpiler-cache"]);
			expect(state.lastRun?.freedBytes).toBeGreaterThanOrEqual(60_000);
			expect(state.usage?.parts.find(part => part.id === "bunTranspilerCache")?.path).toBe(dir);
			expect(w.logs.find(([message]) => message === "bun-transpiler-cache")?.[1].path).toBe(dir);
		},
		SLOW,
	);

	it(
		"leaves a cache under its bound, and one Bun turned off has no row",
		async () => {
			const dir = path.join(w.root, "transpiled");
			await write(dir, "small.pile", "x");
			const state = await run({ env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: dir } });
			expect(await exists(path.join(dir, "small.pile"))).toBe(true);
			expect(actions(state)).toEqual([]);
			const off = await run({ env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
			expect(off.usage?.parts.some(part => part.id === "bunTranspilerCache")).toBe(false);
		},
		SLOW,
	);

	it(
		"clears Bun's install cache with bun itself, and keeps it while an install or a bunx runs or bun is missing",
		async () => {
			const cache = path.join(w.root, "home", ".bun", "install", "cache");
			await write(cache, "left-pad@1.3.0/index.js", BIG);
			const bun = path.join(w.root, "bin", "bun");

			const installing = await run({ bun, processes: "/Users/me/.bun/bin/bunx some-mcp-server\n" });
			const missing = await run({ processes: "" });
			const unknown = await run({ bun, processes: null });
			expect(await exists(path.join(cache, "left-pad@1.3.0/index.js"))).toBe(true);
			expect(keptReasons()).toEqual([
				`${cache}: an install runs`,
				`${cache}: bun was not found`,
				`${cache}: process check unavailable`,
			]);
			// A cache left in place shows in the run's summary, not only in the log.
			expect([installing, missing, unknown].map(state => state.lastRun?.kept)).toEqual([1, 1, 1]);
			expect(actions(installing)).toEqual([]);

			const cleared = await run({ bun, processes: "/Users/me/.bun/bin/bun run dev\n" });
			expect(await exists(cache)).toBe(false);
			expect(actions(cleared)).toEqual(["bun-cache"]);
			expect(cleared.lastRun?.kept).toBe(0);
			expect(cleared.lastRun?.freedBytes).toBeGreaterThanOrEqual(60_000);
		},
		SLOW,
	);

	it(
		"clears npm's _cacache where npm says its cache is, keeps the rest of that folder, and waits while npm runs",
		async () => {
			const npmCache = path.join(w.root, "npm-cache");
			const npm = path.join(w.root, "bin", "npm");
			await write(npmCache, "_cacache/content-v2/sha512/aa/bb/cc", BIG);
			await write(npmCache, "_cacache/index-v5/aa/bb/cc", "{}\n");
			await write(npmCache, "_cacache/tmp/half", "x");
			await write(npmCache, "_npx/abc/node_modules/server/index.js", BIG);
			await write(npmCache, "_logs/debug.log", "log\n");

			const running = await run({ npm, npmCache, processes: "npm install left-pad\n" });
			const npx = await run({
				npm,
				npmCache,
				processes: "node /usr/local/lib/node_modules/npm/bin/npx-cli.js some-server\n",
			});
			expect(await exists(path.join(npmCache, "_cacache/content-v2/sha512/aa/bb/cc"))).toBe(true);
			expect([running, npx].map(state => state.lastRun?.kept)).toEqual([1, 1]);
			expect(keptReasons()).toEqual(Array(2).fill(`${path.join(npmCache, "_cacache")}: npm runs`));

			// A process that only has npm in a path is not npm.
			const state = await run({ npm, npmCache, processes: "node /srv/npm-mirror/server.js\n" });
			expect(actions(state)).toEqual(["npm-cache"]);
			for (const gone of ["content-v2", "index-v5", "tmp"])
				expect(await exists(path.join(npmCache, "_cacache", gone)), gone).toBe(false);
			expect(await exists(path.join(npmCache, "_npx/abc/node_modules/server/index.js"))).toBe(true);
			expect(await fs.readFile(path.join(npmCache, "_logs/debug.log"), "utf8")).toBe("log\n");
			expect(state.usage?.parts.find(part => part.id === "npmCache")?.path).toBe(path.join(npmCache, "_cacache"));
		},
		SLOW,
	);

	it("finds Bun's transpiler cache where Bun's source puts it", () => {
		const home = path.resolve(path.sep, "Users", "me");
		const at = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
			bunTranspilerCacheDir({ HOME: home, USERPROFILE: home, ...env }, platform);
		expect(at({}, "darwin")).toBe(path.join(home, "Library", "Caches", "bun", "@t@"));
		expect(at({}, "linux")).toBe(path.join(home, ".bun", "install", "cache", "@t@"));
		expect(at({}, "win32")).toBe(path.join(home, ".bun", "install", "cache", "@t@"));
		// Bun's own install folder elsewhere does not move it; the XDG folder and the variable do, in that order.
		expect(at({ BUN_INSTALL: path.join(home, "tools", "bun") }, "linux")).toBe(
			path.join(home, ".bun", "install", "cache", "@t@"),
		);
		const xdg = path.join(home, ".cache");
		expect(at({ XDG_CACHE_HOME: xdg }, "darwin")).toBe(path.join(xdg, "bun", "@t@"));
		const named = path.join(home, "elsewhere");
		expect(at({ XDG_CACHE_HOME: xdg, BUN_RUNTIME_TRANSPILER_CACHE_PATH: named }, "darwin")).toBe(named);
		expect(at({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, "darwin")).toBeNull();
		expect(at({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "" }, "darwin")).toBeNull();
	});
});
