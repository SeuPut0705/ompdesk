import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../resources/gui-bridge/stock-helper/dispatch";
import { core } from "./core/process";
import { StockHelper, type StockHelperOptions } from "./stock-helper";

let dir: string;
const helpers: StockHelper[] = [];

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-helper-"));
});
afterEach(async () => {
	await Promise.all(helpers.splice(0).map(helper => helper.stop()));
	await fs.rm(dir, { recursive: true, force: true });
});

/** A worker speaking the helper's protocol through the real dispatcher, with methods a test can steer. */
async function workerScript(): Promise<string> {
	const script = path.join(dir, "worker.ts");
	const dispatch = path.resolve("resources/gui-bridge/stock-helper/dispatch.ts");
	await fs.writeFile(
		script,
		`import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createDispatcher } from ${JSON.stringify(dispatch)};
// Each worker process the core starts, in order: the core holds the process, a test sees it by its pid.
appendFileSync(process.env.WORKER_PIDS, process.pid + "\\n");
// slow takes real time; gated runs until the test writes "release", so a helper timeout cuts it short
// whatever the machine's load does to either side's timers.
const methods = {
	fast: () => "ok",
	slow: async () => {
		await new Promise(done => setTimeout(done, 300));
		writeFileSync(${JSON.stringify(path.join(dir, "slow-done"))}, "");
		return "slow";
	},
	gated: async () => {
		appendFileSync(${JSON.stringify(path.join(dir, "gated-started"))}, "gated\\n");
		while (!existsSync(${JSON.stringify(path.join(dir, "release"))})) await new Promise(done => setTimeout(done, 10));
		return "gated";
	},
	mutate: params => { appendFileSync(${JSON.stringify(path.join(dir, "mutations"))}, params + "\\n"); return "mutated"; },
	record: params => { appendFileSync(${JSON.stringify(path.join(dir, "order"))}, params + "\\n"); return params; },
	hang: () => new Promise(() => {}),
};
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
const dispatch = createDispatcher(methods, line => process.stdout.write(line + "\\n"), false);
// Every withdrawal the worker read, so a test can release a gate only once the worker knows what to skip.
input.on("line", line => {
	if (line.includes('"cancel"')) appendFileSync(${JSON.stringify(path.join(dir, "cancels"))}, line + "\\n");
	dispatch(line);
});
`,
	);
	return script;
}

async function helperOnWorker(requestTimeoutMs: number, options: Omit<StockHelperOptions, "launch"> = {}) {
	const script = await workerScript();
	const pids = path.join(dir, `pids-${helpers.length}`);
	// What stands for omp's package.json: its time and size are what identifies the installed omp.
	const stampFile = path.join(dir, "omp-package.json");
	let installs = 0;
	const install = (version: string) => fs.writeFile(stampFile, version + " ".repeat(++installs));
	await install("18.18.9");
	const helper = new StockHelper(dir, {
		requestTimeoutMs,
		...options,
		launch: async () => ({ bin: "bun", args: [script], env: { ...process.env, WORKER_PIDS: pids }, stampFile }),
	});
	helpers.push(helper);
	// Started before a test's timed part: a request's timeout runs through its worker's start, and a cold
	// `bun` on a busy machine takes longer than the 100-250 ms these tests time out on.
	await helper.request("fast", {}, { timeoutMs: 30_000 });
	/** The pid of every worker process started for this helper so far. */
	const workers = () => readFileSync(pids, "utf8").trim().split("\n").map(Number);
	return { helper, workers, install };
}

function gone(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

describe("StockHelper request timeout", () => {
	it("fails only the slow request and keeps a worker whose late answer comes within the grace", async () => {
		const { helper, workers } = await helperOnWorker(200, { recycleGraceMs: 30_000 });
		await expect(helper.request("gated", {})).rejects.toThrow("timed out");
		expect(workers()).toHaveLength(1);
		expect(gone(workers()[0])).toBe(false);
		// The gated request keeps running in the worker; the next one queues behind it.
		await fs.writeFile(path.join(dir, "release"), "");
		await expect(helper.request("fast", {}, { timeoutMs: 30_000 })).resolves.toBe("ok");
		expect(workers()).toHaveLength(1);
	});

	it("hands a burst of requests to its serial lane in the order they were made", async () => {
		const { helper } = await helperOnWorker(30_000);
		// Sent in one synchronous run, as a caller that starts a scan and then a mutation does: the core must place
		// each in the lane as its frame is read, not as a task of its own happens to start (run 43357570260 ran
		// "late" before the "gated" request it was sent after).
		const sent = Array.from({ length: 60 }, (_, index) => index);
		await Promise.all(sent.map(index => helper.request("record", index)));
		const order = (await fs.readFile(path.join(dir, "order"), "utf8")).trim().split("\n").map(Number);
		expect(order).toEqual(sent);
	});

	it("never runs a queued mutation whose caller already timed out, and its acknowledged withdrawal keeps the worker", async () => {
		const { helper, workers } = await helperOnWorker(250, { recycleGraceMs: 2000 });
		const gated = helper.request("gated", {});
		const gatedTimedOut = expect(gated).rejects.toThrow("timed out");
		const mutate = helper.request("mutate", "late");
		await expect(mutate).rejects.toThrow("timed out");
		await gatedTimedOut;
		// Both withdrawals reach the worker through its stdin pipe, which on a loaded Windows runner arrives after
		// the release file below (release run 39918441333 ran "late"): the gate opens once the worker has read them.
		await vi.waitFor(
			async () =>
				expect(
					(await fs.readFile(path.join(dir, "cancels"), "utf8").catch(() => "")).trim().split("\n"),
				).toHaveLength(2),
			{ timeout: 10_000 },
		);
		// The withdrawn mutation sits behind the gated request; once that ends it must be skipped. The lane is
		// serial, so the fresh mutation is answered only after the late answer and the withdrawal.
		await fs.writeFile(path.join(dir, "release"), "");
		await expect(helper.request("mutate", "fresh", { timeoutMs: 30_000 })).resolves.toBe("mutated");
		expect(await fs.readFile(path.join(dir, "mutations"), "utf8")).toBe("fresh\n");
		// Past both graces: the skipped mutation was acknowledged, so nothing counts as hung. A real wait: the
		// grace is the helper's own timer on a real worker process, which fake timers cannot drive.
		await sleep(2100);
		expect(workers()).toHaveLength(1);
		expect(gone(workers()[0])).toBe(false);
	});

	it("recycles the stock worker when a request hangs past its timeout plus the grace, and starts afresh lazily", async () => {
		const { helper, workers } = await helperOnWorker(150, { recycleGraceMs: 150 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(helper.request("hang", {})).rejects.toThrow("timed out");
			// Queued behind the hung request: fails with the restart instead of waiting out its own timeout.
			const queued = helper.request("fast", {});
			await expect(queued).rejects.toThrow(/timed out|restarted/);
			await vi.waitFor(() => expect(gone(workers()[0])).toBe(true));
			// The core says so on its stderr, which main logs as it arrives.
			await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("hung")));
			// A fresh worker starts here, and a request's timeout runs through its start: a cold `bun` on a
			// Windows runner takes longer than the 150 ms this helper's hang detection runs on.
			await expect(helper.request("fast", {}, { timeoutMs: 10_000 })).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("never recycles the terminals worker: its PTYs outlive a timed-out request", async () => {
		const { helper, workers } = await helperOnWorker(100, { recycleGraceMs: 100, worker: "terminals" });
		await expect(helper.request("hang", {})).rejects.toThrow("timed out");
		await sleep(250);
		expect(gone(workers()[0])).toBe(false);
		expect(workers()).toHaveLength(1);
	});

	it("never recycles the extensions worker: a plugin upgrade may run past any request timeout", async () => {
		const { helper, workers } = await helperOnWorker(100, { recycleGraceMs: 100, worker: "extensions" });
		await expect(helper.request("hang", {})).rejects.toThrow("timed out");
		await sleep(250);
		expect(gone(workers()[0])).toBe(false);
		expect(workers()).toHaveLength(1);
	});

	it("lets one request carry its own timeout, longer or shorter than the helper's default", async () => {
		const { helper } = await helperOnWorker(100);
		// slow takes 300 ms: the default 100 ms would cut it, an explicit 5 s does not.
		await expect(helper.request("slow", {}, { timeoutMs: 5000 })).resolves.toBe("slow");
		const shortened = await helperOnWorker(5000);
		await expect(shortened.helper.request("hang", {}, { timeoutMs: 100 })).rejects.toThrow("timed out");
	});

	it("times a request out even while its worker never finishes starting", async () => {
		const helper = new StockHelper(dir, {
			requestTimeoutMs: 100,
			launch: () => new Promise<never>(() => {}),
		});
		helpers.push(helper);
		await expect(helper.request("fast", {})).rejects.toThrow("timed out");
	});

	it("rejects pending requests on stop()", async () => {
		const { helper } = await helperOnWorker(5000);
		await helper.request("fast", {});
		const slow = helper.request("slow", {});
		await sleep(50);
		const rejected = expect(slow).rejects.toThrow("stopped");
		await helper.stop();
		await rejected;
	});

	it("ends an idle worker once every request it was sent is answered, and starts a fresh one on the next", async () => {
		const { helper, workers } = await helperOnWorker(5000, { worker: "extensions", idleExitMs: 150 });
		await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
		await expect(helper.request("fast", {}, { timeoutMs: 30_000 })).resolves.toBe("ok");
		expect(workers()).toHaveLength(2);
	});

	it("keeps an idle-exit worker up while a request it was sent still runs, even one whose caller timed out", async () => {
		const { helper, workers } = await helperOnWorker(100, { worker: "extensions", idleExitMs: 150 });
		await expect(helper.request("gated", {})).rejects.toThrow("timed out");
		// A plugin upgrade past its timeout: the worker is still at it, so it stays.
		await sleep(500);
		expect(gone(workers()[0])).toBe(false);
		// Its late answer leaves the lane empty: now it ends.
		await fs.writeFile(path.join(dir, "release"), "");
		await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
		expect(workers()).toHaveLength(1);
	});

	it("starts a fresh stock worker once the installed omp changed under an idle one, and keeps it while it is busy", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { helper, workers, install } = await helperOnWorker(30_000);
			// omp was reinstalled under the running worker: its module registry holds the old files, and a module it
			// imports later comes from the new ones (12 Nov 2026: "Export named … not found" on every worktree create).
			await install("18.19.0");
			await expect(helper.request("fast", {})).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
			await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
			// Unchanged: the same worker answers.
			await expect(helper.request("fast", {})).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
			// A change while a request still runs on the worker waits for it: nothing in flight is cut.
			const gated = helper.request("gated", {});
			// The core reads the stamp when the request reaches it: the change comes once the worker runs the request.
			await vi.waitFor(() => expect(readFileSync(path.join(dir, "gated-started"), "utf8")).toBe("gated\n"));
			expect(workers()).toHaveLength(2);
			await install("18.19.1");
			const queued = helper.request("fast", {});
			await fs.writeFile(path.join(dir, "release"), "");
			await expect(gated).resolves.toBe("gated");
			await expect(queued).resolves.toBe("ok");
			expect(workers()).toHaveLength(2);
			await expect(helper.request("fast", {})).resolves.toBe("ok");
			expect(workers()).toHaveLength(3);
		} finally {
			warn.mockRestore();
		}
	});

	it("never retires the terminals worker for a changed omp: its live shells would go with it", async () => {
		const { helper, workers, install } = await helperOnWorker(30_000, { worker: "terminals" });
		await install("18.19.0");
		await expect(helper.request("fast", {})).resolves.toBe("ok");
		expect(workers()).toHaveLength(1);
	});

	it("ends its workers with the core, however the core ends", async () => {
		const { helper, workers } = await helperOnWorker(30_000, { worker: "terminals" });
		const hung = helper.request("hang", {});
		const failed = expect(hung).rejects.toThrow("ompdesk-core exited");
		// A crash of the app's core: nothing closes the worker's stdin in an orderly way and no stop is sent.
		process.kill(core().pid as number, "SIGKILL");
		await failed;
		await vi.waitFor(() => expect(gone(workers()[0])).toBe(true), { timeout: 10_000 });
		// The next request starts a core and a worker again.
		const next = await helperOnWorker(30_000, { worker: "terminals" });
		expect(gone(next.workers()[0])).toBe(false);
	});
});

describe("helperWorker", () => {
	it("sends terminals and PTYs to their own worker, extension calls to the extensions lane, everything else to the stock lane", async () => {
		const routed = [
			["terminal.request", "terminals"],
			["terminal.dispose", "terminals"],
			["pty.request", "terminals"],
			["extensions.inventory", "extensions"],
			["extensions.plugin.upgrade", "extensions"],
			["sessions.list", "stock"],
			["models.validate", "stock"],
			["accounts.providers", "stock"],
		] as const;
		// A worker that answers every method with the worker it was started as.
		const script = path.join(dir, "which-worker.ts");
		const dispatch = path.resolve("resources/gui-bridge/stock-helper/dispatch.ts");
		await fs.writeFile(
			script,
			`import { createInterface } from "node:readline";
import { createDispatcher } from ${JSON.stringify(dispatch)};
const methods = Object.fromEntries(${JSON.stringify(routed.map(([method]) => method))}.map(method => [method, () => process.argv[2]]));
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", createDispatcher(methods, line => process.stdout.write(line + "\\n"), true));
`,
		);
		const helper = new StockHelper(dir, {
			launch: async worker => ({ bin: "bun", args: [script, worker], env: process.env }),
		});
		helpers.push(helper);
		for (const [method, worker] of routed) expect(await helper.request(method, {})).toBe(worker);
	});
});

describe("createDispatcher", () => {
	it("withdraws a queued request that has not started, acknowledges it in its turn, and answers the rest in order", async () => {
		const out: string[] = [];
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const ran: string[] = [];
		const dispatch = createDispatcher(
			{
				first: async () => {
					await gate;
					ran.push("first");
					return 1;
				},
				second: () => {
					ran.push("second");
					return 2;
				},
				third: () => {
					ran.push("third");
					return 3;
				},
			},
			line => out.push(line),
			false,
		);
		dispatch(JSON.stringify({ id: 1, method: "first" }));
		dispatch(JSON.stringify({ id: 2, method: "second" }));
		dispatch(JSON.stringify({ id: 3, method: "third" }));
		dispatch(JSON.stringify({ cancel: 2 }));
		release();
		await vi.waitFor(() => expect(out).toHaveLength(3));
		expect(ran).toEqual(["first", "third"]);
		expect(out.map(line => JSON.parse(line))).toEqual([
			{ id: 1, result: 1 },
			{ id: 2, error: "withdrawn" },
			{ id: 3, result: 3 },
		]);
	});

	it("answers an unqueued probe at once while a scan holds the serial lane", async () => {
		const out: string[] = [];
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const dispatch = createDispatcher(
			{
				"sessions.list": async () => {
					await gate;
					return [];
				},
				"sessions.owned": () => false,
				"sessions.delete": () => true,
			},
			line => out.push(line),
			{ "sessions.owned": true },
		);
		dispatch(JSON.stringify({ id: 1, method: "sessions.list" }));
		dispatch(JSON.stringify({ id: 2, method: "sessions.delete" }));
		dispatch(JSON.stringify({ id: 3, method: "sessions.owned" }));
		await vi.waitFor(() => expect(out).toHaveLength(1));
		expect(JSON.parse(out[0] as string)).toEqual({ id: 3, result: false });
		release();
		await vi.waitFor(() => expect(out).toHaveLength(3));
		expect(out.slice(1).map(line => JSON.parse(line))).toEqual([
			{ id: 1, result: [] },
			{ id: 2, result: true },
		]);
	});

	it("reports unknown methods and malformed requests without stopping", async () => {
		const out: string[] = [];
		const dispatch = createDispatcher({}, line => out.push(line), false);
		dispatch(JSON.stringify({ id: 7, method: "constructor" }));
		dispatch("not json");
		await vi.waitFor(() => expect(out).toHaveLength(2));
	});
});

describe("stock helper terminals", () => {
	it("builds one terminal service for overlapping first requests, so dispose reaches every PTY", async () => {
		// A stand-in for stock's pi-natives: PtySession counts constructions and kills.
		const natives = path.join(dir, "node_modules", "@oh-my-pi", "pi-natives");
		await fs.mkdir(natives, { recursive: true });
		await fs.writeFile(path.join(dir, "package.json"), "{}");
		await fs.writeFile(
			path.join(natives, "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-natives", version: "0.0.0", main: "index.js" }),
		);
		await fs.writeFile(
			path.join(natives, "index.js"),
			`globalThis.ptyKills = 0;
export class PtySession {
	startArgv() { return new Promise(() => {}); }
	write() {}
	resize() {}
	kill() { globalThis.ptyKills++; }
}
`,
		);
		const script = path.join(dir, "terminals-race.ts");
		const terminals = path.resolve("resources/gui-bridge/stock-helper/terminals.ts");
		await fs.writeFile(
			script,
			`import { disposeTerminals, methods } from ${JSON.stringify(terminals)};
const create = owner => methods["terminal.request"]({ owner, cwd: ${JSON.stringify(dir)}, operation: { action: "create", cols: 80, rows: 24 } });
await Promise.all([create("a"), create("b")]);
disposeTerminals();
process.stdout.write(String(globalThis.ptyKills));
`,
		);
		const child = spawn("bun", [script], { env: { ...process.env, OMP_PACKAGE_ROOT: dir } });
		let out = "";
		let err = "";
		child.stdout.on("data", chunk => {
			out += chunk;
		});
		child.stderr.on("data", chunk => {
			err += chunk;
		});
		const [code] = await once(child, "close");
		expect(err).toBe("");
		expect(code).toBe(0);
		expect(out).toBe("2");
	});
});
