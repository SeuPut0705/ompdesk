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
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	type AutopilotCycleRecord,
	type AutopilotStatus,
	DEFAULT_AUTOPILOT_SETTINGS,
	AUTOPILOT_BRIDGE_METHODS as M,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * Autopilot on the installed stock omp, with the real bridge and a scripted OpenAI-compatible provider on
 * loopback (no credentials, no model spend): the `autopilot` tool is registered `essential` and reaches the
 * model; the protocol section rides every goal-continuation turn byte for byte; the `tool_call` guard blocks
 * a push, an edit outside the worktree and an `eval`; the cycle record and the frames arrive, and two unreported
 * cycles in a row do not stop the run; disarm restores the tool set.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

interface ProviderRequest {
	system: string;
	tools: string[];
	/** Tool results the request carried, newest last. */
	toolResults: string[];
	/** How many user/developer messages the conversation holds: the turn number. */
	turn: number;
	/** Tool results since the latest such message: how far into the turn the model is. */
	inTurn: number;
	/** The latest user/developer message, cut: which turn this request belongs to. */
	lastUser: string;
}

type ToolStep = { tool: string; args: Record<string, unknown> };
/** `calls`: several tool calls in one message, which stock runs side by side. */
type Reply = { text: string } | ToolStep | { calls: ToolStep[] };
type Step = Reply | { hang: true };

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completion(step: Reply, tools: string[]): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
	if ("text" in step) {
		return sse([
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		]);
	}
	// The provider payload may name a tool with a prefix; answer with the name as it was offered.
	const calls = "calls" in step ? step.calls : [step];
	const named = (wanted: string) => tools.find(tool => tool === wanted || tool.endsWith(`_${wanted}`)) ?? wanted;
	return sse([
		{
			...base,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: calls.map((call, index) => ({
							index,
							id: `call_${Math.random().toString(36).slice(2, 8)}`,
							type: "function",
							function: { name: named(call.tool), arguments: JSON.stringify(call.args) },
						})),
					},
					finish_reason: null,
				},
			],
		},
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
	]);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(part => textOf((part as { text?: unknown }).text ?? "")).join("");
	return "";
}

interface Provider {
	url: string;
	requests: ProviderRequest[];
	close(): Promise<void>;
}

async function startProvider(script: (requests: readonly ProviderRequest[]) => Step): Promise<Provider> {
	const requests: ProviderRequest[] = [];
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
			const results = parsed.messages
				.filter(message => message.role === "tool")
				.map(message => textOf(message.content));
			const starts = parsed.messages.map((message, index) =>
				message.role === "user" || (message.role === "developer" && index > 0) ? index : -1,
			);
			const lastStart = Math.max(...starts);
			requests.push({
				system,
				tools,
				toolResults: results,
				turn: starts.filter(index => index >= 0).length,
				inTurn: parsed.messages.slice(lastStart + 1).filter(message => message.role === "tool").length,
				lastUser: lastStart >= 0 ? textOf(parsed.messages[lastStart]?.content) : "",
			});
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const step = script(requests);
			// A hanging step keeps the connection open: the turn never ends (until the test kills omp).
			if (!("hang" in step)) res.end(completion(step, tools));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>(done => server.close(() => done()));
		},
	};
}

interface Harness {
	root: string;
	isolated: string;
	bridge: GuiBridgeClient;
	frames: Array<{ type: string; [key: string]: unknown }>;
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	waitFrame(predicate: (frame: { type: string; [key: string]: unknown }) => boolean, ms?: number): Promise<void>;
	/** Kills omp and the bridge; `keep` leaves the agent dir and the repo for a restart. */
	stop(keep?: boolean): Promise<void>;
	/** What a killed or quitting OMPdesk does to omp: its bridge and stdin close; resolves once omp has exited. */
	hangUp(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

async function startOmp(provider: Provider, previous?: Harness): Promise<Harness> {
	const isolated = previous?.isolated ?? mkdtempSync(join(tmpdir(), "ompdesk-autopilot-"));
	chmodSync(isolated, 0o700);
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	const root = previous?.root ?? realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-autopilot-repo-")));
	if (!previous) {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		writeFileSync(join(root, "a.txt"), "hello\n");
		execFileSync("git", ["add", "a.txt"], { cwd: root });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: root });
	}
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
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			...(previous ? ["--continue"] : []),
			"--model",
			"fake/m1",
			"-e",
			resolve("resources/gui-bridge/index.ts"),
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const frames: Harness["frames"] = [];
	const waiters: Array<() => void> = [];
	const responses = new Map<string, (value: Record<string, unknown>) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as { type: string; id?: string; [key: string]: unknown };
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
		for (const wake of waiters.splice(0)) wake();
	});
	const bridge = new GuiBridgeClient(address);
	bridge.onEvent(event => {
		frames.push(event);
		for (const wake of waiters.splice(0)) wake();
	});
	let counter = 0;
	const harness: Harness = {
		root,
		isolated,
		bridge,
		frames,
		send(command) {
			const id = `c${++counter}`;
			return new Promise((done, fail) => {
				const timer = setTimeout(
					() => fail(new Error(`no response to ${JSON.stringify(command)}\n${stderr.slice(-1500)}`)),
					60_000,
				);
				responses.set(id, value => {
					clearTimeout(timer);
					done(value);
				});
				child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			});
		},
		async waitFrame(predicate, ms = 90_000) {
			const end = Date.now() + ms;
			let seen = 0;
			for (;;) {
				for (; seen < frames.length; seen++) if (predicate(frames[seen])) return;
				const left = end - Date.now();
				if (left <= 0) {
					throw new Error(
						`timeout waiting for a frame; frames: ${JSON.stringify(frames.slice(-6)).slice(0, 1500)}\nstderr: ${stderr.slice(-1500)}`,
					);
				}
				await Promise.race([
					new Promise<void>(wake => waiters.push(wake)),
					new Promise(wake => setTimeout(wake, left)),
				]);
			}
		},
		async stop(keep = false) {
			bridge.close();
			child.kill("SIGKILL");
			removeBridgeAddress(address);
			if (keep) return;
			rmSync(isolated, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		},
		async hangUp() {
			const exited = new Promise<void>(done => child.once("exit", () => done()));
			bridge.close();
			child.stdin.end();
			await exited;
			removeBridgeAddress(address);
		},
	};
	cleanups.push(() => harness.stop());
	// The bridge listens once omp has loaded the extension; the session exists at `ready`.
	await harness.waitFrame(frame => frame.type === "ready");
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			await bridge.connect(1_000);
			break;
		} catch (error) {
			if (Date.now() > deadline) throw new Error(`bridge never came up: ${String(error)}\n${stderr.slice(-2000)}`);
			await new Promise(wake => setTimeout(wake, 300));
		}
	}
	return harness;
}

const BASH_PUSH = { tool: "bash", args: { command: "git push origin HEAD:main" } } as const;

/**
 * Turn 1 is a full cycle (begin, a blocked push, a blocked outside write, an allowed `git status`, end); every later turn
 * runs one distinct command and stops without an `end` report: unreported cycles (a distinct command keeps stock's own
 * no-progress rule, which stops on an empty or repeated tool digest, out of the way).
 */
function createScript(options: { hangAfterFirst?: boolean } = {}): (requests: readonly ProviderRequest[]) => Step {
	let turns = 0;
	return requests => {
		const latest = requests.at(-1);
		if (!latest) return { text: "?" };
		if (latest.inTurn === 0) turns++;
		if (options.hangAfterFirst && turns > 1) return { hang: true };
		if (turns > 1) {
			return latest.inTurn === 0
				? { tool: "bash", args: { command: `echo turn-${turns}` } }
				: { text: "nothing to report" };
		}
		return firstCycle(latest.inTurn);
	};
}

function firstCycle(inTurn: number): Step {
	switch (inTurn) {
		case 0:
			return { tool: "autopilot", args: { op: "begin" } };
		case 1:
			return BASH_PUSH;
		case 2:
			return { tool: "write", args: { path: "../outside.txt", content: "x" } };
		case 3:
			return { tool: "bash", args: { command: "git status --short" } };
		case 4:
			return {
				tool: "autopilot",
				args: {
					op: "end",
					area: "tests",
					title: "stock probe item",
					summary: "probed the guard",
					verify: "green",
					commit: "abc1234",
				},
			};
		default:
			return { text: "cycle done" };
	}
}

describe.skipIf(!existsSync(omp))("autopilot on stock omp", () => {
	it("arms, guards, finalizes cycles, keeps going through unreported ones and disarms", async () => {
		const provider = await startProvider(createScript());
		cleanups.push(() => provider.close());
		const h = await startOmp(provider);

		// A tab that is no run answers inactive and arms nothing.
		expect(await h.bridge.request<AutopilotStatus>(M.status, {})).toEqual({ active: false });

		// The tool presentation before arm: top-level tools and `xd://` devices. Disarm must give back exactly this.
		const presentation = async () => {
			const state = (await h.send({ type: "get_state" })).data as
				| { dumpTools?: Array<{ name: string }> }
				| undefined;
			const extras = await h.bridge.request<{ mounted: Array<{ name: string }> }>("composer.tool_extras", {});
			return {
				top: (state?.dumpTools ?? []).map(tool => tool.name).sort(),
				devices: extras.mounted.map(tool => tool.name).sort(),
			};
		};
		const before = await presentation();
		// `debug` is an `xd://` device here: the case where restoring through `setActiveToolsByName` made it top level.
		expect(before.devices).toContain("debug");
		expect(before.top).not.toContain("debug");

		const armed = await h.bridge.request<AutopilotStatus>(M.arm, {
			role: "parent",
			root: h.root,
			run: "2026-10-17",
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			settings: DEFAULT_AUTOPILOT_SETTINGS,
		});
		expect(armed).toMatchObject({ active: true, role: "parent", state: "running", run: "2026-10-17" });
		expect(armed.settings?.ship.autoPush).toBe(false);

		// Goal create AFTER arm: the first turn starts at once.
		const created = await h.send({ type: "goal", op: "create", objective: "Autopilot: test objective" });
		expect(created.success, JSON.stringify(created)).toBe(true);
		await h.waitFrame(frame => frame.type === "autopilot_cycle_end");
		const cycleEnd = h.frames.find(frame => frame.type === "autopilot_cycle_end");
		const record = cycleEnd?.record as AutopilotCycleRecord;
		const trace = JSON.stringify(
			provider.requests.map(({ turn, inTurn, tools, toolResults }) => ({
				turn,
				inTurn,
				tools: tools.length,
				toolResults,
			})),
		);
		expect(record, trace).toMatchObject({
			n: 1,
			area: "tests",
			title: "stock probe item",
			verify: "green",
		});
		// The probe model reports a hash that is no commit of the worktree: the bridge drops it instead of recording it.
		expect(record.commit).toBeUndefined();
		expect(record.tokens).toBeGreaterThan(0);

		// Turn 1: the autopilot tool reached the model as a top-level tool; the section was in the prompt.
		const first = provider.requests[0];
		expect(first.tools.some(name => name === "autopilot" || name.endsWith("_autopilot"))).toBe(true);
		expect(first.system).toContain("<autopilot>");
		expect(first.system).toContain("HARD LIMITS");
		// `ask`, `eval` and `debug` are off the tool set; approvals are granted by the session override (no card ever opened).
		for (const removed of ["ask", "eval", "debug"]) {
			expect(
				first.tools.some(name => name === removed || name.endsWith(`_${removed}`)),
				removed,
			).toBe(false);
		}
		const cards = h.frames.filter(
			frame => frame.type === "extension_ui_request" && String(frame.title).startsWith("Allow tool"),
		);
		expect(cards).toEqual([]);

		// The guard answered the push and the outside write with a block, and let `git status` through.
		const results = provider.requests.flatMap(request => request.toolResults);
		expect(results.some(text => text.includes("Blocked by autopilot") && text.includes("pushing"))).toBe(true);
		expect(
			results.some(text => text.includes("Blocked by autopilot") && text.includes("outside your worktree")),
		).toBe(true);
		expect(existsSync(join(h.root, "..", "outside.txt"))).toBe(false);

		// Continuation turns carry the same section byte for byte (the prompt cache holds).
		// Two unreported cycles in a row no longer stop the run: the third cycle ends and nobody asked for a pause.
		await h.waitFrame(
			frame => frame.type === "autopilot_cycle_end" && (frame.record as { n?: number } | undefined)?.n === 3,
		);
		expect(h.frames.some(frame => frame.type === "autopilot_stop_requested")).toBe(false);
		const systems = provider.requests
			.filter(request => request.system.includes("<autopilot>"))
			.map(request => request.system);
		expect(systems.length).toBeGreaterThanOrEqual(3);
		expect(new Set(systems).size).toBe(1);

		// The journal tells the story.
		const status = await h.bridge.request<AutopilotStatus>(M.status, {});
		expect(status.cycles?.map(cycle => cycle.area)).toEqual(["tests", "unreported", "unreported"]);
		expect(status.totals?.tokens).toBeGreaterThan(0);

		// Main pauses the goal and journals it; the run can be disarmed after the goal is dropped.
		await h.send({ type: "goal", op: "pause" });
		const paused = await h.bridge.request<AutopilotStatus>(M.setState, { state: "paused", reason: "user_pause" });
		expect(paused).toMatchObject({ state: "paused", reason: "user_pause" });
		await h.send({ type: "goal", op: "drop" });
		const ended = await h.bridge.request<AutopilotStatus>(M.disarm, {});
		expect(ended.state).toBe("ended");

		// Back to a normal session: no guard, the tool set is restored (no autopilot tool, `ask` is back).
		const idleBy = Date.now() + 30_000;
		for (;;) {
			const state = await h.send({ type: "get_state" });
			if (!(state.data as { isStreaming?: boolean } | undefined)?.isStreaming || Date.now() > idleBy) break;
			await new Promise(wake => setTimeout(wake, 200));
		}
		// The same top-level tools and the same `xd://` devices as before arm (`debug` a device again, not top level).
		await vi.waitFor(async () => expect(await presentation()).toEqual(before), { timeout: 10_000 });
		const promptResponse = await h.send({ type: "prompt", message: "plain question" });
		const asked = () => provider.requests.findLast(request => request.lastUser.includes("plain question"));
		const until = Date.now() + 20_000;
		while (!asked() && Date.now() < until) await new Promise(wake => setTimeout(wake, 200));
		const plain = asked();
		const recent = JSON.stringify(
			provider.requests.slice(-4).map(request => [request.turn, request.inTurn, request.lastUser]),
		);
		expect(plain, `${JSON.stringify(promptResponse)} ${recent}`).toBeDefined();
		expect(plain?.system).not.toContain("<autopilot>");
		expect(plain?.tools.some(name => name === "ask" || name.endsWith("_ask"))).toBe(true);
		expect(plain?.tools.some(name => name === "autopilot" || name.endsWith("_autopilot"))).toBe(false);
	}, 240_000);

	it("takes the commit a call beside `end` made: end waits for the calls in its message before it reads HEAD", async () => {
		// Cycle 90 of this repository's own run sent its commit and `end` in one message with a mistyped hash: `end` read
		// HEAD before the commit landed, the cycle had no commit and no change, and was never landed.
		const commit =
			"sleep 1 && echo more >> a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -qm second";
		let turns = 0;
		const provider = await startProvider(requests => {
			const latest = requests.at(-1);
			if (!latest) return { text: "?" };
			if (latest.inTurn === 0) turns++;
			if (turns > 1) return { hang: true };
			if (latest.inTurn === 0) return { tool: "autopilot", args: { op: "begin" } };
			if (latest.inTurn === 1) {
				return {
					calls: [
						{ tool: "bash", args: { command: commit } },
						{
							tool: "autopilot",
							args: {
								op: "end",
								area: "tests",
								title: "commit beside end",
								summary: "committed and reported in one message",
								verify: "skipped",
								commit: "abc1234",
							},
						},
					],
				};
			}
			return { text: "cycle done" };
		});
		cleanups.push(() => provider.close());
		const h = await startOmp(provider);
		await h.bridge.request<AutopilotStatus>(M.arm, {
			role: "parent",
			root: h.root,
			run: "2026-10-22",
			branch: "autopilot/2026-10-22",
			baseBranch: "main",
			settings: DEFAULT_AUTOPILOT_SETTINGS,
		});
		await h.send({ type: "goal", op: "create", objective: "Autopilot: test objective" });
		await h.waitFrame(frame => frame.type === "autopilot_cycle_end");
		const record = h.frames.find(frame => frame.type === "autopilot_cycle_end")?.record as AutopilotCycleRecord;
		const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: h.root, encoding: "utf8" }).trim();
		const log = execFileSync("git", ["log", "--oneline"], { cwd: h.root, encoding: "utf8" });
		const results = JSON.stringify(provider.requests.map(request => request.toolResults.slice(-2)));
		expect(record, `${log}\n${results}\n${JSON.stringify(record)}`).toMatchObject({
			n: 1,
			title: "commit beside end",
			commit: head,
		});
		expect(record.change).toMatchObject({ files: 1, commits: 1 });
		await h.stop();
	}, 120_000);

	it("follows the journal after a restart: the guard is on before arm, and the resumed run continues at the next cycle number", async () => {
		const first = await startProvider(createScript({ hangAfterFirst: true }));
		cleanups.push(() => first.close());
		const before = await startOmp(first);
		await before.bridge.request(M.arm, {
			role: "parent",
			root: before.root,
			run: "2026-10-17",
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			settings: DEFAULT_AUTOPILOT_SETTINGS,
		});
		await before.send({ type: "goal", op: "create", objective: "Autopilot: test objective" });
		await before.waitFrame(frame => frame.type === "autopilot_cycle_end");
		// The app dies in the middle of the next cycle: nothing is journaled but cycle 1.
		await before.stop(true);

		let mode: "prompt" | "cycle" = "prompt";
		const second = await startProvider(requests => {
			const latest = requests.at(-1);
			if (!latest) return { text: "?" };
			if (mode === "prompt") return latest.inTurn === 0 ? BASH_PUSH : { text: "stopped" };
			if (latest.inTurn === 0) return { tool: "autopilot", args: { op: "begin" } };
			if (latest.inTurn === 1) {
				return {
					tool: "autopilot",
					args: {
						op: "end",
						area: "bugs",
						title: "after restart",
						summary: "s",
						verify: "green",
						commit: "def5678",
					},
				};
			}
			return { text: "done" };
		});
		cleanups.push(() => second.close());
		const after = await startOmp(second, before);

		// Hydration: the run is still `running` with its history; stock reset the goal, nothing resumes by itself.
		const hydrated = await after.bridge.request<AutopilotStatus>(M.status, {});
		expect(hydrated).toMatchObject({ active: true, state: "running", cycle: 1 });
		expect(hydrated.cycles?.map(cycle => cycle.n)).toEqual([1]);

		// The guard follows the journal from session start, before anything arms: a plain turn cannot push.
		await after.send({ type: "prompt", message: "try the push" });
		const blocked = () =>
			second.requests.flatMap(request => request.toolResults).some(text => text.includes("Blocked by autopilot"));
		const until = Date.now() + 30_000;
		while (!blocked() && Date.now() < until) await new Promise(wake => setTimeout(wake, 200));
		expect(blocked()).toBe(true);

		// Arm (resume) restores tools and overrides, then stock's goal resume continues at cycle 3.
		mode = "cycle";
		const rearmed = await after.bridge.request<AutopilotStatus>(M.arm, {
			role: "parent",
			root: after.root,
			run: "2026-10-17",
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			resume: true,
		});
		// The plain turn above ran while the run was `running`: every turn of a running run is a cycle (unreported here).
		expect(rearmed).toMatchObject({ state: "running", cycle: 2 });
		expect(rearmed.cycles?.map(cycle => cycle.area)).toEqual(["tests", "unreported"]);
		const idleBy = Date.now() + 30_000;
		for (;;) {
			const state = await after.send({ type: "get_state" });
			if (!(state.data as { isStreaming?: boolean } | undefined)?.isStreaming || Date.now() > idleBy) break;
			await new Promise(wake => setTimeout(wake, 200));
		}
		const resumed = await after.send({ type: "goal", op: "resume" });
		expect(resumed.success, JSON.stringify(resumed)).toBe(true);
		const isThird = (frame: { type: string; record?: unknown }) =>
			frame.type === "autopilot_cycle_end" && (frame.record as AutopilotCycleRecord).n === 3;
		await after.waitFrame(isThird);
		const record = after.frames.find(isThird)?.record as AutopilotCycleRecord;
		const trace = JSON.stringify([record, second.requests.at(-1)?.tools]);
		expect(record, trace).toMatchObject({ n: 3, area: "bugs", title: "after restart", verify: "green" });
	}, 240_000);

	it("after OMPdesk goes away mid-turn, the relaunch sees the goal cut off and the resumed run keeps its armed tools", async () => {
		const presentation = async (h: Harness) => {
			const state = (await h.send({ type: "get_state" })).data as
				| { dumpTools?: Array<{ name: string }> }
				| undefined;
			return (state?.dumpTools ?? []).map(tool => tool.name);
		};
		const expectArmed = (tools: string[]) => {
			expect(tools).toContain("autopilot");
			for (const name of ["ask", "eval", "debug"]) expect(tools, name).not.toContain(name);
		};
		// The model never answers: the run's first turn is streaming when OMPdesk dies, and so is every later one.
		const streaming = Promise.withResolvers<void>();
		const provider = await startProvider(() => {
			streaming.resolve();
			return { hang: true };
		});
		cleanups.push(() => provider.close());
		const before = await startOmp(provider);
		const arm = {
			role: "parent",
			root: before.root,
			run: "2026-10-17",
			branch: "autopilot/2026-10-17",
			baseBranch: "main",
			settings: DEFAULT_AUTOPILOT_SETTINGS,
		};
		await before.bridge.request(M.arm, arm);
		await before.send({ type: "goal", op: "create", objective: "Autopilot: test objective" });
		await streaming.promise;
		// A killed or quitting OMPdesk closes omp's stdin and the bridge. Stock journals the turn aborted and may exit
		// without a `session_exit`.
		await before.hangUp();

		const after = await startOmp(provider, before);
		// The goal was active until that process ended; stock paused it at startup.
		const restored = await after.bridge.request<{ goalPausedByExit?: boolean }>("composer.restore_interrupted", {});
		expect(restored.goalPausedByExit).toBe(true);

		// Main's relaunch order (autopilot.ts `#continueAfterRestart`): stock's `goal pause` drops the tool set stock
		// remembered when it reattached the goal (ask, eval and debug back, no `autopilot`), then arm, then resume.
		expect((await after.send({ type: "goal", op: "pause" })).success).toBe(true);
		await after.bridge.request(M.arm, { ...arm, resume: true });
		const resumed = await after.send({ type: "goal", op: "resume" });
		expect(resumed.success, JSON.stringify(resumed)).toBe(true);
		expectArmed(await presentation(after));
		// What stock restores on the next pause (a stop rule) is the armed set too: the run stays armed while it lives.
		expect((await after.send({ type: "goal", op: "pause" })).success).toBe(true);
		expectArmed(await presentation(after));
	}, 120_000);

	it("after a SIGKILL of omp, the relaunch names a background bash job the last process started (no session_exit)", async () => {
		// The turn starts a background job, then the model never answers again: the turn is streaming at the kill.
		const streaming = Promise.withResolvers<void>();
		const provider = await startProvider(requests => {
			if (requests.length === 1) return { tool: "bash", args: { command: "sleep 60", async: true } };
			streaming.resolve();
			return { hang: true };
		});
		cleanups.push(() => provider.close());
		const before = await startOmp(provider);
		await before.send({ type: "prompt", message: "start the job" });
		await streaming.promise;
		expect(provider.requests[1]?.toolResults.join("\n")).toMatch(/bg_|job/i);
		// A crash or SIGKILL: stock journals no `session_exit` (a closed stdin sometimes does not either).
		await before.stop(true);
		const sessions = join(before.isolated, "agent", "sessions");
		const journal = readdirSync(sessions, { recursive: true })
			.map(String)
			.filter(file => file.endsWith(".jsonl"))
			.map(file => readFileSync(join(sessions, file), "utf8"))
			.join("\n");
		// What made the old rule (the life before the latest `session_exit`) report nothing.
		expect(journal).not.toContain('"customType":"session_exit"');

		const after = await startOmp(provider, before);
		const restored = await after.bridge.request<{ jobs?: string[] }>("composer.restore_interrupted", {});
		expect(restored.jobs, JSON.stringify(restored)).toHaveLength(1);
	}, 120_000);
});
