import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRepoLock } from "../local/git/exec";
import { nativeBinPath } from "../native-bin";
import { DIES_WITH_TEST, RM_TEMP } from "../test-fake-omp";
import { type CoreAnswer, CoreError, CoreProcess } from "./process";

const CRATE_VERSION = /^version = "(.+)"$/m.exec(
	readFileSync(join(__dirname, "..", "..", "..", "native", "ompdesk", "crates", "core", "Cargo.toml"), "utf8"),
)?.[1];

let cores: CoreProcess[] = [];
let logs: string[] = [];
const logged: Array<{ pattern: RegExp; resolve: (line: string) => void }> = [];

function log(line: string): void {
	logs.push(line);
	for (const waiter of [...logged]) {
		if (!waiter.pattern.test(line)) continue;
		logged.splice(logged.indexOf(waiter), 1);
		waiter.resolve(line);
	}
}

function nextLog(pattern: RegExp): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const seen = logs.find(line => pattern.test(line));
	if (seen) resolve(seen);
	else logged.push({ pattern, resolve });
	return promise;
}

function startCore(binary = () => nativeBinPath("ompdesk-core")): CoreProcess {
	const core = new CoreProcess({ binary, log });
	cores.push(core);
	return core;
}

const echo = (core: CoreProcess, params: Record<string, unknown>, bin?: Uint8Array, timeoutMs?: number) =>
	core.call<{ value: unknown }>("core.echo", params, { bin, timeoutMs });

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * How main runs git, with a stand-in for git: node, which writes its pid to `pidFile` and then waits, as a git waiting
 * on a hook or the network does. It needs no shell, so the same case runs on Windows.
 */
const standInRunner = (pidFile: string) => ({
	bin: process.execPath,
	args: [
		"-e",
		`${DIES_WITH_TEST} require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e9)`,
		pidFile,
	],
	env: Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	),
	timeoutMs: 600_000,
	maxBytes: 1024 * 1024,
});

interface StandIn {
	answer: Promise<CoreAnswer<unknown>>;
	pid: number;
}

/** A `git.stage` whose git is the stand-in, and the stand-in's pid once it runs. */
async function standInRequest(core: CoreProcess, dir: string, onEnded?: () => void): Promise<StandIn> {
	const pidFile = join(dir, "pid");
	const answer = core.call("git.stage", { git: standInRunner(pidFile), root: dir, paths: null }, { onEnded });
	let pid = 0;
	await vi.waitFor(
		async () => {
			pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
			expect(pid).toBeGreaterThan(0);
		},
		{ timeout: 20_000, interval: 20 },
	);
	return { answer, pid };
}

afterEach(async () => {
	await Promise.all(cores.map(core => core.stop()));
	cores = [];
	logs = [];
	logged.length = 0;
});

describe("CoreProcess", () => {
	it("starts on the first request and announces its version and protocol", async () => {
		const core = startCore();
		const ready = Promise.withResolvers<unknown>();
		core.on("ready", ready.resolve);
		expect(core.pid).toBeNull();
		await echo(core, { value: 1 });
		expect(await ready.promise).toEqual({ version: CRATE_VERSION, protocol: 1 });
	});

	it("answers a request", async () => {
		const answer = await echo(startCore(), { value: { list: [1, "two", null], text: "é ✓ 😀" } });
		expect(answer).toEqual({
			result: { value: { list: [1, "two", null], text: "é ✓ 😀" } },
			bin: null,
			generation: expect.any(Number),
		});
	});

	it("names the core that answered or sent an event, and fences a call to the core it was meant for", async () => {
		const core = startCore();
		const ready = Promise.withResolvers<number>();
		core.on("ready", (_data, _bin, generation) => ready.resolve(generation));
		const first = await echo(core, { value: 1 });
		expect(await ready.promise).toBe(first.generation);
		expect(core.generation).toBe(first.generation);
		await core.stop();
		expect(core.generation).toBe(0);
		// The numbers a core asks by start over with the next one: an answer to the first must not reach the second.
		await expect(core.call("core.echo", { value: 2 }, { generation: first.generation })).rejects.toMatchObject({
			code: "core_exited",
		});
		expect(core.pid).toBeNull();
		const second = await echo(core, { value: 3 });
		expect(second.generation).not.toBe(first.generation);
		await expect(core.call("core.echo", { value: 4 }, { generation: first.generation })).rejects.toMatchObject({
			code: "core_exited",
		});
		expect((await core.call("core.echo", { value: 5 }, { generation: second.generation })).result).toEqual({
			value: 5,
		});
	});

	it("drops a push meant for a core that ended, and starts none for it", async () => {
		const core = startCore();
		const first = await echo(core, { value: 1 });
		await core.stop();
		core.push("core.echo", { value: 2 }, undefined, first.generation);
		expect(core.pid).toBeNull();
		const second = await echo(core, { value: 3 });
		// Written to the core that runs now, because that is the generation it names.
		core.push("core.echo", { value: 4 }, undefined, second.generation);
		expect(core.pid).not.toBeNull();
	});

	it("carries a megabyte of raw bytes each way", async () => {
		const bytes = new Uint8Array(randomBytes(1024 * 1024));
		const answer = await echo(startCore(), { value: "bytes" }, bytes);
		expect(answer.bin).toBeInstanceOf(Uint8Array);
		expect(answer.bin?.byteLength).toBe(bytes.byteLength);
		expect(answer.bin?.buffer.byteLength).toBe(bytes.byteLength);
		expect(Buffer.from(answer.bin ?? []).equals(Buffer.from(bytes))).toBe(true);
	});

	it("refuses an unknown method with its code", async () => {
		const refused = startCore().call("core.nope", {});
		await expect(refused).rejects.toBeInstanceOf(CoreError);
		await expect(refused).rejects.toMatchObject({ code: "unknown_method", message: 'Unknown method "core.nope"' });
	});

	it("answers in completion order: a held request does not hold a later one", async () => {
		const core = startCore();
		const gate = randomUUID();
		const answered: string[] = [];
		const held = echo(core, { value: "held", waitFor: gate }).then(answer => {
			answered.push("held");
			return answer;
		});
		const quick = await echo(core, { value: "quick" });
		answered.push("quick");
		expect(quick.result.value).toBe("quick");
		await echo(core, { release: gate });
		expect((await held).result.value).toBe("held");
		expect(answered).toEqual(["quick", "held"]);
	});

	it("fails a request past its timeout alone and drops its late answer", async () => {
		const core = startCore();
		const gate = randomUUID();
		const late = echo(core, { value: "late", waitFor: gate }, undefined, 50);
		await expect(late).rejects.toMatchObject({ code: "timeout" });
		const dropped = nextLog(/dropped a late answer to request \d+/);
		await expect(echo(core, { value: "next", release: gate })).resolves.toMatchObject({ result: { value: "next" } });
		await dropped;
	});

	it("stops a request in the core when its signal aborts, and says once the core is done with it", async () => {
		const core = startCore();
		const stop = new AbortController();
		const ended = Promise.withResolvers<void>();
		const held = core.call("core.echo", { waitFor: randomUUID() }, { signal: stop.signal, onEnded: ended.resolve });
		await echo(core, { value: "running" });
		stop.abort();
		await expect(held).rejects.toMatchObject({ code: "cancelled" });
		await ended.promise;
		const late = core.call("core.echo", { waitFor: randomUUID() }, { signal: stop.signal });
		await expect(late).rejects.toMatchObject({ code: "cancelled" });
	});

	it("stops a request past its timeout in the core, and says when its late answer came", async () => {
		const core = startCore();
		const ended = Promise.withResolvers<void>();
		const late = core.call("core.echo", { waitFor: randomUUID() }, { timeoutMs: 50, onEnded: ended.resolve });
		await expect(late).rejects.toMatchObject({ code: "timeout" });
		await ended.promise;
		await nextLog(/dropped a late answer to request \d+/);
	});

	it("rejects what waits on a core that dies, and the next request starts a fresh one", async () => {
		const core = startCore();
		await echo(core, { value: 1 });
		const first = core.pid as number;
		const waiting = echo(core, { waitFor: randomUUID() });
		process.kill(first, "SIGKILL");
		await expect(waiting).rejects.toMatchObject({ code: "core_exited" });
		const again: CoreAnswer<{ value: unknown }> = await echo(core, { value: 2 });
		expect(again.result.value).toBe(2);
		expect(core.pid).not.toBe(first);
	});

	it("stop() ends the process", async () => {
		const core = startCore();
		await echo(core, { value: 1 });
		const pid = core.pid as number;
		expect(alive(pid)).toBe(true);
		await core.stop();
		expect(core.pid).toBeNull();
		expect(alive(pid)).toBe(false);
	});

	describe("a core that ends while a request runs its git", () => {
		let dir: string;
		let standIn = 0;
		afterEach(async () => {
			if (standIn && alive(standIn)) process.kill(standIn, "SIGKILL");
			standIn = 0;
			await rm(dir, RM_TEMP);
		});

		it("is killed with it before what waited settles, so the lock's next holder never runs beside that git", async () => {
			dir = await mkdtemp(join(tmpdir(), "omp-core-death-"));
			const core = startCore();
			const seen: Record<string, boolean> = {};
			const request = Promise.withResolvers<StandIn>();
			const old = withRepoLock(dir, async () => {
				const started = await standInRequest(core, dir, () => {
					seen.ended = alive(standIn);
				});
				request.resolve(started);
				try {
					return await started.answer;
				} catch (error) {
					seen.rejected = alive(standIn);
					throw error;
				}
			});
			const next = withRepoLock(dir, async () => {
				seen.next = alive(standIn);
			});
			standIn = (await request.promise).pid;
			expect(alive(standIn)).toBe(true);
			process.kill(core.pid as number, "SIGKILL");
			await expect(old).rejects.toMatchObject({ code: "core_exited" });
			await next;
			expect(seen).toEqual({ ended: false, rejected: false, next: false });
		}, 60_000);

		it("stop() ends a core whose request still runs, and its git with it, leaving none of its processes", async () => {
			dir = await mkdtemp(join(tmpdir(), "omp-core-stop-"));
			const core = startCore();
			const { answer, pid } = await standInRequest(core, dir);
			standIn = pid;
			const group = core.pid as number;
			const settled = answer.catch((error: unknown) => error);
			// stdin's end leaves the request running, so this waits for stop()'s kill.
			await core.stop();
			expect(alive(standIn)).toBe(false);
			expect(alive(group)).toBe(false);
			if (process.platform !== "win32") expect(() => process.kill(-group, 0)).toThrow(/ESRCH/);
			expect(await settled).toMatchObject({ code: "core_exited" });
		}, 60_000);
	});

	it("rests after three starts that end before answering", async () => {
		const core = startCore(() => join(__dirname, "no-such-core"));
		for (let start = 0; start < 3; start++)
			await expect(echo(core, {})).rejects.toMatchObject({ code: "core_unavailable" });
		await expect(echo(core, {})).rejects.toThrow(/not started again for 30 s/);
	});
});
