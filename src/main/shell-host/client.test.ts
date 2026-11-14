import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Answered, HostError, ShellClient } from "./client";
import { duplexPair } from "./duplex-pair";
import { encodeFrame, FrameReader } from "./wire";

describe("frames", () => {
	it("writes a head line and its bin tail, counting the bytes in the head", () => {
		const frame = encodeFrame({ event: "e", data: { a: 1 } }, Buffer.from([1, 2, 3]));
		expect(frame.subarray(0, frame.indexOf(10) + 1).toString()).toBe('{"event":"e","data":{"a":1},"bin":3}\n');
		expect([...frame.subarray(frame.indexOf(10) + 1)]).toEqual([1, 2, 3]);
	});

	it("reads frames split at every byte, a bin tail holding newlines and braces", () => {
		const payload = Buffer.from('{"id":9}\n\r\n{', "utf8");
		const wire = Buffer.concat([
			encodeFrame({ id: 1, method: "a", params: { x: 1 } }),
			encodeFrame({ id: 2, ok: true, result: null }, payload),
			encodeFrame({ event: "e", data: 1 }, Buffer.alloc(0)),
		]);
		const reader = new FrameReader();
		const frames = [];
		for (const byte of wire) frames.push(...reader.push(Buffer.from([byte])));
		expect(frames.map(frame => frame.head)).toEqual([
			{ id: 1, method: "a", params: { x: 1 } },
			{ id: 2, ok: true, result: null },
			{ event: "e", data: 1 },
		]);
		expect(frames[1].bin?.equals(payload)).toBe(true);
		expect(frames[2].bin?.length).toBe(0);
		expect(reader.buffered).toBe(0);
	});

	it("skips a malformed line and a bin that is not a length, and goes on", () => {
		const skipped: string[] = [];
		const reader = new FrameReader(reason => skipped.push(reason));
		const frames = reader.push(Buffer.from('not json\n[1]\n{"bin":-1}\n{"bin":"x"}\r\n{"event":"ok","data":{}}\r\n'));
		expect(frames.map(frame => frame.head)).toEqual([{ event: "ok", data: {} }]);
		expect(skipped).toHaveLength(4);
	});
});

describe("ShellClient", () => {
	const open: ShellClient[] = [];
	afterEach(() => {
		for (const client of open.splice(0)) client.close();
	});
	const pair = (): [ShellClient, ShellClient] => {
		const [a, b] = duplexPair();
		const clients: [ShellClient, ShellClient] = [new ShellClient(a), new ShellClient(b)];
		open.push(...clients);
		return clients;
	};

	it("answers requests both ways, with bin on the request and on the answer", async () => {
		const [node, shell] = pair();
		shell.handle(
			"echo",
			(params: { n: number }, { bin }) =>
				new Answered({ n: params.n + 1, got: bin?.toString("utf8") ?? null }, Buffer.from("back")),
		);
		node.handle("ask", (params: { q: string }) => ({ a: params.q.toUpperCase() }));
		const answer = await node.request<{ n: number; got: string }>("echo", { n: 1 }, { bin: Buffer.from("hello") });
		expect(answer.result).toEqual({ n: 2, got: "hello" });
		expect(answer.bin?.toString()).toBe("back");
		expect(await shell.call("ask", { q: "x" })).toEqual({ a: "X" });
	});

	it("turns an error answer into a HostError and an unknown method into `unsupported`", async () => {
		const [node, shell] = pair();
		shell.handle("boom", () => {
			throw new HostError("denied", "no");
		});
		await expect(node.call("boom")).rejects.toMatchObject({ name: "HostError", code: "denied", message: "no" });
		await expect(node.call("nothing")).rejects.toMatchObject({ code: "unsupported" });
	});

	it("delivers events with their bin in order", async () => {
		const [node, shell] = pair();
		const seen: Array<[unknown, string | undefined]> = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		node.on("chunk", (data: { n: number }, bin) => {
			seen.push([data.n, bin?.toString()]);
			if (seen.length === 3) resolve();
		});
		await shell.event("chunk", { n: 1 }, Buffer.from("a"));
		await shell.event("chunk", { n: 2 });
		await shell.event("chunk", { n: 3 }, Buffer.from("c"));
		await promise;
		expect(seen).toEqual([
			[1, "a"],
			[2, undefined],
			[3, "c"],
		]);
	});

	it("keeps ids per direction: both sides may use id 1 at once", async () => {
		const [node, shell] = pair();
		node.handle("a", () => "from node");
		shell.handle("b", () => "from shell");
		expect(await Promise.all([node.call("b"), shell.call("a")])).toEqual(["from shell", "from node"]);
	});

	it("sends {cancel} when a request is aborted, and aborts the handler the other side runs", async () => {
		const [node, shell] = pair();
		const { promise: started, resolve: running } = Promise.withResolvers<AbortSignal>();
		shell.handle("slow", (_params, { signal }) => {
			running(signal);
			return new Promise(() => undefined);
		});
		const controller = new AbortController();
		const request = node.call("slow", {}, { signal: controller.signal });
		const signal = await started;
		expect(signal.aborted).toBe(false);
		const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		controller.abort();
		await expect(request).rejects.toMatchObject({ code: "cancelled" });
		await aborted;
		expect(signal.aborted).toBe(true);
	});

	it("rejects requests still waiting when the connection drops, and refuses new ones", async () => {
		const [node, shell] = pair();
		const asked = Promise.withResolvers<void>();
		shell.handle("never", () => {
			asked.resolve();
			return new Promise(() => undefined);
		});
		const ended = Promise.withResolvers<Error | undefined>();
		node.onClose(reason => ended.resolve(reason));
		const waiting = node.call("never");
		await asked.promise;
		shell.close();
		await expect(waiting).rejects.toMatchObject({ code: "gone" });
		await ended.promise;
		expect(node.closed).toBe(true);
		await expect(node.call("later")).rejects.toMatchObject({ code: "gone" });
		let late = false;
		node.onClose(() => {
			late = true;
		});
		expect(late).toBe(true);
	});
});

describe("ShellClient over a real socket", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("connects to a pipe or unix socket and talks both ways", async () => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-shell-host-"));
		const path =
			process.platform === "win32"
				? `\\\\.\\pipe\\ompdesk-test-${process.pid}-${Date.now()}`
				: join(dir, "shell.sock");
		const ready = Promise.withResolvers<ShellClient>();
		const server = createServer(socket => ready.resolve(new ShellClient(socket)));
		await new Promise<void>(resolve => server.listen(path, resolve));
		try {
			const node = await ShellClient.connect(path);
			const shell = await ready.promise;
			shell.handle("hello", (params: { token: string }) => ({ ok: params.token === "t" }));
			expect(await node.call("hello", { token: "t" })).toEqual({ ok: true });
			// A big bin tail crosses several socket reads.
			const big = Buffer.alloc(3 * 1024 * 1024, 7);
			shell.handle("size", (_params, { bin }) => ({
				size: bin?.length ?? -1,
				sum: bin?.reduce((a, b) => (a + b) % 251, 0),
			}));
			expect(await node.call("size", {}, { bin: big })).toEqual({ size: big.length, sum: (7 * big.length) % 251 });
			shell.close();
			await new Promise<void>(resolve => node.onClose(() => resolve()));
			expect(node.closed).toBe(true);
		} finally {
			server.close();
		}
	});
});
