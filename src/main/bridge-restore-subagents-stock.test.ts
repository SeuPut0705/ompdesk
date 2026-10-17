import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * A relaunch revives the subagents the last omp was running (bridge `composer.restore_interrupted` → stock
 * `restoreSession`), on the installed omp with a scripted OpenAI-compatible provider on loopback (no model spend).
 *
 * Reported on v0.35.1: the main session's turn had ended with a background subagent still working; after the
 * update restart the subagent went on and its result reached the parent, but nothing in OMPdesk showed it running.
 * Stock sends a revived subagent's lifecycle and progress frames to the buses `restoreSession` is given, as a live
 * run does; the bridge passed none, so omp's RPC subagent registry (`get_subagents`, the `subagent_*` frames the
 * work board, the dock and the composer's background cue read) never heard of it.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const SUBTASK = "SUBTASK-MARK: list the files and report";

type Step = { text: string } | { tool: string; args: Record<string, unknown> } | { hang: true };

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completion(step: Exclude<Step, { hang: true }>, tools: string[]): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
	if ("text" in step) {
		return sse([
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		]);
	}
	const name = tools.find(tool => tool === step.tool || tool.endsWith(`_${step.tool}`)) ?? step.tool;
	const call = {
		index: 0,
		id: "call_spawn",
		type: "function",
		function: { name, arguments: JSON.stringify(step.args) },
	};
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

interface Provider {
	url: string;
	/** Requests whose conversation carries the subagent's assignment. */
	subagentRequests: number;
	close(): Promise<void>;
}

/** The parent spawns one background subagent and ends its turn; the subagent's model call never answers. */
async function startProvider(): Promise<Provider> {
	const provider: Provider = { url: "", subagentRequests: 0, close: async () => undefined };
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
			const user = parsed.messages
				.filter(message => message.role === "user")
				.map(message => textOf(message.content));
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (user.some(text => text.includes(SUBTASK))) {
				provider.subagentRequests++;
				return; // the subagent works until omp is killed (and again once revived)
			}
			// Side requests (the next-prompt suggestion, a title) offer no task tool: a plain answer.
			const spawnNow = tools.some(tool => tool.endsWith("task")) && !parsed.messages.some(m => m.role === "tool");
			const item = { name: "Probe", agent: "task", task: SUBTASK, solutionSpace: "one listing" };
			res.end(
				completion(
					spawnNow ? { tool: "task", args: { context: "probe", tasks: [item] } } : { text: "SPAWNED" },
					tools,
				),
			);
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
	kill(): void;
}

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
	const kill = () => {
		bridge.close();
		child.kill("SIGKILL");
		removeBridgeAddress(address);
	};
	cleanups.push(kill);
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

describe.skipIf(!existsSync(omp))("revived subagents on stock omp", () => {
	it("reports a subagent the restore revived to omp's subagent registry, as a live one", async () => {
		const provider = await startProvider();
		cleanups.push(() => provider.close());
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-revive-"));
		chmodSync(isolated, 0o700);
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-revive-repo-")));
		cleanups.push(() => {
			rmSync(isolated, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		});

		// The parent spawns the subagent in the background and ends its turn; the subagent is mid-call.
		const first = await startOmp(provider, isolated, root, false);
		await first.send({ type: "prompt", message: "start the background work" });
		await expect.poll(() => provider.subagentRequests, { timeout: 90_000 }).toBeGreaterThan(0);
		await expect.poll(() => first.frames.some(frame => frame.type === "agent_end"), { timeout: 60_000 }).toBe(true);
		const [spawned] = await roster(first);
		expect(spawned).toMatchObject({ status: "running" });
		const id = spawned?.id;
		// What a restart (an update, a crash) does to omp.
		first.kill();

		const second = await startOmp(provider, isolated, root, true);
		const outcome = await second.bridge.request<{ subagents: string[] }>("composer.restore_interrupted", {});
		expect(outcome.subagents).toEqual([id]);
		// Revived: its model call goes out again, and omp's registry lists it as running.
		await expect.poll(() => provider.subagentRequests, { timeout: 90_000 }).toBeGreaterThan(1);
		await expect
			.poll(() => roster(second), { timeout: 30_000 })
			.toEqual([expect.objectContaining({ id, status: "running" })]);
	}, 240_000);
});
