/**
 * Memory panel bridge methods against the user's real omp (skipped without
 * one), on stock's local backend in an isolated agent dir: the report names
 * the hooks the backend implements, save writes through stock `save`, the
 * hooks it lacks are refused instead of faked, and clear wipes what save wrote.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcMemoryReport, RpcMemorySaveResult } from "../shared/rpc-types";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const omp = path.join(os.homedir(), ".bun/bin/omp");

/** Every file under `dir` (none when it does not exist). */
async function listFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
	return entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
}

describe.skipIf(!existsSync(omp) || !existsSync(stockRoot))("memory bridge", () => {
	it("reports the local backend's hooks, saves and clears through stock, and refuses search and queue", async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-"));
		const agent = path.join(profile, "agent");
		const project = path.join(profile, "project");
		await fs.mkdir(agent, { mode: 0o700 });
		await fs.mkdir(project, { recursive: true });
		// A model that is never called: rpc mode refuses to start without a default model.
		await fs.writeFile(
			path.join(agent, "models.yml"),
			"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: unused\n    models:\n      - id: idle\n",
		);
		await fs.writeFile(path.join(agent, "config.yml"), "memory:\n  backend: local\n");
		const address = newBridgeAddress();
		const env = {
			...process.env,
			HOME: profile,
			USERPROFILE: profile,
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
				"--model",
				"fixture/idle",
				"-e",
				path.resolve("resources/gui-bridge/index.ts"),
			],
			{ cwd: project, env, stdio: "pipe" },
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

			const report = await client.request<RpcMemoryReport>("get_memory_report");
			expect(report.backend).toBe("local");
			expect(report.capabilities).toEqual({ search: false, save: true, queue: false });
			expect(report.status).toMatchObject({ active: true, writable: true, searchable: false });

			const saved = await client.request<RpcMemorySaveResult>("memory_save", {
				content: "The user prefers tabs.",
				context: "panel test",
			});
			expect(saved).toMatchObject({ backend: "local", stored: 1 });
			const memoryFiles = async () =>
				(await Promise.all((await listFiles(agent)).map(file => fs.readFile(file, "utf8").catch(() => "")))).filter(
					text => text.includes("The user prefers tabs."),
				);
			expect(await memoryFiles()).toHaveLength(1);

			await expect(client.request("memory_search", { query: "tabs" })).rejects.toThrow(
				/not available for the local backend/,
			);
			await expect(client.request("memory_search", { query: "tabs", limit: 0 })).rejects.toThrow(/limit/);
			await expect(client.request("memory_queue")).rejects.toThrow(/not available for the local backend/);
			expect(await client.request("memory_enqueue")).toEqual({ ok: true });

			expect(await client.request("memory_clear")).toEqual({ ok: true });
			expect(await memoryFiles()).toHaveLength(0);
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
			await fs.rm(profile, { recursive: true, force: true });
		}
	}, 60_000);
});
