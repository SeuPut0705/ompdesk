import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { LocalCommandError } from "./local/types";

let server: net.Server | null = null;
let address = "";

afterEach(async () => {
	await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
	server = null;
	if (address) removeBridgeAddress(address);
	vi.restoreAllMocks();
});

/** A stand-in for resources/gui-bridge: answers `echo`, fails `boom` (coded for `old`), pushes one event per connection. */
async function startFakeBridge(): Promise<string> {
	address = newBridgeAddress();
	server = net.createServer(socket => {
		socket.write(`${JSON.stringify({ event: { type: "btw_delta", text: "hi" } })}\n`);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string; params: unknown };
				buffer = buffer.slice(newline + 1);
				if (request.method === "silent") {
					// Never answered: a frozen omp.
				} else if (request.method === "split") {
					// One reply cut across three writes, then two replies in one write.
					const big = `${JSON.stringify({ id: request.id, ok: true, result: "x".repeat(200_000) })}\n`;
					socket.write(big.slice(0, 7));
					socket.write(big.slice(7, 150_000));
					socket.write(
						`${big.slice(150_000)}${JSON.stringify({ event: { type: "btw_delta", text: "a" } })}\n${JSON.stringify({ event: { type: "btw_delta", text: "b" } })}\n`,
					);
				} else {
					const reply =
						request.method === "echo"
							? { id: request.id, ok: true, result: request.params }
							: request.method === "timed"
								? { id: request.id, ok: true, result: 1, timing: { receivedAt: 5, loadMs: 40, ms: 7 } }
								: request.method === "old"
									? { id: request.id, ok: false, error: "Plan mode is unavailable", code: "unsupported_omp" }
									: { id: request.id, ok: false, error: `bad ${request.method}` };
					socket.write(`${JSON.stringify(reply)}\n`);
				}
				newline = buffer.indexOf("\n");
			}
		});
	});
	await new Promise<void>(resolve => server?.listen(address, resolve));
	return address;
}

/** Keep the real Socket/readline emitters, but let each test control connect/error ordering. */
function pauseSocketConnection(): () => net.Socket {
	let socket: net.Socket | undefined;
	vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) {
		socket = this;
		return this;
	});
	return () => {
		if (!socket) throw new Error("Bridge did not create its connecting socket");
		return socket;
	};
}

describe("GuiBridgeClient", () => {
	it("rejects a request the bridge never answers once its timeout passes, and keeps serving the others", async () => {
		const client = new GuiBridgeClient(await startFakeBridge());
		await client.connect();
		const silent = client.request("silent", undefined, undefined, { timeoutMs: 40 });
		await expect(silent).rejects.toMatchObject({ code: "bridge_timeout" });
		await expect(client.request("echo", 7)).resolves.toBe(7);
		client.close();
	});

	it("hands a request's timing out when it is sent and, with the bridge's part, when it settles", async () => {
		const client = new GuiBridgeClient(await startFakeBridge());
		await client.connect();
		const seen: unknown[] = [];
		await client.request("timed", undefined, timing => seen.push({ ...timing }));
		expect(seen).toHaveLength(2);
		expect(seen[0]).toEqual({ connectWaitMs: expect.any(Number), sentAt: expect.any(Number) });
		expect(seen[1]).toMatchObject({ receivedAt: 5, loadMs: 40, bridgeMs: 7, answeredAt: expect.any(Number) });
		// An older bridge sends no timing: the settled call still reports what main measured.
		await client.request("echo", 1, timing => seen.push({ ...timing }));
		expect(seen[3]).toEqual({
			connectWaitMs: expect.any(Number),
			sentAt: expect.any(Number),
			answeredAt: expect.any(Number),
		});
		client.close();
	});

	it("correlates requests, surfaces bridge errors, and delivers pushed events", async () => {
		const client = new GuiBridgeClient(await startFakeBridge());
		const events: unknown[] = [];
		client.onEvent(event => events.push(event));
		await client.connect();
		expect(client.connected).toBe(true);

		await expect(client.request("echo", { n: 1 })).resolves.toEqual({ n: 1 });
		await expect(client.request("boom")).rejects.toThrow("bad boom");
		await expect(client.request("boom")).rejects.not.toBeInstanceOf(LocalCommandError);
		await expect(client.request("old")).rejects.toMatchObject({
			name: "LocalCommandError",
			code: "unsupported_omp",
			message: "Plan mode is unavailable",
		});
		expect(events).toEqual([{ type: "btw_delta", text: "hi" }]);

		client.close();
		expect(client.connected).toBe(false);
		await expect(client.request("echo")).rejects.toMatchObject({
			code: "bridge_unavailable",
			message: "GUI bridge is not connected",
		});
	});

	it("reassembles a reply split across writes and frames sharing one write", async () => {
		const client = new GuiBridgeClient(await startFakeBridge());
		const events: unknown[] = [];
		client.onEvent(event => events.push(event));
		await client.connect();
		await expect(client.request("split")).resolves.toHaveLength(200_000);
		await expect(client.request("echo", 1)).resolves.toBe(1);
		expect(events).toEqual([
			{ type: "btw_delta", text: "hi" },
			{ type: "btw_delta", text: "a" },
			{ type: "btw_delta", text: "b" },
		]);
		client.close();
	});

	it("rejects requests when no bridge ever listened", async () => {
		const client = new GuiBridgeClient(newBridgeAddress());
		await expect(client.connect(500)).rejects.toThrow();
		await expect(client.request("capabilities")).rejects.toMatchObject({ code: "bridge_unavailable" });
	});

	it("propagates input errors from both the socket and readline to the caller", async () => {
		const connectingSocket = pauseSocketConnection();
		const client = new GuiBridgeClient(newBridgeAddress());
		const connecting = client.connect();
		const socket = connectingSocket();
		const failed = expect(connecting).rejects.toThrow("missing bridge socket");
		socket.emit("error", new Error("missing bridge socket"));
		await failed;
		expect(socket.destroyed).toBe(true);
		expect(client.connected).toBe(false);
		client.close();
	});

	it("cancels and destroys an in-flight socket when closed before connecting", async () => {
		const connectingSocket = pauseSocketConnection();
		const client = new GuiBridgeClient(newBridgeAddress());
		const failed = expect(client.connect()).rejects.toThrow("GUI bridge is closed");
		const socket = connectingSocket();
		client.close();
		await failed;
		expect(socket.destroyed).toBe(true);
		expect(client.connected).toBe(false);
		await expect(client.connect()).rejects.toThrow("GUI bridge is closed");
	});

	it("rejects outstanding requests when an established socket fails", async () => {
		const connectingSocket = pauseSocketConnection();
		const client = new GuiBridgeClient(newBridgeAddress());
		const connecting = client.connect();
		const socket = connectingSocket();
		vi.spyOn(socket, "write").mockReturnValue(true);
		socket.emit("connect");
		await connecting;
		const failed = expect(client.request("capabilities")).rejects.toMatchObject({
			code: "bridge_unavailable",
			message: "bridge transport failed",
		});
		socket.emit("error", new Error("bridge transport failed"));
		await failed;
		expect(client.connected).toBe(false);
		client.close();
	});
});
