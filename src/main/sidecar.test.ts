import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Store from "electron-store";
import { describe, expect, it, vi } from "vitest";
import type {
	CommandOutputFrame,
	PromptResultFrame,
	SessionSettledFrame,
	SidecarStatus,
	SidecarStatusPayload,
} from "../shared/rpc-types";
import type { OmpResolution } from "./omp-runtime";
import { type SidecarFailureReport, SidecarManager } from "./sidecar";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";

/** A resolved "system omp" that is really the test's fake sidecar script. */
function ompAt(bin: string): () => Promise<OmpResolution> {
	return async () => ({
		ok: true,
		runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
	});
}

async function waitForReady(sidecar: SidecarManager): Promise<void> {
	const ready = Promise.withResolvers<void>();
	const onStatus = ({ status }: { status: SidecarStatus }) => {
		if (status === "ready") ready.resolve();
	};
	sidecar.on("status", onStatus);
	try {
		await ready.promise;
	} finally {
		sidecar.off("status", onStatus);
	}
}

describe("SidecarManager", () => {
	it("passes the active session path on a manual restart", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-"));
		const logPath = path.join(tempDir, "argv.json");
		const sessionPath = path.join(tempDir, "session.jsonl");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
		try {
			const firstReady = waitForReady(sidecar);
			sidecar.start();
			await firstReady;

			const restarted = waitForReady(sidecar);
			sidecar.restart(undefined, sessionPath);
			await restarted;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--session", sessionPath]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("configures v2 sidecars with the GUI event filter", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-filter-"));
		const commandLog = path.join(tempDir, "commands.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs";\nimport { createInterface } from "node:readline";\nconst commands: unknown[] = [];\nconst rl = createInterface({ input: process.stdin });\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");\nrl.on("line", line => {\n\tconst command = JSON.parse(line) as { id?: string; type: string; events?: string[] | null };\n\tcommands.push(command);\n\tfs.writeFileSync(${JSON.stringify(commandLog)}, JSON.stringify(commands));\n\tprocess.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: {} }) + "\\n");\n});\n`,
		);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			await expect
				.poll(
					async () => {
						try {
							return JSON.parse(await fs.readFile(commandLog, "utf8")) as Array<{
								type: string;
								events?: string[] | null;
							}>;
						} catch {
							return [];
						}
					},
					{ timeout: 5_000, interval: 25 },
				)
				.toHaveLength(3);

			const commands = JSON.parse(await fs.readFile(commandLog, "utf8")) as Array<{
				type: string;
				events?: string[] | null;
			}>;
			expect(commands.map(command => command.type)).toEqual([
				"negotiate_protocol",
				"set_event_filter",
				"set_ask_dialog",
			]);
			expect(commands[1]?.events).toContain("message_update");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("spawns a chat sidecar with stock --no-tools in the code-controlled argv", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-chat-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, kind: "chat" });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--no-tools"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("pins autoResume off for a freshly created tab, and only for its first boot", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-fresh-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, fresh: true, bridgeDir: tempDir });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const bridgeEntry = path.join(tempDir, "index.ts");
			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual([
				"--mode",
				"rpc-ui",
				"--config",
				path.join(tempDir, "fresh-launch.yml"),
				"-e",
				bridgeEntry,
			]);

			const restarted = waitForReady(sidecar);
			sidecar.restart();
			await restarted;
			const restartLaunch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(restartLaunch).toEqual(["--mode", "rpc-ui", "-e", bridgeEntry]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("routes prompt results, settled state, and text-mode command output as dedicated frames", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-output-"));
		const binaryPath = await writeFakeOmp(
			tempDir,
			`process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "prompt_result", id: "local-command", agentInvoked: false }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "session_settled" }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "command_output", text: "Enabled models" }) + "\\n");\nprocess.stdin.resume();\n`,
		);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
		const received = Promise.withResolvers<CommandOutputFrame>();
		sidecar.once("commandOutput", frame => received.resolve(frame as CommandOutputFrame));
		const promptResult = Promise.withResolvers<PromptResultFrame>();
		sidecar.once("promptResult", frame => promptResult.resolve(frame as PromptResultFrame));
		const settled = Promise.withResolvers<SessionSettledFrame>();
		sidecar.once("sessionSettled", frame => settled.resolve(frame as SessionSettledFrame));
		try {
			sidecar.start();
			expect(await Promise.all([promptResult.promise, settled.promise, received.promise])).toEqual([
				{ type: "prompt_result", id: "local-command", agentInvoked: false },
				{ type: "session_settled" },
				{ type: "command_output", text: "Enabled models" },
			]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("answers GUI-side commands in-process and stamps agent_end entry ids without reordering frames", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-local-"));
		const commandLog = path.join(tempDir, "commands.json");
		const script = [
			'import * as fs from "node:fs";',
			'import { createInterface } from "node:readline";',
			"const out = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\\n');",
			"const seen: string[] = [];",
			'const userMessage = { role: "user", content: "hi", timestamp: 10 };',
			'const entries = [{ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: userMessage }];',
			'out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });',
			"createInterface({ input: process.stdin }).on('line', line => {",
			"\tconst command = JSON.parse(line);",
			"\tseen.push(command.type);",
			`\tfs.writeFileSync(${JSON.stringify(commandLog)}, JSON.stringify(seen));`,
			'\tif (command.type === "get_entries") return out({ type: "response", id: command.id, command: "get_entries", success: true, data: { entries, leafId: "e1" } });',
			'\tif (command.type === "get_state") return out({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "s1" } });',
			'\tout({ type: "response", id: command.id, command: command.type, success: true });',
			'\tif (command.type === "prompt") {',
			'\t\tout({ type: "agent_end", messages: [userMessage] });',
			'\t\tout({ type: "prompt_result", id: command.id, agentInvoked: true });',
			"\t}",
			"});",
		].join("\n");
		const binaryPath = await writeFakeOmp(tempDir, script);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
		const frames: Array<{ type: string; messages?: Array<{ entryId?: string }> }> = [];
		sidecar.on("frame", frame => frames.push(frame));
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			const client = sidecar.rpcClient;
			if (!client) throw new Error("no rpc client");

			const transcript = await client.command({ type: "get_transcript" });
			expect(transcript).toMatchObject({
				type: "response",
				command: "get_transcript",
				success: true,
				data: { messages: [{ role: "user", entryId: "e1" }] },
			});

			await client.command({ type: "prompt", message: "hi" });
			await expect.poll(() => frames.map(frame => frame.type)).toEqual(["agent_end", "prompt_result"]);
			expect(frames[0]?.messages?.[0]?.entryId).toBe("e1");
			// get_transcript never reached omp; its projection did (get_state, then get_entries).
			const commands = JSON.parse(await fs.readFile(commandLog, "utf8")) as string[];
			expect(commands).not.toContain("get_transcript");
			expect(commands).toEqual(["get_state", "get_entries", "prompt", "get_entries"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("appends the workspace launch profile flags at spawn, denylist-proof", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-profile-"));
		const fakeHome = path.join(tempDir, "home");
		const workspaceCwd = path.join(tempDir, "workspace");
		await fs.mkdir(fakeHome, { recursive: true });
		await fs.mkdir(workspaceCwd, { recursive: true });
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);

		// electron-store/conf resolves its prefs path from os.homedir() per
		// construction (%APPDATA% on Windows), so a redirected HOME lands the
		// store inside tempDir. Discover the exact path through the same stack
		// rather than hardcoding conf internals, then seed the workspace profile.
		const originalHome = process.env.HOME;
		const originalAppData = process.env.APPDATA;
		process.env.HOME = fakeHome;
		if (process.platform === "win32") process.env.APPDATA = fakeHome;
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: workspaceCwd });
		try {
			// Same options as the loader; a variable sidesteps the excess-property
			// check on electron-store's Options type (projectName reaches conf).
			const storeOptions = { name: "prefs", projectName: "omp-gui" };
			const probe = new Store(storeOptions);
			await fs.mkdir(path.dirname(probe.path), { recursive: true });
			await fs.writeFile(
				probe.path,
				JSON.stringify({
					launchProfiles: {
						[workspaceCwd]: {
							appendSystemPrompt: "GUI injected",
							noRules: true,
							addDirs: ["/data/extra"],
							tools: ["read", "bash"],
							// Smuggled keys that could reach code-controlled flags —
							// parseLaunchProfile drops them before the mapping.
							"--session": "hijack",
							session: "hijack",
						},
					},
				}),
			);

			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual([
				"--mode",
				"rpc-ui",
				"--append-system-prompt",
				"GUI injected",
				"--no-rules",
				"--add-dir",
				"/data/extra",
				"--tools",
				"read,bash",
			]);
		} finally {
			process.env.HOME = originalHome;
			if (process.platform === "win32") process.env.APPDATA = originalAppData;
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("adoptCwd re-roots the reported cwd and plain restarts spawn there", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-adopt-"));
		// realpath: the spawned process's process.cwd() resolves /var symlinks.
		const adoptedCwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-adopted-")));
		const logPath = path.join(tempDir, "spawn.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
		try {
			// Same-cwd adoption is a no-op; a new cwd moves the reported cwd.
			expect(sidecar.adoptCwd(tempDir)).toBe(false);
			expect(sidecar.adoptCwd(adoptedCwd)).toBe(true);
			expect(sidecar.cwd).toBe(adoptedCwd);

			// A plain restart (crash recovery, manual session resume) respawns in
			// the ADOPTED cwd — the session's workspace, not the stale spawn cwd.
			const ready = waitForReady(sidecar);
			sidecar.restart();
			await ready;

			const spawn = JSON.parse(await fs.readFile(logPath, "utf8")) as { cwd: string };
			expect(spawn.cwd).toBe(adoptedCwd);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
			await fs.rm(adoptedCwd, RM_TEMP);
		}
	});

	it("keeps a boot-crashing sidecar in the restart loop instead of a false ready", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-boot-crash-"));
		// Advertises protocol v2 and never answers `negotiate_protocol`, then dies:
		// teardown rejects the pending negotiation on a generation that is already
		// gone, which is what used to report "ready" and zero the restart counter.
		const binaryPath = await writeFakeOmp(
			tempDir,
			`process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");\nsetTimeout(() => process.exit(3), 120);\n`,
		);

		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			await expect
				.poll(() => statuses.some(payload => payload.status === "restarting"), { timeout: 9_000, interval: 50 })
				.toBe(true);
			// The rejected negotiation settles as a microtask after the status push.
			await delay(20);

			expect(statuses.at(-1)).toMatchObject({
				status: "restarting",
				restart: { attempt: 1, maxAttempts: 3 },
			});
			expect(statuses.filter(payload => payload.status === "ready")).toEqual([]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 15_000);

	it("drops a spawn whose env resolution was superseded by a restart", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-superseded-"));
		const pidPath = path.join(tempDir, "pids.txt");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.appendFile(${JSON.stringify(pidPath)}, String(process.pid) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);

		const sidecar = new SidecarManager({
			omp: ompAt(binaryPath),
			cwd: tempDir,
			proxyEnv: async () => {
				await delay(200);
				return {};
			},
		});
		const readPids = async (): Promise<string[]> => {
			try {
				return (await fs.readFile(pidPath, "utf8")).trim().split("\n").filter(Boolean);
			} catch {
				return [];
			}
		};
		try {
			sidecar.start();
			// Inside the first env window: restart() has no child to kill yet, so
			// without the guard both pending resolutions would spawn.
			await delay(50);
			sidecar.restart();
			await expect.poll(readPids, { timeout: 9_000, interval: 50 }).toHaveLength(1);
			// Both resolutions are 50ms apart, so a superseded spawn that was going
			// to happen has long since written its pid by now.
			await delay(1_000);
			expect(await readPids()).toHaveLength(1);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 15_000);

	it("surfaces the omp resolution error (missing or too old) instead of spawning", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-noomp-"));
		const statuses: SidecarStatusPayload[] = [];
		const error = "omp 18.0.0 is too old; this GUI needs omp 18.6.0 or newer. Run `omp update`, then relaunch.";
		const sidecar = new SidecarManager({ omp: async () => ({ ok: false, error }), cwd: tempDir });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			await expect.poll(() => statuses.at(-1)?.status).toBe("error");
			expect(statuses.map(payload => payload.status)).toEqual(["starting", "error"]);
			expect(statuses.at(-1)?.message).toBe(error);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("resumes on the default model when the saved session model cannot be restored at boot", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-model-"));
		const logPath = path.join(tempDir, "argv.json");
		const sessionPath = path.join(tempDir, "session.jsonl");
		const binaryPath = await writeFakeOmp(
			tempDir,
			[
				'import * as fs from "node:fs/promises";',
				"const argv = process.argv.slice(2);",
				'if (!argv.includes("--model")) {',
				'\tprocess.stderr.write("error: Could not restore model gone/model-x\\n      at createAgentSession (omp)\\n");',
				"\tprocess.exit(1);",
				"}",
				`await fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(argv));`,
				'process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");',
				"process.stdin.resume();",
			].join("\n"),
		);

		const reportFailure = vi.fn();
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, reportFailure });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			const firstReady = waitForReady(sidecar);
			sidecar.start();
			await firstReady;

			const restarted = waitForReady(sidecar);
			sidecar.restart(undefined, sessionPath);
			await restarted;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--session", sessionPath, "--model", "@default"]);
			const ready = statuses.filter(payload => payload.status === "ready");
			expect(ready.at(-1)?.modelFallback).toBe("gone/model-x");
			// A recoverable boot failure is not a crash: no restart backoff, no crash report.
			expect(statuses.some(payload => payload.status === "restarting")).toBe(false);
			expect(reportFailure).not.toHaveBeenCalled();
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("falls back to the crash loop when the default-model respawn fails the same way", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-model-loop-"));
		const binaryPath = await writeFakeOmp(
			tempDir,
			`process.stderr.write("error: Could not restore model gone/model-x\\n");\nprocess.exit(1);\n`,
		);

		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			await expect
				.poll(() => statuses.some(payload => payload.status === "restarting"), { timeout: 9_000, interval: 50 })
				.toBe(true);
			expect(statuses.find(payload => payload.status === "restarting")?.message).toContain(
				"Could not restore model gone/model-x",
			);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 15_000);

	it("boots on a catalog model when omp has no usable model, then drops it once ready", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-no-model-"));
		const logPath = path.join(tempDir, "argv.jsonl");
		const binaryPath = await writeFakeOmp(
			tempDir,
			[
				'import * as fs from "node:fs/promises";',
				"const argv = process.argv.slice(2);",
				`await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");`,
				'if (!argv.includes("--model")) {',
				'\tprocess.stderr.write("No models available. Use /login or set an API key environment variable. Then use /model to select a model.\\n");',
				"\tprocess.exit(1);",
				"}",
				'process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");',
				"process.stdin.resume();",
			].join("\n"),
		);

		const reportFailure = vi.fn();
		const bootModel = vi.fn(async () => "catalog/model-a");
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, reportFailure, bootModel });
		sidecar.on("status", payload => statuses.push(payload));
		const launches = async () =>
			(await fs.readFile(logPath, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as string[]);
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			expect(await launches()).toEqual([
				["--mode", "rpc-ui"],
				["--mode", "rpc-ui", "--model", "catalog/model-a"],
			]);
			expect(bootModel).toHaveBeenCalledTimes(1);
			// A recoverable boot failure is not a crash: no restart backoff, no crash report.
			expect(statuses.some(payload => payload.status === "restarting")).toBe(false);
			expect(reportFailure).not.toHaveBeenCalled();

			// Once booted, a restart (e.g. after the user connects a provider) asks
			// omp for its own default model again instead of pinning the placeholder.
			sidecar.restart();
			await expect
				.poll(async () => (await launches())[2], { timeout: 5_000, interval: 25 })
				.toEqual(["--mode", "rpc-ui"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("falls back to the crash loop when the catalog-model respawn has no model either", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-no-model-loop-"));
		const binaryPath = await writeFakeOmp(
			tempDir,
			`process.stderr.write("No models available.\\n");\nprocess.exit(1);\n`,
		);

		const bootModel = vi.fn(async () => "catalog/model-a");
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, bootModel });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			await expect
				.poll(() => statuses.some(payload => payload.status === "restarting"), { timeout: 9_000, interval: 50 })
				.toBe(true);
			expect(bootModel).toHaveBeenCalledTimes(1);
			expect(statuses.find(payload => payload.status === "restarting")?.message).toContain("No models available");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 15_000);

	it("carries the crashed spawn's stderr into the restart reason and the crash report", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-stderr-"));
		const binaryPath = await writeFakeOmp(
			tempDir,
			`process.stderr.write("dyld: Library not loaded: pi_natives\\n  Referenced by: omp\\n");\nsetTimeout(() => process.exit(4), 120);\n`,
		);

		const reportFailure = vi.fn();
		const statuses: SidecarStatusPayload[] = [];
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, reportFailure });
		sidecar.on("status", payload => statuses.push(payload));
		try {
			sidecar.start();
			await expect
				.poll(() => statuses.some(payload => payload.status === "restarting"), { timeout: 9_000, interval: 50 })
				.toBe(true);

			const reason = statuses[statuses.length - 1].message ?? "";
			expect(reason).toContain("Exit code 4");
			expect(reason).toContain("dyld: Library not loaded: pi_natives");
			// Stack-ish continuation lines stay out of the one-line reason.
			expect(reason).not.toContain("Referenced by");

			const report = reportFailure.mock.calls[0]?.[0] as SidecarFailureReport;
			expect(report).toMatchObject({ attempt: 1, maxAttempts: 3, cwd: tempDir });
			expect(report.stderr).toEqual(["dyld: Library not loaded: pi_natives", "  Referenced by: omp"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 15_000);
});
