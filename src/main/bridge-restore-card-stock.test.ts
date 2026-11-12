import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * A card open when the app quits into an update comes back after the relaunch (bridge `composer.restore_interrupted`
 * → stock `restoreSession`, what TurnResume runs for an `asking` marker), on the installed omp with a scripted
 * OpenAI-compatible provider on loopback (no model spend). The automatic update stops waiting for such a card once
 * nobody has given the computer input for ten minutes (app-auto-update.ts): safe only because the same question
 * reopens. Stock replays the cut-off call itself (the batch is fully failed or left pending), so the model is not
 * asked again. A plan proposal is not here: it lives only in the bridge of the omp that made it (modes/plan.ts
 * `pending`), and the automatic update keeps waiting for it.
 */
const PROMPT = "CARD-MARK go";
/** The extension UI methods that wait for the person's answer (the rest are fire-and-forget). */
const DIALOGS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

interface Step {
	tool: string;
	args: Record<string, unknown>;
}

interface Frame {
	type: string;
	id?: string;
	method?: string;
	title?: string;
	options?: unknown;
}

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completion(step: Step | { text: string }, tools: string[]): string {
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
		id: "call_card",
		type: "function",
		function: { name, arguments: JSON.stringify(step.args) },
	};
	return sse([
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
	]);
}

interface Provider {
	url: string;
	/** Requests of the session's own turn (side requests, which offer no bash tool, are left out). */
	requests: number;
	close(): Promise<void>;
}

/** Answers the prompt with `step`, and anything after its result with text. */
async function startProvider(step: Step): Promise<Provider> {
	const provider: Provider = { url: "", requests: 0, close: async () => undefined };
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
				messages: Array<{ role: string }>;
				tools?: Array<{ function?: { name?: string } }>;
			};
			const tools = (parsed.tools ?? []).map(tool => tool.function?.name ?? "");
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (!tools.some(tool => tool.endsWith("bash"))) {
				res.end(completion({ text: "side" }, tools));
				return;
			}
			provider.requests++;
			const answered = parsed.messages.some(message => message.role === "tool");
			res.end(completion(answered ? { text: "ANSWERED" } : step, tools));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as { port: number };
	provider.url = `http://127.0.0.1:${port}/v1`;
	provider.close = () => {
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	};
	return provider;
}

/** How the app stops a tab's omp at a quit (omp-stop.ts): SIGTERM on POSIX, stdin first with ai-memory's grace or on Windows. */
type Stop = "sigterm" | "stdin";

interface Omp {
	bridge: GuiBridgeClient;
	frames: Frame[];
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
	stop(how: Stop): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

async function startOmp(
	provider: Provider,
	isolated: string,
	root: string,
	resume: boolean,
	extra: string[],
): Promise<Omp> {
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
		PI_CONFIG_DIR: configDirName(isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...(resume ? ["--continue"] : []),
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
			...extra,
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	const frames: Frame[] = [];
	const responses = new Map<string, (value: Record<string, unknown>) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame;
			const answer = frame.type === "response" && frame.id ? responses.get(frame.id) : undefined;
			if (answer) answer(frame as unknown as Record<string, unknown>);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	const bridge = new GuiBridgeClient(address);
	let counter = 0;
	let stopping: Promise<void> | undefined;
	const stop = (how: Stop) => {
		stopping ??= (async () => {
			bridge.close();
			if (how === "stdin") child.stdin.end();
			else child.kill("SIGTERM");
			// A guard, not a wait: an omp that ignores its stop is killed so the test ends.
			const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
			await exited.promise;
			clearTimeout(guard);
			removeBridgeAddress(address);
		})();
		return stopping;
	};
	cleanups.push(() => stop("stdin"));
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
		stop,
		send: command => {
			const id = `c${++counter}`;
			const { promise, resolve: done, reject: fail } = Promise.withResolvers<Record<string, unknown>>();
			// A guard, not a wait: an omp that never answers fails the test with its stderr.
			const guard = setTimeout(() => fail(new Error(`no response\n${stderr.slice(-1500)}`)), 60_000);
			responses.set(id, value => {
				clearTimeout(guard);
				done(value);
			});
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			return promise;
		},
	};
}

/** The cards an omp asked the person: what each one showed. */
const cards = (o: Omp) =>
	o.frames
		.filter(frame => frame.type === "extension_ui_request" && DIALOGS[String(frame.method)] === true)
		.map(({ method, title, options }) => ({ method, title, options }));

/** The tab's turn waits on `step`'s card when the app quits into an update; the relaunch continues it as TurnResume does. */
async function relaunchOverCard(step: Step, how: Stop, extra: string[] = []) {
	const provider = await startProvider(step);
	cleanups.push(() => provider.close());
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-card-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-card-repo-")));
	cleanups.push(() => {
		rmSync(isolated, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const first = await startOmp(provider, isolated, root, false, extra);
	await first.send({ type: "prompt", message: PROMPT });
	await expect.poll(() => cards(first).length, { timeout: 60_000 }).toBe(1);
	await first.stop(how);
	const asked = provider.requests;
	const second = await startOmp(provider, isolated, root, true, extra);
	const outcome = await second.bridge.request<{ turn?: boolean; followUp?: boolean }>(
		"composer.restore_interrupted",
		{},
	);
	if (outcome.turn !== true && outcome.followUp !== true) await second.send({ type: "retry" });
	await expect.poll(() => cards(second).length, { timeout: 60_000 }).toBe(1);
	return { before: cards(first), after: cards(second), outcome, askedAgain: provider.requests - asked };
}

const ASK: Step = {
	tool: "ask",
	args: {
		html: '<form><label>Which color?<select name="color"><option>red</option><option>blue</option></select></label></form>',
	},
};
const BASH: Step = { tool: "bash", args: { command: "echo approved-$((40+2))", i: "printing" } };

describe.skipIf(!existsSync(omp))("a card open when the app quits into an update, on stock omp", () => {
	for (const how of ["sigterm", "stdin"] as const) {
		it(`reopens the same ask card after the relaunch (${how})`, async () => {
			const { before, after, outcome, askedAgain } = await relaunchOverCard(ASK, how);
			expect(before).toEqual([{ method: "select", title: "Which color?", options: ["red", "blue"] }]);
			expect(after).toEqual(before);
			expect(outcome).toMatchObject({ turn: true });
			expect(askedAgain).toBe(0);
		}, 240_000);

		it(`reopens the same approval card after the relaunch (${how})`, async () => {
			const { before, after, outcome, askedAgain } = await relaunchOverCard(BASH, how, [
				"--approval-mode",
				"always-ask",
			]);
			expect(before).toEqual([
				expect.objectContaining({ title: expect.stringContaining("echo approved-$((40+2))") }),
			]);
			expect(after).toEqual(before);
			expect(outcome).toMatchObject({ turn: true });
			expect(askedAgain).toBe(0);
		}, 240_000);
	}
});
