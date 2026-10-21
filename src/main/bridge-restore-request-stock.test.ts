import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * A relaunch continues a turn that OMPdesk's quit cut while omp was preparing its next model request (bridge
 * `composer.restore_interrupted` → stock `restoreSession`), on the installed omp with a scripted OpenAI-compatible
 * provider on loopback (no model spend).
 *
 * Reported on v0.41.0 (19 Oct 2026): "Restart to update" ended a session ~140 ms after its bash result came back,
 * while stock was still building the next request over a 600k-token context. Stock disposed the session and journaled
 * `session_exit` with kind `normal` and no pending tool call; the abort landed before the model call, where stock's
 * agent loop stops without an assistant message (pi-agent-core `agent-loop.ts`, the `beforeModelCall` gate), so no
 * aborted reply reached the journal. Stock's `findUnfinishedTurn` reads a normal exit with nothing pending as a turn
 * that ended, and `/retry` finds no failed reply: the relaunch logged `restored: nothing, retried: false` and the turn
 * was dropped. A prompt cut the same way in a session that already had a reply is dropped alike.
 *
 * The test widens that window with a second extension whose `context` handler (awaited before every model request)
 * waits until the abort, then quits the way OMPdesk does: stdin closes.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const FIRST = "FIRST-MARK say hello";
const SECOND = "SECOND-MARK go on";

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

interface Provider {
	url: string;
	/** Second-turn requests past `secondTurn`'s steps, answered `CONTINUED`: the continued turn. */
	continued: number;
	close(): Promise<void>;
}

/** The first prompt is answered in text; the second runs `secondTurn` (one step per tool result since it), then `CONTINUED`. */
async function startProvider(secondTurn: readonly Step[]): Promise<Provider> {
	const provider: Provider = { url: "", continued: 0, close: async () => undefined };
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
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			// Side requests (the next-prompt suggestion, a title) offer no bash tool: a plain answer.
			if (!tools.some(tool => tool.endsWith("bash"))) {
				res.end(completion({ text: "side" }, tools, "side"));
				return;
			}
			const second = parsed.messages.findIndex(
				message => message.role === "user" && textOf(message.content).includes(SECOND),
			);
			if (second === -1) {
				res.end(completion({ text: "FIRST-DONE" }, tools, "first"));
				return;
			}
			const step = parsed.messages.slice(second).filter(message => message.role === "tool").length;
			const scripted = secondTurn[step];
			if (scripted) {
				res.end(completion(scripted, tools, `call_${step}`));
				return;
			}
			provider.continued++;
			res.end(completion({ text: "CONTINUED" }, tools, "continued"));
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

/**
 * While `hold` exists, the request after `holdAfter` (the second prompt, or its bash result) waits in a `context`
 * handler until the session aborts, after writing `held`: the slow request preparation of the report.
 */
function writeHoldExtension(dir: string, holdAfter: "user" | "toolResult"): { hold: string; held: string } {
	const hold = join(dir, "hold");
	const held = join(dir, "held");
	writeFileSync(hold, "");
	writeFileSync(
		join(dir, "hold-extension.ts"),
		`import { existsSync, writeFileSync } from "node:fs";
export default function (pi: { on(event: string, handler: (event: { messages: Array<{ role: string; content: unknown }> }, ctx: unknown, signal?: AbortSignal) => unknown): void }) {
	pi.on("context", async (event, _ctx, signal) => {
		if (!existsSync(${JSON.stringify(hold)})) return undefined;
		const text = JSON.stringify(event.messages);
		if (!text.includes(${JSON.stringify(SECOND)}) || event.messages.at(-1)?.role !== ${JSON.stringify(holdAfter)}) return undefined;
		writeFileSync(${JSON.stringify(held)}, "");
		await new Promise<void>(done => {
			if (signal?.aborted) done();
			signal?.addEventListener("abort", () => done());
		});
		return undefined;
	});
}
`,
	);
	return { hold, held };
}

interface Omp {
	bridge: GuiBridgeClient;
	frames: Array<{ type: string; [key: string]: unknown }>;
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** OMPdesk's quit of a tab's omp (sidecar.ts): stdin closes and stock disposes the session. */
	quit(): Promise<void>;
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
			...["-e", join(isolated, "hold-extension.ts")],
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
	const quit = async () => {
		bridge.close();
		child.stdin.end();
		// A guard, not a wait: an omp that ignores its closed stdin is killed so the test ends.
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
		removeBridgeAddress(address);
	};
	cleanups.push(() => quit());
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
		quit,
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

interface Entry {
	type?: string;
	customType?: string;
	data?: { kind?: string; pendingToolCalls?: unknown[] };
	message?: { role?: string; content?: unknown; stopReason?: string };
}

function journalFile(isolated: string): string {
	const sessions = join(isolated, "agent", "sessions");
	const [project] = readdirSync(sessions);
	const [file] = readdirSync(join(sessions, project ?? "")).filter(name => name.endsWith(".jsonl"));
	return join(sessions, project ?? "", file ?? "");
}

function journal(isolated: string): Entry[] {
	return readFileSync(journalFile(isolated), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Entry);
}

const messagesOf = (entries: readonly Entry[]) => entries.filter(entry => entry.type === "message");

/**
 * One omp life that answers a first prompt, then quits while the second turn prepares its next model request.
 * `lostAfterExit`: the tail message (`holdAfter`) is journaled before the quit, and stock's own abort record, written
 * after its `session_exit`, never reaches the journal (the report: omp's stdout write failed EPIPE as the app went and
 * stock's graceful quit ended the process first; a race this test cannot time, so it removes what followed the exit).
 */
async function quitBeforeRequest(
	secondTurn: readonly Step[],
	holdAfter: "user" | "toolResult",
	options: { lostAfterExit?: boolean } = {},
) {
	const provider = await startProvider(secondTurn);
	cleanups.push(() => provider.close());
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-request-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-request-repo-")));
	cleanups.push(() => {
		rmSync(isolated, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const { hold, held } = writeHoldExtension(isolated, holdAfter);
	const first = await startOmp(provider, isolated, root, false);
	await first.send({ type: "prompt", message: FIRST });
	await expect.poll(() => first.frames.some(frame => frame.type === "agent_end"), { timeout: 60_000 }).toBe(true);
	await first.send({ type: "prompt", message: SECOND });
	await expect.poll(() => existsSync(held), { timeout: 60_000 }).toBe(true);
	if (options.lostAfterExit) {
		await expect.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.role, { timeout: 30_000 }).toBe(holdAfter);
	}
	await first.quit();
	const lines = readFileSync(journalFile(isolated), "utf8").split("\n").filter(Boolean);
	const exitAt = lines.findLastIndex(line => (JSON.parse(line) as Entry).customType === "session_exit");
	if (options.lostAfterExit) {
		writeFileSync(journalFile(isolated), `${lines.slice(0, exitAt + 1).join("\n")}\n`);
		// What the relaunch finds: a clean exit with nothing pending after the cut-off tail, and no reply after it.
		const before = journal(isolated);
		expect(before.at(-1)).toMatchObject({ customType: "session_exit", data: { kind: "normal" } });
		expect(before.at(-1)?.data?.pendingToolCalls).toBeUndefined();
		expect(messagesOf(before).at(-1)?.message?.role).toBe(holdAfter);
	}
	const before = journal(isolated);
	rmSync(hold);
	const second = await startOmp(provider, isolated, root, true);
	const outcome = await second.bridge.request<{ turn: boolean }>("composer.restore_interrupted", {});
	return { provider, isolated, outcome, before };
}

describe.skipIf(!existsSync(omp))("a quit while omp prepares the next model request, on stock omp", () => {
	it("continues the turn whose bash result the model had not answered yet, without running bash again", async () => {
		const { provider, isolated, outcome } = await quitBeforeRequest(
			[{ tool: "bash", args: { command: "echo probe", i: "probing" } }],
			"toolResult",
			{ lostAfterExit: true },
		);
		expect(outcome).toMatchObject({ turn: true });
		await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
		await expect
			.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.content, { timeout: 30_000 })
			.toEqual([expect.objectContaining({ text: "CONTINUED" })]);
		expect(messagesOf(journal(isolated)).filter(entry => entry.message?.role === "toolResult")).toHaveLength(1);
	}, 240_000);

	it("answers a prompt whose first request was being prepared, with the prompt in the journal once", async () => {
		const { provider, isolated, outcome, before } = await quitBeforeRequest([], "user");
		// Stock journals an unanswered prompt only as its process ends, after the exit record: its own restore sees it.
		const exitAt = before.findLastIndex(entry => entry.customType === "session_exit");
		expect(messagesOf(before.slice(exitAt)).map(entry => entry.message?.role)).toEqual(["user"]);
		expect(outcome).toMatchObject({ turn: true });
		await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
		await expect
			.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.content, { timeout: 30_000 })
			.toEqual([expect.objectContaining({ text: "CONTINUED" })]);
		const prompts = messagesOf(journal(isolated)).filter(entry => textOf(entry.message?.content).includes(SECOND));
		expect(prompts).toHaveLength(1);
	}, 240_000);
});

/**
 * The v0.48.0 → v0.49.0 update restart (21 Oct 2026): the quit aborted two turns mid-tool (a `wait`, a long bash), stock
 * journaled the aborted tool result and the aborted reply, and then a custom message landed after them: in the parent
 * a report the bridge handed the session once the abort left it idle (`ompdesk.mail`), in a child a follow-up stock had
 * queued since an earlier relaunch. Stock's `retry` reads the conversation's end past its eval snapshots only, so the
 * custom message hid the aborted reply: the relaunch logged `restored: nothing, retried: false` and both sat idle.
 */
describe.skipIf(!existsSync(omp))(
	"a quit that aborted a tool, with a note journaled after the abort, on stock omp",
	() => {
		it("goes on with the turn after the relaunch", async () => {
			const provider = await startProvider([{ tool: "bash", args: { command: "sleep 120", i: "long check" } }]);
			cleanups.push(() => provider.close());
			const isolated = mkdtempSync(join(tmpdir(), "ompdesk-noted-"));
			chmodSync(isolated, 0o700);
			const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-noted-repo-")));
			cleanups.push(() => {
				rmSync(isolated, { recursive: true, force: true });
				rmSync(root, { recursive: true, force: true });
			});
			const { hold } = writeHoldExtension(isolated, "user");
			rmSync(hold);
			const first = await startOmp(provider, isolated, root, false);
			await first.send({ type: "prompt", message: FIRST });
			await expect
				.poll(() => first.frames.some(frame => frame.type === "agent_end"), { timeout: 60_000 })
				.toBe(true);
			await first.send({ type: "prompt", message: SECOND });
			await expect
				.poll(() => first.frames.some(frame => frame.type === "tool_execution_start"), { timeout: 60_000 })
				.toBe(true);
			await first.quit();
			const lines = readFileSync(journalFile(isolated), "utf8").split("\n").filter(Boolean);
			const last = JSON.parse(lines.at(-1) ?? "{}") as { id?: string };
			expect(messagesOf(journal(isolated)).at(-1)?.message?.stopReason).toBe("aborted");
			// What v0.49.0's bridge journaled after the abort: a session report, displayed, in the model's context.
			const note = {
				type: "custom_message",
				id: "n0te0001",
				parentId: last.id,
				timestamp: new Date().toISOString(),
				customType: "ompdesk.mail",
				content: '<ompdesk-mail from="child" kind="progress">still working</ompdesk-mail>',
				display: true,
				details: { id: "m1", from: "child", kind: "progress", text: "still working" },
			};
			writeFileSync(journalFile(isolated), `${[...lines, JSON.stringify(note)].join("\n")}\n`);
			const second = await startOmp(provider, isolated, root, true);
			const outcome = await second.bridge.request<{ turn: boolean; followUp: boolean }>(
				"composer.restore_interrupted",
				{},
			);
			expect(outcome).toMatchObject({ turn: false, followUp: true });
			await expect.poll(() => provider.continued, { timeout: 60_000 }).toBe(1);
			await expect
				.poll(() => messagesOf(journal(isolated)).at(-1)?.message?.content, { timeout: 30_000 })
				.toEqual([expect.objectContaining({ text: "CONTINUED" })]);
		}, 240_000);
	},
);
