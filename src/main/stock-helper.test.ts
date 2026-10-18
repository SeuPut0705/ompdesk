import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../resources/gui-bridge/stock-helper/dispatch";
import { helperWorker, StockHelper, type StockHelperOptions } from "./stock-helper";

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
		`import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createDispatcher } from ${JSON.stringify(dispatch)};
// slow takes real time so the helper's own timeout has something to cut short.
const methods = {
	fast: () => "ok",
	slow: async () => {
		await new Promise(done => setTimeout(done, 300));
		writeFileSync(${JSON.stringify(path.join(dir, "slow-done"))}, "");
		return "slow";
	},
	mutate: params => { appendFileSync(${JSON.stringify(path.join(dir, "mutations"))}, params + "\\n"); return "mutated"; },
	hang: () => new Promise(() => {}),
};
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", createDispatcher(methods, line => process.stdout.write(line + "\\n"), false));
`,
	);
	return script;
}

async function helperOnWorker(requestTimeoutMs: number, options: Omit<StockHelperOptions, "spawnWorker"> = {}) {
	const script = await workerScript();
	const children: ChildProcessWithoutNullStreams[] = [];
	const helper = new StockHelper(dir, {
		requestTimeoutMs,
		...options,
		spawnWorker: async () => {
			const child = spawn("bun", [script], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			return child;
		},
	});
	helpers.push(helper);
	return { helper, children };
}

const gone = (child: ChildProcessWithoutNullStreams | undefined) =>
	child !== undefined && (child.exitCode !== null || child.signalCode !== null);

describe("StockHelper request timeout", () => {
	it("fails only the slow request and keeps a worker whose late answer comes within the grace", async () => {
		const { helper, children } = await helperOnWorker(200, { recycleGraceMs: 2000 });
		await expect(helper.request("slow", {})).rejects.toThrow("timed out");
		expect(children).toHaveLength(1);
		expect(children[0]?.exitCode).toBeNull();
		// The slow request keeps running in the worker; wait for it before the next one queues behind it.
		await vi.waitFor(() => fs.access(path.join(dir, "slow-done")));
		await expect(helper.request("fast", {})).resolves.toBe("ok");
		expect(children).toHaveLength(1);
	});

	it("never runs a queued mutation whose caller already timed out, and its acknowledged withdrawal keeps the worker", async () => {
		const { helper, children } = await helperOnWorker(250, { recycleGraceMs: 700 });
		const slow = helper.request("slow", {});
		const slowTimedOut = expect(slow).rejects.toThrow("timed out");
		const mutate = helper.request("mutate", "late");
		await expect(mutate).rejects.toThrow("timed out");
		await slowTimedOut;
		// The withdrawn mutation sits behind the slow request; once that ends it must be skipped.
		await vi.waitFor(() => fs.access(path.join(dir, "slow-done")));
		await expect(helper.request("mutate", "fresh")).resolves.toBe("mutated");
		expect(await fs.readFile(path.join(dir, "mutations"), "utf8")).toBe("fresh\n");
		// Past both graces: the skipped mutation was acknowledged, so nothing counts as hung.
		await sleep(800);
		expect(children).toHaveLength(1);
		expect(gone(children[0])).toBe(false);
	});

	it("recycles the stock worker when a request hangs past its timeout plus the grace, and starts afresh lazily", async () => {
		const { helper, children } = await helperOnWorker(150, { recycleGraceMs: 150 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(helper.request("hang", {})).rejects.toThrow("timed out");
			// Queued behind the hung request: fails with the restart instead of waiting out its own timeout.
			const queued = helper.request("fast", {});
			await expect(queued).rejects.toThrow(/timed out|restarted/);
			await vi.waitFor(() => expect(gone(children[0])).toBe(true));
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("hung"));
			// A fresh worker starts here, and a request's timeout runs through its start: a cold `bun` on a
			// Windows runner takes longer than the 150 ms this helper's hang detection runs on.
			await expect(helper.request("fast", {}, { timeoutMs: 10_000 })).resolves.toBe("ok");
			expect(children).toHaveLength(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("never recycles the terminals worker: its PTYs outlive a timed-out request", async () => {
		const { helper, children } = await helperOnWorker(100, { recycleGraceMs: 100, worker: "terminals" });
		await expect(helper.request("hang", {})).rejects.toThrow("timed out");
		await sleep(250);
		expect(gone(children[0])).toBe(false);
		expect(children).toHaveLength(1);
	});

	it("never recycles the extensions worker: a plugin upgrade may run past any request timeout", async () => {
		const { helper, children } = await helperOnWorker(100, { recycleGraceMs: 100, worker: "extensions" });
		await expect(helper.request("hang", {})).rejects.toThrow("timed out");
		await sleep(250);
		expect(gone(children[0])).toBe(false);
		expect(children).toHaveLength(1);
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
			spawnWorker: () => new Promise<never>(() => {}),
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
});

describe("helperWorker", () => {
	it("sends terminals and PTYs to their own worker, extension calls to the extensions lane, everything else to the stock lane", () => {
		expect(helperWorker("terminal.request")).toBe("terminals");
		expect(helperWorker("terminal.dispose")).toBe("terminals");
		expect(helperWorker("pty.request")).toBe("terminals");
		expect(helperWorker("extensions.inventory")).toBe("extensions");
		expect(helperWorker("extensions.plugin.upgrade")).toBe("extensions");
		expect(helperWorker("sessions.list")).toBe("stock");
		expect(helperWorker("models.validate")).toBe("stock");
		expect(helperWorker("accounts.providers")).toBe("stock");
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
