import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	Connection,
	DATA_OFFSET,
	HUB_CALL_DEADLINE_MS,
	Hub,
	type HubInstanceHandler,
	type HubItem,
	LENGTH,
	STATE,
} from "./hub";
import { CoreError, core, stopCore } from "./process";

afterAll(() => stopCore());

/** A `test:probe` instance of the real core's hub, and everything it told main. */
function probe(hub: Hub, answer: (q: string, item: HubItem) => unknown = () => "yes") {
	const items: HubItem[] = [];
	const lost: CoreError[] = [];
	const handler: HubInstanceHandler = {
		item: item => items.push(item),
		ask: (q, item) => answer(q, item),
		lost: error => lost.push(error),
	};
	const id = hub.nextId();
	hub.open(id, "test:probe", {}, handler);
	return { id, items, lost };
}

/** Kills the running core after `ms`, from another process: main's own thread is blocked meanwhile. */
function killCoreAfter(ms: number): void {
	const pid = core().pid;
	if (pid === null) throw new Error("no core runs");
	spawn(process.execPath, ["-e", `setTimeout(() => process.kill(${pid}, "SIGKILL"), ${ms})`], {
		stdio: "ignore",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	}).unref();
}

describe("the hub connection", () => {
	it("answers a call after main handled every item the call made", () => {
		const hub = new Hub();
		const instance = probe(hub);
		expect(hub.call(instance.id, "push", { n: 7 })).toBe(7);
		expect(instance.items).toEqual([{ k: "n", n: 7 }]);
	});

	it("lets main answer a synchronous question inside a call, nested calls included", () => {
		const hub = new Hub();
		const order: string[] = [];
		const instance = probe(hub, () => {
			order.push("asked");
			// A listener that calls back in while the core's rule waits for this answer.
			expect(hub.call(instance.id, "push", { n: 1 })).toBe(1);
			order.push("nested answered");
			return "from main";
		});
		expect(hub.call(instance.id, "ask")).toBe("from main");
		expect(order).toEqual(["asked", "nested answered"]);
		expect(instance.items).toEqual([{ k: "n", n: 1 }, { k: "after" }]);
	});

	it("answers a later question once main's promise settles, without blocking main", async () => {
		const hub = new Hub();
		const instance = probe(hub, () => Promise.resolve("later"));
		await expect(hub.callLater(instance.id, "askLater")).resolves.toBe("later");
	});

	it("runs what a call woke in the core as microtasks after the caller's own code, as a promise continuation", async () => {
		const hub = new Hub();
		const instance = probe(hub);
		// The rule's continuation runs once `fire` came.
		const waited = hub.callLater(instance.id, "wait");
		hub.call(instance.id, "fire");
		expect(instance.items).toEqual([]);
		await Promise.resolve();
		expect(instance.items).toEqual([{ k: "woke" }]);
		await expect(waited).resolves.toBe("woke");
	});

	it("answers a drain whose ping is older than the hand-over that took its lines", async () => {
		const hub = new Hub();
		const instance = probe(hub, () => "yes");
		// Each synchronous question's answer goes out inside the call; the core's reply to it can come while the worker
		// is between hand-overs, so a ping waits in main's queue for lines a later wait already took.
		for (let round = 0; round < 50; round++) {
			hub.call(instance.id, "ask");
			await new Promise(resolve => setImmediate(resolve));
		}
		expect(instance.lost).toEqual([]);
	});

	it("never holds main past the deadline when the core stops answering, and opens a new core after", () => {
		const hub = new Hub();
		const instance = probe(hub);
		const before = core().pid;
		const started = performance.now();
		// `wait` answers only on `fire`, which never comes: the hub does not answer.
		expect(() => hub.call(instance.id, "wait")).toThrow(CoreError);
		const blocked = performance.now() - started;
		expect(blocked).toBeGreaterThanOrEqual(HUB_CALL_DEADLINE_MS - 50);
		expect(blocked).toBeLessThan(HUB_CALL_DEADLINE_MS + 1_000);
		expect(instance.lost.map(error => error.code)).toEqual(["hub_lost"]);
		const again = probe(hub);
		expect(hub.call(again.id, "push", { n: 2 })).toBe(2);
		expect(core().pid).not.toBe(before);
	});

	it("never hands a question of the next core the answer to one the lost core asked", async () => {
		const hub = new Hub();
		const stale = Promise.withResolvers<string>();
		let asked = 0;
		const old = probe(hub, () => {
			asked++;
			return stale.promise;
		});
		const unanswered = hub.callLater(old.id, "askLater").catch((error: unknown) => error);
		// Main took the question (its promise is pending) before the core is lost.
		hub.barrier();
		expect(asked).toBe(1);
		killCoreAfter(200);
		expect(() => hub.call(old.id, "wait")).toThrow(CoreError);
		expect(await unanswered).toBeInstanceOf(CoreError);
		// The next core's first question carries the number the lost core's had.
		const fresh = Promise.withResolvers<string>();
		const next = probe(hub, () => fresh.promise);
		const answer = hub.callLater(next.id, "askLater");
		hub.barrier();
		stale.resolve("stale");
		await new Promise(resolve => setImmediate(resolve));
		fresh.resolve("fresh");
		await expect(answer).resolves.toBe("fresh");
	});

	it("wakes main at once when the core ends in the middle of a call (the quit, a crash)", () => {
		const hub = new Hub();
		const instance = probe(hub);
		killCoreAfter(200);
		const started = performance.now();
		expect(() => hub.call(instance.id, "wait")).toThrow(CoreError);
		expect(performance.now() - started).toBeLessThan(HUB_CALL_DEADLINE_MS);
		expect(instance.lost).toHaveLength(1);
	});
});

describe("the hub worker's line reader", () => {
	it("keeps a Korean character whole when a chunk ends in the middle of it", async () => {
		const text = "경로 /Users/홍길동/프로젝트 이어하기";
		const bytes = Buffer.from(`${JSON.stringify({ id: 1, text })}\n`, "utf8");
		const cut = bytes.indexOf(Buffer.from("홍", "utf8")) + 1; // inside the 3-byte character
		const dir = mkdtempSync(join(tmpdir(), "hub-utf8-"));
		const address =
			process.platform === "win32"
				? `\\\\.\\pipe\\ompdesk-hub-utf8-${process.pid}-${Date.now()}`
				: join(dir, "s.sock");
		const server = createServer(socket => {
			socket.setNoDelay(true);
			socket.once("data", () => {
				socket.write(bytes.subarray(0, cut));
				setTimeout(() => socket.write(bytes.subarray(cut)), 50);
			});
		});
		await new Promise<void>(resolve => server.listen(address, resolve));
		const connection = new Connection({ address, token: "t" }, 1);
		try {
			let lines: { text?: string }[] = [];
			for (let attempt = 0; attempt < 40 && lines.length === 0; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 25));
				Atomics.store(connection.control, STATE, 1);
				connection.worker.postMessage({ wait: "drain" });
				Atomics.wait(connection.control, STATE, 1, 1000);
				const length = Atomics.load(connection.control, LENGTH);
				const raw = Buffer.from(new Uint8Array(connection.sab, DATA_OFFSET, length)).toString("utf8");
				lines = (JSON.parse(raw) as { lines: { text?: string }[] }).lines;
				Atomics.store(connection.control, STATE, 0);
			}
			expect(lines.map(line => line.text)).toEqual([text]);
		} finally {
			await connection.worker.terminate();
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
