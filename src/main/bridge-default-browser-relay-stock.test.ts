/**
 * The default browser's relay binding on the installed omp: stock's own relay server (`startRelayServer`) opens a new
 * tab in whichever connected extension it picks, so a browser's agents must reach a relay only that browser's
 * extension dials. Two stock relay servers run on two ports (the way each browser's extension copy is bound to its own
 * port, src/main/agent-browsers.ts); a fake extension answers each one's hello and `createTab` as the real one does,
 * and a CDP `Target.createTarget` sent to one relay's endpoint must reach only that relay's extension.
 *
 * Stock needs Bun (`Bun.serve`), so the servers run in a `bun` child; this test is the extensions and the CDP client.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const bun = path.join(os.homedir(), ".bun/bin/bun");

const SERVERS = `
import { startRelayServer } from ${JSON.stringify(path.join(stockRoot, "src/tools/browser/relay/server"))};
function freePort() {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = server.port;
	server.stop(true);
	return port;
}
const a = startRelayServer({ port: freePort(), group: false });
const b = startRelayServer({ port: freePort(), group: false });
console.log(JSON.stringify({ a: a.port, b: b.port }));
process.stdin.resume();
process.stdin.on("close", () => {
	a.stop();
	b.stop();
	process.exit(0);
});
`;

const TAB = { url: "about:blank", title: "", active: true, discarded: false, windowId: 1, pinned: false, groupId: -1 };

interface FakeExtension {
	socket: WebSocket;
	/** The `createTab` requests this extension was asked to perform. */
	created: string[];
}

/** An extension as stock's protocol (relay/protocol.ts) has it: hello, then an answer to every rpc. */
async function connectExtension(port: number, label: string): Promise<FakeExtension> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	const created: string[] = [];
	socket.addEventListener("message", event => {
		const request: { t?: string; id: number; op?: string; url?: string } = JSON.parse(String(event.data));
		if (request.t !== "rpc") return;
		if (request.op === "createTab") created.push(request.url ?? "");
		const result = request.op === "createTab" ? { tab: { ...TAB, tabId: 100, url: request.url ?? "" } } : {};
		socket.send(JSON.stringify({ t: "rpcResult", id: request.id, ok: true, result }));
	});
	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve());
	socket.addEventListener("error", () => opened.reject(new Error(`extension ${label} socket failed`)));
	await opened.promise;
	socket.send(
		JSON.stringify({
			t: "hello",
			userAgent: "Mozilla/5.0 Chrome/138.0.0.0",
			browserVersion: "Chrome/138.0.0.0",
			tabs: [{ ...TAB, tabId: 1 }],
			attachedTabIds: [],
			discardedTabsProtocol: 1,
			instanceId: label,
			browserSession: `${label}-run`,
		}),
	);
	await expect
		.poll(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).status, { timeout: 5_000 })
		.toBe(200);
	return { socket, created };
}

/** One CDP command to a relay's endpoint, as the omp browser tool sends it. */
async function cdp(
	port: number,
	method: string,
	params: object,
): Promise<{ result?: object; error?: { message: string } }> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
	const answer = Promise.withResolvers<{ result?: object; error?: { message: string } }>();
	socket.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as { id?: number; result?: object; error?: { message: string } };
		if (message.id === 1) answer.resolve(message);
	});
	socket.addEventListener("error", () => answer.reject(new Error("cdp socket failed")));
	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve());
	await opened.promise;
	socket.send(JSON.stringify({ id: 1, method, params }));
	try {
		return await answer.promise;
	} finally {
		socket.close();
	}
}

describe.skipIf(!existsSync(bun) || !existsSync(stockRoot))("default browser relay binding on stock's relay", () => {
	it("opens a tab only in the extension bound to the relay endpoint it was sent to", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "default-browser-relay-"));
		const script = path.join(dir, "servers.mjs");
		await fs.writeFile(script, SERVERS);
		const child = spawn(bun, ["run", script], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
		const extensions: FakeExtension[] = [];
		let errors = "";
		child.stderr.on("data", chunk => {
			errors += String(chunk);
		});
		try {
			const started = Promise.withResolvers<{ a: number; b: number }>();
			child.once("exit", code => started.reject(new Error(`bun exited ${code}: ${errors}`)));
			let output = "";
			child.stdout.on("data", chunk => {
				output += String(chunk);
				const line = output.split("\n").find(candidate => candidate.startsWith("{"));
				if (line) started.resolve(JSON.parse(line) as { a: number; b: number });
			});
			const ports = await started.promise;
			expect(ports.a).not.toBe(ports.b);

			const chrome = await connectExtension(ports.a, "chrome");
			const edge = await connectExtension(ports.b, "edge");
			extensions.push(chrome, edge);

			const toChrome = await cdp(ports.a, "Target.createTarget", { url: "https://chrome.example/" });
			expect(toChrome.error).toBeUndefined();
			expect(chrome.created).toEqual(["https://chrome.example/"]);
			expect(edge.created).toEqual([]);

			const toEdge = await cdp(ports.b, "Target.createTarget", { url: "https://edge.example/" });
			expect(toEdge.error).toBeUndefined();
			expect(edge.created).toEqual(["https://edge.example/"]);
			expect(chrome.created).toEqual(["https://chrome.example/"]);

			// Chrome's extension goes away: its relay refuses; the tab does not fall to the browser still connected.
			chrome.socket.close();
			await expect
				.poll(async () => (await fetch(`http://127.0.0.1:${ports.a}/json/version`)).status, { timeout: 5_000 })
				.toBe(503);
			expect((await fetch(`http://127.0.0.1:${ports.b}/json/version`)).status).toBe(200);
			const refused = await cdp(ports.a, "Target.createTarget", { url: "https://chrome.example/again" });
			expect(refused.error?.message).toContain("relay extension is not connected");
			expect(edge.created).toEqual(["https://edge.example/"]);
		} finally {
			for (const extension of extensions) extension.socket.close();
			child.stdin.end();
			child.kill();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
