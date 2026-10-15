/**
 * Instruction files against the user's real omp (skipped without one): the
 * bridge lists what stock's context-file discovery finds for the session's
 * folder, grouped by stock's disable id, and a switch writes that id to
 * `disabledExtensions` (isolated agent dir) and comes back disabled.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcContextFilesResult } from "../shared/rpc-types";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const omp = path.join(os.homedir(), ".bun/bin/omp");

describe.skipIf(!existsSync(omp) || !existsSync(stockRoot))("instruction files bridge", () => {
	it("lists the folder's context files by stock id and turns one off through disabledExtensions", async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-context-files-"));
		const agent = path.join(profile, "agent");
		const project = path.join(profile, "project");
		await fs.mkdir(agent, { mode: 0o700 });
		await fs.mkdir(path.join(project, "pkg"), { recursive: true });
		// A model that is never called: rpc mode refuses to start without a default model.
		await fs.writeFile(
			path.join(agent, "models.yml"),
			"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: unused\n    models:\n      - id: idle\n",
		);
		await fs.writeFile(path.join(project, "AGENTS.md"), "# Root rules\n");
		await fs.writeFile(path.join(project, "CLAUDE.md"), "# Claude rules\n");
		await fs.mkdir(path.join(project, ".git"));
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

			const before = await client.request<RpcContextFilesResult>("get_context_files");
			const agentsRow = before.files.find(file => file.id === "context-file:project:AGENTS.md");
			expect(agentsRow).toMatchObject({ name: "AGENTS.md", level: "project", enabled: true });
			const listed = await Promise.all((agentsRow?.files ?? []).map(file => fs.realpath(file.path)));
			expect(listed).toContain(await fs.realpath(path.join(project, "AGENTS.md")));
			expect(before.files.some(file => file.id === "context-file:project:CLAUDE.md")).toBe(true);

			await expect(
				client.request("set_context_file_enabled", { contextFileId: "skill:nope", enabled: false }),
			).rejects.toThrow(/Invalid context file id/);
			const off = await client.request<{ id: string; enabled: boolean }>("set_context_file_enabled", {
				contextFileId: "context-file:project:AGENTS.md",
				enabled: false,
			});
			expect(off).toMatchObject({ id: "context-file:project:AGENTS.md", enabled: false });
			const after = await client.request<RpcContextFilesResult>("get_context_files");
			expect(after.files.find(file => file.id === "context-file:project:AGENTS.md")?.enabled).toBe(false);
			expect(after.files.find(file => file.id === "context-file:project:CLAUDE.md")?.enabled).toBe(true);
			expect(await fs.readFile(path.join(agent, "config.yml"), "utf8")).toContain("context-file:project:AGENTS.md");

			await client.request("set_context_file_enabled", {
				contextFileId: "context-file:project:AGENTS.md",
				enabled: true,
			});
			const restored = await client.request<RpcContextFilesResult>("get_context_files");
			expect(restored.files.find(file => file.id === "context-file:project:AGENTS.md")?.enabled).toBe(true);
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
