import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeBinPath } from "../native-bin";
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
		expect(answer).toEqual({ result: { value: { list: [1, "two", null], text: "é ✓ 😀" } }, bin: null });
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

	it("rests after three starts that end before answering", async () => {
		const core = startCore(() => join(__dirname, "no-such-core"));
		for (let start = 0; start < 3; start++)
			await expect(echo(core, {})).rejects.toMatchObject({ code: "core_unavailable" });
		await expect(echo(core, {})).rejects.toThrow(/not started again for 30 s/);
	});
});
