/**
 * Test-only fake omp for `link-traffic-report.test.ts`, run by bun the way the app runs the real CLI. It speaks the NDJSON
 * RPC a SidecarManager expects and, on a `prompt` whose message is a JSON scenario, streams the frames stock omp
 * would: assistant messages whose every `message_update` carries the whole accumulated message twice (`message` and
 * `assistantMessageEvent.partial`, stock's default `set_event_filter`), a long tool call that says nothing while it
 * runs, and a `task` tool whose subagent reports `AgentProgress` snapshots at most every 150 ms
 * (`PROGRESS_COALESCE_MS` in omp's task/executor.ts), as `tool_execution_update` details and, while the GUI asked
 * (`set_subagent_subscription`), as `subagent_progress` frames, plus its own stream as `subagent_event` at `events`.
 * Standalone: the test writes this file's text out as the omp script, so it imports nothing local.
 */
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

interface Scenario {
	kind: "stream" | "tool-wait" | "subagent";
	/** Tokens of the assistant's thinking block, then of its text block (`stream`), or of each subagent message. */
	thinkingTokens?: number;
	textTokens?: number;
	tokenMs?: number;
	/** `tool-wait`: how long the tool call stays silent. `subagent`: how long the subagent works. */
	seconds?: number;
	/** `subagent`: stream exactly this many messages instead of working `seconds`. */
	messages?: number;
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

async function toolWait(emit: (event: object) => void, seconds: number): Promise<void> {
	await streamMessage(emit, 0, 12, 0, { id: "call-1", name: "bash", command: "sleep 30" });
	emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep 30" } });
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
		await toolWait(emit, scenario.seconds ?? 10);
	} else {
		await subagent(emit, scenario);
	}
	emit({ type: "turn_end" });
	emit({ type: "agent_end", messages: turn });
	out({ type: "session_settled" });
}

out({
	type: "ready",
	protocolVersion: 2,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});

createInterface({ input: process.stdin }).on("line", line => {
	const command = JSON.parse(line) as { id?: string; type: string; level?: string; message?: string };
	if (command.type === "set_subagent_subscription" && command.level) level = command.level;
	out({ type: "response", id: command.id, command: command.type, success: true, data: {} });
	if (command.type === "prompt" && command.message) void run(JSON.parse(command.message) as Scenario);
});
