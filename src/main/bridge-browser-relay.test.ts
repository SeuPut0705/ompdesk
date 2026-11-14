/**
 * Agent browsing against the installed omp: the gui-bridge starts stock's own
 * browser relay inside the session and holds `browser.relay`/`browser.relayUrl`
 * as runtime overrides. The preview's relay extension (the shell's preview
 * module) completes stock's extension handshake against it; that half is
 * covered against the real shell by e2e/preview-agent.e2e.ts.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { relayExtensionUrl } from "./shell-host/modules/preview";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");

describe.skipIf(!existsSync(omp) || !existsSync(stockRoot))("stock browser relay bridge", () => {
	it("serves stock's relay for the session, refuses a wrong token and clears it on stop", async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-relay-"));
		const agent = path.join(profile, "agent");
		await fs.mkdir(agent, { mode: 0o700 });
		// A model that is never called: rpc mode refuses to start without a default model, and a CI runner has none.
		await fs.writeFile(
			path.join(agent, "models.yml"),
			"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: unused\n    models:\n      - id: idle\n",
		);
		const address = newBridgeAddress();
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: configDirName(profile),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_BRIDGE: address,
		};
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--model",
				"fixture/idle",
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

			await client.request("browser.relay_stop");
			await expect(fetch(`${relay.url}/json/version`)).rejects.toThrow();
			expect(JSON.stringify(await client.request("settings_get", { paths: ["browser.relayUrl"] }))).not.toContain(
				relay.url,
			);
		} finally {
			client.close();
			child.stdin.end();
			child.kill();
			if (child.exitCode === null && child.signalCode === null) {
				const exited = Promise.withResolvers<void>();
				child.once("exit", () => exited.resolve());
				await exited.promise;
			}
			removeBridgeAddress(address);
			await removeWhenFree(profile);
		}
	}, 60_000);
});
