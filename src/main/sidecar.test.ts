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
				.toHaveLength(4);

			const commands = JSON.parse(await fs.readFile(commandLog, "utf8")) as Array<{
				type: string;
				events?: string[] | null;
				tools?: Array<{ name: string }>;
			}>;
			expect(commands.map(command => command.type)).toEqual([
				"negotiate_protocol",
				"set_event_filter",
				"set_ask_dialog",
				"set_host_tools",
			]);
			expect(commands[3]?.tools?.map(tool => tool.name)).toEqual(["gui_terminal_read", "gui_visualize"]);
			expect(commands[1]?.events).toContain("message_update");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("spawns a chat sidecar with the same full-tool argv as an agent", async () => {
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
			expect(launch).toEqual(["--mode", "rpc-ui"]);
			expect(launch).not.toContain("--no-tools");
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
			'import * as net from "node:net";',
			"const out = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\\n');",
			"const seen: string[] = [];",
			'const userMessage = { role: "user", content: "hi", timestamp: 10 };',
			'const entries = [{ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: userMessage }];',
			// The bridge server would keep the fake alive after stdin closes; on Windows the live
			// process then locks tempDir (its cwd) and the cleanup rmdir fails with EBUSY.
			'const answer = (request) => request.method === "sessions.transcript" ? { leafId: "e1", total: 1, messages: [{ ...userMessage, entryId: "e1" }] } : request.method === "sessions.attach_entry_ids" ? { messages: request.params.messages.map(message => ({ ...message, entryId: "e1" })) } : null;',
			'net.createServer(socket => { socket.setEncoding("utf8"); let buffer = ""; socket.on("data", chunk => { buffer += chunk; for (let i = buffer.indexOf("\\n"); i !== -1; i = buffer.indexOf("\\n")) { const request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); socket.write(JSON.stringify({ id: request.id, ok: true, result: answer(request) }) + "\\n"); } }); }).listen(process.env.OMP_GUI_BRIDGE, () => out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));',
			"createInterface({ input: process.stdin }).on('line', line => {",
			"\tconst command = JSON.parse(line);",
			"\tseen.push(command.type);",
			`\tfs.writeFileSync(${JSON.stringify(commandLog)}, JSON.stringify(seen));`,
			'\tif (command.type === "get_state") return out({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "s1" } });',
			'\tout({ type: "response", id: command.id, command: command.type, success: true });',
			'\tif (command.type === "prompt") {',
			'\t\tout({ type: "agent_end", messages: [userMessage] });',
			'\t\tout({ type: "prompt_result", id: command.id, agentInvoked: true });',
			"\t}",
			"});",
			'process.stdin.on("end", () => process.exit(0));',
		].join("\n");
		const binaryPath = await writeFakeOmp(tempDir, script);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, bridgeDir: tempDir });
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
			// Transcript and entry-id matching go through the bridge, never raw get_entries.
			const commands = JSON.parse(await fs.readFile(commandLog, "utf8")) as string[];
			expect(commands).not.toContain("get_transcript");
			expect(commands).toEqual(["get_state", "prompt"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("delivers the events omp sent before a response ahead of that response", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-order-"));
		const script = [
			'import { createInterface } from "node:readline";',
			'import * as net from "node:net";',
			"const out = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\\n');",
			'const answer = (request) => request.method === "sessions.transcript" ? { leafId: "e1", total: 0, messages: [] } : null;',
			'net.createServer(socket => { socket.setEncoding("utf8"); let buffer = ""; socket.on("data", chunk => { buffer += chunk; for (let i = buffer.indexOf("\\n"); i !== -1; i = buffer.indexOf("\\n")) { const request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); socket.write(JSON.stringify({ id: request.id, ok: true, result: answer(request) }) + "\\n"); } }); }).listen(process.env.OMP_GUI_BRIDGE, () => out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));',
			"createInterface({ input: process.stdin }).on('line', line => {",
			"\tconst command = JSON.parse(line);",
			// A step the agent took before this answer, as a run streams between commands.
			'\tif (command.type === "abort") out({ type: "tool_execution_start", toolCallId: "c1", toolName: "wait", args: {} });',
			'\tout({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "s1" } });',
			// One it took right after: still batched when main answers the next command itself.
			'\tif (command.type === "abort") out({ type: "tool_execution_end", toolCallId: "c1", toolName: "wait", result: {}, isError: false });',
			"});",
			'process.stdin.on("end", () => process.exit(0));',
		].join("\n");
		const binaryPath = await writeFakeOmp(tempDir, script);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, bridgeDir: tempDir });
		const order: string[] = [];
		sidecar.on("events", (events: Array<{ type: string }>) => {
			for (const event of events) order.push(event.type);
		});
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			const client = sidecar.rpcClient;
			if (!client) throw new Error("no rpc client");
			// Connects the bridge and learns the session, so the snapshot below is one quick bridge reply.
			await client.command({ type: "get_transcript" });

			// A response omp sends itself.
			await client.command({ type: "abort" });
			order.push("abort response");
			// A response main answers from a bridge snapshot.
			await client.command({ type: "get_transcript" });
			order.push("transcript response");
			expect(order).toEqual(["tool_execution_start", "abort response", "tool_execution_end", "transcript response"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("passes the bridge's goal time limit frame on with the agent events, so the window toasts it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-goal-limit-"));
		const script = [
			'import { createInterface } from "node:readline";',
			'import * as net from "node:net";',
			"const out = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\\n');",
			// The bridge answers the transcript read, then pushes the frame modes/goal.ts emits at the limit.
			'const answer = (request) => request.method === "sessions.transcript" ? { leafId: "e1", total: 0, messages: [] } : null;',
			'net.createServer(socket => { socket.setEncoding("utf8"); let buffer = ""; socket.on("data", chunk => { buffer += chunk; for (let i = buffer.indexOf("\\n"); i !== -1; i = buffer.indexOf("\\n")) { const request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); socket.write(JSON.stringify({ id: request.id, ok: true, result: answer(request) }) + "\\n"); socket.write(JSON.stringify({ event: { type: "goal_time_limit_reached", minutes: 1 } }) + "\\n"); } }); }).listen(process.env.OMP_GUI_BRIDGE, () => out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));',
			"createInterface({ input: process.stdin }).on('line', line => {",
			"\tconst command = JSON.parse(line);",
			'\tout({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "s1" } });',
			"});",
			'process.stdin.on("end", () => process.exit(0));',
		].join("\n");
		const binaryPath = await writeFakeOmp(tempDir, script);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, bridgeDir: tempDir });
		const events: unknown[] = [];
		sidecar.on("events", (batch: unknown[]) => events.push(...batch));
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			const client = sidecar.rpcClient;
			if (!client) throw new Error("no rpc client");
			await client.command({ type: "get_transcript" });
			await expect
				.poll(() => events, { timeout: 5_000, interval: 25 })
				.toContainEqual({ type: "goal_time_limit_reached", minutes: 1 });
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("keeps every response behind an agent_end that waits for its entry ids", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-held-"));
		const answered = path.join(tempDir, "transcript-answered");
		const script = [
			'import * as fs from "node:fs";',
			'import { createInterface } from "node:readline";',
			'import * as net from "node:net";',
			"const line = (frame: unknown) => JSON.stringify(frame) + '\\n';",
			"const out = (frame: unknown) => process.stdout.write(line(frame));",
			'const message = { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 7 };',
			// The entry ids wait for the test's second abort: until then the agent_end stays held.
			"let aborts = 0;",
			"let pendingIds: (() => void) | undefined;",
			"let bridgeSocket;",
			'const reply = (socket, request) => socket.write(JSON.stringify({ id: request.id, ok: true, result: request.method === "sessions.attach_entry_ids" ? { messages: request.params.messages.map(m => ({ ...m, entryId: "e7" })) } : request.method === "sessions.transcript" ? { leafId: "e7", total: 1, messages: [{ ...message, entryId: "e7" }] } : null }) + "\\n");',
			"const answer = (socket, request) => {",
			'\tif (request.method === "sessions.attach_entry_ids") return void (pendingIds = () => reply(socket, request));',
			"\treply(socket, request);",
			`\tif (aborts === 1 && request.method === "sessions.transcript") fs.writeFileSync(${JSON.stringify(answered)}, "");`,
			"};",
			'net.createServer(socket => { bridgeSocket = socket; socket.setEncoding("utf8"); let buffer = ""; socket.on("data", chunk => { buffer += chunk; for (let i = buffer.indexOf("\\n"); i !== -1; i = buffer.indexOf("\\n")) { const request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); answer(socket, request); } }); }).listen(process.env.OMP_GUI_BRIDGE, () => out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));',
			"createInterface({ input: process.stdin }).on('line', input => {",
			"\tconst command = JSON.parse(input);",
			'\tconst response = { type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "s1" } };',
			'\tif (command.type !== "abort") return out(response);',
			"\taborts++;",
			// One write: main reads the run's end and the response behind it together.
			'\tif (aborts === 1) return process.stdout.write(line({ type: "agent_start" }) + line({ type: "message_end", message }) + line({ type: "agent_end", messages: [message] }) + line(response));',
			"\tpendingIds?.();",
			"\tout(response);",
			"});",
			'process.stdin.on("end", () => { bridgeSocket?.destroy(); process.exit(0); });',
		].join("\n");
		const binaryPath = await writeFakeOmp(tempDir, script);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, bridgeDir: tempDir });
		const order: string[] = [];
		sidecar.on("events", (events: Array<{ type: string; messages?: Array<{ entryId?: string }> }>) => {
			for (const event of events)
				order.push(event.messages ? `${event.type} ${event.messages[0]?.entryId}` : event.type);
		});
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			const client = sidecar.rpcClient;
			if (!client) throw new Error("no rpc client");
			// Connects the bridge and learns the session.
			await client.command({ type: "get_transcript" });
			order.length = 0;

			const held = Promise.withResolvers<void>();
			sidecar.on("frame", (frame: { type: string }) => {
				if (frame.type === "message_end") held.resolve();
			});
			// omp's own response, sent right behind the run's end.
			const first = client.command({ type: "abort" }).then(() => order.push("abort response"));
			await held.promise;
			// One main answers from a bridge snapshot while the end still waits: the bridge has
			// answered it well before the entry ids are released below.
			const transcript = client.command({ type: "get_transcript" }).then(() => order.push("transcript response"));
			await expect
				.poll(() =>
					fs.stat(answered).then(
						() => true,
						() => false,
					),
				)
				.toBe(true);
			const second = client.command({ type: "abort" }).then(() => order.push("second abort response"));
			await Promise.all([first, transcript, second]);

			expect(order.slice(0, 4)).toEqual(["agent_start", "message_end", "agent_end e7", "abort response"]);
			expect(order.indexOf("transcript response")).toBeGreaterThan(order.indexOf("agent_end e7"));
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("commits every message a deferred or compacted agent_end left out, with entry ids, in stream order", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-run-"));
		// Stock's real order for "Use your todo tool …": run 1 (user prompt, todo/bash/todo/bash) ends,
		// a todo reminder continues it as run 2, and only run 2's deferred agent_end reaches the wire.
		const script = [
			'import { createInterface } from "node:readline";',
			'import * as net from "node:net";',
			"const out = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\\n');",
			'const call = (timestamp: number, name: string) => ({ role: "assistant", content: [{ type: "toolCall", id: "c" + timestamp, name, arguments: {} }], stopReason: "toolUse", timestamp });',
			'const result = (timestamp: number, name: string) => ({ role: "toolResult", toolCallId: "c" + (timestamp - 1), toolName: name, content: [{ type: "text", text: name }], isError: false, timestamp });',
			'const run1 = [{ role: "user", content: "Use your todo tool", timestamp: 100 }, call(101, "todo"), result(102, "todo"), call(103, "bash"), result(104, "bash"), call(105, "todo"), result(106, "todo"), call(107, "bash"), result(108, "bash"), { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 109 }];',
			'const run2 = [{ role: "custom", customType: "todo-reminder", content: "finish todos", display: false, timestamp: 110 }, call(111, "todo"), result(112, "todo"), call(113, "todo"), result(114, "todo"), { role: "assistant", content: [{ type: "text", text: "all done" }], stopReason: "stop", timestamp: 115 }];',
			'const deliver = (messages: unknown[]) => { for (const message of messages) { out({ type: "message_start", message }); out({ type: "message_end", message }); } };',
			'const answer = (request) => request.method === "sessions.attach_entry_ids" ? { messages: request.params.messages.map(message => ({ ...message, entryId: "e" + message.timestamp })) } : null;',
			'net.createServer(socket => { socket.setEncoding("utf8"); let buffer = ""; socket.on("data", chunk => { buffer += chunk; for (let i = buffer.indexOf("\\n"); i !== -1; i = buffer.indexOf("\\n")) { const request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); socket.write(JSON.stringify({ id: request.id, ok: true, result: answer(request) }) + "\\n"); } }); }).listen(process.env.OMP_GUI_BRIDGE, () => out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));',
			"createInterface({ input: process.stdin }).on('line', line => {",
			"\tconst command = JSON.parse(line);",
			'\tout({ type: "response", id: command.id, command: command.type, success: true });',
			'\tif (command.type !== "prompt") return;',
			'\tout({ type: "agent_start" });',
			"\tdeliver(run1);",
			'\tout({ type: "agent_start" });',
			"\tdeliver(run2);",
			// Deferred: run 1's agent_end was replaced. Compacted: stock also drops run 2's delivered prefix.
			'\tout(command.message === "compact" ? { type: "agent_end", messages: run2.slice(3), messageCount: run2.length } : { type: "agent_end", messages: run2 });',
			'\tout({ type: "prompt_result", id: command.id, agentInvoked: true });',
			"});",
			'process.stdin.on("end", () => process.exit(0));',
		].join("\n");
		const binaryPath = await writeFakeOmp(tempDir, script);

		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, bridgeDir: tempDir });
		const ends: Array<Array<{ entryId?: string }>> = [];
		sidecar.on("frame", (frame: { type: string; messages?: Array<{ entryId?: string }> }) => {
			if (frame.type === "agent_end") ends.push(frame.messages ?? []);
		});
		const wholeRun = Array.from({ length: 16 }, (_, index) => `e${100 + index}`);
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			const client = sidecar.rpcClient;
			if (!client) throw new Error("no rpc client");

			await client.command({ type: "prompt", message: "defer" });
			await expect.poll(() => ends.length).toBe(1);
			expect(ends[0]?.map(message => message.entryId)).toEqual(wholeRun);

			await client.command({ type: "prompt", message: "compact" });
			await expect.poll(() => ends.length).toBe(2);
			expect(ends[1]?.map(message => message.entryId)).toEqual(wholeRun);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	it("appends the workspace launch profile flags at spawn, denylist-proof", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-profile-"));
		const workspaceCwd = path.join(tempDir, "workspace");
		await fs.mkdir(workspaceCwd, { recursive: true });
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		// The app's prefs store, kept in tempDir: never the developer's own prefs.json.
		const prefs = new Store<Record<string, unknown>>({ name: "prefs", cwd: path.join(tempDir, "prefs") });
		const sidecar = new SidecarManager({
			omp: ompAt(binaryPath),
			cwd: workspaceCwd,
			launchProfiles: () => prefs.get("launchProfiles"),
		});
		try {
			// Written after construction: the profile is read at spawn.
			prefs.set("launchProfiles", {
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
			});

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

	// Red/yellow, as stock prints them when color is forced (CI): the parser must see through ANSI codes.
	it.each([
		[
			"18.6",
			"\\x1b[31mNo models available. Use /login or set an API key environment variable. Then use /model to select a model.\\x1b[39m\\n",
		],
		[
			"18.7",
			"\\x1b[31mNo default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.\\x1b[39m\\n\\x1b[33m\\nSet an API key environment variable:\\x1b[39m\\n  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\\n",
		],
	])(
		"boots on a catalog model when omp %s has no usable model, then drops it once ready",
		async (_version, stderr) => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-no-model-"));
			const logPath = path.join(tempDir, "argv.jsonl");
			const binaryPath = await writeFakeOmp(
				tempDir,
				[
					'import * as fs from "node:fs/promises";',
					"const argv = process.argv.slice(2);",
					`await fs.appendFile(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");`,
					'if (!argv.includes("--model")) {',
					`\tprocess.stderr.write("${stderr}");`,
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
		},
	);

	// Windows CI: the fake's grandchild never got its write out after the fake
	// exited (the respawn loop never saw it), so the late-stderr setup only holds on POSIX.
	it.skipIf(process.platform === "win32")(
		"diagnoses a boot failure whose stderr lands after the process exited",
		async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-late-stderr-"));
			const binaryPath = await writeFakeOmp(
				tempDir,
				[
					'if (process.argv.includes("--model")) {',
					'\tprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");',
					"\tprocess.stdin.resume();",
					"} else {",
					"\t// A grandchild holding stderr (as under a cmd.exe shim) writes after this process exits;",
					"\t// the real delay is the point: the write must land after `exit`.",
					'\tBun.spawn(["bun", "-e", \'await Bun.sleep(300); process.stderr.write("No models available.\\\\n")\'], {',
					'\t\tstdio: ["ignore", "ignore", "inherit"],',
					"\t}).unref();",
					"\tprocess.exit(1);",
					"}",
				].join("\n"),
			);

			const bootModel = vi.fn(async () => "catalog/model-a");
			const statuses: SidecarStatusPayload[] = [];
			const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, bootModel });
			sidecar.on("status", payload => statuses.push(payload));
			try {
				const ready = waitForReady(sidecar);
				sidecar.start();
				await ready;
				expect(bootModel).toHaveBeenCalledTimes(1);
				expect(statuses.some(payload => payload.status === "restarting")).toBe(false);
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, RM_TEMP);
			}
		},
		15_000,
	);

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

	it("returns a live sidecar to ready once it answers again after a failed health check", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-health-"));
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import { createInterface } from "node:readline";\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\ncreateInterface({ input: process.stdin }).on("line", line => {\n\tconst command = JSON.parse(line) as { id?: string; type: string };\n\tprocess.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "s1" } }) + "\\n");\n});\n`,
		);
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, healthRecoveryProbeMs: 20 });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;
			const statuses: SidecarStatus[] = [];
			sidecar.on("status", ({ status }: SidecarStatusPayload) => statuses.push(status));

			const recovered = waitForReady(sidecar);
			sidecar.markUnhealthy("Health check timed out");
			// The child is still there and still holds its session.
			expect(sidecar.status).toBe("error");
			expect(sidecar.processAlive).toBe(true);
			await recovered;
			expect(statuses).toEqual(["error", "ready"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	});

	// POSIX only: the fake child closes fd 0 to break the pipe, which the Windows
	// .cmd shim and named-pipe semantics don't reproduce (the spawn never gets
	// ready). The stdin error handler under test is platform-independent.
	it.skipIf(process.platform === "win32")(
		"survives writes to a child that stopped reading stdin (EPIPE)",
		async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-epipe-"));
			const binaryPath = await writeFakeOmp(
				tempDir,
				`import * as fs from "node:fs";\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nfs.closeSync(0);\nsetInterval(() => {}, 1000);\n`,
			);
			const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir });
			const uncaught: unknown[] = [];
			const onUncaught = (error: unknown) => uncaught.push(error);
			process.on("uncaughtException", onUncaught);
			try {
				const ready = waitForReady(sidecar);
				sidecar.start();
				await ready;
				// Every write after the read end closed fails on the stream, not the call.
				for (let index = 0; index < 50; index++)
					sidecar.sendSideChannel({ type: "extension_ui_response", id: `${index}` });
				await delay(200);
				expect(uncaught).toEqual([]);
			} finally {
				process.off("uncaughtException", onUncaught);
				sidecar.dispose();
				await fs.rm(tempDir, RM_TEMP);
			}
		},
	);

	it("holds a fresh tab at starting until its start gate settles, then restarts fresh in the gate's cwd", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gate-"));
		const gatedCwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-gated-")));
		const logPath = path.join(tempDir, "spawns.jsonl");
		// Listens on the bridge address like the real extension, then reports ready.
		const binaryPath = await writeFakeOmp(
			tempDir,
			[
				`import * as fs from "node:fs";`,
				`import * as net from "node:net";`,
				`fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
				`const server = net.createServer(() => {});`,
				`server.listen(process.env.OMP_GUI_BRIDGE, () => process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n"));`,
				`server.unref();`,
				`process.stdin.resume();`,
			].join("\n"),
		);
		const gate = Promise.withResolvers<string | null>();
		// Resolved by the gate itself: the first spawn is a real child (cold exec of a
		// just-written script, then the bridge connect), so no fixed window fits it.
		const gateCalled = Promise.withResolvers<{ connected: boolean; cwd: string }>();
		const gateCalls: string[] = [];
		const statuses: SidecarStatus[] = [];
		const sidecar = new SidecarManager({ omp: ompAt(binaryPath), cwd: tempDir, fresh: true, bridgeDir: tempDir });
		sidecar.on("status", ({ status }: SidecarStatusPayload) => statuses.push(status));
		sidecar.setStartGate(async (bridge, cwd) => {
			gateCalls.push(cwd);
			gateCalled.resolve({ connected: bridge.connected, cwd });
			return gate.promise;
		});
		try {
			sidecar.start();
			expect(await gateCalled.promise).toEqual({ connected: true, cwd: tempDir });
			await delay(100);
			expect(statuses).not.toContain("ready");

			const ready = waitForReady(sidecar);
			gate.resolve(gatedCwd);
			await ready;
			expect(sidecar.cwd).toBe(gatedCwd);
			const spawns = (await fs.readFile(logPath, "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { argv: string[]; cwd: string });
			expect(spawns).toHaveLength(2);
			expect(spawns[1]?.cwd).toBe(gatedCwd);
			// Still a fresh session there: no autoResume of an older one.
			expect(spawns[1]?.argv).toContain(path.join(tempDir, "fresh-launch.yml"));
			// One-shot: a later restart reports ready without asking again.
			const again = waitForReady(sidecar);
			sidecar.restart();
			await again;
			expect(gateCalls).toHaveLength(1);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
			await fs.rm(gatedCwd, RM_TEMP);
		}
	}, 15_000);
});
