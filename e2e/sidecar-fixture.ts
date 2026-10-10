#!/usr/bin/env bun
/// <reference types="bun" />
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as nodePath from "node:path";
import { createInterface } from "node:readline";
import type { AgentMessage, RpcSecurityDashboardResult, SubagentSnapshot } from "../src/shared/rpc-types";

// A local stand-in for the system omp the GUI drives: stock `--mode rpc-ui` on
// stdin/stdout, plus the gui-bridge extension's socket (loaded with `-e`,
// address in `OMP_GUI_BRIDGE`) answering the bridge methods the e2e suites
// reach. No provider credentials, external network, or user session files.
if (process.argv.includes("--version")) {
	console.log("omp/18.8.7");
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
} else if (process.env.OMP_GUI_TEST_MODEL_SETUP === "1" && process.argv.includes("rpc")) {
	// `OMP_GUI_TEST_MODEL_SETUP=1`: the model setup assistant's research job, stock
	// `--mode rpc` (src/main/model-setup-runner.ts). It answers set_event_filter and
	// the prompt, streams two tool calls, then the stock-shaped reply (a plan in a
	// code fence, with one unknown role the parser drops) and the prompt_result.
	const expected = [
		"--mode",
		"rpc",
		"--no-session",
		"--model",
		"*",
		"--thinking",
		"auto",
		"--tools",
		"web_search,read",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-lsp",
		"--no-title",
	];
	const argv = process.argv.slice(2);
	if (
		argv.length !== expected.length ||
		argv.some((arg, index) => expected[index] !== "*" && arg !== expected[index])
	) {
		console.error(`fixture: unexpected research argv: ${argv.join(" ")}`);
		process.exit(1);
	}
	const write = (frame: object) => process.stdout.write(`${JSON.stringify(frame)}\n`);
	const plan = {
		assignments: [
			{
				role: "default",
				model: "anthropic/claude-sonnet-4-5",
				reason: "Leads the coding benchmarks among the picks.",
			},
			{ role: "smol", model: "fixture/local-fixture", reason: "Fastest and cheapest pick." },
			{ role: "slow", model: "anthropic/claude-sonnet-4-5", reason: "Strongest reasoning scores." },
			{ role: "plan", model: "anthropic/claude-sonnet-4-5", reason: "Best long-horizon planning results." },
			{ role: "advisor", model: "fixture/local-fixture", reason: "A different vendor than the default model." },
			{ role: "reviewer", model: "fixture/local-fixture", reason: "Not a role omp knows." },
		],
		advisor: { enable: true, reason: "A capable second vendor is available." },
		sources: [{ title: "Fixture leaderboard", url: "https://example.com/leaderboard" }],
		notes: "Canned fixture plan.",
	};
	const research = async (id: unknown) => {
		await Bun.sleep(600);
		write({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "web_search",
			args: { query: "coding benchmarks 2026" },
		});
		await Bun.sleep(600);
		write({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "t1", toolName: "web_search", content: [] },
		});
		write({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "read",
			args: { path: "https://example.com/leaderboard" },
		});
		await Bun.sleep(600);
		write({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Comparing the picks." },
					{ type: "text", text: `Here is the plan:\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`` },
				],
				stopReason: "stop",
			},
		});
		write({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
	};
	const lines = createInterface({ input: process.stdin });
	lines.on("line", line => {
		const command = JSON.parse(line) as { id?: unknown; type?: unknown; message?: unknown };
		if (process.env.OMP_GUI_TEST_RECORD)
			fs.appendFileSync(
				process.env.OMP_GUI_TEST_RECORD,
				`${JSON.stringify({ type: `research:${String(command.type)}`, argv, message: command.message, recordedBy: "model-setup" })}\n`,
			);
		write({ type: "response", id: command.id, command: command.type, success: true });
		if (command.type === "prompt") void research(command.id);
	});
	// Stock RPC mode ends when its client closes stdin.
	lines.on("close", () => process.exit(0));
} else if (process.argv[2] === "update" && process.argv.includes("--check")) {
	console.log("Current version: 18.8.7\nAlready up to date");
} else if (!process.argv.includes("--mode")) {
	// Other CLI calls have no local stand-in.
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
	const sessionId = `fixture-${process.pid}`;
	const entries: Entry[] = [];
	/**
	 * `OMP_GUI_TEST_SESSION_FILES=1`: the journal is also a stock session file
	 * (title slot, header, entries) under `$PI_CODING_AGENT_DIR/sessions/`,
	 * created with the first entry and reported by get_state, so the GUI's
	 * session index lists it the way it lists real omp sessions.
	 */
	const sessionFile =
		process.env.OMP_GUI_TEST_SESSION_FILES === "1" && process.env.PI_CODING_AGENT_DIR
			? nodePath.join(process.env.PI_CODING_AGENT_DIR, "sessions", "fixture", `${sessionId}.jsonl`)
			: undefined;
	const sessionCreated = new Date().toISOString();
	let sessionTitle = "";
	const persistSession = () => {
		if (!sessionFile || entries.length === 0) return;
		const lines = [
			{ type: "title", v: 1, title: sessionTitle, updatedAt: new Date().toISOString() },
			{ type: "session", version: 3, id: sessionId, timestamp: sessionCreated, cwd: process.cwd() },
			...entries,
		];
		fs.mkdirSync(nodePath.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	};
	const append = (fields: { type: string; [key: string]: unknown }, time: number | string) => {
		entries.push({
			...fields,
			id: `entry-${entries.length + 1}`,
			parentId: entries.at(-1)?.id ?? null,
			timestamp: new Date(time).toISOString(),
		});
		persistSession();
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
		...(sessionFile ? { sessionFile } : {}),
		sessionName: sessionTitle || "Audit session",
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
	 * `OMP_GUI_TEST_MODELS=1` (with it) gives Settings › Models data to show:
	 * Anthropic starts signed in with two accounts and their quota, and the
	 * model roles and usage reads answer.
	 */
	const loginProvider = process.env.OMP_GUI_TEST_LOGIN === "1";
	const modelsData = loginProvider && process.env.OMP_GUI_TEST_MODELS === "1";
	let anthropicSignedIn = modelsData;
	let anthropicAccounts = modelsData
		? [
				{ credentialId: 1, label: "work@example.com", detail: "Claude Max · Work", type: "oauth", active: true },
				{ credentialId: 2, label: "home@example.com", detail: "Claude Pro", type: "oauth", active: false },
			]
		: [];
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
	// OMP_GUI_TEST_WORKTREE_LIFECYCLE=<onStart>:<onExit> sets stock's per-session
	// worktree settings (worktree-lifecycle.e2e.ts); unset leaves them out, so no
	// tab starts in a worktree.
	const worktreeLifecycle = /^(off|ask|create):(keep|ask|remove)$/.exec(
		process.env.OMP_GUI_TEST_WORKTREE_LIFECYCLE ?? "",
	);
	if (worktreeLifecycle) {
		values["worktree.onStart"] = worktreeLifecycle[1];
		values["worktree.onExit"] = worktreeLifecycle[2];
	}
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
	 * session id, so a multi-tab test can tell which tab's omp received it. The
	 * first line of each process is its `launch`: argv and working directory.
	 */
	const record = (frame: object) => {
		if (process.env.OMP_GUI_TEST_RECORD)
			fs.appendFileSync(process.env.OMP_GUI_TEST_RECORD, `${JSON.stringify({ ...frame, recordedBy: sessionId })}\n`);
	};
	record({ type: "launch", argv: process.argv.slice(2), cwd: process.cwd() });

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
	/** Stock's `subagent_lifecycle` frame for one roster subagent (any subscription level but `off`). */
	const writeLifecycle = (agent: SubagentSnapshot, status: "started" | "completed") =>
		write({
			type: "subagent_lifecycle",
			payload: {
				id: agent.id,
				agent: agent.agent,
				agentSource: "bundled",
				description: agent.description,
				status,
				parentSubagentId: agent.parentSubagentId,
				index: agent.index,
			},
		});

	// The gui-bridge extension's end of `OMP_GUI_BRIDGE`: `{id, method, params}` in,
	// `{id, ok, result|error}` and pushed `{event}` out (resources/gui-bridge/index.ts).
	type Params = Record<string, unknown>;
	type Reply = (result: unknown) => void;
	const bridgeClients = new Set<net.Socket>();
	/** The bridge's settings and role writes push config_update, as `resources/gui-bridge/settings.ts` does. */
	const emitConfigUpdate = () => {
		const frame = `${JSON.stringify({ event: { type: "config_update", model, thinkingLevel: "medium" } })}\n`;
		for (const socket of bridgeClients) socket.write(frame);
	};
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
	/** `OMP_GUI_TEST_MODELS`: the catalog's long tail, signed out, as a real omp lists it. */
	const MODELS_PAGE_PROVIDERS = [
		["openai-codex", "OpenAI Codex"],
		["github-copilot", "GitHub Copilot"],
		["openrouter", "OpenRouter"],
		["google-gemini-cli", "Google Gemini CLI"],
		["deepseek", "DeepSeek"],
		["groq", "Groq"],
		["mistral", "Mistral"],
		["xai", "xAI"],
		["cerebras", "Cerebras"],
		["fireworks", "Fireworks"],
		["together", "Together AI"],
		["perplexity", "Perplexity"],
	].map(([id, name]) => ({ id, name, authenticated: false, loginAvailable: true, disabled: false, modelCount: 0 }));
	const claudeModels = [
		{ ...model, id: "claude-opus-4-1", name: "Claude Opus 4.1", provider: "anthropic", contextWindow: 200000 },
		{ ...model, id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 1000000 },
	];
	const catalogModels = () => (modelsData && anthropicSignedIn ? [model, ...claudeModels] : [model]);
	/** `ResetPasses` (src/shared/rpc-types.ts) as the bridge shapes stock's saved resets. */
	interface FixtureResetPasses {
		count: number;
		usableCount: number;
		expiresAt?: number;
		title?: string;
		clears: string[];
		early: boolean;
		creditId?: string;
		redeemable: boolean;
	}
	const accountQuota: Record<
		number,
		{
			credentialId: number;
			state: string;
			remainingFraction: number;
			resetsAt?: number;
			limits: Array<{ id: string; label: string; usedFraction: number; windowLabel: string }>;
			resetPasses?: FixtureResetPasses;
		}
	> = {
		1: {
			credentialId: 1,
			state: "healthy",
			remainingFraction: 0.62,
			limits: [
				{ id: "5h", label: "5h", usedFraction: 0.38, windowLabel: "5 hours" },
				{ id: "7d", label: "Week", usedFraction: 0.21, windowLabel: "7 days" },
			],
		},
		2: {
			credentialId: 2,
			state: "depleted",
			remainingFraction: 0,
			resetsAt: Date.now() + 2 * 3_600_000,
			limits: [
				{ id: "5h", label: "5h", usedFraction: 1, windowLabel: "5 hours" },
				{ id: "7d", label: "Week", usedFraction: 0.64, windowLabel: "7 days" },
			],
		},
	};
	/**
	 * `OMP_GUI_TEST_RESET_PASSES=1` (with OMP_GUI_TEST_MODELS): both accounts hold
	 * saved rate-limit resets. work@ is under its limits, so its pass waits;
	 * home@ hit its 5h limit, so one of its two passes can be spent, and
	 * `reset_pass_redeem` clears that window the way stock's redeem does.
	 */
	if (modelsData && process.env.OMP_GUI_TEST_RESET_PASSES === "1") {
		const expiresAt = Date.now() + 9 * 86_400_000;
		accountQuota[1].resetPasses = {
			count: 1,
			usableCount: 0,
			expiresAt,
			clears: ["5h"],
			early: false,
			redeemable: false,
		};
		accountQuota[2].resetPasses = {
			count: 2,
			usableCount: 2,
			expiresAt,
			title: "One free rate limit reset",
			clears: ["5h"],
			early: false,
			creditId: "grant-home-1",
			redeemable: true,
		};
	}
	const resetPassMethods: Record<string, (params: Params, reply: Reply) => unknown> = {
		reset_pass_redeem: params => {
			const quota = accountQuota[Number(params.credentialId)];
			const passes = quota?.resetPasses;
			if (!quota || !passes?.redeemable || params.creditId !== passes.creditId) {
				return { ok: false, code: "not_redeemable", message: "nothing was spent" };
			}
			quota.limits = quota.limits.map(limit =>
				passes.clears.includes(limit.id) ? { ...limit, usedFraction: 0 } : limit,
			);
			quota.state = "healthy";
			quota.remainingFraction = 1 - Math.max(...quota.limits.map(limit => limit.usedFraction));
			delete quota.resetsAt;
			quota.resetPasses =
				passes.count > 1
					? { ...passes, count: passes.count - 1, usableCount: passes.usableCount - 1, redeemable: false }
					: undefined;
			return { ok: true, code: "reset", message: "Reset applied.", cleared: passes.clears };
		},
	};
	const modelRoles: Record<string, string | undefined> = {
		default: "anthropic/claude-sonnet-4-5",
		slow: "anthropic/claude-opus-4-1",
		commit: "fixture/local-fixture",
	};
	/** Like stock: the advisor runs when it is on and a model resolves (its own role, else the Thinking role). */
	const advisorState = (settings: Record<string, unknown>) => {
		const advisorEnabled = settings["advisor.enabled"] === true;
		return { advisorEnabled, advisorActive: advisorEnabled && Boolean(modelRoles.advisor ?? modelRoles.slow) };
	};
	const ROLE_META = [
		{ id: "default", name: "Default", section: "chat" },
		{ id: "smol", name: "Fast", tag: "SMOL", color: "success", section: "chat" },
		{ id: "slow", name: "Thinking", tag: "SLOW", color: "accent", section: "chat" },
		{ id: "plan", name: "Plan", tag: "PLAN", color: "info", section: "chat" },
		{ id: "advisor", name: "Advisor", tag: "ADVISOR", color: "accent", section: "chat" },
		{ id: "commit", name: "Commit messages", section: "kind" },
	];
	const modelsPageMethods: Record<string, (params: Params, reply: Reply) => unknown> = {
		model_roles: () => ({
			roles: ROLE_META.map(meta => ({
				...meta,
				...(modelRoles[meta.id] ? { model: modelRoles[meta.id] } : {}),
				source: modelRoles[meta.id] ? "global" : "default",
				candidates: catalogModels().map(entry => ({
					provider: entry.provider,
					id: entry.id,
					name: entry.name,
					kind: "chat",
				})),
			})),
		}),
		model_role_metadata: () => ({ roles: ROLE_META }),
		model_role_set: params => {
			modelRoles[String(params.role)] = typeof params.modelId === "string" ? params.modelId : undefined;
			emitConfigUpdate();
			return { role: params.role, modelId: params.modelId ?? null };
		},
		usage: () => ({
			reports: anthropicAccounts.map(account => ({
				provider: "anthropic",
				fetchedAt: Date.now(),
				account: account.label,
				credentialId: account.credentialId,
				active: account.credentialId === 1,
				limits: accountQuota[account.credentialId].limits,
				...(accountQuota[account.credentialId].resetPasses
					? { resetPasses: accountQuota[account.credentialId].resetPasses }
					: {}),
			})),
			session: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationTokens: 0,
				premiumRequests: 0,
				cost: 0,
			},
		}),
		provider_accounts: params => ({
			providerId: params.providerId,
			...(anthropicAccounts.some(account => account.credentialId === 1) ? { pinnedCredentialId: 1 } : {}),
			accounts:
				params.providerId === "anthropic"
					? anthropicAccounts.map(account => accountQuota[account.credentialId])
					: [],
		}),
		provider_logout: params => {
			if (params.providerId === "anthropic") {
				anthropicAccounts = [];
				anthropicSignedIn = false;
			}
			return { providerId: params.providerId };
		},
	};
	const gitIn = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	/** The primary checkout's root when `cwd` is one with commits (stock `canAutoCreateWorktree`), else null. */
	const primaryCheckout = (cwd: string): string | null => {
		try {
			const gitDir = fs.realpathSync(gitIn(cwd, "rev-parse", "--absolute-git-dir"));
			const common = fs.realpathSync(nodePath.resolve(cwd, gitIn(cwd, "rev-parse", "--git-common-dir")));
			if (gitDir !== common) return null;
			gitIn(cwd, "rev-parse", "--verify", "--quiet", "HEAD");
			return nodePath.dirname(common);
		} catch {
			return null;
		}
	};
	/** Stock's worktree-lifecycle bridge methods over the git CLI, shaped like `createSessionWorktree`. */
	const worktreeLifecycleMethods: Record<string, (params: Params, reply: Reply) => unknown> = {
		worktree_lifecycle_settings: () => ({
			onStart: values["worktree.onStart"],
			onExit: values["worktree.onExit"],
			eligible: primaryCheckout(process.cwd()) !== null,
		}),
		worktree_lifecycle_create: () => {
			const cwd = process.cwd();
			const primary = primaryCheckout(cwd);
			const root = process.env.OMP_WORKTREE_DIR;
			// Never the user's ~/.omp/wt from a test.
			if (!primary || !root)
				throw new Error("fixture worktree_lifecycle_create needs a repository and OMP_WORKTREE_DIR");
			const now = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
			// Two tabs can start in the same second; stock would refuse the second name.
			const branch = `wt/${stamp}-${process.pid}`;
			const baseCommit = gitIn(cwd, "rev-parse", "HEAD");
			const target = nodePath.join(
				root,
				`${branch.replaceAll(/[^A-Za-z0-9._-]+/g, "-")}-${createHash("sha1").update(primary).digest("hex").slice(0, 7)}`,
			);
			fs.mkdirSync(root, { recursive: true });
			gitIn(cwd, "branch", branch, baseCommit);
			gitIn(primary, "worktree", "add", "-q", target, branch);
			return { path: fs.realpathSync(target), branch, sourceCwd: cwd, baseCommit, root };
		},
	};
	const promptHistory: Array<{ prompt: string; created_at: number; cwd?: string }> = [];
	/** A handler returning `undefined` replies itself (deferred, or ahead of the events it pushes). */
	const bridgeMethods: Record<string, (params: Params, reply: Reply) => unknown> = {
		ping: () => ({ version: "18.8.7" }),
		capabilities: () => ({ ompVersion: "18.8.7", unavailable: [] }),
		history_recent: params =>
			promptHistory.filter(entry => !params.cwd || entry.cwd === params.cwd).slice(0, Number(params.limit ?? 200)),
		history_search: params =>
			promptHistory
				.filter(
					entry =>
						(!params.cwd || entry.cwd === params.cwd) &&
						String(params.query)
							.toLowerCase()
							.split(/\s+/)
							.every(token => entry.prompt.toLowerCase().includes(token)),
				)
				.slice(0, Number(params.limit ?? 100)),
		history_record: params => {
			const prompt = String(params.prompt);
			const skipped = /^\/(?:login|join)[\s:]/.test(prompt) || /^\/mcp[\s:]add\b.*--token\s/.test(prompt);
			if (!skipped) {
				const index = promptHistory.findIndex(entry => entry.prompt === prompt);
				if (index !== -1) promptHistory.splice(index, 1);
				promptHistory.unshift({
					prompt,
					created_at: Date.now() / 1000,
					cwd: typeof params.cwd === "string" ? params.cwd : undefined,
				});
			}
			return { skipped };
		},
		"stream_metadata.start": () => {
			write({ type: "token_rate", rate: 64 });
			return null;
		},
		"composer.state": () => ({
			cwd: process.cwd(),
			autoRetryEnabled: true,
			thinkingConfigured: "medium",
			planModeEnabled,
			prewalkArmed: false,
			agentsPaused: false,
		}),
		"composer.cycle_model_backward": () => {
			model.id = model.id === "local-fixture" ? "local-fixture-alt" : "local-fixture";
			return { model, thinkingLevel: "medium", isScoped: false };
		},
		"composer.copy_targets": () => ({
			targets: [
				{
					id: "msg:1",
					label: "Fixture copy target",
					preview: "Fixture copy target",
					content: "Fixture copy target",
				},
			],
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
		"composer.tool_extras": () => ({ sources: {}, mounted: [] }),
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
				// Settings › Features renders the advisor row only when the schema has the setting.
				...(modelsData
					? [
							{
								path: "advisor.enabled",
								type: "boolean",
								tab: "model",
								label: "Advisor",
								description: "A second model reviews the main model's turns.",
								default: false,
							},
						]
					: []),
				...(worktreeLifecycle
					? [
							{
								path: "worktree.onStart",
								type: "enum",
								tab: "tasks",
								group: "Isolation",
								label: "Worktree on Start",
								description: "Whether fresh interactive sessions start in a new linked worktree",
								default: "off",
								options: [
									{ value: "off", label: "Off" },
									{ value: "ask", label: "Ask" },
									{ value: "create", label: "Create" },
								],
							},
							{
								path: "worktree.onExit",
								type: "enum",
								tab: "tasks",
								group: "Isolation",
								label: "Worktree on Exit",
								description:
									"What to do on exit with worktrees created since omp started (on start or with `/wt`)",
								default: "keep",
								options: [
									{ value: "keep", label: "Keep" },
									{ value: "ask", label: "Ask" },
									{ value: "remove", label: "Remove" },
								],
							},
						]
					: []),
			],
		}),
		settings_get: (params, reply) => {
			if (holdSettings && !params.paths) {
				holdSettings = false;
				const snapshot = { ...values };
				releaseSettings = () => reply({ values: snapshot, ...advisorState(snapshot) });
				return undefined;
			}
			return { values, ...advisorState(values) };
		},
		settings_set: params => {
			const path = String(params.path);
			values[path] = params.value;
			emitConfigUpdate();
			return {
				path,
				value: params.value,
				savedValue: params.value,
				...(path === "advisor.enabled" ? advisorState(values) : {}),
			};
		},
		models_catalog: () => ({ models: catalogModels(), discoveryStates: [], refreshPending: false, generation: 1 }),
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
								modelCount: modelsData && anthropicSignedIn ? 2 : 0,
							},
							...(modelsData ? MODELS_PAGE_PROVIDERS : []),
						]
					: []),
			],
			models: catalogModels(),
			discoveryStates: [],
			refreshPending: false,
			generation: 1,
		}),
		security_dashboard: securityDashboard,
		ssh_hosts: () => ({ hosts: [], warnings: [], openSshAvailable: true }),
		"sessions.foreign_list": () => ({ sessions: [] }),
		"sessions.transcript": params => {
			const messages = entries
				.filter(entry => entry.type === "message")
				.map(entry => ({ ...(entry.message as AgentMessage), entryId: entry.id }));
			const offset = typeof params.offset === "number" ? params.offset : 0;
			const limit = typeof params.limit === "number" ? params.limit : messages.length;
			return {
				leafId: entries.at(-1)?.id ?? null,
				total: messages.length,
				messages: messages.slice(offset, offset + limit),
			};
		},
		"sessions.attach_entry_ids": params => ({
			messages: (params.messages as AgentMessage[]).map(message => {
				const entry = entries.find(
					candidate =>
						candidate.type === "message" && JSON.stringify(candidate.message) === JSON.stringify(message),
				);
				return entry ? { ...message, entryId: entry.id } : message;
			}),
		}),
		"sessions.tree": () => {
			const visible = entries.filter(
				entry => entry.type === "message" && ["user", "assistant"].includes((entry.message as AgentMessage).role),
			);
			return {
				activeLeafId: visible.at(-1)?.id ?? null,
				tree: visible.map((entry, index) => {
					const message = entry.message as AgentMessage;
					const content = message.content;
					const text =
						typeof content === "string"
							? content
							: (content ?? [])
									.filter(block => block.type === "text")
									.map(block => block.text)
									.join(" ");
					return {
						entryId: entry.id,
						parentId: visible[index - 1]?.id ?? null,
						role: message.role,
						textPreview: text.replace(/\s+/g, " ").trim().slice(0, 200),
						timestamp: Date.parse(entry.timestamp),
						onActiveBranch: true,
						isLeaf: index === visible.length - 1,
					};
				}),
			};
		},
		"sessions.delete": params => {
			const target = params.sessionPath;
			if (typeof target !== "string" || !target.endsWith(".jsonl")) throw new Error("Invalid session path");
			if (target === sessionFile) throw new Error("Cannot delete the active session");
			fs.rmSync(target, { force: true });
			fs.rmSync(target.slice(0, -6), { recursive: true, force: true });
			return null;
		},
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
		"git.worktree_location": params => ({
			root: process.env.OMP_WORKTREE_DIR ?? nodePath.join(process.env.PI_CODING_AGENT_DIR ?? "", "wt"),
			hash: Bun.hash(nodePath.resolve(String(params.primaryRoot)))
				.toString(16)
				.padStart(16, "0")
				.slice(-7),
		}),
		"workspace.resolve_path": params => ({ path: nodePath.resolve(process.cwd(), String(params.path)) }),
		image_generation_sync: () => ({}),
		reply_language_set: params => ({ language: typeof params.language === "string" ? params.language : null }),
		account_rotation_set: params => ({ mode: params.mode === "even" ? "even" : "quota" }),
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
		get_agent_definitions: () => ({ agents: [] }),
		get_memory_report: () => ({ backend: "none", entryCount: 0 }),
		model_roles: () => ({
			roles: ROLE_META.map(meta => ({
				...meta,
				source: "default",
				candidates: [{ provider: "fixture", id: "local-fixture", name: "Local fixture", kind: "chat" }],
			})),
		}),
		...(modelsData ? modelsPageMethods : {}),
		...(modelsData && process.env.OMP_GUI_TEST_RESET_PASSES === "1" ? resetPassMethods : {}),
		...(worktreeLifecycle ? worktreeLifecycleMethods : {}),
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
	// An svg fence as stock omp teaches models to write it (theme tokens), plus
	// a script and an onload handler the preview must never run.
	const SVG_REPLY = [
		"Here is the badge:",
		"",
		"```svg",
		'<svg viewBox="0 0 120 60" width="240" height="120" onload="window.__svgPwned = 1">',
		"  <script>window.__svgPwned = 2</script>",
		'  <rect x="4" y="4" width="112" height="52" rx="10" fill="none" stroke="var(--accent)" stroke-width="4"/>',
		'  <circle cx="30" cy="30" r="12" fill="var(--success)"/>',
		'  <text x="50" y="36" font-size="14" fill="var(--fg)">OMP</text>',
		"</svg>",
		"```",
	].join("\n");

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
		write({ type: "token_rate", rate: 64 });
		write({ type: "message_end", message: user });
		if (message === "fixture reads") {
			const targets = ["https://example.com/leaderboard", "xd://lsp", "src/a.ts"];
			const answer: AgentMessage = {
				role: "assistant",
				timestamp: Date.now(),
				content: targets.map((path, index) => ({
					type: "toolCall",
					id: `fixture-read-${index}`,
					name: "read",
					arguments: { path, __ompReadGroup: { path } },
				})),
			};
			write({ type: "message_start", message: answer });
			appendMessage(answer);
			write({ type: "message_end", message: answer });
			const results: AgentMessage[] = [];
			for (const [index, path] of targets.entries()) {
				const toolCallId = `fixture-read-${index}`;
				write({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path } });
				write({ type: "read_group_metadata", toolCallId, target: { path } });
				const content = [{ type: "text" as const, text: "fixture read output" }];
				write({ type: "tool_execution_end", toolCallId, toolName: "read", result: { content }, isError: false });
				const result: AgentMessage = {
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content,
					timestamp: Date.now(),
				};
				appendMessage(result);
				results.push(result);
			}
			endTurn([answer, ...results]);
		} else if (message === "fixture stream" || message === "fixture meter") {
			const answer: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
			write({ type: "message_start", message: answer });
			streamChunks = 0;
			streamTick = () => {
				streamChunks++;
				write({
					type: "message_update",
					message: answer,
					assistantMessageEvent: {
						type: message === "fixture meter" ? "thinking_delta" : "text_delta",
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
		} else if (message === "fixture transcript") {
			const answer: AgentMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "변경 범위를 확인하고 읽기 흐름을 정리해요." },
					{
						type: "text",
						text: '## 변경 사항\n\n본문과 `inlineCode`를 차분하게 읽을 수 있어요. [문서 보기](https://example.com/docs)\n\n- 첫 번째 항목\n- 긴 파일 경로도 확인해요: `src/components/transcript/very-long-component-name.tsx`\n\n> 중요한 맥락을 따로 표시해요.\n\n| 항목 | 상태 |\n| --- | --- |\n| 타입 검사 | 완료 |\n| 접근성 | 확인 중 |\n\n```typescript\nconst greeting = "안녕하세요";\nconsole.log(greeting);\n```\n\n다음 단계는 검토한 내용을 적용하는 거예요.',
					},
				],
				timestamp: Date.now(),
				stopReason: "error",
				errorMessage: "503 Service unavailable: fixture provider temporarily unavailable",
			};
			appendMessage(answer);
			write({ type: "message_end", message: answer });
			endTurn([user, answer]);
		} else if (message !== "fixture running") {
			const answer: AgentMessage = {
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							message === "fixture math"
								? MATH_REPLY
								: message === "fixture image"
									? "Here is the chart:\n\n![chart](pixel.png)"
									: message === "fixture svg"
										? SVG_REPLY
										: "Local fixture reply",
					},
				],
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
			case "cycle_model":
				model.id = model.id === "local-fixture" ? "local-fixture-alt" : "local-fixture";
				ok({ model, thinkingLevel: "medium", isScoped: false });
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
				ok({ models: catalogModels() });
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
			// Stock `get_logout_accounts` / one-account `logout` (the bridge's provider_accounts adds quotas).
			case "get_logout_accounts":
				ok({ accounts: command.providerId === "anthropic" ? anthropicAccounts : [] });
				break;
			case "logout":
				anthropicAccounts = anthropicAccounts.filter(account => account.credentialId !== command.credentialId);
				if (anthropicAccounts.length === 0) anthropicSignedIn = false;
				ok({ providerId: text("providerId") });
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
					sessionTitle = line.slice("fixture:title:".length);
					persistSession();
					write({ type: "session_info_update", title: sessionTitle });
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
				// omp withdraws that confirm unanswered (dialog timeout, abort).
				if (line === "fixture:confirm:cancel") {
					write({
						type: "extension_ui_request",
						id: `cancel-${Date.now()}`,
						method: "cancel",
						targetId: "fixture-confirm",
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
				// A subagent roster for the sidebar rows and the dock line; the live ones
				// announce their start the way stock does.
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
					for (const agent of subagentRoster) if (agent.live) writeLifecycle(agent, "started");
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
					writeLifecycle(agent, "completed");
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
			case "promote_queued_message": {
				// Stock: the first matching follow-up moves to the end of the steering lane.
				const index = lanes.followUp.indexOf(text("message"));
				if (index !== -1) lanes.steering.push(...lanes.followUp.splice(index, 1));
				ok({ promoted: index !== -1 });
				if (index !== -1) emitQueue();
				break;
			}
			case "abort_and_restore_queue": {
				// Stock (TUI Esc parity): withdraw the queued input first, then abort.
				const restored = {
					steering: lanes.steering.map(message => ({ text: message })),
					followUp: lanes.followUp.map(message => ({ text: message })),
				};
				const hadQueue = lanes.steering.length + lanes.followUp.length > 0;
				lanes.steering = [];
				lanes.followUp = [];
				if (hadQueue) emitQueue();
				clearInterval(streamTimer);
				ok(restored);
				if (isStreaming) endTurn([]);
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
