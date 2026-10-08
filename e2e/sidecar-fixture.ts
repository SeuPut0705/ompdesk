#!/usr/bin/env bun
/// <reference types="bun" />
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import type { AgentMessage, RpcSecurityDashboardResult, SubagentSnapshot } from "../src/shared/rpc-types";

// A local stand-in for the system omp the GUI drives: stock `--mode rpc-ui` on
// stdin/stdout, plus the gui-bridge extension's socket (loaded with `-e`,
// address in `OMP_GUI_BRIDGE`) answering the bridge methods the e2e suites
// reach. No provider credentials, external network, or user session files.
if (process.argv.includes("--version")) {
	console.log("omp/18.8.0");
	process.exit(0);
}
if (process.argv[2] === "stats") {
	const binary = process.env.OMP_GUI_TEST_STATS_BINARY;
	if (binary) {
		const child = Bun.spawn([binary, ...process.argv.slice(2)], {
			stdout: "inherit",
			stderr: "inherit",
			env: process.env,
		});
		process.on("SIGTERM", () => child.kill());
		await child.exited;
	} else {
		// The routes that contract a bare JSON array must actually receive one, so the
		// dashboard renders rows instead of its empty/error state.
		const lists: Record<string, unknown[]> = {
			"/api/stats/errors": [
				{
					id: 1,
					entryId: "err-1",
					sessionFile: "/home/dev/.omp/agent/sessions/2026-09-21-workspace-alpha.jsonl",
					folder: "/home/dev/projects/workspace-alpha",
					model: "claude-opus-4-1",
					provider: "anthropic",
					timestamp: 1758451200000,
					stopReason: "error",
					errorMessage:
						"stream disconn…fter 3 retries: upstream provider returned 529 overloaded_state for this deployment",
					usage: { totalTokens: 18_432 },
				},
			],
			"/api/stats/folders": [
				{
					folder: "/home/dev/projects/workspace-alpha",
					totalRequests: 142,
					failedRequests: 4,
					errorRate: 0.028,
					totalInputTokens: 921_400,
					totalOutputTokens: 148_220,
					totalCacheReadTokens: 4_812_000,
					totalCacheWriteTokens: 302_400,
					totalCost: 41.27,
					avgDuration: 8421,
					avgTokensPerSecond: 61.4,
				},
				{
					folder: "/home/dev/projects/a/much/longer/nested/repository/path/that/should/not/overflow/the/column",
					totalRequests: 9,
					failedRequests: 0,
					errorRate: 0,
					totalInputTokens: 12_400,
					totalOutputTokens: 2_220,
					totalCacheReadTokens: 0,
					totalCacheWriteTokens: 0,
					totalCost: 0.42,
					avgDuration: null,
					avgTokensPerSecond: null,
				},
			],
		};
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				const { pathname } = new URL(request.url);
				return Response.json(lists[pathname] ?? {}, { headers: { "x-omp-stats-dashboard": "1" } });
			},
		});
		process.stdout.write(`http://localhost:${server.port}\n`);
		process.on("SIGTERM", () => {
			server.stop(true);
			process.exit(0);
		});
	}
} else if (!process.argv.includes("--mode")) {
	// Other `omp` CLI calls main makes (`plugin list --json`, `update --check`, …) have no local stand-in.
	console.error(`fixture: unsupported invocation: ${process.argv.slice(2).join(" ")}`);
	process.exit(1);
} else {
	// Stock omp exits on flags it does not know (cli/args.ts `reportUnrecognizedFlags`);
	// mirror that so a fork-only launch flag fails here the way it fails for real.
	const VALUE_FLAGS: Record<string, true> = {
		"--mode": true,
		"--session": true,
		"--config": true,
		"--model": true,
		"--thinking": true,
		"--extension": true,
		"-e": true,
	};
	const BOOLEAN_FLAGS: Record<string, true> = { "--no-tools": true, "--no-session": true, "--no-title": true };
	const flags: Record<string, string> = {};
	for (let index = 2; index < process.argv.length; index++) {
		const arg = process.argv[index];
		if (VALUE_FLAGS[arg]) flags[arg] = process.argv[++index] ?? "";
		else if (BOOLEAN_FLAGS[arg]) flags[arg] = "";
		else {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		}
	}
	if (flags["--mode"] !== "rpc-ui") {
		console.error(`fixture: unsupported mode ${flags["--mode"]}`);
		process.exit(1);
	}
	const extension = flags["-e"] ?? flags["--extension"];
	for (const file of [extension, flags["--config"]]) {
		if (file !== undefined && !fs.existsSync(file)) {
			console.error(`fixture: no such file: ${file}`);
			process.exit(1);
		}
	}

	// The session journal as stock `get_entries` exposes it: one linear branch.
	interface Entry {
		type: string;
		id: string;
		parentId: string | null;
		timestamp: string;
		[key: string]: unknown;
	}
	const entries: Entry[] = [];
	const append = (fields: { type: string; [key: string]: unknown }, time: number | string) => {
		entries.push({
			...fields,
			id: `entry-${entries.length + 1}`,
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date(time).toISOString(),
		});
	};
	const appendMessage = (message: AgentMessage) =>
		append({ type: "message", message }, message.timestamp ?? Date.now());

	const count = Math.min(50_000, Number(process.env.OMP_GUI_TEST_HISTORY ?? 0));
	for (let index = 0; index < count; index++) {
		const timestamp = 1700000000000 + index * 1000;
		if (index > 0 && index % 1000 === 0)
			append(
				{
					type: "compaction",
					summary: `Compacted history ${index}`,
					firstKeptEntryId: entries.at(-1)?.id,
					tokensBefore: 90000,
					tokensAfter: 12000,
				},
				timestamp,
			);
		else if (index % 1000 === 2)
			appendMessage({
				timestamp,
				role: "user",
				content: [
					{ type: "text", text: `Image question ${index}` },
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6VQAAAAASUVORK5CYII=",
					},
				],
			});
		else if (index % 10 === 5)
			appendMessage({
				timestamp,
				role: "assistant",
				content: [{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: { path: "example.ts" } }],
				stopReason: "toolUse",
			});
		else if (index % 10 === 6)
			appendMessage({
				timestamp,
				role: "toolResult",
				toolCallId: `tool-${index - 1}`,
				toolName: "read",
				content: [{ type: "text", text: `Result ${index}\nconst value = ${index};` }],
				isError: false,
			});
		else if (index % 2 === 0)
			appendMessage({ timestamp, role: "user", content: [{ type: "text", text: `History question ${index}` }] });
		else
			appendMessage({
				timestamp,
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Consider context ${index}.` },
					{ type: "text", text: `History answer ${index}. This is a bounded local performance fixture.` },
				],
				stopReason: "stop",
			});
	}

	const model = {
		id: "local-fixture",
		name: "Local fixture",
		provider: "fixture",
		reasoning: true,
		contextWindow: 128000,
		maxTokens: 4096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const lanes: Record<"steering" | "followUp", string[]> = { steering: [], followUp: [] };
	let isStreaming = false;
	let planModeEnabled = false;
	/** Stock `/btw` history, newest first. */
	const btwRecords: object[] = [];
	const sessionId = `fixture-${process.pid}`;
	// Stock `get_state`: cwd, plan mode and the pause gate come from the bridge's `composer.state`.
	const state = () => ({
		model,
		thinkingLevel: "medium",
		isStreaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionId,
		sessionName: "Audit session",
		autoCompactionEnabled: true,
		queuedMessageCount: lanes.steering.length + lanes.followUp.length,
		hasPendingAsyncWork: false,
		isSettled: !isStreaming,
		queuedMessages: { steering: [...lanes.steering], followUp: [...lanes.followUp] },
		todoPhases: [],
		fastModeEnabled: false,
		tokensPerSecond: null,
		fastModeActive: false,
		messageCount: entries.length,
		systemPrompt: [],
		dumpTools: [],
		contextUsage: { tokens: 74_800, contextWindow: 128_000, percent: 58 },
	});
	let securityMode = "disabled";
	let streamTimer: Timer | undefined;
	let streamChunks = 0;
	let streamTick: (() => void) | undefined;
	/** get_subagents roster; `fixture:subagents` fills it (running, finished, nested). */
	let subagentRoster: SubagentSnapshot[] = [];
	/** The emitted plan proposal awaiting `plan_approval`, as the bridge's get_plan_mode reports it. */
	let planProposal: Record<string, unknown> | undefined;
	let holdSettings = false;
	let releaseSettings: (() => void) | undefined;
	/**
	 * `OMP_GUI_TEST_LOGIN=1`: Anthropic is a signed-out OAuth provider the
	 * providers screen can sign in to; other suites keep the one fixture provider.
	 */
	const loginProvider = process.env.OMP_GUI_TEST_LOGIN === "1";
	let anthropicSignedIn = false;
	/** The `login` in flight: its open_url and input request ids, and how it ends. */
	let pendingLogin: { urlId: string; inputId: string; finish: (value: string | undefined) => void } | undefined;
	const values: Record<string, unknown> = {
		"approval.mode": "ask",
		"theme.dark": "dark",
		"theme.light": "light",
		"theme.mode": "dark",
		"security.enabled": false,
		"compaction.reserveTokens": 8192,
	};
	const stats = {
		sessionId,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		premiumRequests: 0,
	};
	/**
	 * Every stdin command and bridge request, one JSON line each, keyed by `type`
	 * (bridge: the method name) and tagged `recordedBy` with this process's
	 * session id, so a multi-tab test can tell which tab's omp received it.
	 */
	const record = (frame: object) => {
		if (process.env.OMP_GUI_TEST_RECORD)
			fs.appendFileSync(process.env.OMP_GUI_TEST_RECORD, `${JSON.stringify({ ...frame, recordedBy: sessionId })}\n`);
	};

	// Stock framing (rpc-frame.ts): under protocol v2 a frame over 1 MiB is split into base64 `rpc_chunk` lines.
	const MAX_FRAME_BYTES = 1_048_576;
	const MAX_REASSEMBLED_BYTES = 67_108_864;
	const CHUNK_PAYLOAD_BYTES = 262_144;
	let protocolVersion = 1;
	let chunkSequence = 0;
	const write = (frame: object) => {
		const json = JSON.stringify(frame);
		const bytes = Buffer.from(json, "utf8");
		if (protocolVersion < 2 || bytes.byteLength <= MAX_FRAME_BYTES) {
			process.stdout.write(`${json}\n`);
			return;
		}
		const chunkId = `fixture-${++chunkSequence}`;
		const total = Math.ceil(bytes.byteLength / CHUNK_PAYLOAD_BYTES);
		let lines = "";
		for (let index = 0; index < total; index++) {
			const data = bytes.subarray(index * CHUNK_PAYLOAD_BYTES, (index + 1) * CHUNK_PAYLOAD_BYTES).toString("base64");
			lines += `${JSON.stringify({ type: "rpc_chunk", chunkId, index, count: total, byteLength: bytes.byteLength, data })}\n`;
		}
		process.stdout.write(lines);
	};
	const emitQueue = () =>
		write({ type: "queue_update", steering: [...lanes.steering], followUp: [...lanes.followUp] });
	const endTurn = (messages: AgentMessage[]) => {
		isStreaming = false;
		write({ type: "agent_end", messages });
	};

	// The gui-bridge extension's end of `OMP_GUI_BRIDGE`: `{id, method, params}` in,
	// `{id, ok, result|error}` and pushed `{event}` out (resources/gui-bridge/index.ts).
	type Params = Record<string, unknown>;
	type Reply = (result: unknown) => void;
	const bridgeClients = new Set<net.Socket>();
	const securityDashboard = (): RpcSecurityDashboardResult => {
		if (securityMode === "unavailable") throw new Error("Isolated dashboard unavailable");
		const dashboard: RpcSecurityDashboardResult = {
			enabled: securityMode !== "disabled",
			modelReady: true,
			modelLabel: "Local fixture",
			repositoryRoot: process.cwd(),
			scans: [],
			operations: [],
		};
		if (securityMode === "disabled" || securityMode === "unscanned") return dashboard;
		const now = new Date().toISOString();
		const scan = {
			id: "scan",
			status:
				securityMode === "failed"
					? ("failed" as const)
					: securityMode === "incomplete"
						? ("partial" as const)
						: ("completed" as const),
			createdAt: now,
			producer: "fixture",
			findingCount: securityMode === "findings" ? 1 : 0,
			target: { kind: "working_tree" as const, displayName: "Working tree" },
		};
		dashboard.scans = [scan];
		dashboard.latest = {
			scan,
			findings:
				securityMode === "findings"
					? [
							{
								id: "f1",
								scanId: "scan",
								title: "Untrusted path reaches file access",
								summary: "Isolated finding",
								severity: "high",
								confidence: "high",
								disposition: "open",
								validation: "unvalidated",
								evidence: [],
							},
						]
					: [],
		};
		if (securityMode === "running")
			dashboard.operations = [
				{
					operationId: "op",
					planId: "plan",
					scanId: "scan",
					phase: "reviewing",
					createdAt: now,
					updatedAt: now,
					findingCount: 0,
				},
			];
		return dashboard;
	};
	const SCHEMA_TABS = ["context", "model", "providers", "tasks", "files", "shell", "tools", "memory", "interaction"];
	/** A handler returning `undefined` replies itself (deferred, or ahead of the events it pushes). */
	const bridgeMethods: Record<string, (params: Params, reply: Reply) => unknown> = {
		ping: () => ({ version: "18.8.0" }),
		capabilities: () => ({ ompVersion: "18.8.0", unavailable: [] }),
		"composer.state": () => ({
			cwd: process.cwd(),
			autoRetryEnabled: true,
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			planModeEnabled,
			prewalkArmed: false,
			agentsPaused: false,
		}),
		"composer.context_report": () => ({
			contextWindow: 128_000,
			model: model.id,
			breakdown: {
				contextWindow: 128_000,
				anchored: true,
				usedTokens: 74_800,
				systemPromptTokens: 4_100,
				systemToolsTokens: 6_900,
				systemContextTokens: 1_450,
				skillsTokens: 820,
				messagesTokens: 61_530,
			},
		}),
		"composer.jobs": () => [
			{
				id: "done",
				type: "bash",
				label: "Completed local job",
				status: "completed",
				startTime: 1000,
				endTime: 3000,
			},
		],
		"composer.active_tools": () => ({ tools: [] }),
		"composer.skill_count": () => ({ skills: 0 }),
		"composer.share_preview": () => ({
			snapshotId: "fixture",
			preview: JSON.stringify({ entries }),
			serverUrl: "http://127.0.0.1/local-share",
			store: "blob",
			redactionEnabled: true,
		}),
		"composer.share": () => ({ url: "http://127.0.0.1/shared#local" }),
		settings_schema: () => ({
			tabs: SCHEMA_TABS.map(id => ({ id, label: id, groups: [] })),
			entries: [
				...SCHEMA_TABS.map(tab => ({
					path: tab === "context" ? "compaction.enabled" : `fixture.${tab}`,
					type: "boolean",
					tab,
					label: tab === "context" ? "Auto compaction" : `Fixture ${tab}`,
					description: "Isolated audit setting",
					default: true,
				})),
				{
					path: "compaction.reserveTokens",
					type: "number",
					tab: "context",
					label: "Reserve tokens",
					description: "Isolated numeric audit setting",
					default: 8192,
				},
			],
		}),
		settings_get: (params, reply) => {
			if (holdSettings && !params.paths) {
				holdSettings = false;
				const snapshot = { ...values };
				releaseSettings = () => reply({ values: snapshot, advisorEnabled: false, advisorActive: false });
				return undefined;
			}
			return { values, advisorEnabled: false, advisorActive: false };
		},
		settings_set: params => {
			const path = String(params.path);
			values[path] = params.value;
			return { path, value: params.value, savedValue: params.value };
		},
		models_catalog: () => ({ models: [model], discoveryStates: [], refreshPending: false, generation: 1 }),
		providers: () => ({
			providers: [
				{ id: "fixture", name: "Local fixture", hasAuth: true, authenticated: true, modelCount: 1 },
				...(loginProvider
					? [
							{
								id: "anthropic",
								name: "Anthropic",
								authenticated: anthropicSignedIn,
								authKind: anthropicSignedIn ? "oauth" : undefined,
								loginAvailable: true,
								disabled: false,
								modelCount: 0,
							},
						]
					: []),
			],
			models: [model],
			discoveryStates: [],
			refreshPending: false,
			generation: 1,
		}),
		security_dashboard: securityDashboard,
		ssh_hosts: () => ({ hosts: [], warnings: [], openSshAvailable: true }),
		"sessions.foreign_list": () => ({ sessions: [] }),
		"sessions.arg_completions": () => ({ items: [] }),
		"sessions.usage_history": () => ({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			sampledAt: Date.now(),
		}),
		"workspace.directories": () => ({ directories: [] }),
		image_generation_sync: () => ({}),
		reply_language_set: params => ({ language: typeof params.language === "string" ? params.language : null }),
		"modes.get_plan_mode": () => ({ enabled: planModeEnabled, proposal: planProposal }),
		"modes.set_plan_mode": params => {
			planModeEnabled = params.enabled === true;
			if (!planModeEnabled) planProposal = undefined;
			return { enabled: planModeEnabled };
		},
		"modes.get_loop_mode": () => ({ enabled: false, state: "off" }),
		"modes.get_vibe_mode": () => ({ enabled: false }),
		get_gui_themes: () => ({ themes: [] }),
		get_themes: () => ({ themes: [] }),
		get_plugins: () => ({ plugins: [] }),
		get_marketplaces: () => ({ marketplaces: [] }),
		get_prompt_templates: () => ({ templates: [] }),
		get_hooks: () => ({ hooks: [] }),
		get_mcp_servers: () => ({ servers: [] }),
		get_skills: () => ({ skills: [] }),
	};
	const serveBridge = (socket: net.Socket, line: string) => {
		const request: { id?: unknown; method?: unknown; params?: Params } = JSON.parse(line);
		const method = String(request.method);
		const params = request.params ?? {};
		record({ type: method, ...params });
		const reply = (result: unknown) => socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
		const fail = (error: string) => socket.write(`${JSON.stringify({ id: request.id, ok: false, error })}\n`);
		const handler = Object.hasOwn(bridgeMethods, method) ? bridgeMethods[method] : undefined;
		if (!handler) {
			fail(`Fixture bridge does not implement ${method}`);
			return;
		}
		try {
			const result = handler(params, reply);
			if (result !== undefined) reply(result);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
	};

	const MATH_REPLY = `只有统计口径相同时，才有：

\\[\\boxed{TPM = TPS \\times 60}\\]

- \\(P\\)：参数数量，例如 \\(8\\times10^9\\)。

那么，纯权重带宽模型下：

\\[
\\boxed{TPS_{\\text{decode}}\\approx \\frac{\\text{显存有效带宽，byte/s}}{\\text{每步读取的权重，byte}}}
\\]

纯生成阶段 TPS：

\\[
TPS_{\\text{decode}}
=
\\frac{500-1}{12-2}
=
49.9
\\]

减 1 是因为，第一个 token 已经在第 2 秒收到。

\\[
T_{\\text{请求}} = T_{\\text{排队等待}} + T_{\\text{网络传输}} + T_{\\text{输入预处理}} + T_{\\text{输入分词}} + T_{\\text{首令牌等待}} + \\frac{N_{\\text{输出令牌总数}}-1}{TPS_{\\text{decode}}} + T_{\\text{结果后处理}} + T_{\\text{客户端渲染}}
\\]`;

	const prompt = (message: string, respond: () => void) => {
		if (message === "fixture hold settings") {
			holdSettings = true;
			respond();
			return;
		}
		if (message === "fixture release settings") {
			releaseSettings?.();
			releaseSettings = undefined;
			respond();
			return;
		}
		respond();
		isStreaming = true;
		// The new turn takes the queued input with it.
		if (lanes.steering.length + lanes.followUp.length) {
			lanes.steering = [];
			lanes.followUp = [];
			emitQueue();
		}
		const user: AgentMessage = { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() };
		appendMessage(user);
		write({ type: "agent_start" });
		write({ type: "message_end", message: user });
		if (message === "fixture stream") {
			const answer: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
			write({ type: "message_start", message: answer });
			streamChunks = 0;
			streamTick = () => {
				streamChunks++;
				write({
					type: "message_update",
					message: answer,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: `Stream chunk ${streamChunks}.\n`,
						partial: answer,
					},
				});
			};
			clearInterval(streamTimer);
			streamTimer = setInterval(streamTick, 16);
		} else if (message === "fixture steps") {
			// A run of separate assistant messages, each thinking then calling a
			// tool, with gaps between them — the shape that used to mount a new
			// live work group per step.
			const turn: AgentMessage[] = [user];
			const step = (index: number) => {
				if (index === 4) {
					const answer: AgentMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Steps finished" }],
						timestamp: Date.now(),
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
					};
					appendMessage(answer);
					write({ type: "message_end", message: answer });
					turn.push(answer);
					endTurn(turn);
					return;
				}
				const id = `step-${Date.now()}-${index}`;
				const shell: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
				write({ type: "message_start", message: shell });
				write({
					type: "message_update",
					message: shell,
					assistantMessageEvent: {
						type: "thinking_delta",
						contentIndex: 0,
						delta: `Planning step ${index + 1}`,
						partial: shell,
					},
				});
				setTimeout(() => {
					const args = { command: `echo step ${index + 1}` };
					write({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args });
					const call: AgentMessage = {
						role: "assistant",
						content: [{ type: "toolCall", id, name: "bash", arguments: args }],
						timestamp: shell.timestamp,
						provider: model.provider,
						model: model.id,
						stopReason: "toolUse",
					};
					appendMessage(call);
					write({ type: "message_end", message: call });
					turn.push(call);
					setTimeout(() => {
						write({
							type: "tool_execution_end",
							toolCallId: id,
							toolName: "bash",
							result: { content: [{ type: "text", text: `step ${index + 1} done` }] },
							isError: false,
						});
						setTimeout(() => step(index + 1), 400);
					}, 400);
				}, 400);
			};
			step(0);
		} else if (message === "fixture edits") {
			// Commands with output lines alternating with file edits, whose diff
			// stats carry an `sr-only` label, so the live log fills well past its
			// window; the last command is left running and the turn never ends.
			const step = (index: number) => {
				const id = `edit-step-${Date.now()}-${index}`;
				const toolName = index % 2 === 1 ? "edit" : "bash";
				const args =
					toolName === "edit"
						? { path: `src/module-${index}.ts`, edits: [{ old_text: "a", new_text: "b\nc" }] }
						: { command: `run step ${index + 1}` };
				const call: AgentMessage = {
					role: "assistant",
					content: [{ type: "toolCall", id, name: toolName, arguments: args }],
					timestamp: Date.now(),
					provider: model.provider,
					model: model.id,
					stopReason: "toolUse",
				};
				write({ type: "turn_start" });
				write({ type: "message_start", message: { role: "assistant", content: [], timestamp: call.timestamp } });
				appendMessage(call);
				write({ type: "message_end", message: call });
				write({ type: "tool_execution_start", toolCallId: id, toolName, args });
				const output = Array.from({ length: 8 }, (_, line) => `step ${index + 1} output ${line + 1}`).join("\n");
				if (index === 6) {
					write({
						type: "tool_execution_update",
						toolCallId: id,
						toolName,
						args,
						partialResult: { content: [{ type: "text", text: output }] },
					});
					return;
				}
				const content: AgentMessage["content"] = [{ type: "text", text: toolName === "edit" ? "edited" : output }];
				const result =
					toolName === "edit" ? { content, details: { diff: "@@ -1 +1,2 @@\n-a\n+b\n+c" } } : { content };
				setTimeout(() => {
					write({ type: "tool_execution_end", toolCallId: id, toolName, result, isError: false });
					const toolResult: AgentMessage = {
						role: "toolResult",
						toolCallId: id,
						toolName,
						content: result.content,
						isError: false,
						timestamp: Date.now(),
					};
					appendMessage(toolResult);
					write({ type: "message_end", message: toolResult });
					write({ type: "turn_end", message: call, toolResults: [toolResult] });
					setTimeout(() => step(index + 1), 80);
				}, 80);
			};
			step(0);
		} else if (message === "fixture approval") {
			write({
				type: "extension_ui_request",
				id: "approval",
				method: "select",
				title: `Allow tool: bash\n${"x".repeat(2200)}\ncritical final argument`,
				options: ["Approve", "Deny"],
			});
		} else if (message === "fixture ask") {
			write({
				type: "extension_ui_request",
				id: "fixture-ask",
				method: "ask",
				questions: [
					{
						id: "env",
						header: "Target",
						question: "Where should this deploy?",
						options: [
							{ label: "Staging", description: "Safe environment for checks" },
							{ label: "Production", description: "Every user sees it" },
						],
						recommended: 0,
					},
					{
						id: "checks",
						header: "Checks",
						question: "Which checks should run first?",
						multi: true,
						options: [{ label: "Unit tests" }, { label: "E2E" }, { label: "Lint" }],
					},
					{
						id: "notify",
						header: "Notify",
						question: "Tell the team when it lands?",
						options: [{ label: "Yes" }, { label: "No" }],
					},
				],
			});
		} else if (message !== "fixture running") {
			const answer: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: message === "fixture math" ? MATH_REPLY : "Local fixture reply" }],
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
			};
			appendMessage(answer);
			write({ type: "message_end", message: answer });
			endTurn([user, answer]);
		}
	};

	const handleCommand = (command: { type?: unknown; id?: unknown; [key: string]: unknown }) => {
		record(command);
		const type = String(command.type);
		const text = (key: string) => (typeof command[key] === "string" ? command[key] : "");
		const ok = (data: unknown = {}) =>
			write({ type: "response", id: command.id, command: type, success: true, data });
		const fail = (error: string, code?: string) =>
			write({ type: "response", id: command.id, command: type, success: false, error, code });
		switch (type) {
			case "negotiate_protocol":
				if (command.protocolVersion !== 2) {
					fail(`Unsupported RPC protocol version: ${String(command.protocolVersion)}`);
					break;
				}
				ok({ protocolVersion: 2 });
				protocolVersion = 2;
				break;
			case "set_event_filter":
			case "set_ask_dialog":
			case "set_subagent_subscription":
			case "set_host_tools":
			case "set_host_uri_schemes":
				ok();
				break;
			case "get_state":
				ok(state());
				break;
			case "get_entries": {
				const leafId = entries.at(-1)?.id ?? null;
				if (command.since === undefined) {
					ok({ entries, leafId });
					break;
				}
				const index = entries.findIndex(entry => entry.id === command.since);
				if (index === -1) fail(`Unknown entries cursor: ${text("since")}`, "unknown_since");
				else ok({ entries: entries.slice(index + 1), leafId });
				break;
			}
			case "get_messages":
				ok({ messages: entries.flatMap(entry => (entry.type === "message" ? [entry.message] : [])) });
				break;
			case "get_subagents":
				ok({ subagents: subagentRoster });
				break;
			case "get_available_models":
				ok({ models: [model] });
				break;
			case "get_available_thinking_levels":
				ok({ levels: ["off", "low", "medium", "high"] });
				break;
			case "get_login_providers":
				ok({
					providers: loginProvider
						? [{ id: "anthropic", name: "Anthropic", available: true, authenticated: anthropicSignedIn }]
						: [],
				});
				break;
			case "get_provider_accounts":
				ok({ providerId: text("providerId"), accounts: [] });
				break;
			// Stock 18.8 (rpc-mode.ts `login`, Anthropic's oauth-code flow): open_url
			// is fire-and-forget, then a blocking `input` for the pasted code or
			// redirect URL (raced against the host's callback server, which never
			// fires here). The command answers once that input does.
			case "login": {
				if (command.providerId !== "anthropic") {
					fail(`Unknown OAuth provider: ${text("providerId")}`);
					break;
				}
				const urlId = `fixture-login-url-${Date.now()}`;
				const inputId = `fixture-login-input-${Date.now()}`;
				write({
					type: "extension_ui_request",
					id: urlId,
					method: "open_url",
					url: "https://claude.ai/oauth/authorize?code=true&client_id=fixture&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=xyz",
					launchUrl: "http://localhost:54545/launch",
					instructions: "Complete the sign-in in your browser.",
				});
				write({
					type: "extension_ui_request",
					id: inputId,
					method: "input",
					title: "Paste the authorization code (or full redirect URL):",
					timeout: 600_000,
				});
				pendingLogin = {
					urlId,
					inputId,
					finish: value => {
						pendingLogin = undefined;
						if (value?.trim()) {
							anthropicSignedIn = true;
							ok({ providerId: "anthropic" });
						} else fail("Login cancelled");
					},
				};
				break;
			}
			case "btw": {
				const now = Date.now();
				const btw = {
					id: `fixture-btw-${btwRecords.length + 1}`,
					leafId: null,
					question: text("question"),
					answer: "",
					status: "running",
					createdAt: now,
					updatedAt: now,
				};
				write({ type: "btw_record", record: btw });
				ok({ record: btw });
				const done = { ...btw, answer: "Local side answer", status: "complete", updatedAt: Date.now() };
				btwRecords.unshift(done);
				write({ type: "btw_delta", recordId: btw.id, delta: done.answer });
				write({ type: "btw_record", record: done });
				break;
			}
			case "btw_cancel":
				ok({ cancelled: false });
				break;
			case "get_btw_history":
				ok({ records: btwRecords });
				break;
			case "goal":
				ok({ goal: null, state: null });
				break;
			case "get_available_commands":
				ok({
					commands: [
						"jobs",
						"share",
						"live",
						"btw",
						"settings",
						"stats",
						"theme",
						"benchmark",
						"import",
						"context",
						"debug",
						"tools",
						"models",
						"providers",
						"modes",
						"hotkeys",
					].map(name => ({ name, source: "builtin", textModeExecutable: false, description: name })),
				});
				break;
			case "get_session_stats":
				ok(stats);
				break;
			case "live_start":
				write({ type: "live_phase", phase: "connecting" });
				write({ type: "live_phase", phase: "listening" });
				ok({ voice: text("voice") || "marin" });
				break;
			case "live_mute":
				ok({ muted: command.muted ?? true });
				break;
			case "live_stop":
				write({ type: "live_end" });
				ok();
				break;
			case "extension_ui_response":
				// The sign-in's requests are not a turn's: no response frame, no agent_end.
				if (pendingLogin && command.id === pendingLogin.urlId) break;
				if (pendingLogin && command.id === pendingLogin.inputId) {
					pendingLogin.finish(command.cancelled === true ? undefined : text("value"));
					break;
				}
				ok();
				endTurn([]);
				break;
			case "bash": {
				const line = text("command");
				if (line === "fixture:progress") {
					ok({ chunks: streamChunks });
					break;
				}
				// Hold the stream still (a tool running, the model thinking) so a
				// layout change can be observed without new text masking it.
				if (line === "fixture:pause") {
					clearInterval(streamTimer);
					ok();
					break;
				}
				if (line === "fixture:resume") {
					clearInterval(streamTimer);
					if (streamTick) streamTimer = setInterval(streamTick, 16);
					ok();
					break;
				}
				// Session title (stock's session_info_update): main carries it to the
				// tab's sidebar row and its notifications, background tabs included.
				if (line.startsWith("fixture:title:")) {
					write({ type: "session_info_update", title: line.slice("fixture:title:".length) });
					ok();
					break;
				}
				// A blocking confirm mid-run; the answer ends the turn (extension_ui_response).
				if (line === "fixture:confirm") {
					write({
						type: "extension_ui_request",
						id: "fixture-confirm",
						method: "confirm",
						title: "Deploy to staging?",
						message: "The agent wants to run the staging deploy script.",
					});
					ok();
					break;
				}
				// The running turn finishes normally (completion notification).
				if (line === "fixture:finish") {
					const answer: AgentMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Background run finished" }],
						timestamp: Date.now(),
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
					};
					appendMessage(answer);
					write({ type: "message_end", message: answer });
					endTurn([answer]);
					ok();
					break;
				}
				// The agent proposes a plan: plan mode turns on, the bridge pushes the
				// one-shot `plan_proposal` frame and keeps it for get_plan_mode.
				if (line === "fixture:plan") {
					planModeEnabled = true;
					planProposal = {
						planFilePath: `${process.cwd()}/.omp/plans/fixture-rollout.md`,
						title: "Fixture rollout plan",
						suggestedFileName: "FIXTURE_ROLLOUT.md",
						planContent: "## Steps\n\n1. Ship the background tab coverage.\n2. Watch the release run.",
						options: ["execute", "compact", "keep_context", "save", "refine"],
					};
					const frame = `${JSON.stringify({ event: { type: "plan_proposal", ...planProposal } })}\n`;
					for (const socket of bridgeClients) socket.write(frame);
					ok();
					break;
				}
				// The `next-prompt` extension's suggestion widget; `clear` is its own
				// clear on input / agent_start.
				if (line.startsWith("fixture:next-prompt:")) {
					const suggestion = line.slice("fixture:next-prompt:".length);
					write({
						type: "extension_ui_request",
						id: `next-prompt-${Date.now()}`,
						method: "setWidget",
						widgetKey: "next-prompt",
						widgetLines: suggestion === "clear" ? undefined : [`\x1b[2m↹ Tab  ${suggestion}\x1b[22m`],
						widgetPlacement: "belowEditor",
					});
					ok();
					break;
				}
				// A subagent roster for the sidebar rows and the dock line.
				if (line === "fixture:subagents") {
					const now = Date.now();
					subagentRoster = [
						{
							id: "sa-explore",
							index: 0,
							agent: "explore",
							description: "Map the settings code",
							status: "running",
							live: true,
							lastUpdate: now,
						},
						{
							id: "sa-review",
							index: 1,
							agent: "reviewer",
							description: "Review the sidebar diff",
							status: "completed",
							lastUpdate: now - 5000,
						},
						{
							id: "sa-nested",
							index: 2,
							agent: "task",
							description: "Read locale files",
							status: "running",
							live: true,
							parentSubagentId: "sa-explore",
							lastUpdate: now,
						},
					];
					ok();
					break;
				}
				// One roster subagent finishes: its terminal lifecycle frame, then the roster agrees.
				if (line.startsWith("fixture:subagents:finish:")) {
					const id = line.slice("fixture:subagents:finish:".length);
					const agent = subagentRoster.find(entry => entry.id === id);
					if (!agent) {
						fail(`Fixture has no subagent ${id}`);
						break;
					}
					agent.status = "completed";
					agent.live = false;
					agent.lastUpdate = Date.now();
					write({
						type: "subagent_lifecycle",
						payload: {
							id,
							agent: agent.agent,
							agentSource: "bundled",
							description: agent.description,
							status: "completed",
							parentSubagentId: agent.parentSubagentId,
							index: agent.index,
						},
					});
					ok();
					break;
				}
				// A todo tool call settling mid-run: the workspace dock appears above
				// the composer and takes height from the transcript viewport.
				if (line === "fixture:todo") {
					const tool = { toolCallId: `todo-${Date.now()}`, toolName: "todo" };
					const tasks = Array.from({ length: 6 }, (_, index) => ({
						content: `Fixture task ${index + 1}`,
						status: index === 0 ? "in_progress" : "pending",
					}));
					write({ type: "tool_execution_start", ...tool, args: {} });
					write({
						type: "tool_execution_end",
						...tool,
						result: {
							content: [{ type: "text", text: "todo updated" }],
							details: { phases: [{ name: "Fixture", tasks }] },
						},
						isError: false,
					});
					ok();
					break;
				}
				if (line === "fixture:large-tool") {
					const tool = { toolCallId: "large-tool", toolName: "bash" };
					write({ type: "tool_execution_start", ...tool, args: { command: "local audit fixture" } });
					write({
						type: "tool_execution_end",
						...tool,
						result: { content: [{ type: "text", text: "bounded output line\n".repeat(25000) }] },
						isError: false,
					});
					ok();
					break;
				}
				if (line.startsWith("fixture:security:")) {
					securityMode = line.slice("fixture:security:".length);
					ok();
					break;
				}
				ok({ output: "", exitCode: 0, cancelled: false, truncated: false });
				break;
			}
			case "steer":
			case "follow_up":
				lanes[type === "steer" ? "steering" : "followUp"].push(text("message"));
				ok();
				emitQueue();
				break;
			case "remove_queued_message": {
				const lane = command.queue === "steering" ? lanes.steering : lanes.followUp;
				const index = lane.indexOf(text("message"));
				if (index !== -1) lane.splice(index, 1);
				ok({ removed: index !== -1 });
				emitQueue();
				break;
			}
			case "abort":
				clearInterval(streamTimer);
				ok();
				endTurn([]);
				break;
			case "prompt":
				if (text("message") === "fixture uncertain") {
					prompt(text("message"), () => fail("Isolated lost acknowledgement", "rpc_delivery_unknown"));
					break;
				}
				prompt(text("message"), ok);
				break;
			default:
				fail(`Fixture does not implement ${type}`);
		}
	};

	const startRpc = () => {
		write({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_REASSEMBLED_BYTES,
		});
		createInterface({ input: process.stdin })
			.on("line", line => handleCommand(JSON.parse(line)))
			// Like stock rpc mode: the host closing stdin ends the process (a running stream timer would not).
			.on("close", () => process.exit(0));
	};

	// Like the real extension: inert unless loaded and handed an address, and listening before `ready`.
	const bridgeAddress = process.env.OMP_GUI_BRIDGE;
	if (extension && bridgeAddress) {
		fs.rmSync(bridgeAddress, { force: true });
		const server = net.createServer(socket => {
			bridgeClients.add(socket);
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line) serveBridge(socket, line);
				}
			});
			socket.on("close", () => bridgeClients.delete(socket));
			socket.on("error", () => bridgeClients.delete(socket));
		});
		// The bridge must never be what keeps the process alive.
		server.unref();
		process.once("exit", () => fs.rmSync(bridgeAddress, { force: true }));
		server.listen(bridgeAddress, startRpc);
	} else startRpc();
}
