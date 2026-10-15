import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../resources/gui-bridge/stock-helper/dispatch";
import { StockHelper } from "./stock-helper";

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
		await new Promise(done => setTimeout(done, 600));
		writeFileSync(${JSON.stringify(path.join(dir, "slow-done"))}, "");
		return "slow";
	},
	mutate: params => { appendFileSync(${JSON.stringify(path.join(dir, "mutations"))}, params + "\\n"); return "mutated"; },
	"terminal.ping": () => "pong",
};
const input = createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", createDispatcher(methods, line => process.stdout.write(line + "\\n"), method => method.startsWith("terminal.")));
`,
	);
	return script;
}

async function helperOnWorker(requestTimeoutMs: number) {
	const script = await workerScript();
	const children: ChildProcessWithoutNullStreams[] = [];
	const helper = new StockHelper(dir, {
		requestTimeoutMs,
		spawnWorker: async () => {
			const child = spawn("bun", [script], { stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			return child;
		},
	});
	helpers.push(helper);
	return { helper, children };
}

describe("StockHelper request timeout", () => {
	it("fails only the slow request and keeps the worker (and its terminals) alive", async () => {
		const { helper, children } = await helperOnWorker(200);
		await expect(helper.request("slow", {})).rejects.toThrow("timed out");
		expect(children).toHaveLength(1);
		expect(children[0]?.exitCode).toBeNull();
		// The slow request keeps running in the worker; wait for it before the next one queues behind it.
		await vi.waitFor(() => fs.access(path.join(dir, "slow-done")));
		await expect(helper.request("fast", {})).resolves.toBe("ok");
		expect(children).toHaveLength(1);
	});

	it("never runs a queued mutation whose caller already timed out", async () => {
		const { helper } = await helperOnWorker(250);
		const slow = helper.request("slow", {});
		const slowTimedOut = expect(slow).rejects.toThrow("timed out");
		const mutate = helper.request("mutate", "late");
		await expect(mutate).rejects.toThrow("timed out");
		await slowTimedOut;
		// The withdrawn mutation sits behind the slow request; once that ends it must be skipped.
		await vi.waitFor(() => fs.access(path.join(dir, "slow-done")));
		await expect(helper.request("mutate", "fresh")).resolves.toBe("mutated");
		expect(await fs.readFile(path.join(dir, "mutations"), "utf8")).toBe("fresh\n");
	});

	it("answers terminal requests while a stock request is still running", async () => {
		const { helper } = await helperOnWorker(5000);
		await helper.request("fast", {});
		const slow = helper.request("slow", {});
		let slowDone = false;
		void slow.then(() => {
			slowDone = true;
		});
		await expect(helper.request("terminal.ping", {})).resolves.toBe("pong");
		expect(slowDone).toBe(false);
		await expect(slow).resolves.toBe("slow");
	});

	it("rejects pending requests on stop()", async () => {
		const { helper } = await helperOnWorker(5000);
		await helper.request("fast", {});
		const slow = helper.request("slow", {});
		await expect(helper.request("terminal.ping", {})).resolves.toBe("pong");
		const rejected = expect(slow).rejects.toThrow("stopped");
		await helper.stop();
		await rejected;
	});
});

describe("createDispatcher", () => {
	it("withdraws a queued request that has not started, and answers the rest in order", async () => {
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
			() => false,
		);
		dispatch(JSON.stringify({ id: 1, method: "first" }));
		dispatch(JSON.stringify({ id: 2, method: "second" }));
		dispatch(JSON.stringify({ id: 3, method: "third" }));
		dispatch(JSON.stringify({ cancel: 2 }));
		release();
		await vi.waitFor(() => expect(out).toHaveLength(2));
		expect(ran).toEqual(["first", "third"]);
		expect(out.map(line => JSON.parse(line))).toEqual([
			{ id: 1, result: 1 },
			{ id: 3, result: 3 },
		]);
	});

	it("reports unknown methods and malformed requests without stopping", async () => {
		const out: string[] = [];
		const dispatch = createDispatcher(
			{},
			line => out.push(line),
			() => false,
		);
		dispatch(JSON.stringify({ id: 7, method: "constructor" }));
		dispatch("not json");
		await vi.waitFor(() => expect(out).toHaveLength(2));
	});
});
