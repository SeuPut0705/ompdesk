#!/usr/bin/env bun
/// <reference types="bun" />
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createInterface } from "node:readline";
import { transcriptPageMessages, transcriptTurnStart } from "../resources/gui-bridge/transcript-page";
import type { AgentMessage, RpcSecurityDashboardResult, SubagentSnapshot } from "../src/shared/rpc-types";
import { tinyPdf } from "./tiny-pdf";
import { createWorkReplay, type RecordedWorkFrame, rebaseWorkRecording } from "./work-recording";

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
} else if (process.argv[2] === "-p") {
	// Print mode (scheduled runs): the prompt arrives on stdin; "fixture hang" keeps running until killed.
	const prompt = await Bun.stdin.text();
	if (process.env.OMP_GUI_TEST_RECORD) {
		const frame = { type: "print", argv: process.argv.slice(2), cwd: process.cwd(), prompt };
		fs.appendFileSync(process.env.OMP_GUI_TEST_RECORD, `${JSON.stringify(frame)}\n`);
	}
	console.log(`fixture print: ${prompt.trim()}`);
	if (prompt.includes("fixture hang")) setInterval(() => {}, 1000);
	else if (prompt.includes("fixture fail")) {
		console.error("fixture print failed");
		process.exit(4);
	}
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
	let activeLeafId: string | null = null;
	let holdHistory = false;
	let releaseHistory: (() => void) | undefined;
	let failHistory = false;
	const activeBranch = (): Entry[] => {
		const byId = new Map(entries.map(entry => [entry.id, entry]));
		const branch: Entry[] = [];
		let id = activeLeafId;
		while (id) {
			const entry = byId.get(id);
			if (!entry) break;
			branch.push(entry);
			id = entry.parentId;
		}
		return branch.reverse();
	};
	/** A message's text blocks joined by `separator` (stock's branch picker joins with none). */
	const messageText = (message: AgentMessage, separator: string) =>
		typeof message.content === "string"
			? message.content
			: (message.content ?? [])
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join(separator);
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
	const append = (fields: { type: string; [key: string]: unknown }, time: number | string, persist = true) => {
		entries.push({
			...fields,
			id: `entry-${entries.length + 1}`,
			parentId: activeLeafId,
			timestamp: new Date(time).toISOString(),
		});
		activeLeafId = entries.at(-1)?.id ?? null;
		if (persist) persistSession();
	};
	const appendMessage = (message: AgentMessage) =>
		append({ type: "message", message }, message.timestamp ?? Date.now());
	const seedLongSession = () => {
		entries.length = 0;
		activeLeafId = null;
		for (let turn = 0; turn < 250; turn++) {
			const time = 1700000000000 + turn * 6000;
			const messages: AgentMessage[] = [
				{ role: "user", content: `Long session turn ${String(turn).padStart(3, "0")}`, timestamp: time },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: `long-${turn}-a`, name: "read", arguments: { path: "a.ts" } }],
					timestamp: time + 1,
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: `long-${turn}-a`,
					toolName: "read",
					content: [{ type: "text", text: "const a = 1;" }],
					timestamp: time + 2,
					isError: false,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: `long-${turn}-b`, name: "read", arguments: { path: "b.ts" } }],
					timestamp: time + 3,
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: `long-${turn}-b`,
					toolName: "read",
					content: [{ type: "text", text: "const b = 2;" }],
					timestamp: time + 4,
					isError: false,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: `Long session answer ${String(turn).padStart(3, "0")}` }],
					timestamp: time + 5,
					stopReason: "stop",
				},
			];
			for (const message of messages) append({ type: "message", message }, message.timestamp ?? time, false);
		}
		persistSession();
	};
	if (process.env.OMP_GUI_TEST_LONG_SESSION === "1") seedLongSession();
	/**
	 * A stock session file becomes the journal (its last entry the leaf). Custom
	 * messages join the branch as stock's session context lists them.
	 * `OMP_GUI_TEST_SEED_SESSION=<file>` starts from a private copy of one (opt-in
	 * audits), so the transcript the GUI pages through is real; `switch_session`
	 * loads the file it is given.
	 */
	const loadJournal = (file: string) => {
		entries.length = 0;
		const header: { id?: string; title?: string } = {};
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line) continue;
			const entry = JSON.parse(line) as Entry;
			if (entry.type === "session") header.id = entry.id;
			if (entry.type === "title") header.title = String(entry.title ?? "");
			if (entry.type === "session" || entry.type === "title") continue;
			if (entry.type !== "custom_message") {
				entries.push(entry);
				continue;
			}
			const { customType, content, display, details } = entry;
			entries.push({
				type: "message",
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				message: { role: "custom", customType, content, display, details, timestamp: Date.parse(entry.timestamp) },
			});
		}
		activeLeafId = entries.at(-1)?.id ?? null;
		return header;
	};
	if (process.env.OMP_GUI_TEST_SEED_SESSION) loadJournal(process.env.OMP_GUI_TEST_SEED_SESSION);

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
	/** The stored session `switch_session` opened (a relaunch reopening a run it cut off). */
	let resumed: { id: string; file: string } | undefined;
	let isStreaming = false;
	/** The thinking selector and effort; `fixture reply actions` turns stock auto on and classifies the turn high. */
	let thinking = { level: "medium", configured: "medium" };
	/** `fixture usage limit` stops a turn on the provider's quota; its account resets at this time. */
	let usageLimitResetAt: number | undefined;
	let planModeEnabled = Boolean(process.env.OMP_GUI_TEST_PANEL_PLAN);
	// Stock `--session <file>`: the process boots on that stored session (a tab
	// opened on a fork, a restored tab), so get_state already names it.
	if (flags["--session"] && fs.existsSync(flags["--session"])) {
		const header = loadJournal(flags["--session"]);
		resumed = { id: header.id ?? sessionId, file: flags["--session"] };
		sessionTitle = header.title ?? "";
	}
	/** Stock `/btw` history, newest first. */
	const btwRecords: object[] = [];
	// Stock `get_state`: cwd, plan mode and the pause gate come from the bridge's `composer.state`.
	const state = () => ({
		model,
		thinkingLevel: thinking.level,
		isStreaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionId: resumed?.id ?? sessionId,
		...(resumed ? { sessionFile: resumed.file } : sessionFile ? { sessionFile } : {}),
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
		slowModeSupported,
		slowModeEnabled,
		...(slowModeSupported ? { slowModeScope: "session" } : {}),
		messageCount: entries.length,
		systemPrompt: [],
		dumpTools: [],
		contextUsage: { tokens: 74_800, contextWindow: 128_000, percent: 58 },
	});
	let securityMode = "disabled";
	/** Stock `/slow` applies to the model only with `OMP_GUI_TEST_SLOW_MODE=1` (other suites keep their Run settings). */
	const slowModeSupported = process.env.OMP_GUI_TEST_SLOW_MODE === "1";
	let slowModeEnabled = false;
	/** A user `!` bash held open by `fixture:hold-bash` until `abort_bash` settles it. */
	let heldBash: ((data: unknown) => void) | undefined;
	let streamTimer: Timer | undefined;
	let streamChunks = 0;
	let streamTick: (() => void) | undefined;
	/** get_subagents roster; `fixture:subagents` fills it (running, finished, nested). */
	let subagentRoster: SubagentSnapshot[] = [];
	let subagentSubscription = "progress";
	/** The emitted plan proposal awaiting `plan_approval`, as the bridge's get_plan_mode reports it. */
	let planProposal: Record<string, unknown> | undefined;
	/** Stock's agent writes the plan before proposing it; the fixture's proposal leaves the same file behind. */
	const writeProposedPlan = (proposal: Record<string, unknown>) => {
		if (typeof proposal.planFilePath !== "string" || typeof proposal.planContent !== "string") return;
		fs.mkdirSync(nodePath.dirname(proposal.planFilePath), { recursive: true });
		fs.writeFileSync(proposal.planFilePath, proposal.planContent);
	};
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
	/** Long-tail providers connected through the API-key sign-in below (`login` with an `input` for the key). */
	const apiKeyProviders = new Set<string>();
	/** Ids a later "Add another account" sign-in hands out, after the two seeded accounts. */
	let nextCredentialId = 3;
	/** Background jobs `composer.cancel_job` stopped; they then list as cancelled, the way stock reports them. */
	const cancelledJobs = new Set<string>();
	/** The `login` in flight: its open_url and input request ids, and how it ends. */
	let pendingLogin: { urlId: string; inputId: string; finish: (value: string | undefined) => void } | undefined;
	/** Code-paste requests a finished browser sign-in left open; stock resolves their late answers silently. */
	const leftoverLoginInputs = new Set<string>();
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
	/**
	 * `OMP_GUI_TEST_REPLAY_FRAMES` (e2e/event-replay.e2e.ts): every message and tool frame goes
	 * out a second time behind the next frame, so the GUI sees each one late and twice.
	 */
	const replayFrames = process.env.OMP_GUI_TEST_REPLAY_FRAMES === "1";
	let pendingReplay = "";
	const write = (frame: object) => {
		if ("type" in frame && frame.type === "subagent_event" && subagentSubscription !== "events") return;
		const json = JSON.stringify(frame);
		const bytes = Buffer.from(json, "utf8");
		if (protocolVersion < 2 || bytes.byteLength <= MAX_FRAME_BYTES) {
			if (!replayFrames) {
				process.stdout.write(`${json}\n`);
				return;
			}
			process.stdout.write(`${json}\n${pendingReplay}`);
			const replayable =
				"type" in frame && typeof frame.type === "string" && /^(message|tool_execution)_/.test(frame.type);
			pendingReplay = replayable ? `${json}\n` : "";
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
			/** Stock's shape (pi-ai `usage/claude.ts`): ids, English labels and canonical window ids. */
			limits: Array<{
				id: string;
				label: string;
				usedFraction: number;
				windowId: string;
				windowLabel: string;
				resetsAt?: number;
			}>;
			resetPasses?: FixtureResetPasses;
		}
	> = {
		1: {
			credentialId: 1,
			state: "healthy",
			remainingFraction: 0.62,
			limits: [
				{ id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 0.38, windowId: "5h", windowLabel: "5 Hour" },
				{ id: "anthropic:7d", label: "Claude 7 Day", usedFraction: 0.21, windowId: "7d", windowLabel: "7 Day" },
			],
		},
		2: {
			credentialId: 2,
			state: "depleted",
			remainingFraction: 0,
			resetsAt: Date.now() + 2 * 3_600_000,
			limits: [
				{ id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 1, windowId: "5h", windowLabel: "5 Hour" },
				{ id: "anthropic:7d", label: "Claude 7 Day", usedFraction: 0.64, windowId: "7d", windowLabel: "7 Day" },
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
			clears: ["anthropic:5h"],
			early: false,
			redeemable: false,
		};
		accountQuota[2].resetPasses = {
			count: 2,
			usableCount: 2,
			expiresAt,
			title: "One free rate limit reset",
			clears: ["anthropic:5h"],
			early: false,
			creditId: "grant-home-1",
			redeemable: true,
		};
	}
	/**
	 * `OMP_GUI_TEST_USAGE_DRIFT=1` (with OMP_GUI_TEST_MODELS): the quota moves
	 * between reads the way a live account does. Each window names its reset,
	 * and every usage read after the first spends 5% more of work@'s 5h window,
	 * so a surface that polls shows new numbers without being reopened.
	 */
	const usageDrift = modelsData && process.env.OMP_GUI_TEST_USAGE_DRIFT === "1";
	let usageReads = 0;
	if (usageDrift) {
		for (const quota of Object.values(accountQuota)) {
			quota.limits = quota.limits.map(limit => ({
				...limit,
				resetsAt: Date.now() + (limit.windowId === "5h" ? 3 * 3_600_000 : 4 * 86_400_000),
			}));
		}
	}
	const readUsage = () => {
		if (!usageDrift || usageReads++ === 0) return;
		accountQuota[1].limits = accountQuota[1].limits.map(limit =>
			limit.windowId === "5h" ? { ...limit, usedFraction: Math.min(1, limit.usedFraction + 0.05) } : limit,
		);
	};
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
		usage: () => {
			readUsage();
			return {
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
			};
		},
		provider_accounts: params => {
			readUsage();
			return {
				providerId: params.providerId,
				...(anthropicAccounts.some(account => account.credentialId === 1) ? { pinnedCredentialId: 1 } : {}),
				accounts:
					params.providerId === "anthropic"
						? anthropicAccounts.map(account => ({ ...accountQuota[account.credentialId], fetchedAt: Date.now() }))
						: [],
			};
		},
		provider_logout: params => {
			if (params.providerId === "anthropic") {
				anthropicAccounts = [];
				anthropicSignedIn = false;
			}
			apiKeyProviders.delete(String(params.providerId));
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
		worktree_lifecycle_create: params => {
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
			const branch = `${typeof params.branchPrefix === "string" ? params.branchPrefix : "wt/"}${stamp}-${process.pid}`;
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
	/** Stock's blob store: base64 bytes by sha256 hex, behind the `blob:sha256:` refs a journal persists. */
	const imageBlobs = new Map<string, string>();
	/** The delegation strength the GUI holds on this tab (gui-bridge modes/delegation.ts); spawn env first. */
	let delegationMode = process.env.OMP_GUI_DELEGATION ?? "default";
	/** Stock's relay server while a spec lets the agent into the preview (browser.relay_start). */
	let relayServer: { server: { stop(): void }; url: string; token: string } | null = null;
	/** A handler returning `undefined` replies itself (deferred, or ahead of the events it pushes). */
	const bridgeMethods: Record<string, (params: Params, reply: Reply) => unknown> = {
		capabilities: () => ({ ompVersion: "18.8.7", unavailable: [] }),
		// gui-bridge browser-relay.ts: stock's own relay server, loaded from the installed omp
		// only when a spec names it (OMP_E2E_STOCK_RELAY = stock's tools/browser/relay/server.ts).
		// The endpoint lands in OMP_E2E_RELAY_FILE so the spec can connect puppeteer to it.
		"browser.relay_start": (_params, reply) => {
			void (async () => {
				const modulePath = process.env.OMP_E2E_STOCK_RELAY;
				if (!modulePath) throw new Error("OMP_E2E_STOCK_RELAY is not set");
				if (!relayServer) {
					const { startRelayServer } = await import(modulePath);
					const probe = net.createServer();
					const listening = Promise.withResolvers<void>();
					probe.listen(0, "127.0.0.1", () => listening.resolve());
					await listening.promise;
					const address = probe.address();
					const port = typeof address === "object" && address ? address.port : 0;
					probe.close();
					const token = createHash("sha256").update(String(Math.random())).digest("base64url");
					relayServer = {
						server: startRelayServer({ port, token, group: false }),
						url: `http://127.0.0.1:${port}`,
						token,
					};
					if (process.env.OMP_E2E_RELAY_FILE)
						fs.writeFileSync(process.env.OMP_E2E_RELAY_FILE, JSON.stringify({ url: relayServer.url }));
				}
				reply({ url: relayServer.url, token: relayServer.token });
			})();
		},
		"browser.relay_stop": () => {
			relayServer?.server.stop();
			relayServer = null;
			return {};
		},
		read_image_blob: params => {
			const hash = /^blob:sha256:([a-f0-9]{64})$/.exec(String(params.ref))?.[1];
			if (!hash) throw new Error("Invalid image blob reference");
			return { data: imageBlobs.get(hash) ?? null };
		},
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
			thinkingConfigured: thinking.configured,
			planModeEnabled,
			prewalkArmed: false,
			agentsPaused: false,
		}),
		"composer.cycle_model_backward": () => {
			model.id = model.id === "local-fixture" ? "local-fixture-alt" : "local-fixture";
			return { model, thinkingLevel: "medium", isScoped: false };
		},
		// `/open`: no assistant link in the fixture transcript (opening one would start the user's browser).
		"composer.last_link": () => ({ href: null }),
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
		"composer.jobs": () =>
			[
				...(process.env.OMP_GUI_TEST_PANEL_PLAN
					? [
							{
								id: "watch",
								type: "bash",
								label: "Watching the delivery build",
								status: "running",
								startTime: Date.now() - 12_000,
								resultPreview: "\u001b[32mCompiled renderer\u001b[0m\nWatching for file changes…",
							},
						]
					: []),
				{
					id: "done",
					type: "bash",
					label: "Completed local job",
					status: "completed",
					startTime: 1000,
					endTime: 3000,
					resultPreview: process.env.OMP_GUI_TEST_PANEL_PLAN ? "Build completed successfully." : undefined,
				},
			].map(job => (cancelledJobs.has(job.id) ? { ...job, status: "cancelled", endTime: Date.now() } : job)),
		"composer.cancel_job": params => {
			cancelledJobs.add(String(params.id));
			return { cancelled: true };
		},
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
				// A safeguard the user turned on: Settings › Permissions asks before turning it off.
				{
					path: "secrets.enabled",
					type: "boolean",
					tab: "interaction",
					label: "Hide secrets",
					description: "Obfuscate configured secrets before sending to AI providers",
					default: true,
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
							...(modelsData
								? MODELS_PAGE_PROVIDERS.map(row =>
										apiKeyProviders.has(row.id) ? { ...row, authenticated: true, authKind: "apikey" } : row,
									)
								: []),
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
		"sessions.transcript": (params, reply) => {
			const messages = activeBranch()
				.filter(entry => entry.type === "message")
				.map(entry => ({ ...(entry.message as AgentMessage), entryId: entry.id }));
			const offset =
				typeof params.offset === "number" && Number.isInteger(params.offset) && params.offset >= 0
					? Math.min(params.offset, messages.length)
					: 0;
			const limit =
				typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 0
					? params.limit
					: messages.length;
			const end = Math.min(messages.length, offset + limit);
			// The bridge's own rule: a page starts at a turn, never at a steer inside one.
			const start = params.snapToTurn === true ? transcriptTurnStart(messages, offset, end) : offset;
			if (limit > 0 && failHistory) {
				failHistory = false;
				throw new Error("Fixture history page failed");
			}
			const result = {
				leafId: activeLeafId,
				total: messages.length,
				startIndex: start,
				messages: transcriptPageMessages(messages.slice(start, end)),
			};
			if (limit > 0 && holdHistory) {
				holdHistory = false;
				releaseHistory = () => reply(result);
				return undefined;
			}
			return result;
		},
		// Like the bridge: stock entries match the delivered message, and the reply carries the
		// read metadata the transcript has (the live delivery never does).
		"sessions.attach_entry_ids": params => ({
			messages: (params.messages as AgentMessage[]).map(message => {
				const bare = (value: unknown) =>
					JSON.stringify(value, (key, field) => (key === "__ompReadGroup" ? undefined : field));
				const entry = entries.find(
					candidate => candidate.type === "message" && bare(candidate.message) === bare(message),
				);
				return entry ? { ...(entry.message as AgentMessage), entryId: entry.id } : message;
			}),
		}),
		"sessions.tree": () => {
			const visible = entries.filter(
				entry => entry.type === "message" && ["user", "assistant"].includes((entry.message as AgentMessage).role),
			);
			const branchIds = new Set(activeBranch().map(entry => entry.id));
			const visibleIds = new Set(visible.map(entry => entry.id));
			const byId = new Map(entries.map(entry => [entry.id, entry]));
			const visibleParent = (entry: Entry) => {
				let parent = entry.parentId;
				while (parent && !visibleIds.has(parent)) parent = byId.get(parent)?.parentId ?? null;
				return parent;
			};
			const parents = new Set(visible.map(visibleParent));
			return {
				activeLeafId,
				tree: visible.map(entry => {
					const message = entry.message as AgentMessage;
					const text = messageText(message, " ");
					return {
						entryId: entry.id,
						parentId: visibleParent(entry),
						role: message.role,
						textPreview: text.replace(/\s+/g, " ").trim().slice(0, 200),
						timestamp: Date.parse(entry.timestamp),
						onActiveBranch: branchIds.has(entry.id),
						isLeaf: !parents.has(entry.id),
					};
				}),
			};
		},
		"sessions.switch_leaf": params => {
			if (typeof params.entryId !== "string" || !entries.some(entry => entry.id === params.entryId)) {
				throw new Error("Unknown session entry");
			}
			activeLeafId = params.entryId;
			return { cancelled: false, activeLeafId };
		},
		// Stock `fork_from`: a new session file holding the root→entry path.
		"sessions.fork_from": params => {
			const byId = new Map(entries.map(entry => [entry.id, entry]));
			const path: Entry[] = [];
			for (
				let entry = byId.get(String(params.entryId));
				entry;
				entry = entry.parentId ? byId.get(entry.parentId) : undefined
			)
				path.unshift(entry);
			if (path.length === 0) throw new Error("Unknown session entry");
			const forkId = `fixture-fork-${process.pid}-${Date.now()}`;
			const dir = sessionFile
				? nodePath.dirname(sessionFile)
				: fs.mkdtempSync(nodePath.join(os.tmpdir(), "omp-fork-"));
			const sessionPath = nodePath.join(dir, `${forkId}.jsonl`);
			const header = {
				type: "session",
				version: 3,
				id: forkId,
				timestamp: new Date().toISOString(),
				cwd: process.cwd(),
			};
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(sessionPath, `${[header, ...path].map(line => JSON.stringify(line)).join("\n")}\n`);
			return { sessionPath, sessionId: forkId };
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
		// Stock resolves `local://` under the session's artifacts; the fixture uses `<cwd>/local`.
		"sessions.resolve_local_url": params => {
			const url = String(params.url);
			if (!/^local:/i.test(url)) throw new Error("resolve_local_url requires a local:// URL");
			return { path: nodePath.join(process.cwd(), "local", url.replace(/^local:\/*/i, "")) };
		},
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
		"modes.get_delegation": () => ({ mode: delegationMode }),
		"modes.set_delegation": params => {
			delegationMode = typeof params.mode === "string" ? params.mode : "default";
			return { mode: delegationMode };
		},
		user_profile_set: params => ({
			name: typeof params.name === "string" ? params.name : "",
			experience: typeof params.experience === "string" ? params.experience : null,
		}),
		account_rotation_set: params => ({ mode: params.mode === "even" ? "even" : "quota" }),
		"modes.get_plan_mode": () => {
			let planFilePath: string | undefined;
			if (process.env.OMP_GUI_TEST_PANEL_PLAN) {
				planFilePath = nodePath.join(process.cwd(), "panel-fixture-plan.md");
				fs.copyFileSync(process.env.OMP_GUI_TEST_PANEL_PLAN, planFilePath);
			}
			// The bridge points the plan state at the reviewed file once the agent proposes it.
			planFilePath ??= typeof planProposal?.planFilePath === "string" ? planProposal.planFilePath : undefined;
			return { enabled: planModeEnabled || Boolean(planFilePath), planFilePath, proposal: planProposal };
		},
		"modes.set_plan_mode": params => {
			planModeEnabled = params.enabled === true;
			if (!planModeEnabled) planProposal = undefined;
			return { enabled: planModeEnabled };
		},
		// Approving keeps the context: plan mode ends and stock's synthetic prompt starts the
		// execution turn (a `fixture flow` run, driven like any other).
		"modes.plan_approval": params => {
			if (!planProposal) throw new Error("No plan is awaiting approval");
			planProposal = undefined;
			if (params.approved !== true) return { approved: false, dispatched: false, reason: "rejected" };
			planModeEnabled = false;
			setTimeout(() => {
				isStreaming = true;
				const developer: AgentMessage = {
					role: "developer",
					content: [{ type: "text", text: "Execute the approved plan." }],
					attribution: "agent",
					synthetic: true,
					timestamp: Date.now(),
				};
				appendMessage(developer);
				write({ type: "agent_start" });
				write({ type: "message_end", message: developer });
				startFlow(developer);
			}, 0);
			return { approved: true, dispatched: true };
		},
		"modes.get_loop_mode": () => ({ enabled: false, state: "off" }),
		"modes.get_vibe_mode": () => ({ enabled: false }),
		get_gui_themes: () => ({ themes: [] }),
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
		// Stock `fetchUsageReports` for the fixture provider: limited only after `fixture usage limit`.
		usage: () => ({
			reports:
				usageLimitResetAt === undefined
					? []
					: [{ provider: "fixture", fetchedAt: Date.now(), limits: [], resetAt: usageLimitResetAt }],
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
	// Bare path mentions (MixA A116/A117): a file with a line, a folder in inline
	// code, a Korean line reference, and a path that does not exist.
	const PATHS_REPLY = [
		"Updated local/PLAN.md:3 and wrote the notes into `local/`.",
		"",
		"local/PLAN.md 1번 줄 is the title; src/gone.ts was never created.",
	].join("\n");
	// Reply actions (MixA A113/A114, A118, A120): a web, a mail and a path link,
	// Korean glued to bold and to a bare URL, and a shell fence.
	const ACTIONS_REPLY = [
		"Read [the docs](http://127.0.0.1:9/docs), write to [the team](mailto:team@example.com) or open src/app.ts.",
		"",
		"결과는 **0.118%**이며 자세한 내용은 https://example.com/report에서 확인해요.",
		"",
		"```bash",
		"echo ompdesk-run-in-terminal",
		"```",
	].join("\n");
	// GitHub-flavored structure as a model writes it: anchors, local/mail links,
	// task list, aligned table, the five alerts, a plain quote, unlabeled and
	// labeled fences, a mermaid fence and footnotes.
	const MARKDOWN_REPLY = [
		"## Release checklist",
		"",
		"Jump to [the notes](#notes), open [the plan](local://PLAN.md), or write to [the team](mailto:team@example.com).",
		"",
		"- [x] Types pass",
		"- [ ] Captures in both themes",
		"",
		"| Step | Count | Owner |",
		"|:-----|:-----:|------:|",
		"| Build | 3 | ci |",
		"| Review | 12 | Kim |",
		"",
		"> [!NOTE]",
		"> Notes stay readable.",
		"",
		"> [!TIP]",
		"> Tips mark their rule only.",
		"",
		"> [!IMPORTANT]",
		"> Important carries the accent.",
		"",
		"> [!WARNING]",
		"> Back up first.",
		"",
		"> [!CAUTION]",
		"> This cannot be undone.",
		"",
		"> A plain quote stays upright.",
		"",
		"```",
		"function plain() { return 'no guessed colors'; }",
		"```",
		"",
		"```ts",
		"const answer: number = 42; // a long line that runs past the edge of the block so wrapping has something to do",
		"```",
		"",
		"```mermaid",
		"graph LR",
		"  Plan --> Build --> Ship",
		"```",
		"",
		"### Notes",
		"",
		"Footnotes link both ways.[^1]",
		"",
		"[^1]: Refs and backrefs point at each other.",
	].join("\n");
	// Streamed and then held mid-paragraph: the live tail must render, not show markers.
	const MARKDOWN_STREAM =
		"## Live answer\n\nThe first block is done.\n\nStreaming **bold**, `code` and a [link](https://example.com) render live while the";

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

	// Deterministic, held stages: the test advances only after observing the
	// current surface. This avoids racing screenshots against fixture timers.
	let advanceWork: (() => void) | undefined;
	let appendWorkOutput: (() => void) | undefined;
	/** `fixture:work-stream`: stream the current step's output and its subagents' events until the step moves on. */
	let streamWork: (() => void) | undefined;
	let workStreamTimer: Timer | undefined;
	let replayRecordedWork: (() => void) | undefined;
	const recordedMessages = new Map<string, AgentMessage[]>();
	const emitRecordedWork = (item: RecordedWorkFrame) => {
		if (item.channel === "main") {
			for (const event of item.events) {
				if (event.type === "message_end") appendMessage(event.message);
				write(event);
			}
			return;
		}
		const frame = item.frame;
		if (frame.type === "subagent_lifecycle") {
			const p = frame.payload;
			const existing = subagentRoster.find(node => node.id === p.id);
			const node: SubagentSnapshot = {
				...existing,
				id: p.id,
				index: p.index,
				agent: p.agent,
				agentSource: p.agentSource,
				status: p.status === "started" ? "running" : p.status,
				parentToolCallId: p.parentToolCallId,
				sessionFile: p.sessionFile,
				lastUpdate: Date.now(),
			};
			if (existing) Object.assign(existing, node);
			else subagentRoster.push(node);
		} else if (frame.type === "subagent_progress") {
			const node = subagentRoster.find(node => node.id === frame.payload.progress.id);
			if (node) Object.assign(node, { status: frame.payload.progress.status, progress: frame.payload.progress });
		} else if (frame.payload.event.type === "message_end") {
			const messages = recordedMessages.get(frame.payload.id) ?? [];
			messages.push(frame.payload.event.message);
			recordedMessages.set(frame.payload.id, messages);
		}
		write(frame);
	};
	const startWorkView = (user: AgentMessage) => {
		const screenshot = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="720" height="320" viewBox="0 0 720 320"><rect width="720" height="320" fill="#faf9f6"/><rect width="720" height="38" fill="#eceae5"/><circle cx="20" cy="19" r="5" fill="#b8b3a9"/><text x="44" y="24" font-family="sans-serif" font-size="12" fill="#69665e">example.com · Workspace</text><text x="48" y="94" font-family="sans-serif" font-size="28" fill="#35332e">Project overview</text><text x="48" y="124" font-family="sans-serif" font-size="14" fill="#827d73">A calm workspace for the next step.</text><rect x="48" y="158" width="288" height="110" rx="8" fill="#efede7"/><rect x="358" y="158" width="314" height="110" rx="8" fill="#efede7"/><text x="70" y="192" font-family="sans-serif" font-size="15" fill="#69665e">Implementation</text><text x="380" y="192" font-family="sans-serif" font-size="15" fill="#69665e">Review</text><text x="70" y="228" font-family="sans-serif" font-size="12" fill="#827d73">Ready to continue</text><text x="380" y="228" font-family="sans-serif" font-size="12" fill="#827d73">Reading source files</text></svg>',
		).toString("base64");
		type WorkFixtureStep = {
			name: string;
			args: Record<string, unknown>;
			result: { content: AgentMessage["content"]; details?: Record<string, unknown> };
		};
		// The edit step's two changes, each taller than the stage: following must land on the newest
		// one's first changed line, which neither the stage's top nor its bottom shows.
		const readyLines = ["  ready: false,", ...Array.from({ length: 16 }, (_, i) => `  check${i + 1}: true,`)];
		const startLines = [
			"export function start() {",
			...Array.from({ length: 16 }, (_, i) => `  run('step ${i + 1}');`),
			"}",
		];
		const editDiff = [
			`@@ -1,4 +1,${3 + readyLines.length} @@`,
			" export const workspace = {",
			"   title: 'Live work',",
			"-  ready: true,",
			...readyLines.map(line => `+${line}`),
			" };",
			`@@ -30,3 +${29 + readyLines.length},${2 + startLines.length} @@`,
			" // Starts the workspace.",
			"-export function start() {}",
			...startLines.map(line => `+${line}`),
			" export default workspace;",
		].join("\n");
		const steps: WorkFixtureStep[] = [
			{
				name: "bash",
				args: { command: "bun run check:types", intent: "Checking the workspace types" },
				result: {
					content: [{ type: "text", text: "$ tsc --noEmit\nChecking renderer components…" }],
					details: { exitCode: 0 },
				},
			},
			{
				name: "write",
				args: {
					path: "src/workspace.ts",
					content: "export const workspace = {\n  title: 'Live work',\n  ready: true,\n};\n",
				},
				result: { content: [{ type: "text", text: "Wrote src/workspace.ts" }] },
			},
			{
				name: "read",
				args: { path: "src/workspace.ts" },
				result: {
					content: [
						{ type: "text", text: "export const workspace = {\n  title: 'Live work',\n  ready: true,\n};" },
					],
					details: {
						displayContent: {
							text: "export const workspace = {\n  title: 'Live work',\n  ready: true,\n};",
							startLine: 1,
						},
					},
				},
			},
			{
				name: "task",
				args: {
					tasks: [
						{ name: "WorkspaceScout", task: "Read the workspace state" },
						{ name: "WorkspaceReview", task: "Review accessibility" },
					],
				},
				result: {
					content: [{ type: "text", text: "Agents are reading the workspace" }],
					details: {
						progress: [
							{ id: "WorkspaceScout", status: "running", lastIntent: "Reading source files" },
							{ id: "WorkspaceReview", status: "running", lastIntent: "Reviewing keyboard navigation" },
						],
					},
				},
			},
			{
				name: "wait",
				args: { i: "background activity" },
				result: { content: [{ type: "text", text: "Waiting for background activity" }] },
			},
			{
				name: "wait",
				args: { i: "background activity" },
				result: { content: [{ type: "text", text: "Waiting for background activity" }] },
			},
			{
				name: "browser",
				args: { action: "run", code: "await tab.screenshot()", url: "https://example.com/workspace" },
				result: {
					content: [{ type: "image", mimeType: "image/svg+xml", data: screenshot }],
					details: { url: "https://example.com/workspace" },
				},
			},
			{
				name: "computer",
				args: { action: "screenshot" },
				result: { content: [{ type: "image", mimeType: "image/svg+xml", data: screenshot }] },
			},
			{
				name: "edit",
				args: {
					path: "src/workspace.ts",
					edits: [
						{ old_text: "  ready: true,", new_text: readyLines.join("\n") },
						{ old_text: "export function start() {}", new_text: startLines.join("\n") },
					],
				},
				result: {
					content: [{ type: "text", text: "Updated workspace state" }],
					details: { diff: editDiff },
				},
			},
			{
				name: "eval",
				args: { code: "console.log(workspace.title)", language: "javascript" },
				result: { content: [{ type: "text", text: "Live work\nWorkspace state is ready" }] },
			},
			{
				name: "grep",
				args: { pattern: "workspace", path: "src" },
				result: {
					content: [
						{
							type: "text",
							text: "src/workspace.ts:1:export const workspace = {\nsrc/app.ts:4:import { workspace } from './workspace';",
						},
					],
				},
			},
			{
				name: "glob",
				args: { pattern: "src/*.ts" },
				result: { content: [{ type: "text", text: "src/workspace.ts\nsrc/app.ts" }] },
			},
			{
				name: "web_search",
				args: { query: "accessible keyboard navigation" },
				result: {
					content: [
						{
							type: "text",
							text: "Keyboard accessibility · W3C\nhttps://www.w3.org/WAI/\nMake every control reachable with the keyboard.",
						},
					],
				},
			},
		];
		const turn: AgentMessage[] = [user];
		let index = -1;
		const shell: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
		write({ type: "message_start", message: shell });
		write({
			type: "message_update",
			message: shell,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Preparing the workspace and checking the implementation.",
				partial: shell,
			},
		});
		const finishStep = () => {
			clearInterval(workStreamTimer);
			if (index < 0 || index >= steps.length) return;
			const step = steps[index];
			const id = `work-view-${index}`;
			if (step.name === "task") {
				step.result.details = {
					results: subagentRoster.map(agent => ({
						id: agent.id,
						agent: agent.agent,
						output: "Workspace has 5 lines.",
						exitCode: 0,
					})),
				};
				for (const agent of subagentRoster) {
					agent.status = "completed";
					const messages = recordedMessages.get(agent.id) ?? [];
					messages.push({
						role: "toolResult",
						toolCallId: `${agent.id}-bash`,
						toolName: "bash",
						content: [{ type: "text", text: `5 src/workspace.ts · ${agent.id}` }],
						details: { exitCode: 0 },
						isError: false,
						timestamp: Date.now(),
					});
					recordedMessages.set(agent.id, messages);
					write({
						type: "subagent_event",
						payload: {
							id: agent.id,
							event: {
								type: "tool_execution_end",
								toolCallId: `${agent.id}-bash`,
								toolName: "bash",
								result: {
									content: [{ type: "text", text: `5 src/workspace.ts · ${agent.id}` }],
									details: { exitCode: 0 },
								},
								isError: false,
							},
						},
					});
					write({
						type: "subagent_lifecycle",
						payload: { ...agent, agentSource: "bundled", status: "completed" },
					});
				}
			}
			write({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: step.name,
				result: step.result,
				isError: false,
			});
			const result: AgentMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: step.name,
				content: step.result.content,
				details: step.result.details,
				timestamp: Date.now(),
			};
			appendMessage(result);
			write({ type: "message_end", message: result });
			turn.push(result);
		};
		advanceWork = () => {
			finishStep();
			index++;
			if (index === steps.length) {
				const answer: AgentMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Live workspace finished" }],
					timestamp: Date.now(),
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
				};
				appendMessage(answer);
				write({ type: "message_end", message: answer });
				endTurn([...turn, answer]);
				advanceWork = undefined;
				appendWorkOutput = undefined;
				streamWork = undefined;
				return;
			}
			const step = steps[index];
			const id = `work-view-${index}`;
			// Like stock, the first call ends the reply whose thinking streamed since message_start:
			// one assistant message (same timestamp) carries the thinking and the call.
			const toolCall = { type: "toolCall" as const, id, name: step.name, arguments: step.args };
			const call: AgentMessage = {
				role: "assistant",
				content:
					index === 0
						? [
								{ type: "thinking", thinking: "Preparing the workspace and checking the implementation." },
								toolCall,
							]
						: [toolCall],
				timestamp: index === 0 ? shell.timestamp : Date.now(),
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
			};
			if (index > 0) write({ type: "message_start", message: call });
			appendMessage(call);
			write({ type: "message_end", message: call });
			turn.push(call);
			if (index === 0) {
				const notices: AgentMessage[] = [
					{
						role: "custom",
						id: "work-view-irc",
						customType: "irc:incoming",
						content: "Workspace coordination from ReaMcp",
						details: {
							from: "ReaMcp",
							message: "Workspace coordination is ready.\n**IRC details stay inside this work card.**",
						},
						timestamp: Date.now(),
					},
					{
						role: "custom",
						id: "work-view-advisor",
						customType: "advisor",
						content: "Advisor notes",
						details: {
							notes: [
								{
									note: "Check keyboard reachability before finishing.\n**Advisor details stay inside this work card.**",
									severity: "concern",
								},
							],
						},
						timestamp: Date.now(),
					},
				];
				for (const notice of notices) {
					appendMessage(notice);
					write({ type: "message_end", message: notice });
					turn.push(notice);
				}
			}
			write({ type: "tool_execution_start", toolCallId: id, toolName: step.name, args: step.args });
			write({
				type: "tool_execution_update",
				toolCallId: id,
				toolName: step.name,
				args: step.args,
				// Stock reports a command's exit code only with its end, never on a running update.
				partialResult: step.name === "bash" ? { content: step.result.content } : step.result,
			});
			if (step.name === "task") {
				subagentRoster = ["WorkspaceScout", "WorkspaceReview"].map((name, agentIndex) => ({
					id: name,
					index: agentIndex,
					agent: "scout",
					status: "running",
					live: true,
					parentToolCallId: id,
					lastUpdate: Date.now(),
				}));
				for (const agent of subagentRoster)
					write({ type: "subagent_lifecycle", payload: { ...agent, agentSource: "bundled", status: "started" } });
				for (const agent of subagentRoster) {
					recordedMessages.set(agent.id, [
						// Progress counts the completed read, then the wc execution below.
						// Keep that first call in the transcript so catch-up has no phantom gap.
						{
							role: "assistant",
							timestamp: Date.now() - 2,
							content: [
								{
									type: "toolCall",
									id: `${agent.id}-read`,
									name: "read",
									arguments: { path: "src/workspace.ts" },
								},
							],
						},
						{
							role: "toolResult",
							toolCallId: `${agent.id}-read`,
							toolName: "read",
							content: [{ type: "text", text: "export const workspace = { ready: true };" }],
							isError: false,
							timestamp: Date.now() - 1,
						},
						{
							role: "assistant",
							timestamp: Date.now(),
							content: [
								{
									type: "toolCall",
									id: `${agent.id}-bash`,
									name: "bash",
									arguments: { command: "wc -l src/workspace.ts", intent: "Counting workspace lines" },
								},
							],
						},
					]);
					agent.progress = {
						id: agent.id,
						index: agent.index,
						agent: agent.agent,
						agentSource: "bundled",
						status: "running",
						task: "Inspect workspace",
						lastIntent: agent.index === 0 ? "Reading source files" : "Reviewing keyboard navigation",
						currentTool: "bash",
						currentToolArgs: JSON.stringify({ command: "wc -l src/workspace.ts" }),
						currentToolIntent: agent.index === 0 ? "Reading source files" : "Reviewing keyboard navigation",
						recentTools: [],
						recentOutput: [],
						toolCount: 1,
						requests: 1,
						tokens: 10,
						cost: 0,
						durationMs: 100,
					};
					write({
						type: "subagent_progress",
						payload: {
							index: agent.index,
							agent: agent.agent,
							agentSource: "bundled",
							task: "Inspect workspace",
							parentToolCallId: id,
							progress: agent.progress,
						},
					});
				}
			}
		};
		appendWorkOutput = () => {
			if (index === 3) {
				for (const agent of subagentRoster) {
					if (agent.progress) {
						agent.progress = {
							...agent.progress,
							currentToolIntent: "Counting source lines",
							toolCount: 2,
							tokens: 84,
							durationMs: 1200,
						};
						write({
							type: "subagent_progress",
							payload: {
								index: agent.index,
								agent: agent.agent,
								agentSource: "bundled",
								task: "Inspect workspace",
								parentToolCallId: agent.parentToolCallId,
								progress: agent.progress,
							},
						});
					}
					write({
						type: "subagent_event",
						payload: {
							id: agent.id,
							event: {
								type: "tool_execution_start",
								toolCallId: `${agent.id}-bash`,
								toolName: "bash",
								args: { command: "wc -l src/workspace.ts", intent: "Counting workspace lines" },
							},
						},
					});
					write({
						type: "subagent_event",
						payload: {
							id: agent.id,
							event: {
								type: "tool_execution_update",
								toolCallId: `${agent.id}-bash`,
								toolName: "bash",
								args: { command: "wc -l src/workspace.ts" },
								partialResult: { content: [{ type: "text", text: `5 src/workspace.ts · ${agent.id}` }] },
							},
						},
					});
				}
				return;
			}
			if (index !== 0) return;
			steps[0].result = {
				content: [
					{
						type: "text",
						text: "$ tsc --noEmit\nChecking renderer components…\nChecking workspace state…\n\u001b[32mAll types are valid\u001b[0m",
					},
				],
				details: { exitCode: 0 },
			};
			write({
				type: "tool_execution_update",
				toolCallId: "work-view-0",
				toolName: "bash",
				args: steps[0].args,
				partialResult: { content: steps[0].result.content },
			});
		};
		streamWork = () => {
			clearInterval(workStreamTimer);
			const step = steps[index];
			if (!step) return;
			const id = `work-view-${index}`;
			let tick = 0;
			let output = "";
			const agentOutput = new Map<string, string>();
			const agentReply = new Map<string, string>();
			const replyStart = Date.now();
			// ~30 frames a second, the rate stock forwards a busy tool's partials.
			workStreamTimer = setInterval(() => {
				tick++;
				output += `${step.name} output line ${tick}: ${"x".repeat(tick % 80)}\n`;
				if (step.name === "bash")
					write({
						type: "tool_execution_update",
						toolCallId: id,
						toolName: step.name,
						args: step.args,
						partialResult: { content: [{ type: "text", text: output }] },
					});
				for (const agent of subagentRoster) {
					const text = `${agentOutput.get(agent.id) ?? ""}${agent.id} line ${tick}\n`;
					agentOutput.set(agent.id, text);
					write({
						type: "subagent_event",
						payload: {
							id: agent.id,
							event: {
								type: "tool_execution_update",
								toolCallId: `${agent.id}-bash`,
								toolName: "bash",
								args: { command: "wc -l src/workspace.ts" },
								partialResult: { content: [{ type: "text", text }] },
							},
						},
					});
					// Stock forwards a subagent's stream unfiltered ("full" message updates):
					// every delta carries the whole reply so far, twice.
					const delta = `Checking ${agent.id} step ${tick}. `;
					const reply = `${agentReply.get(agent.id) ?? ""}${delta}`;
					agentReply.set(agent.id, reply);
					const message: AgentMessage = {
						role: "assistant",
						content: [{ type: "text", text: reply }],
						timestamp: replyStart,
					};
					write({
						type: "subagent_event",
						payload: {
							id: agent.id,
							event: {
								type: "message_update",
								message,
								assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
							},
						},
					});
					if (agent.progress && tick % 10 === 0) {
						agent.progress = { ...agent.progress, tokens: agent.progress.tokens + 40, durationMs: tick * 33 };
						write({
							type: "subagent_progress",
							payload: {
								index: agent.index,
								agent: agent.agent,
								agentSource: "bundled",
								task: "Inspect workspace",
								parentToolCallId: agent.parentToolCallId,
								progress: agent.progress,
							},
						});
					}
				}
			}, 33);
		};
	};
	/**
	 * `fixture flow`: one turn played op by op through `fixture:flow:<json>` bash lines, in stock's
	 * event order, so an audit can stage a real run's sequence: calls and their agents, steers and
	 * follow-ups, a question, a mid-turn compaction, a plan proposal (stock's silent abort), a stop.
	 */
	let flow:
		| {
				op: (spec: Record<string, unknown>) => string | undefined;
				answer: (command: Record<string, unknown>) => boolean;
				abort: () => boolean;
		  }
		| undefined;
	const startFlow = (user: AgentMessage) => {
		const turn: AgentMessage[] = [user];
		const running = new Map<string, string>();
		subagentRoster = [];
		let pendingAsk: string | undefined;
		let asks = 0;
		const say = (message: AgentMessage) => {
			appendMessage(message);
			write({ type: "message_start", message });
			write({ type: "message_end", message });
			turn.push(message);
		};
		const call = (id: string, name: string, args: Record<string, unknown>) => {
			say({
				role: "assistant",
				content: [{ type: "toolCall", id, name, arguments: args }],
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
			});
			running.set(id, name);
			write({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
		};
		const end = (id: string, text: string, isError: boolean, details?: Record<string, unknown>) => {
			const name = running.get(id) ?? "bash";
			running.delete(id);
			const content: AgentMessage["content"] = [{ type: "text", text }];
			write({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content, details }, isError });
			const result: AgentMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: name,
				content,
				details,
				isError,
				timestamp: Date.now(),
			};
			appendMessage(result);
			write({ type: "message_end", message: result });
			turn.push(result);
		};
		const settle = (agent: SubagentSnapshot, status: "completed" | "aborted") => {
			agent.status = status;
			agent.live = false;
			agent.lastUpdate = Date.now();
			write({ type: "subagent_lifecycle", payload: { ...agent, agentSource: "bundled", status } });
		};
		const finish = (last: AgentMessage) => {
			say(last);
			endTurn([...turn]);
			flow = undefined;
		};
		flow = {
			op: spec => {
				const id = typeof spec.id === "string" ? spec.id : "";
				switch (spec.op) {
					case "call": {
						const name = String(spec.name);
						call(id, name, (spec.args as Record<string, unknown> | undefined) ?? {});
						for (const agentId of (spec.agents as string[] | undefined) ?? []) {
							const agent: SubagentSnapshot = {
								id: agentId,
								index: subagentRoster.length,
								agent: "explore",
								description: `${agentId} task`,
								status: "running",
								live: true,
								parentToolCallId: id,
								lastUpdate: Date.now(),
							};
							subagentRoster.push(agent);
							write({
								type: "subagent_lifecycle",
								payload: { ...agent, agentSource: "bundled", status: "started" },
							});
						}
						return undefined;
					}
					case "output":
						write({
							type: "tool_execution_update",
							toolCallId: id,
							toolName: running.get(id) ?? "bash",
							partialResult: { content: [{ type: "text", text: String(spec.text) }] },
						});
						return undefined;
					case "end": {
						if (!running.has(id)) return `Flow has no running call ${id}`;
						const agents = subagentRoster.filter(agent => agent.parentToolCallId === id);
						for (const agent of agents) if (agent.live) settle(agent, "completed");
						const details = agents.length
							? {
									results: agents.map(agent => ({
										id: agent.id,
										agent: agent.agent,
										exitCode: 0,
										output: `${agent.id} finished its part.`,
										durationMs: 1500,
									})),
								}
							: running.get(id) === "bash"
								? { exitCode: spec.error ? 1 : 0 }
								: undefined;
						// A renderer audit passes the tool's own `details` (stock's result shape) with `end`.
						const given = spec.details as Record<string, unknown> | undefined;
						end(id, String(spec.text ?? "done"), spec.error === true, given ?? details);
						return undefined;
					}
					// Stock delivers queued steers into the running loop as `steering` user messages.
					case "steer": {
						const steers = lanes.steering.splice(0);
						emitQueue();
						for (const text of steers)
							say({ role: "user", content: [{ type: "text", text }], steering: true, timestamp: Date.now() });
						return steers.length ? undefined : "No steer queued";
					}
					case "ask": {
						asks++;
						const askId = `flow-ask-${asks}`;
						const questions = [
							{
								id: "target",
								header: "Target",
								question: "Which environment should the checks use?",
								options: [{ label: "Staging" }, { label: "Production" }],
								recommended: 0,
							},
						];
						call(askId, "ask", { questions });
						pendingAsk = askId;
						write({ type: "extension_ui_request", id: askId, method: "ask", questions });
						return undefined;
					}
					// Stock's mid-turn maintenance: start, the compaction entry, end (the loop goes on).
					case "compact-start":
						write({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
						return undefined;
					case "compact-end": {
						const kept = entries.find(entry => entry.message === user)?.id;
						const compaction = {
							summary: "Compacted the run so far.",
							firstKeptEntryId: kept,
							tokensBefore: 182_000,
							tokensAfter: 24_000,
						};
						append({ type: "compaction", ...compaction }, Date.now());
						write({
							type: "auto_compaction_end",
							action: "context-full",
							result: compaction,
							aborted: false,
							willRetry: false,
						});
						return undefined;
					}
					// The plan proposal: the bridge pushes the frame, then stock's silent abort ends the turn.
					case "propose": {
						planModeEnabled = true;
						planProposal = {
							planFilePath: `${process.cwd()}/.omp/plans/flow-plan.md`,
							title: "Flow rollout plan",
							suggestedFileName: "FLOW_PLAN.md",
							planContent: "## Steps\n\n1. Split the checks.\n2. Run them in parallel.",
							options: ["execute", "compact", "keep_context", "save", "refine"],
						};
						writeProposedPlan(planProposal);
						const frame = `${JSON.stringify({ event: { type: "plan_proposal", ...planProposal } })}\n`;
						for (const socket of bridgeClients) socket.write(frame);
						finish({
							role: "assistant",
							content: [],
							stopReason: "aborted",
							errorMessage: "__omp.silent_abort__",
							errorId: 0x0200_0000,
							timestamp: Date.now(),
							provider: model.provider,
							model: model.id,
						});
						return undefined;
					}
					// The reply; queued follow-ups then enter the same run as new user turns.
					case "reply": {
						const answer: AgentMessage = {
							role: "assistant",
							content: [{ type: "text", text: String(spec.text ?? "Flow finished") }],
							timestamp: Date.now(),
							provider: model.provider,
							model: model.id,
							stopReason: "stop",
						};
						const followUps = lanes.followUp.splice(0);
						if (!followUps.length) {
							finish(answer);
							return undefined;
						}
						say(answer);
						emitQueue();
						for (const text of followUps)
							say({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
						return undefined;
					}
					default:
						return `Unknown flow op ${String(spec.op)}`;
				}
			},
			answer: command => {
				if (!pendingAsk || command.id !== pendingAsk) return false;
				const answer = JSON.stringify(command.answers ?? command.value ?? null);
				end(pendingAsk, `User answered: ${answer}`, false);
				pendingAsk = undefined;
				return true;
			},
			// Stock's stop: running calls end aborted, live agents with them, then the empty aborted reply.
			abort: () => {
				for (const agent of subagentRoster) if (agent.live) settle(agent, "aborted");
				for (const [id, name] of [...running]) {
					// Stock's task returns its partial results, each cut-off agent marked aborted.
					if (name !== "task") {
						end(id, "Command aborted", true);
						continue;
					}
					const results = subagentRoster
						.filter(agent => agent.parentToolCallId === id)
						.map(agent => ({ id: agent.id, agent: agent.agent, aborted: true, exitCode: 1, output: "" }));
					end(id, "Tasks aborted", false, { results });
				}
				finish({
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "Interrupted by user",
					timestamp: Date.now(),
					provider: model.provider,
					model: model.id,
				});
				return true;
			},
		};
	};
	/** `fixture steer work`: one turn that takes a steer mid-run, driven by `fixture:steer-*` bash lines. */
	let steerWork: { deliver: () => void; finish: () => void } | undefined;
	const startSteerWork = (user: AgentMessage) => {
		const turn: AgentMessage[] = [user];
		subagentRoster = [];
		const startCall = (id: string, name: string, args: Record<string, unknown>) => {
			const call: AgentMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id, name, arguments: args }],
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
			};
			write({ type: "message_start", message: call });
			appendMessage(call);
			write({ type: "message_end", message: call });
			turn.push(call);
			write({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
		};
		const endCall = (id: string, name: string, text: string, details?: Record<string, unknown>) => {
			const content: AgentMessage["content"] = [{ type: "text", text }];
			write({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: name,
				result: { content, details },
				isError: false,
			});
			const result: AgentMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: name,
				content,
				details,
				isError: false,
				timestamp: Date.now(),
			};
			appendMessage(result);
			write({ type: "message_end", message: result });
			turn.push(result);
		};
		const startAgent = (id: string, parentToolCallId: string, task: string) => {
			const agent: SubagentSnapshot = {
				id,
				index: subagentRoster.length,
				agent: "debugger",
				status: "running",
				live: true,
				parentToolCallId,
				lastUpdate: Date.now(),
			};
			subagentRoster.push(agent);
			write({ type: "subagent_lifecycle", payload: { ...agent, agentSource: "bundled", status: "started" } });
			write({
				type: "subagent_progress",
				payload: {
					index: agent.index,
					agent: agent.agent,
					agentSource: "bundled",
					task,
					parentToolCallId,
					progress: {
						id,
						index: agent.index,
						agent: agent.agent,
						agentSource: "bundled",
						status: "running",
						task,
						lastIntent: task,
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						requests: 1,
						tokens: 10,
						cost: 0,
						durationMs: 100,
					},
				},
			});
		};
		// A command, then an agent whose task returns while the agent keeps working.
		startCall("steer-bash", "bash", {
			command: "bun test e2e/work-replay.test.ts",
			intent: "Running the lane replay",
		});
		endCall("steer-bash", "bash", "12 pass\n0 fail", { exitCode: 0 });
		startCall("steer-task-1", "task", { tasks: [{ name: "LaneRace", task: "Find the lane conclusion race" }] });
		startAgent("LaneRace", "steer-task-1", "Find the lane conclusion race");
		// Stock's background spawn returns at once with the spawned agent's progress row.
		endCall("steer-task-1", "task", "LaneRace is working in the background", {
			results: [],
			progress: [
				{ id: "LaneRace", index: 0, agent: "debugger", status: "running", task: "Find the lane conclusion race" },
			],
			async: { state: "running", jobId: "LaneRace", type: "task" },
		});
		steerWork = {
			// Stock: the queued steer enters the running loop as a `steering` user message.
			deliver: () => {
				const steers = lanes.steering.splice(0);
				emitQueue();
				for (const text of steers) {
					const message: AgentMessage = {
						role: "user",
						content: [{ type: "text", text }],
						steering: true,
						timestamp: Date.now(),
					};
					appendMessage(message);
					write({ type: "message_start", message });
					write({ type: "message_end", message });
					turn.push(message);
				}
				startCall("steer-task-2", "task", { tasks: [{ name: "CiSpeed", task: "Split CI timing" }] });
				startAgent("CiSpeed", "steer-task-2", "Split CI timing");
			},
			finish: () => {
				for (const agent of subagentRoster) {
					agent.status = "completed";
					write({
						type: "subagent_lifecycle",
						payload: { ...agent, agentSource: "bundled", status: "completed" },
					});
				}
				// Stock settles each agent in the transcript: CiSpeed through its task call's result
				// rows, the detached LaneRace through an async-result delivery wrapping its
				// <task-result> envelope. A reload replays the lanes from these records alone.
				endCall("steer-task-2", "task", "CiSpeed finished", {
					results: [
						{
							id: "CiSpeed",
							agent: "debugger",
							exitCode: 0,
							output: "CI timing split into two jobs.",
							durationMs: 1800,
						},
					],
				});
				const delivery: AgentMessage = {
					role: "custom",
					customType: "async-result",
					content:
						'<system-notice>\nBackground job LaneRace has completed. Resume your work using the result below.\n<task-result id="LaneRace" agent="debugger" status="completed" duration="2.4s">\n<output>\nThe lane conclusion race is fixed.\n</output>\n</task-result>\n</system-notice>',
					display: true,
					details: {
						jobs: [
							{ jobId: "LaneRace", type: "task", status: "completed", agentId: "LaneRace", durationMs: 2400 },
						],
					},
					timestamp: Date.now(),
				};
				appendMessage(delivery);
				write({ type: "message_end", message: delivery });
				turn.push(delivery);
				const answer: AgentMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Lane race fixed and CI timing split." }],
					timestamp: Date.now(),
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
				};
				appendMessage(answer);
				write({ type: "message_end", message: answer });
				endTurn([...turn, answer]);
				steerWork = undefined;
			},
		};
	};
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
		if (message === "fixture work view") {
			startWorkView(user);
		} else if (message === "fixture steer work") {
			startSteerWork(user);
		} else if (message === "fixture flow") {
			startFlow(user);
		} else if (message === "fixture real work replay") {
			const recording = rebaseWorkRecording(
				JSON.parse(
					fs.readFileSync(nodePath.join(import.meta.dir, "fixtures/real-live-work.json"), "utf8"),
				) as RecordedWorkFrame[],
			);
			// Held at AlphaCounter's `sleep 3 && wc -l` start (260) and its result (284).
			const next = createWorkReplay(recording, [260, 284], emitRecordedWork, ms => {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, ms);
				return promise;
			});
			replayRecordedWork = () => {
				// The audit captured both real yields but stopped before the main reply.
				// Close fixture playback; never manufacture an assistant answer.
				void next().then(finished => {
					if (finished) endTurn([]);
				});
			};
			replayRecordedWork();
		} else if (message === "fixture reads") {
			const targets = ["https://example.com/leaderboard", "xd://lsp", "src/a.ts"];
			const answer: AgentMessage = {
				role: "assistant",
				timestamp: Date.now(),
				content: targets.map((path, index) => ({
					type: "toolCall",
					id: `fixture-read-${index}`,
					name: "read",
					arguments: { path },
				})),
			};
			// As stock and the bridge: the live message carries no read metadata, the transcript
			// does, and the bridge sends it beside the message's end.
			write({ type: "message_start", message: answer });
			appendMessage({
				...answer,
				content: targets.map((path, index) => ({
					type: "toolCall",
					id: `fixture-read-${index}`,
					name: "read",
					arguments: { path, __ompReadGroup: { path } },
				})),
			});
			write({ type: "message_end", message: answer });
			for (const [index, path] of targets.entries())
				write({ type: "read_group_metadata", toolCallId: `fixture-read-${index}`, target: { path } });
			const results: AgentMessage[] = [];
			for (const [index, path] of targets.entries()) {
				const toolCallId = `fixture-read-${index}`;
				write({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path } });
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
		} else if (message === "fixture media") {
			// The agent renders a clip with ffmpeg, reads it back and speaks a narration with
			// stock tts. Stock results name those files only by path (read's mediaPath, tts's
			// "Saved … to"); the reply links one, quotes others (a long recording past any IPC
			// cap, a picture, a frame the read already showed, a PDF, a page) and names a file
			// that is gone. A finished subagent made media of its own.
			const out = nodePath.join(process.cwd(), "out");
			fs.mkdirSync(out, { recursive: true });
			for (const name of ["clip.webm", "tone.mp3"])
				fs.copyFileSync(nodePath.join(import.meta.dir, "media", name), nodePath.join(out, name));
			// 40 MB: an MP4 followed by a top-level `free` box, valid and seekable, over the old blob cap.
			const longClip = fs.readFileSync(nodePath.join(import.meta.dir, "media", "clip.mp4"));
			const padding = 40 * 1024 * 1024;
			const free = Buffer.alloc(8);
			free.writeUInt32BE(padding + 8, 0);
			free.write("free", 4, "latin1");
			fs.writeFileSync(nodePath.join(out, "long.mp4"), Buffer.concat([longClip, free, Buffer.alloc(padding)]));
			const png = fs.readFileSync(nodePath.join(import.meta.dir, "../resources/icon.png"));
			fs.writeFileSync(nodePath.join(out, "frame.png"), png);
			fs.writeFileSync(
				nodePath.join(out, "chart.svg"),
				'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#5b5bd6"/><circle cx="80" cy="50" r="30" fill="#fff"/></svg>',
			);
			fs.writeFileSync(nodePath.join(out, "report.pdf"), tinyPdf());
			fs.writeFileSync(
				nodePath.join(out, "page.html"),
				'<!doctype html><html><body><h1>Fixture page</h1><script>document.body.dataset.ran = "yes"</script><img src="https://example.com/beacon.png" alt=""></body></html>',
			);
			const mediaAgent = "MediaMaker";
			recordedMessages.set(mediaAgent, [
				{
					role: "assistant",
					timestamp: Date.now(),
					content: [
						{ type: "toolCall", id: `${mediaAgent}-read`, name: "read", arguments: { path: "out/clip.webm" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: `${mediaAgent}-read`,
					toolName: "read",
					content: [
						{ type: "text", text: "Video file [video/webm], contact sheet" },
						{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
					],
					details: { mediaPath: nodePath.join(out, "clip.webm"), contentType: "video/webm" },
					isError: false,
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					timestamp: Date.now(),
					content: [
						{
							type: "text",
							text: "Checked the clip; the narration is `out/tone.mp3`, the chart `out/chart.svg`.",
						},
					],
				},
			]);
			const mediaSnapshot: SubagentSnapshot = {
				id: mediaAgent,
				index: 0,
				agent: "task",
				status: "completed",
				live: false,
				lastUpdate: Date.now(),
			};
			subagentRoster = [mediaSnapshot];
			write({
				type: "subagent_lifecycle",
				payload: { ...mediaSnapshot, agentSource: "bundled", status: "started" },
			});
			write({
				type: "subagent_lifecycle",
				payload: { ...mediaSnapshot, agentSource: "bundled", status: "completed" },
			});
			const steps = [
				{
					id: "fixture-media-bash",
					name: "bash",
					args: { command: "ffmpeg -f lavfi -i testsrc2=size=160x90 -t 1.5 out/clip.webm" },
					result: { content: [{ type: "text" as const, text: "" }], details: { exitCode: 0 } },
				},
				{
					id: "fixture-media-read",
					name: "read",
					args: { path: "out/clip.webm" },
					result: {
						content: [{ type: "text" as const, text: "Video file [video/webm], 1.5s, 160x90" }],
						details: { mediaPath: nodePath.join(out, "clip.webm"), contentType: "video/webm" },
					},
				},
				{
					id: "fixture-media-tts",
					name: "tts",
					args: { text: "Hello from the fixture", output_path: "out/tone.mp3" },
					result: {
						content: [
							{
								type: "text" as const,
								text: "Saved 6392 bytes to out/tone.mp3 (model=fixture/tts, voice=default, codec=mp3).",
							},
						],
						details: { bytes: 6392, voiceId: "default", codec: "mp3", backend: "openai-speech" },
					},
				},
				{
					id: "fixture-media-frame",
					name: "read",
					args: { path: "out/frame.png" },
					result: {
						content: [
							{ type: "text" as const, text: "Read image file [image/png]" },
							{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
						],
						details: { mediaPath: nodePath.join(out, "frame.png") },
					},
				},
			];
			const call: AgentMessage = {
				role: "assistant",
				timestamp: Date.now(),
				content: steps.map(step => ({ type: "toolCall", id: step.id, name: step.name, arguments: step.args })),
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
			};
			write({ type: "message_start", message: call });
			appendMessage(call);
			write({ type: "message_end", message: call });
			const results: AgentMessage[] = steps.map(step => {
				write({ type: "tool_execution_start", toolCallId: step.id, toolName: step.name, args: step.args });
				write({
					type: "tool_execution_end",
					toolCallId: step.id,
					toolName: step.name,
					result: step.result,
					isError: false,
				});
				const result: AgentMessage = {
					role: "toolResult",
					toolCallId: step.id,
					toolName: step.name,
					...step.result,
					isError: false,
					timestamp: Date.now(),
				};
				appendMessage(result);
				write({ type: "message_end", message: result });
				return result;
			});
			const answer: AgentMessage = {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Rendered [the clip](out/clip.webm) with a narration in `out/tone.mp3`; the full take is `out/long.mp4`. Frame `out/frame.png`, chart `out/chart.svg`, report `out/report.pdf` and page `out/page.html`. The first draft `out/draft.mp4` is gone.",
					},
				],
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
			};
			appendMessage(answer);
			write({ type: "message_end", message: answer });
			endTurn([user, call, ...results, answer]);
		} else if (message === "fixture subagent screenshots") {
			// A subagent reads two PNGs back. Its transcript comes from its JSONL the way
			// stock serves it: image bytes persisted as `blob:sha256:` references. One
			// blob is in the store; the other was collected.
			const png = fs.readFileSync(nodePath.join(import.meta.dir, "../resources/icon.png")).toString("base64");
			const hash = createHash("sha256").update(Buffer.from(png, "base64")).digest("hex");
			imageBlobs.set(hash, png);
			const shots = [
				{ path: nodePath.join(process.cwd(), "screenshots", "home.png"), ref: `blob:sha256:${hash}` },
				{ path: nodePath.join(process.cwd(), "screenshots", "gone.png"), ref: `blob:sha256:${"0".repeat(64)}` },
			];
			const agentId = "ShotReader";
			const taskId = "fixture-shots-task";
			const now = Date.now();
			recordedMessages.set(
				agentId,
				shots.flatMap((shot, index): AgentMessage[] => [
					{
						role: "assistant",
						timestamp: now + index * 2,
						content: [
							{ type: "toolCall", id: `${agentId}-read-${index}`, name: "read", arguments: { path: shot.path } },
						],
					},
					{
						role: "toolResult",
						toolCallId: `${agentId}-read-${index}`,
						toolName: "read",
						content: [
							{ type: "text", text: "Read image file [image/png]" },
							{ type: "image", data: shot.ref, mimeType: "image/png" },
						],
						details: {
							fileSize: 1024,
							meta: { source: { type: "path", value: shot.path } },
							mediaPath: shot.path,
						},
						isError: false,
						timestamp: now + index * 2 + 1,
					},
				]),
			);
			const args = { tasks: [{ name: agentId, task: "Look at the screenshots" }] };
			const call: AgentMessage = {
				role: "assistant",
				timestamp: now,
				content: [{ type: "toolCall", id: taskId, name: "task", arguments: args }],
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
			};
			write({ type: "message_start", message: call });
			appendMessage(call);
			write({ type: "message_end", message: call });
			write({ type: "tool_execution_start", toolCallId: taskId, toolName: "task", args });
			const agent: SubagentSnapshot = {
				id: agentId,
				index: 0,
				agent: "scout",
				status: "completed",
				live: false,
				parentToolCallId: taskId,
				lastUpdate: now,
			};
			subagentRoster = [agent];
			write({ type: "subagent_lifecycle", payload: { ...agent, agentSource: "bundled", status: "started" } });
			write({ type: "subagent_lifecycle", payload: { ...agent, agentSource: "bundled", status: "completed" } });
			const taskResult = {
				content: [{ type: "text" as const, text: "ShotReader looked at both screenshots." }],
				details: { results: [{ id: agentId, agent: "scout", output: "Both screenshots read.", exitCode: 0 }] },
			};
			write({
				type: "tool_execution_end",
				toolCallId: taskId,
				toolName: "task",
				result: taskResult,
				isError: false,
			});
			const result: AgentMessage = {
				role: "toolResult",
				toolCallId: taskId,
				toolName: "task",
				...taskResult,
				isError: false,
				timestamp: Date.now(),
			};
			appendMessage(result);
			write({ type: "message_end", message: result });
			const answer: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Screenshots checked" }],
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
			};
			appendMessage(answer);
			write({ type: "message_end", message: answer });
			endTurn([user, call, result, answer]);
		} else if (message === "fixture markdown stream") {
			// Streams MARKDOWN_STREAM in small deltas, then holds the turn open
			// (`fixture:finish` ends it) so the live tail can be inspected.
			const answer: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };
			write({ type: "message_start", message: answer });
			let sent = 0;
			clearInterval(streamTimer);
			streamTick = undefined;
			streamTimer = setInterval(() => {
				const delta = MARKDOWN_STREAM.slice(sent, sent + 12);
				if (!delta) {
					clearInterval(streamTimer);
					return;
				}
				sent += delta.length;
				write({
					type: "message_update",
					message: answer,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: answer },
				});
			}, 16);
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
		} else if (message === "fixture edits" || message === "fixture panel edits") {
			// Commands with output lines alternating with file edits, whose diff
			// stats carry an `sr-only` label, so the live log fills well past its
			// window; the last command is left running and the turn never ends.
			const step = (index: number) => {
				const id = `edit-step-${Date.now()}-${index}`;
				const toolName = index % 2 === 1 ? "edit" : "bash";
				const args =
					toolName === "edit"
						? {
								path:
									message === "fixture panel edits" && index === 5
										? "local://review.md"
										: `src/module-${index}.ts`,
								edits: [{ old_text: "a", new_text: "b\nc" }],
							}
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
		} else if (message === "fixture long ask") {
			// One question with many described options: taller than a 2×2 pane.
			write({
				type: "extension_ui_request",
				id: "fixture-long-ask",
				method: "ask",
				questions: [
					{
						id: "region",
						header: "Region",
						question: "Which region should host the release?",
						multi: true,
						options: Array.from({ length: 12 }, (_, i) => ({
							label: `Region ${i + 1}`,
							description: `Datacenter option ${i + 1} with its own latency and cost profile`,
						})),
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
		} else if (message === "fixture usage limit") {
			// The provider's quota stops the turn; the limit resets a few seconds later.
			usageLimitResetAt = Date.now() + Number(process.env.OMP_GUI_TEST_USAGE_RESET_MS ?? 90_000);
			const answer: AgentMessage = {
				role: "assistant",
				content: [],
				timestamp: Date.now(),
				provider: model.provider,
				model: model.id,
				stopReason: "error",
				errorMessage: "429 usage limit reached for this account",
			};
			appendMessage(answer);
			write({ type: "message_end", message: answer });
			endTurn([user, answer]);
		} else if (message !== "fixture running") {
			if (message === "fixture reply actions") {
				// Stock auto thinking names the effort it classified for this turn.
				thinking = { level: "high", configured: "auto" };
				write({ type: "thinking_level_changed", thinkingLevel: "high", configured: "auto", resolved: "high" });
			}
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
										: message === "fixture markdown"
											? MARKDOWN_REPLY
											: message === "fixture paths"
												? PATHS_REPLY
												: message === "fixture reply actions"
													? ACTIONS_REPLY
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
				ok();
				break;
			case "set_host_tools":
				ok({
					toolNames: Array.isArray(command.tools)
						? command.tools.map(tool => (tool && typeof tool === "object" && "name" in tool ? tool.name : null))
						: [],
				});
				break;
			// Stock answers nothing to a host tool's result; the recorded frame is what tests read.
			case "host_tool_result":
				break;
			case "set_subagent_subscription":
				subagentSubscription = text("level");
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
				const leafId = activeLeafId;
				if (command.since === undefined) {
					ok({ entries, leafId });
					break;
				}
				const index = entries.findIndex(entry => entry.id === command.since);
				if (index === -1) fail(`Unknown entries cursor: ${text("since")}`, "unknown_since");
				else ok({ entries: entries.slice(index + 1), leafId });
				break;
			}
			case "get_subagents":
				ok({ subagents: subagentRoster });
				break;
			case "get_subagent_messages": {
				const id = text("subagentId");
				const messages = recordedMessages.get(id) ?? [];
				ok({ messages, entries: [], fromByte: 0, nextByte: 0, reset: false });
				break;
			}
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
			// Stock 18.10 (rpc-mode.ts `login` over Anthropic's callback-server flow,
			// probed): open_url with the loopback launch page (fire-and-forget), the
			// "waiting" progress notice, then a blocking `input` for the pasted code
			// or redirect URL. Stock races that paste against its callback server and
			// never closes it (no `cancel` frame): a callback ends the login while the
			// paste stays pending, and an empty answer only makes it ask again.
			case "login": {
				// An API-key provider of the long tail (stock's DeepSeek-style flow): the
				// key page as open_url without a callback server, then the pasted key.
				const keyProvider = MODELS_PAGE_PROVIDERS.find(row => row.id === command.providerId);
				if (modelsData && keyProvider) {
					const urlId = `fixture-key-url-${Date.now()}`;
					const inputId = `fixture-key-input-${Date.now()}`;
					write({
						type: "extension_ui_request",
						id: urlId,
						method: "open_url",
						url: `https://${keyProvider.id}.example/api_keys`,
						instructions: `Create or copy your API key from the ${keyProvider.name} dashboard`,
					});
					write({
						type: "extension_ui_request",
						id: inputId,
						method: "input",
						title: `Paste your ${keyProvider.name} API key`,
						placeholder: "sk-...",
						timeout: 600_000,
					});
					pendingLogin = {
						urlId,
						inputId,
						finish: value => {
							pendingLogin = undefined;
							if (value?.trim()) {
								apiKeyProviders.add(keyProvider.id);
								ok({ providerId: keyProvider.id });
							} else fail("Login cancelled");
						},
					};
					break;
				}
				if (command.providerId !== "anthropic") {
					fail(`Unknown OAuth provider: ${text("providerId")}`);
					break;
				}
				const urlId = `fixture-login-url-${Date.now()}`;
				const loginState = "xyz";
				let inputId = "";
				const askForCode = () => {
					inputId = `fixture-login-input-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
					write({
						type: "extension_ui_request",
						id: inputId,
						method: "input",
						title: "Paste the authorization code (or full redirect URL):",
						timeout: 600_000,
					});
				};
				const signIn = () => {
					// With the seeded accounts, each further sign-in stores one more account, as stock does.
					if (modelsData) {
						const credentialId = nextCredentialId++;
						anthropicAccounts = [
							...anthropicAccounts.map(account => ({ ...account, active: false })),
							{
								credentialId,
								label: `added-${credentialId}@example.com`,
								detail: "Claude Pro",
								type: "oauth",
								active: true,
							},
						];
						accountQuota[credentialId] = {
							credentialId,
							state: "healthy",
							remainingFraction: 1,
							limits: [
								{
									id: "anthropic:5h",
									label: "Claude 5 Hour",
									usedFraction: 0,
									windowId: "5h",
									windowLabel: "5 Hour",
								},
								{
									id: "anthropic:7d",
									label: "Claude 7 Day",
									usedFraction: 0,
									windowId: "7d",
									windowLabel: "7 Day",
								},
							],
						};
					}
					anthropicSignedIn = true;
				};
				// Stock's callback server (callback-server.ts): `/launch` redirects to the
				// authorization URL, `/callback` with the flow's state signs in, and one
				// with `error` (the provider's Deny) fails the login at once.
				const settle = (outcome: { ok: true } | { ok: false; error: string }) => {
					if (pendingLogin?.urlId !== urlId) return;
					// The paste stock raced against the callback stays open; its late answer is ignored.
					leftoverLoginInputs.add(inputId);
					pendingLogin = undefined;
					callbackServer.stop();
					if (outcome.ok) {
						signIn();
						ok({ providerId: "anthropic" });
					} else fail(outcome.error);
				};
				const callbackServer = Bun.serve({
					hostname: "127.0.0.1",
					port: 0,
					fetch: (request): Response => {
						const url = new URL(request.url);
						record({ type: "login_callback", path: url.pathname, query: Object.fromEntries(url.searchParams) });
						if (url.pathname === "/launch") return Response.redirect(authUrl, 302);
						if (url.pathname !== "/callback") return new Response("Not Found", { status: 404 });
						if (url.searchParams.get("state") !== loginState) {
							return new Response("State mismatch", { status: 500 });
						}
						const error = url.searchParams.get("error");
						if (error) {
							settle({
								ok: false,
								error: `Authorization failed: ${url.searchParams.get("error_description") || error}`,
							});
							return new Response("Authorization failed", { status: 500 });
						}
						if (!url.searchParams.get("code")) return new Response("Missing authorization code", { status: 500 });
						settle({ ok: true });
						return new Response("Signed in. You can close this tab.", { status: 200 });
					},
				});
				const origin: string = `http://127.0.0.1:${callbackServer.port}`;
				const authUrl: string = `https://claude.ai/oauth/authorize?code=true&client_id=fixture&redirect_uri=${encodeURIComponent(`${origin}/callback`)}&state=${loginState}`;
				write({
					type: "extension_ui_request",
					id: urlId,
					method: "open_url",
					url: authUrl,
					launchUrl: `${origin}/launch`,
					instructions: "Complete the sign-in in your browser.",
				});
				write({
					type: "extension_ui_request",
					id: `fixture-login-wait-${Date.now()}`,
					method: "notify",
					message: "Waiting for browser authentication...",
					notifyType: "info",
				});
				askForCode();
				pendingLogin = {
					urlId,
					get inputId() {
						return inputId;
					},
					finish: value => {
						// Stock's manual-code loop: no code in the answer, ask again.
						if (!value?.trim()) {
							askForCode();
							return;
						}
						settle({ ok: true });
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
						"retry",
					]
						.map(name => ({ name, source: "builtin", textModeExecutable: false, description: name }))
						.concat([
							{
								name: "skill:review",
								source: "skill",
								textModeExecutable: false,
								description: "Review the working tree",
							},
						]),
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
				if (typeof command.id === "string" && leftoverLoginInputs.delete(command.id)) break;
				if (pendingLogin && command.id === pendingLogin.inputId) {
					pendingLogin.finish(command.cancelled === true ? undefined : text("value"));
					break;
				}
				// A question inside a flow run answers its ask call; the run goes on.
				if (flow?.answer(command)) {
					ok();
					break;
				}
				ok();
				endTurn([]);
				break;
			case "bash": {
				const line = text("command");
				if (line.startsWith("fixture:flow:")) {
					const error = flow
						? flow.op(JSON.parse(line.slice("fixture:flow:".length)) as Record<string, unknown>)
						: "Fixture has no flow running";
					if (error) fail(error);
					else ok();
					break;
				}
				// The agent calls a GUI host tool (`fixture:host-tool:<name>`); its host_tool_result is recorded.
				if (line.startsWith("fixture:host-tool:")) {
					write({
						type: "host_tool_call",
						id: `host-tool-${Date.now()}`,
						toolCallId: "fixture-host-tool",
						toolName: line.slice("fixture:host-tool:".length),
						arguments: {},
					});
					ok();
					break;
				}
				if (line === "fixture:replay-next") {
					replayRecordedWork?.();
					ok();
					break;
				}
				if (line === "fixture:work-next") {
					advanceWork?.();
					ok();
					break;
				}
				if (line === "fixture:work-stream") {
					streamWork?.();
					ok();
					break;
				}
				if (line === "fixture:work-output") {
					appendWorkOutput?.();
					ok();
					break;
				}
				if (line === "fixture:steer-next" || line === "fixture:steer-finish") {
					if (!steerWork) {
						fail("Fixture has no steer work running");
						break;
					}
					if (line === "fixture:steer-next") steerWork.deliver();
					else steerWork.finish();
					ok();
					break;
				}
				if (line === "fixture:hold-history") {
					holdHistory = true;
					ok();
					break;
				}
				if (line === "fixture:release-history") {
					releaseHistory?.();
					releaseHistory = undefined;
					ok();
					break;
				}
				if (line === "fixture:fail-history") {
					failHistory = true;
					ok();
					break;
				}
				if (line === "fixture:long-session") {
					seedLongSession();
					ok({ totalMessages: 1500, leafId: activeLeafId });
					break;
				}
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
					writeProposedPlan(planProposal);
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
				// A user `!` bash that runs until stock's `abort_bash` stops it.
				if (line === "fixture:hold-bash") {
					heldBash = ok;
					break;
				}
				// Extension UI an rpc-ui host gets at once: status texts, a widget
				// under the editor, a window title, an error notice, an editor in
				// prompt style and two confirms queued behind it (the last one timed).
				if (line === "fixture:ext-ui") {
					const ui = (request: Record<string, unknown>) =>
						write({ type: "extension_ui_request", id: `ext-${Date.now()}-${Math.random()}`, ...request });
					ui({ method: "setStatus", statusKey: "b-tests", statusText: "\x1b[32m✓\x1b[39m 128 tests" });
					ui({ method: "setStatus", statusKey: "a-index", statusText: "Indexer ready" });
					ui({
						method: "setWidget",
						widgetKey: "review",
						widgetLines: ["2 files changed since the last review"],
						widgetPlacement: "belowEditor",
					});
					ui({ method: "setTitle", title: "Fixture extension title" });
					ui({ method: "notify", message: "Fixture index failed to refresh", notifyType: "error" });
					write({
						type: "extension_ui_request",
						id: "ext-editor",
						method: "editor",
						title: "Goal objective",
						promptStyle: true,
					});
					write({
						type: "extension_ui_request",
						id: "ext-confirm-1",
						method: "confirm",
						title: "Deploy to staging?",
						message: "The agent wants to run the staging deploy script.",
					});
					write({
						type: "extension_ui_request",
						id: "ext-confirm-2",
						method: "confirm",
						title: "Notify the team?",
						message: "",
						timeout: 600_000,
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
			case "set_slow_mode":
				if (!slowModeSupported) {
					fail("Slow mode is unavailable for the current model.");
					break;
				}
				slowModeEnabled = command.enabled === true;
				ok({ enabled: slowModeEnabled });
				break;
			case "abort_bash":
				heldBash?.({ output: "held output\n", exitCode: undefined, cancelled: true, truncated: false });
				heldBash = undefined;
				ok();
				break;
			case "steer_subagent": {
				const target = subagentRoster.find(agent => agent.id === command.subagentId);
				if (target?.status !== "running") {
					fail(`Subagent not running: ${text("subagentId")}`);
					break;
				}
				ok();
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
				if (!flow?.abort() && isStreaming) endTurn([]);
				break;
			}
			// Stock `getUserMessagesForBranching` / `branch`: the leaf moves to the
			// picked user message's parent and its text comes back for the editor.
			case "get_branch_messages":
				ok({
					messages: activeBranch()
						.filter(entry => entry.type === "message" && (entry.message as AgentMessage).role === "user")
						.map(entry => ({ entryId: entry.id, text: messageText(entry.message as AgentMessage, "") })),
				});
				break;
			case "branch": {
				const target = entries.find(entry => entry.id === command.entryId);
				const message = target?.type === "message" ? (target.message as AgentMessage) : undefined;
				if (!target || message?.role !== "user") {
					fail("Invalid entry ID for branching");
					break;
				}
				activeLeafId = target.parentId;
				persistSession();
				ok({ text: messageText(message, ""), cancelled: false });
				break;
			}
			// Stock `switch_session`: the journal becomes the stored session's.
			case "switch_session": {
				const sessionPath = text("sessionPath");
				if (!fs.existsSync(sessionPath)) {
					fail(`Session file not found: ${sessionPath}`);
					break;
				}
				// The stored file becomes the live journal, as it was written.
				const header = loadJournal(sessionPath);
				resumed = { id: header.id ?? sessionId, file: sessionPath };
				sessionTitle = header.title ?? "";
				ok({ cancelled: false });
				break;
			}
			// Stock's manual `/compact`: one compaction entry keeping the last message (context popover e2e).
			case "compact": {
				const compaction = {
					summary: "Compacted on request.",
					firstKeptEntryId: entries.at(-1)?.id,
					tokensBefore: 74_800,
				};
				append({ type: "compaction", ...compaction }, Date.now());
				ok(compaction);
				break;
			}
			case "abort":
				clearInterval(streamTimer);
				clearInterval(workStreamTimer);
				ok();
				if (!flow?.abort()) endTurn([]);
				break;
			case "prompt":
				if (text("message") === "/retry") {
					// Stock `/retry` (main's `retry` handler sends it): the failed turn runs again, here answering.
					const failed = usageLimitResetAt !== undefined;
					usageLimitResetAt = undefined;
					ok({ agentInvoked: failed });
					if (!failed) break;
					isStreaming = true;
					write({ type: "agent_start" });
					const answer: AgentMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Resumed after the usage limit reset." }],
						timestamp: Date.now(),
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
					};
					appendMessage(answer);
					write({ type: "message_end", message: answer });
					endTurn([answer]);
					break;
				}
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
