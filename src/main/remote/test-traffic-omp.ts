/**
 * Test-only fake omp for `link-traffic-report.test.ts`, run by bun the way the app runs the real CLI. It speaks the NDJSON
 * RPC a SidecarManager expects and, on a `prompt` whose message is a JSON scenario, streams the frames stock omp
 * would: assistant messages whose every `message_update` carries the whole accumulated message twice (`message` and
 * `assistantMessageEvent.partial`, stock's default `set_event_filter`), a long tool call that says nothing while it
 * runs, and a `task` tool whose subagent reports `AgentProgress` snapshots at most every 150 ms
 * (`PROGRESS_COALESCE_MS` in omp's task/executor.ts), as `tool_execution_update` details and, while the GUI asked
 * (`set_subagent_subscription`), as `subagent_progress` frames, plus its own stream as `subagent_event` at `events`.
 * `get_subagent_messages` reads `subagents/<id>.jsonl` under its working folder as stock's
 * `readRpcSubagentTranscript` reads a subagent's journal: what follows `fromByte` up to the last whole line, as both
 * `entries` and `messages`, with the offset to read from next. Launched with a bridge (`OMP_GUI_BRIDGE`, the rig's
 * `bridge` option) it serves `read_image_blob` there, from `blobs/<sha256>` under its working folder as stock's blob
 * store keeps them, and `sessions.transcript` (the gui-bridge's page of the session's messages) over
 * `transcript.jsonl` there, one message a line, its leaf named by the line count; every other bridge method fails.
 * `get_state` names `session.jsonl` in its working folder as the session's file.
 * Standalone: the test writes this file's text out as the omp script, so it imports nothing local.
 */
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

interface Scenario {
	kind: "stream" | "tool-wait" | "subagent" | "subagents";
	/** Tokens of the assistant's thinking block, then of its text block (`stream`), or of each subagent message. */
	thinkingTokens?: number;
	textTokens?: number;
	tokenMs?: number;
	/** `tool-wait`: how long the tool call stays silent. `subagent`: how long the subagent works. */
	seconds?: number;
	/** `subagent`: stream exactly this many messages instead of working `seconds`. */
	messages?: number;
	/** `subagents`: how many subagents one task call runs side by side. */
	count?: number;
	/** `tool-wait`: the call streams this many output lines first, each update carrying the whole output so far. */
	outputLines?: number;
}

const WORDS = [
	"the",
	"session",
	"transcript",
	"renders",
	"each",
	"delta",
	"after",
	"function",
	"returns",
	"because",
	"worktree",
	"before",
	"reading",
	"remote",
	"host",
	"stream",
	"cache",
	"update",
];

const out = (frame: object): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};
let level = "off";
let clock = 1_760_000_000_000;
let counter = 0;

function token(): string {
	counter++;
	return `${WORDS[counter % WORDS.length]} `;
}

function usage(output: number) {
	return {
		input: 1200,
		output,
		cacheRead: 8000,
		cacheWrite: 0,
		totalTokens: 9200 + output,
		cost: { input: 0.003, output: 0.0004, cacheRead: 0.002, cacheWrite: 0, total: 0.0054 },
	};
}

function assistant(content: object[], stopReason: string, timestamp: number): Record<string, unknown> {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(0),
		stopReason,
		timestamp,
	};
}

/** One streamed assistant message: thinking then text, one `message_update` per token. */
async function streamMessage(
	emit: (event: object) => void,
	thinkingTokens: number,
	textTokens: number,
	tokenMs: number,
	toolCall?: { id: string; name: string; command: string },
): Promise<Record<string, unknown>> {
	const timestamp = ++clock;
	const content: Array<Record<string, unknown>> = [];
	const message = assistant(content, "stop", timestamp);
	emit({ type: "message_start", message: { ...message, content: [] } });
	const run = async (type: "thinking" | "text", tokens: number) => {
		const block: Record<string, unknown> = type === "thinking" ? { type, thinking: "" } : { type, text: "" };
		const contentIndex = content.push(block) - 1;
		emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: `${type}_start`, contentIndex, partial: message },
		});
		for (let i = 0; i < tokens; i++) {
			const delta = token();
			block[type] = `${block[type] as string}${delta}`;
			emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: `${type}_delta`, contentIndex, delta, partial: message },
			});
			if (tokenMs > 0) await sleep(tokenMs);
		}
		emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: `${type}_end`, contentIndex, content: block[type], partial: message },
		});
	};
	if (thinkingTokens > 0) await run("thinking", thinkingTokens);
	if (textTokens > 0) await run("text", textTokens);
	if (toolCall) {
		const block = {
			type: "toolCall",
			id: toolCall.id,
			name: toolCall.name,
			arguments: {} as Record<string, unknown>,
		};
		const contentIndex = content.push(block) - 1;
		emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex, partial: message },
		});
		block.arguments = { command: toolCall.command };
		emit({
			type: "message_update",
			message,
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex,
				delta: JSON.stringify({ command: toolCall.command }),
				partial: message,
			},
		});
		emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall: block, partial: message },
		});
		message.stopReason = "toolUse";
	}
	message.usage = usage(thinkingTokens + textTokens);
	emit({ type: "message_end", message });
	return message;
}

function progressOf(index: number, tools: number, startMs: number, text: string): Record<string, unknown> {
	const recentTools = Array.from({ length: Math.min(tools, 5) }, (_, i) => ({
		tool: i % 2 === 0 ? "read" : "grep",
		args: `src/main/remote/host-services.ts:${100 + i * 40}-${140 + i * 40}`,
		intent: "Reading the host's event forwarding",
		endMs: Date.now() - (5 - i) * 800,
	}));
	return {
		index,
		id: "0-Explore",
		agent: "explore",
		agentSource: "bundled",
		status: "running",
		task: "Map how the host forwards omp events to a paired device and name every periodic sender.",
		assignment: `${"Find every place the host pushes state to a device and report the file, the line and how often it fires. ".repeat(12)}`,
		description: "Map host pushes",
		lastIntent: "Reading the host's event forwarding",
		currentTool: "grep",
		currentToolArgs: "pattern=emit( path=src/main/remote",
		currentToolStartMs: Date.now() - 400,
		recentTools,
		recentOutput: Array.from({ length: 8 }, (_, i) => `${text.slice(i * 40, i * 40 + 90)}`),
		toolCount: tools,
		requests: tools + 1,
		tokens: 4000 + tools * 900,
		contextTokens: 22000,
		contextWindow: 200000,
		cost: 0.01 * tools,
		durationMs: Date.now() - startMs,
	};
}

async function toolWait(emit: (event: object) => void, seconds: number, outputLines = 0): Promise<void> {
	await streamMessage(emit, 0, 12, 0, { id: "call-1", name: "bash", command: "sleep 30" });
	emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep 30" } });
	// Stock's bash (tools/bash.ts): every update carries the call's whole output so far.
	let streamed = "";
	for (let line = 0; line < outputLines; line++) {
		streamed += `✓ test ${line} passed in ${line % 9} ms: src/main/remote/link-events.test.ts\n`;
		emit({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "sleep 30" },
			partialResult: { content: [{ type: "text", text: streamed }], details: {} },
		});
		await sleep(2);
	}
	await sleep(seconds * 1000);
	const output = Array.from({ length: 200 }, (_, line) => `line ${line}: src/main/remote/link-events.ts`).join("\n");
	const result = { content: [{ type: "text", text: output }], details: { exitCode: 0 } };
	emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result, isError: false });
	// Stock's order (pi-agent-core agent-loop.ts `emitToolResult`): the result message, built from the same result.
	const message = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: ++clock,
	};
	emit({ type: "message_start", message });
	emit({ type: "message_end", message });
	await streamMessage(emit, 0, 20, 0);
}

async function subagent(emit: (event: object) => void, scenario: Scenario): Promise<void> {
	const seconds = scenario.seconds ?? 10;
	const tokenMs = scenario.tokenMs ?? 12;
	await streamMessage(emit, 0, 12, 0, { id: "call-task", name: "task", command: "explore" });
	emit({ type: "tool_execution_start", toolCallId: "call-task", toolName: "task", args: { agent: "explore" } });
	const startMs = Date.now();
	const lifecycle = {
		id: "0-Explore",
		agent: "explore",
		agentSource: "bundled",
		description: "Map host pushes",
		index: 0,
		parentToolCallId: "call-task",
	};
	if (level !== "off") out({ type: "subagent_lifecycle", payload: { ...lifecycle, status: "started" } });
	let tools = 0;
	let tail = "";
	let streaming = true;
	const progress = (): void => {
		const progressNow = progressOf(0, tools, startMs, tail);
		if (level !== "off") {
			out({
				type: "subagent_progress",
				payload: {
					index: 0,
					agent: "explore",
					agentSource: "bundled",
					task: progressNow.task,
					assignment: progressNow.assignment,
					parentToolCallId: "call-task",
					progress: progressNow,
				},
			});
		}
		emit({
			type: "tool_execution_update",
			toolCallId: "call-task",
			toolName: "task",
			args: { agent: "explore" },
			partialResult: {
				content: [{ type: "text", text: "explore running" }],
				details: { results: [], totalDurationMs: Date.now() - startMs, progress: [progressNow] },
			},
		});
	};
	const timer = setInterval(() => {
		if (streaming) progress();
	}, 150);
	const subEmit = (event: object): void => {
		if (level === "events") out({ type: "subagent_event", payload: { id: "0-Explore", event } });
	};
	const deadline = Date.now() + seconds * 1000;
	const more = (): boolean => (scenario.messages === undefined ? Date.now() < deadline : tools < scenario.messages);
	while (more()) {
		const message = await streamMessage(subEmit, 0, scenario.textTokens ?? 300, tokenMs, {
			id: `sub-call-${tools}`,
			name: "grep",
			command: "emit(",
		});
		tail = `${tail}${JSON.stringify(message.content)}`.slice(-4000);
		subEmit({
			type: "tool_execution_start",
			toolCallId: `sub-call-${tools}`,
			toolName: "grep",
			args: { pattern: "emit(" },
		});
		await sleep(300);
		subEmit({
			type: "tool_execution_end",
			toolCallId: `sub-call-${tools}`,
			toolName: "grep",
			result: { content: [{ type: "text", text: "src/main/remote/host-services.ts:1462: #emit" }] },
			isError: false,
		});
		tools++;
	}
	streaming = false;
	clearInterval(timer);
	if (level !== "off") out({ type: "subagent_lifecycle", payload: { ...lifecycle, status: "completed" } });
	emit({
		type: "tool_execution_end",
		toolCallId: "call-task",
		toolName: "task",
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
	});
	await streamMessage(emit, 0, 20, 0);
}

/**
 * One task call fanning out to `count` subagents, as stock's sync fan-out reports it (`#executeSyncFanout` in
 * task/index.ts, `emitProgressNow` in task/executor.ts): each subagent's snapshot at most every 150 ms, its
 * `recentOutput` the last 8 lines of its streamed text, newest first, and every snapshot also as the parent's
 * combined `tool_execution_update` carrying the latest snapshot of every subagent.
 */
async function parallelSubagents(emit: (event: object) => void, scenario: Scenario): Promise<void> {
	const count = scenario.count ?? 4;
	const deadline = Date.now() + (scenario.seconds ?? 10) * 1000;
	await streamMessage(emit, 0, 12, 0, { id: "call-task", name: "task", command: "explore" });
	const args = { agent: "explore", tasks: Array.from({ length: count }, (_, i) => ({ id: `Area${i}` })) };
	emit({ type: "tool_execution_start", toolCallId: "call-task", toolName: "task", args });
	const startMs = Date.now();
	const latest = new Map<number, Record<string, unknown>>();
	const combined = (): void =>
		emit({
			type: "tool_execution_update",
			toolCallId: "call-task",
			toolName: "task",
			args,
			partialResult: {
				content: [{ type: "text", text: `Running ${count} agents...` }],
				details: { results: [], totalDurationMs: Date.now() - startMs, progress: [...latest.values()] },
			},
		});
	const one = async (index: number): Promise<void> => {
		const id = `${index}-Area${index}`;
		const lifecycle = { id, agent: "explore", agentSource: "bundled", description: `Map area ${index}`, index };
		if (level !== "off") out({ type: "subagent_lifecycle", payload: { ...lifecycle, status: "started" } });
		let tail = "";
		const recentTools: Array<Record<string, unknown>> = [];
		const progress: Record<string, unknown> = {
			index,
			id,
			agent: "explore",
			agentSource: "bundled",
			status: "running",
			task: `Map area ${index}: how the host forwards omp events to a paired device and every periodic sender.`,
			assignment: `${"Find every place the host pushes state to a device and report the file, the line and how often it fires. ".repeat(12)}`,
			description: `Map area ${index}`,
			recentTools,
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		const report = (): void => {
			progress.recentOutput = tail
				.split("\n")
				.filter(line => line.trim())
				.slice(-8)
				.reverse();
			progress.durationMs = Date.now() - startMs;
			const snapshot: Record<string, unknown> = { ...progress, recentTools: [...recentTools] };
			latest.set(index, snapshot);
			if (level !== "off") {
				const { task, assignment } = snapshot;
				out({
					type: "subagent_progress",
					payload: { index, agent: "explore", agentSource: "bundled", task, assignment, progress: snapshot },
				});
			}
			combined();
		};
		const timer = setInterval(report, 150);
		const subEmit = (event: object): void => {
			if (level === "events") out({ type: "subagent_event", payload: { id, event } });
			const update = event as { type: string; assistantMessageEvent?: { type: string; delta?: string } };
			const delta = update.assistantMessageEvent?.type === "text_delta" ? update.assistantMessageEvent.delta : "";
			if (!delta) return;
			tail = `${tail}${delta}${(progress.tokens as number) % 14 === 13 ? "\n" : ""}`.slice(-8192);
			progress.tokens = (progress.tokens as number) + 1;
		};
		let tools = 0;
		while (Date.now() < deadline) {
			const call = `sub-${index}-call-${tools}`;
			progress.requests = (progress.requests as number) + 1;
			await streamMessage(subEmit, 0, scenario.textTokens ?? 120, scenario.tokenMs ?? 12, {
				id: call,
				name: "grep",
				command: "emit(",
			});
			progress.currentTool = "grep";
			progress.currentToolArgs = `pattern=emit( path=src/main/area${index}`;
			progress.currentToolStartMs = Date.now();
			subEmit({ type: "tool_execution_start", toolCallId: call, toolName: "grep", args: { pattern: "emit(" } });
			await sleep(300);
			const result = { content: [{ type: "text", text: `src/main/area${index}/host.ts:${100 + tools}: #emit` }] };
			subEmit({ type: "tool_execution_end", toolCallId: call, toolName: "grep", result, isError: false });
			recentTools.unshift({ tool: "grep", args: progress.currentToolArgs, endMs: Date.now() });
			recentTools.splice(5);
			progress.currentTool = undefined;
			progress.currentToolArgs = undefined;
			progress.toolCount = ++tools;
			progress.cost = 0.01 * tools;
		}
		clearInterval(timer);
		progress.status = "completed";
		report();
		if (level !== "off") out({ type: "subagent_lifecycle", payload: { ...lifecycle, status: "completed" } });
	};
	await Promise.all(Array.from({ length: count }, (_, index) => one(index)));
	emit({
		type: "tool_execution_end",
		toolCallId: "call-task",
		toolName: "task",
		result: { content: [{ type: "text", text: "done" }] },
		isError: false,
	});
	await streamMessage(emit, 0, 20, 0);
}

async function run(scenario: Scenario): Promise<void> {
	const turn: object[] = [];
	// Stock's events go straight to stdout; `agent_end` carries the turn's messages.
	const emit = (event: object): void => {
		const frame = event as { type: string; message?: object };
		if (frame.type === "message_end" && frame.message) turn.push(frame.message);
		out(event);
	};
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: ++clock },
	});
	emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: clock } });
	if (scenario.kind === "stream") {
		await streamMessage(emit, scenario.thinkingTokens ?? 0, scenario.textTokens ?? 0, scenario.tokenMs ?? 12);
	} else if (scenario.kind === "tool-wait") {
		await toolWait(emit, scenario.seconds ?? 10, scenario.outputLines);
	} else if (scenario.kind === "subagents") {
		await parallelSubagents(emit, scenario);
	} else {
		await subagent(emit, scenario);
	}
	emit({ type: "turn_end" });
	emit({ type: "agent_end", messages: turn });
	out({ type: "session_settled" });
}

/**
 * The gui-bridge's `read_image_blob` (resources/gui-bridge/extensions/agents.ts) over `blobs/` in the working folder,
 * and its `sessions.transcript` page over `transcript.jsonl` there.
 */
async function serveBridge(address: string): Promise<void> {
	const server = createServer(socket => {
		createInterface({ input: socket }).on("line", line => {
			const { id, method, params } = JSON.parse(line) as {
				id: number;
				method: string;
				params?: { ref?: unknown; offset?: number; limit?: number };
			};
			if (method === "sessions.transcript") {
				socket.write(`${JSON.stringify({ id, ok: true, result: sessionPage(params?.offset, params?.limit) })}\n`);
				return;
			}
			if (method !== "read_image_blob") {
				socket.write(`${JSON.stringify({ id, ok: false, error: `unknown method ${method}` })}\n`);
				return;
			}
			const hash =
				typeof params?.ref === "string" ? /^blob:sha256:([a-f0-9]{64})$/.exec(params.ref)?.[1] : undefined;
			let data: string | null = null;
			try {
				if (hash) data = readFileSync(join(process.cwd(), "blobs", hash)).toString("base64");
			} catch {
				data = null;
			}
			socket.write(`${JSON.stringify({ id, ok: true, result: { data } })}\n`);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(address, listening.resolve);
	await listening.promise;
}

/** One page of `transcript.jsonl`'s messages: `{leafId, version, total, messages, startIndex}`, as the bridge answers. */
function sessionPage(offset = 0, limit = 0): Record<string, unknown> {
	let lines: string[] = [];
	try {
		lines = readFileSync(join(process.cwd(), "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
	} catch {
		lines = [];
	}
	const start = Math.max(0, Math.min(offset, lines.length));
	const messages = lines.slice(start, start + Math.max(0, limit)).map(text => JSON.parse(text) as unknown);
	return {
		leafId: `leaf-${lines.length}`,
		version: `v${lines.length}`,
		total: lines.length,
		messages,
		startIndex: start,
	};
}

if (process.env.OMP_GUI_BRIDGE) await serveBridge(process.env.OMP_GUI_BRIDGE);

out({
	type: "ready",
	protocolVersion: 2,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});

/** Stock's `readRpcSubagentTranscript` (modes/rpc/rpc-subagents.ts), over this folder's `subagents/<id>.jsonl`. */
function subagentTranscript(subagentId: string, fromByte = 0): Record<string, unknown> {
	const sessionFile = join(process.cwd(), "subagents", `${subagentId}.jsonl`);
	let start = Math.max(0, Math.trunc(fromByte));
	const size = statSync(sessionFile).size;
	let reset = false;
	if (start > size) {
		start = 0;
		reset = true;
	}
	const text = start >= size ? "" : readFileSync(sessionFile).subarray(start).toString("utf8");
	const complete = text.slice(0, text.lastIndexOf("\n") + 1);
	const entries = complete
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type?: string; message?: unknown });
	return {
		sessionFile,
		fromByte: start,
		nextByte: start + Buffer.byteLength(complete, "utf8"),
		reset,
		entries,
		messages: entries.filter(entry => entry.type === "message").map(entry => entry.message),
	};
}

createInterface({ input: process.stdin }).on("line", line => {
	const command = JSON.parse(line) as {
		id?: string;
		type: string;
		level?: string;
		message?: string;
		subagentId?: string;
		fromByte?: number;
	};
	if (command.type === "set_subagent_subscription" && command.level) level = command.level;
	if (command.type === "get_subagent_messages" && command.subagentId) {
		out({
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
			data: subagentTranscript(command.subagentId, command.fromByte),
		});
		return;
	}
	// Stock's slash command list as the built-in skill packs make it: about 300 commands, most a long description.
	const data =
		command.type === "get_state"
			? { sessionFile: join(process.cwd(), "session.jsonl"), sessionId: `session-${process.pid}` }
			: command.type === "get_available_commands"
				? {
						commands: Array.from({ length: 300 }, (_, index) => ({
							name: `skill:pack-${index}`,
							source: "skill",
							description: `Use this skill when the work touches area ${index}: ${WORDS.join(" ")}`,
						})),
					}
				: {};
	out({ type: "response", id: command.id, command: command.type, success: true, data });
	if (command.type === "prompt" && command.message) void run(JSON.parse(command.message) as Scenario);
});
