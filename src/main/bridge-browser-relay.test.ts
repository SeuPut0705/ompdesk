/**
 * Agent browsing against the installed omp: the gui-bridge starts stock's own
 * browser relay inside the session, holds `browser.relay`/`browser.relayUrl`
 * as runtime overrides, and the preview's relay extension (main/preview/
 * agent-relay.ts) completes stock's extension handshake so the relay offers
 * the preview page as its one CDP target.
 */
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { PreviewRelayExtension, type RelayDebugger, relayExtensionUrl } from "./preview/agent-relay";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const omp = path.join(os.homedir(), ".bun/bin/omp");

class IdleDebugger extends EventEmitter {
	attach(): void {}
	detach(): void {}
	isAttached(): boolean {
		return false;
	}
	async sendCommand(): Promise<unknown> {
		return {};
	}
}

describe.skipIf(!existsSync(omp) || !existsSync(stockRoot))("stock browser relay bridge", () => {
	it("serves stock's relay for the session and lists the preview once its extension says hello", async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-relay-"));
		const agent = path.join(profile, "agent");
		await fs.mkdir(agent, { mode: 0o700 });
		const realAgent = path.join(os.homedir(), ".omp/agent");
		await fs.copyFile(path.join(realAgent, "config.yml"), path.join(agent, "config.yml")).catch(() => {});
		if (existsSync(path.join(realAgent, "agent.db")))
			execFileSync("sqlite3", [
				path.join(realAgent, "agent.db"),
				`VACUUM INTO '${path.join(agent, "agent.db").replaceAll("'", "''")}'`,
			]);
		const address = newBridgeAddress();
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: profile,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_BRIDGE: address,
		};
		const child = spawn(
			omp,
			[
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				path.resolve("resources/gui-bridge/index.ts"),
			],
			{ cwd: profile, env, stdio: "pipe" },
		);
		const client = new GuiBridgeClient(address);
		let errors = "";
		child.stderr.on("data", chunk => {
			errors += String(chunk);
		});
		let socket: WebSocket | null = null;
		try {
			const ready = Promise.withResolvers<void>();
			// Real child readiness is event-driven; this deadline only diagnoses a stuck external omp.
			const timer = setTimeout(() => ready.reject(new Error(`omp did not become ready: ${errors}`)), 40_000);
			child.once("error", ready.reject);
			child.once("exit", code => ready.reject(new Error(`omp exited ${code}: ${errors}`)));
			let output = "";
			child.stdout.on("data", chunk => {
				output += String(chunk);
				if (/"type"\s*:\s*"ready"/.test(output)) ready.resolve();
			});
			await ready.promise.finally(() => clearTimeout(timer));
			await client.connect();

			const relay = await client.request<{ url: string; token: string }>("browser.relay_start");
			expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			// A second start reuses the running relay.
			expect(await client.request("browser.relay_start")).toEqual(relay);
			const held = JSON.stringify(
				await client.request("settings_get", { paths: ["browser.relay", "browser.relayUrl"] }),
			);
			expect(held).toContain(relay.url);

			const before = await fetch(`${relay.url}/json/version`);
			expect(before.status).toBe(503);
			expect(await before.json()).toMatchObject({ error: "relay extension is not connected" });
			const target = relayExtensionUrl(relay.url, relay.token);
			if (!target) throw new Error("relay endpoint refused");
			const refused = await fetch(target.replace("ws://", "http://").replace(relay.token, "wrong"));
			expect(refused.status).toBe(401);

			const extension = new PreviewRelayExtension(
				{
					id: 41,
					url: () => "https://example.com/",
					title: () => "Example Domain",
					userAgent: () => "Mozilla/5.0 Chrome/138.0.0.0 Electron/36.9.5",
					// Only the listener and attach surface is exercised before puppeteer connects.
					debugger: new IdleDebugger() as unknown as RelayDebugger,
					ensureRenderer: async () => {},
				},
				message => socket?.send(JSON.stringify(message)),
				() => {},
			);
			const opened = Promise.withResolvers<void>();
			socket = new WebSocket(target);
			socket.addEventListener("open", () => opened.resolve());
			socket.addEventListener("error", () => opened.reject(new Error("extension socket failed")));
			socket.addEventListener("message", message => extension.handle(String(message.data)));
			await opened.promise;
			socket.send(JSON.stringify(extension.hello("ompdesk-preview-test")));
			await expect.poll(async () => (await fetch(`${relay.url}/json/version`)).status, { timeout: 5_000 }).toBe(200);
			expect(await (await fetch(`${relay.url}/json/list`)).json()).toEqual([
				expect.objectContaining({ type: "page", title: "Example Domain", url: "https://example.com/" }),
			]);

			await client.request("browser.relay_stop");
			await expect(fetch(`${relay.url}/json/version`)).rejects.toThrow();
			expect(JSON.stringify(await client.request("settings_get", { paths: ["browser.relayUrl"] }))).not.toContain(
				relay.url,
			);
		} finally {
			socket?.close();
			client.close();
			child.stdin.end();
			child.kill();
			if (child.exitCode === null && child.signalCode === null) {
				const exited = Promise.withResolvers<void>();
				child.once("exit", () => exited.resolve());
				await exited.promise;
			}
			removeBridgeAddress(address);
			await fs.rm(profile, { recursive: true, force: true });
		}
	}, 60_000);
});
