import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { isNewer } from "../shared/version";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { parseOmpVersion } from "./omp-runtime";

/**
 * A relaunch revives the subagents the last omp was running (bridge `composer.restore_interrupted` → stock
 * `restoreSession`), on the installed omp with a scripted OpenAI-compatible provider on loopback (no model spend).
 *
 * Reported on v0.35.1: the main session's turn had ended with a background subagent still working; after the
 * update restart the subagent went on and its result reached the parent, but nothing in OMPdesk showed it running.
 * Stock sends a revived subagent's lifecycle and progress frames to the buses `restoreSession` is given, as a live
 * run does; the bridge passed none, so omp's RPC subagent registry (`get_subagents`, the `subagent_*` frames the
 * work board, the dock and the composer's background cue read) never heard of it.
 *
 * Reported on v0.37.0/v0.38.1 (18 Oct 2026): a revived subagent went on but its session's own turn did not, so
 * the session sat silent until the subagent finished. Whether the parent's turn ended (v0.38.1) or stock's restore
 * declined to continue it (v0.37.0 on omp 18.12.1: the parent was cut off in `wait` and its journal used `eval`, so
 * stock's eval-state-context message ends the transcript and neither `restoreInterruptedTurn` nor `/retry` sees the
 * interrupted turn, oh-my-pi#16195), the bridge gives the parent one follow-up naming the revived subagents.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
/**
 * First stock omp whose restore continues a turn cut off in a session that used `eval` (oh-my-pi#16195, fixed in
 * 18.12.2 by `conversationEnd` in `session/turn-recovery.ts`). MIN_OMP_VERSION still admits older omp, where the
 * bridge's follow-up is what wakes that parent, so the eval case pins whichever behaviour the installed omp has.
 */
const STOCK_RESTORES_EVAL_TURN = "18.12.2";
const installedVersion = existsSync(omp)
	? parseOmpVersion(execFileSync(omp, ["--version"], { encoding: "utf8" }))
	: null;
const restoresEvalTurn = installedVersion !== null && !isNewer(STOCK_RESTORES_EVAL_TURN, installedVersion);
const SUBTASK = "SUBTASK-MARK: list the files and report";
/** A line of the bridge's follow-up for revived subagents (restart-core.ts `restartFollowUp`). */
const NOTICE_MARK = "These background agents you started are working again";

type Step = { text: string } | { tool: string; args: Record<string, unknown> };

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completion(step: Step, tools: string[], callId: string): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
	if ("text" in step) {
		return sse([
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		]);
	}
	const name = tools.find(tool => tool === step.tool || tool.endsWith(`_${step.tool}`)) ?? step.tool;
	const call = { index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(step.args) } };
	return sse([
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
	]);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(part => textOf((part as { text?: unknown }).text ?? "")).join("");
	return "";
}

const SPAWN: Step = {
	tool: "task",
	args: { context: "probe", tasks: [{ name: "Probe", agent: "task", task: SUBTASK, solutionSpace: "one listing" }] },
};
const WAIT: Step = { tool: "wait", args: { i: "waiting for Probe" } };
/** Any `eval` call in the journal makes stock append its eval-state-context after a session loads. */
const EVAL: Step = { tool: "eval", args: { language: "js", code: "1 + 1", i: "probe eval" } };

interface Provider {
	url: string;
	/** Requests whose conversation carries the subagent's assignment. */
	subagentRequests: number;
	/** Each subagent request's system prompt and tool names, in arrival order. */
	subagentCalls: Call[];
	/** Each parent request's (one offering the `task` tool) system prompt and tool names, in arrival order. */
	parentCalls: Call[];
	/** Parent requests whose conversation carries the bridge's follow-up for revived subagents. */
	noticeRequests: string[];
	close(): Promise<void>;
}

/** What one model request sent besides its conversation. */
interface Call {
	system: string;
	tools: string[];
}

/**
 * The parent runs `script` (one step per tool result so far), then answers in text; the subagent runs `subagentScript`
 * the same way and then its model call never answers; a parent request carrying the bridge's follow-up is answered
 * `PARENT-NOTED`.
 */
async function startProvider(script: readonly Step[], subagentScript: readonly Step[] = []): Promise<Provider> {
	const provider: Provider = {
		url: "",
		subagentRequests: 0,
		subagentCalls: [],
		parentCalls: [],
		noticeRequests: [],
		close: async () => undefined,
	};
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			if (!req.url?.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const parsed = JSON.parse(body) as {
				messages: Array<{ role: string; content: unknown }>;
				tools?: Array<{ function?: { name?: string } }>;
			};
			const tools = (parsed.tools ?? []).map(tool => tool.function?.name ?? "");
			const system = parsed.messages
				.filter(message => message.role === "system" || message.role === "developer")
				.map(message => textOf(message.content))
				.join("\n");
			const user = parsed.messages
				.filter(message => message.role === "user")
				.map(message => textOf(message.content));
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			// The follow-up names the subagent's assignment too: only a conversation without it is the subagent's.
			const notice = user.find(text => text.includes(NOTICE_MARK));
			if (!notice && user.some(text => text.includes(SUBTASK))) {
				provider.subagentRequests++;
				provider.subagentCalls.push({ system, tools });
				const step = subagentScript[parsed.messages.filter(message => message.role === "tool").length];
				if (step) {
					res.end(completion(step, tools, `sub_${provider.subagentRequests}`));
					return;
				}
				return; // the subagent works until omp is killed (and again once revived)
			}
			// Side requests (the next-prompt suggestion, a title) offer no task tool: a plain answer.
			if (!tools.some(tool => tool.endsWith("task"))) {
				res.end(completion({ text: "side" }, tools, "side"));
				return;
			}
			provider.parentCalls.push({ system, tools });
			if (notice) {
				provider.noticeRequests.push(notice);
				res.end(completion({ text: "PARENT-NOTED" }, tools, "noted"));
				return;
			}
			const step = parsed.messages.filter(message => message.role === "tool").length;
			res.end(completion(script[step] ?? { text: "PARENT-DONE" }, tools, `call_${step}`));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	provider.url = `http://127.0.0.1:${port}/v1`;
	provider.close = () => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	};
	return provider;
}

interface Omp {
	bridge: GuiBridgeClient;
	frames: Array<{ type: string; [key: string]: unknown }>;
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	/**
	 * What a restart does to omp: an update's approved quit (SIGTERM, stock journals the exit), a crash, the way
	 * SidecarManager stops it, closing its stdin (`EOF`; stock disposes the session and parks its background subagents),
	 * or the app going away under it (`GONE`, an update swap: its next write to the closed stdout fails, and stock's
	 * stdout-disconnect handling quits at once, journaling every session's exit as `manual` and aborting nothing).
	 */
	kill(signal?: Signal): Promise<void>;
}

type Signal = "SIGKILL" | "SIGTERM" | "EOF" | "GONE";

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

async function startOmp(provider: Provider, isolated: string, root: string, resume: boolean): Promise<Omp> {
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: ${provider.url}`,
			"    apiKey: x",
			"    api: openai-completions",
			"    models:",
			"      - id: m1",
			"        name: m1",
			"        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }",
			"",
		].join("\n"),
	);
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: isolated,
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		omp,
		[
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...(resume ? ["--continue"] : []),
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const frames: Omp["frames"] = [];
	const responses = new Map<string, (value: Record<string, unknown>) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as { type: string; id?: string; [key: string]: unknown };
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	const bridge = new GuiBridgeClient(address);
	let counter = 0;
	const kill = async (signal: Signal = "SIGKILL") => {
		bridge.close();
		if (signal === "EOF") child.stdin.end();
		else if (signal === "GONE") {
			child.stdout.destroy();
			child.stdin.write(`${JSON.stringify({ id: "gone", type: "get_state" })}\n`);
		} else child.kill(signal);
		await exited;
		removeBridgeAddress(address);
	};
	cleanups.push(() => kill());
	await expect.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000 }).toBe(true);
	await expect
		.poll(
			() =>
				bridge.connect(1_000).then(
					() => true,
					() => false,
				),
			{ timeout: 60_000, message: `bridge never came up\n${stderr.slice(-2000)}` },
		)
		.toBe(true);
	return {
		bridge,
		frames,
		kill,
		send: command => {
			const id = `c${++counter}`;
			const { promise, resolve: done, reject: fail } = Promise.withResolvers<Record<string, unknown>>();
			// A guard, not a wait: an omp that never answers fails the test with its stderr.
			const timer = setTimeout(() => fail(new Error(`no response\n${stderr.slice(-1500)}`)), 60_000);
			responses.set(id, value => {
				clearTimeout(timer);
				done(value);
			});
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			return promise;
		},
	};
}

/** omp's RPC subagent registry, as the GUI reads it (`get_subagents`). */
async function roster(omp: Omp): Promise<Array<{ id?: unknown; status?: unknown }>> {
	const { data } = await omp.send({ type: "get_subagents" });
	return typeof data === "object" && data !== null && "subagents" in data && Array.isArray(data.subagents)
		? data.subagents
		: [];
}

/** The main session's journal entries (the subagent's transcript lives in a folder beside it). */
function mainJournal(isolated: string): Array<{ type?: string; customType?: string; details?: unknown }> {
	const sessions = join(isolated, "agent", "sessions");
	const [project] = readdirSync(sessions);
	const [file] = readdirSync(join(sessions, project ?? "")).filter(name => name.endsWith(".jsonl"));
	return readFileSync(join(sessions, project ?? "", file ?? ""), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

interface Restored {
	turn: boolean;
	subagents: string[];
	followUp: boolean;
}

/**
 * One isolated omp life whose parent runs `script` until the subagent is mid-call (after `subagentScript`'s tool
 * calls), stopped by `signal`, then relaunched. `between` runs after the stop and before that relaunch (omp lives that
 * run no restore).
 */
async function cutOff(
	script: readonly Step[],
	signal: Signal,
	subagentScript: readonly Step[] = [],
	between?: (life: { provider: Provider; isolated: string; root: string }) => Promise<void>,
) {
	const provider = await startProvider(script, subagentScript);
	cleanups.push(() => provider.close());
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-revive-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-revive-repo-")));
	cleanups.push(() => {
		rmSync(isolated, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const first = await startOmp(provider, isolated, root, false);
	await first.send({ type: "prompt", message: "start the background work" });
	await expect.poll(() => provider.subagentRequests, { timeout: 90_000 }).toBeGreaterThan(subagentScript.length);
	const waits = script.at(-1) === WAIT;
	await expect
		.poll(
			() =>
				first.frames.some(frame =>
					waits
						? frame.type === "tool_execution_start" && JSON.stringify(frame).includes('"wait"')
						: frame.type === "agent_end",
				),
			{ timeout: 60_000 },
		)
		.toBe(true);
	const [spawned] = await roster(first);
	expect(spawned).toMatchObject({ status: "running" });
	await first.kill(signal);
	// Counted with no omp running: stock starts a revived subagent during the restore, before it answers.
	const requestsAtCut = provider.subagentRequests;
	const parentCallsAtCut = provider.parentCalls.length;
	await between?.({ provider, isolated, root });
	const second = await startOmp(provider, isolated, root, true);
	const outcome = await second.bridge.request<Restored>("composer.restore_interrupted", {});
	return { provider, isolated, second, outcome, id: spawned?.id, requestsAtCut, parentCallsAtCut };
}

/** Every journal under `isolated`, written `ms` earlier than it was (the lives so far happened that long ago). */
function ageJournals(isolated: string, ms: number): void {
	const shift = (value: unknown) =>
		typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) - ms).toISOString() : value;
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".jsonl")) {
				const lines = readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map(line => {
						const parsed = JSON.parse(line) as { timestamp?: unknown; data?: { recordedAt?: unknown } };
						parsed.timestamp = shift(parsed.timestamp);
						if (parsed.data?.recordedAt !== undefined) parsed.data.recordedAt = shift(parsed.data.recordedAt);
						return JSON.stringify(parsed);
					});
				writeFileSync(path, `${lines.join("\n")}\n`);
			}
		}
	};
	walk(join(isolated, "agent", "sessions"));
}

describe.skipIf(!existsSync(omp))("revived subagents on stock omp", () => {
	it("reports a subagent the restore revived to omp's subagent registry, and tells the idle parent once", async () => {
		// The parent spawns the subagent in the background and ends its turn; the subagent is mid-call.
		const { provider, isolated, second, outcome, id } = await cutOff([SPAWN, { text: "SPAWNED" }], "SIGKILL");
		expect(outcome).toMatchObject({ turn: false, subagents: [id], followUp: true });
		// Revived: its model call goes out again, and omp's registry lists it as running.
		await expect.poll(() => provider.subagentRequests, { timeout: 90_000 }).toBeGreaterThan(1);
		await expect
			.poll(() => roster(second), { timeout: 30_000 })
			.toEqual([expect.objectContaining({ id, status: "running" })]);
		// The idle parent gets one turn: the follow-up names the subagent and its assignment, and it answers.
		await expect.poll(() => provider.noticeRequests.length, { timeout: 60_000 }).toBe(1);
		expect(provider.noticeRequests[0]).toContain(`- ${id}: ${SUBTASK}`);
		const notes = mainJournal(isolated).filter(entry => entry.customType === "ompdesk-restart-subagents");
		expect(notes).toEqual([
			expect.objectContaining({
				type: "custom_message",
				details: { jobs: [], subagents: [{ id, intent: SUBTASK }] },
			}),
		]);
	}, 240_000);

	it("continues a parent cut off in `wait` in an eval journal: stock's restore (≥ 18.12.2) or the bridge's follow-up", async () => {
		// v0.37.0: the parent waited on its background subagent; the update's quit (SIGTERM) cut the `wait`.
		const { provider, isolated, outcome, id } = await cutOff([EVAL, SPAWN, WAIT], "SIGTERM");
		// The eval-state-context still follows the interrupted-turn record on every omp.
		expect(mainJournal(isolated).some(entry => entry.customType === "eval-state-context")).toBe(true);
		if (restoresEvalTurn) {
			// Stock looks past it and continues the cut-off turn; the bridge's notice joins that turn once.
			expect(outcome).toMatchObject({ turn: true, subagents: [id], followUp: true });
			await expect.poll(() => provider.noticeRequests.length, { timeout: 60_000 }).toBe(1);
			expect(mainJournal(isolated).filter(entry => entry.customType === "ompdesk-restart-subagents")).toHaveLength(
				1,
			);
			return;
		}
		// Older stock leaves the parent's turn alone, so the bridge tells it once.
		expect(outcome).toMatchObject({ turn: false, subagents: [id], followUp: true });
		await expect.poll(() => provider.noticeRequests.length, { timeout: 60_000 }).toBe(1);
		expect(mainJournal(isolated).filter(entry => entry.customType === "ompdesk-restart-subagents")).toHaveLength(1);
	}, 240_000);

	// 27 Oct 2026, an update restart: stock restored the parent's turn (its cut-off `wait` reran) and revived four
	// subagents whose first requests took 1.5-5 minutes; the parent heard nothing of them and the work looked stalled.
	// Its restored turn had also lost the prompt sections: they join through `before_agent_start`, which stock runs for
	// a prompt, never for a turn its restore continues.
	it("tells a turn stock's restore continues once, at once, which subagents work again, with its live prompt sections", async () => {
		const { provider, isolated, outcome, id, parentCallsAtCut } = await cutOff([SPAWN, WAIT], "SIGTERM");
		expect(outcome).toMatchObject({ turn: true, subagents: [id], followUp: true });
		// At once: the subagent never answers here, so the rerun `wait` could only end on the notice (stock interrupts or
		// skips an interruptible wait for a steer), never on the subagent's result.
		await expect.poll(() => provider.noticeRequests.length, { timeout: 60_000 }).toBe(1);
		expect(provider.noticeRequests[0]).toContain(`- ${id}: ${SUBTASK}`);
		expect(mainJournal(isolated).filter(entry => entry.customType === "ompdesk-restart-subagents")).toEqual([
			expect.objectContaining({ details: { jobs: [], subagents: [{ id, intent: SUBTASK }] } }),
		]);
		const live = provider.parentCalls[parentCallsAtCut - 1];
		const restored = provider.parentCalls[parentCallsAtCut];
		expect(live?.system).toContain("<background-checks>");
		expect(restored?.system).toBe(live?.system);
	}, 240_000);

	// 24 Oct 2026, two subagents lost: a graceful stop (stdin closed, as SidecarManager stops omp) disposes the session,
	// stock parks its background subagents without a tombstone and their transcripts end on a "Request was aborted"
	// reply, which stock's `hasRestorableTurn` reads as a finished turn: the relaunch's `wait` found nothing to wait for.
	it("revives a background subagent a graceful stop (stdin closed) cut off, and tells the idle parent once", async () => {
		const { provider, isolated, second, outcome, id } = await cutOff([SPAWN, { text: "SPAWNED" }], "EOF");
		expect(outcome).toMatchObject({ turn: false, subagents: [id], followUp: true });
		await expect.poll(() => provider.subagentRequests, { timeout: 90_000 }).toBeGreaterThan(1);
		await expect
			.poll(() => roster(second), { timeout: 30_000 })
			.toEqual([expect.objectContaining({ id, status: "running" })]);
		await expect.poll(() => provider.noticeRequests.length, { timeout: 60_000 }).toBe(1);
		expect(provider.noticeRequests[0]).toContain(`- ${id}: ${SUBTASK}`);
		expect(mainJournal(isolated).filter(entry => entry.customType === "ompdesk-restart-subagents")).toHaveLength(1);
	}, 240_000);

	it("revives a background subagent a graceful stop cut off while the parent waited on it, and tells that turn once", async () => {
		const { provider, second, isolated, outcome, id } = await cutOff([SPAWN, WAIT], "EOF");
		expect(outcome).toMatchObject({ turn: true, subagents: [id], followUp: true });
		await expect
			.poll(() => roster(second), { timeout: 30_000 })
			.toEqual([expect.objectContaining({ id, status: "running" })]);
		await expect.poll(() => provider.noticeRequests.length, { timeout: 60_000 }).toBe(1);
		expect(mainJournal(isolated).filter(entry => entry.customType === "ompdesk-restart-subagents")).toHaveLength(1);
	}, 240_000);

	// 26 Oct 2026 (v0.75.2 → v0.75.3 update restart), four subagents lost: each was waiting for its model's answer to a
	// tool result. The graceful stop journaled their `session_exit` as normal with nothing pending and no aborted reply
	// after it, so stock read their turns as finished and the parent's rerun `wait` found nothing to wait for.
	// 27 Oct 2026, the next update restart revived four, and each one's first request lacked every OMPdesk prompt section
	// (stock runs `before_agent_start` for a prompt, not for the turn its restore continues): the prompt prefix changed,
	// the provider cache missed and the thinking was dropped, 1.5-5 minutes each before a word.
	it("revives a subagent a graceful stop cut off between a tool result and its model's answer, with its live prompt sections", async () => {
		const READ: Step = { tool: "read", args: { path: ".", i: "listing the folder" } };
		const { provider, second, outcome, id, requestsAtCut } = await cutOff([SPAWN, WAIT], "GONE", [READ]);
		expect(outcome).toMatchObject({ turn: true, subagents: [id] });
		await expect.poll(() => provider.subagentRequests, { timeout: 90_000 }).toBeGreaterThan(requestsAtCut);
		await expect
			.poll(() => roster(second), { timeout: 30_000 })
			.toEqual([expect.objectContaining({ id, status: "running" })]);
		const live = provider.subagentCalls[requestsAtCut - 1];
		const revived = provider.subagentCalls[requestsAtCut];
		expect(live?.system).toContain("<background-checks>");
		expect(revived?.system).toBe(live?.system);
	}, 240_000);
});

// 30 Oct 2026: the parent's omp restart (SIGTERM) cut a background subagent; the session went on without it (the
// parent's work was handed to another subagent), relaunches ran no restore for the idle session, and ten hours later a
// relaunch with a turn running revived it, because stock's restore revives every restorable subagent whatever its age.
describe.skipIf(!existsSync(omp))("a subagent an earlier stop cut", () => {
	it("is not revived by a later relaunch once the session went on without it", async () => {
		const { provider, outcome, requestsAtCut, isolated } = await cutOff(
			[SPAWN, { text: "SPAWNED" }],
			"SIGTERM",
			[],
			async ({ provider: model, isolated: dir, root }) => {
				// The cut happened hours ago; since then the session went on (a turn) and a relaunch ran no restore.
				ageJournals(dir, 3 * 60 * 60_000);
				const idle = await startOmp(model, dir, root, true);
				await idle.send({ type: "prompt", message: "something else" });
				await expect.poll(() => idle.frames.some(frame => frame.type === "agent_end"), { timeout: 60_000 }).toBe(true);
				await idle.kill("EOF");
			},
		);
		expect(outcome).toMatchObject({ turn: false, subagents: [], followUp: false });
		expect(provider.subagentRequests).toBe(requestsAtCut);
		expect(mainJournal(isolated).some(entry => entry.customType === "ompdesk-restart-subagents")).toBe(false);
	}, 240_000);
});
