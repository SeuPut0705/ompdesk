import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { LocalCommandError } from "./local/types";

let server: net.Server | null = null;
let address = "";

afterEach(async () => {
	await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
	server = null;
	if (address) removeBridgeAddress(address);
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
				if (request.method === "split") {
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

describe("GuiBridgeClient", () => {
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
		await expect(client.request("ping")).rejects.toMatchObject({ code: "bridge_unavailable" });
	});
});
