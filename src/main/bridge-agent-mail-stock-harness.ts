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
import { expect } from "vitest";
import { MAIL_CUSTOM_TYPE } from "../../resources/gui-bridge/agent-control-contracts";
import { deliveryFor, type MailKind } from "./agent-control/mail";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * The installed omp and what a stock-level mail test needs around it: a scripted OpenAI-compatible provider on
 * loopback (no model spend), an omp in rpc-ui mode with the gui bridge extension, and readers for its frames and
 * session files. Shared by `bridge-agent-mail-stock.test.ts` and `bridge-agent-mail-restart-stock.test.ts`.
 */
export const omp = join(homedir(), ".bun", "bin", "omp");
export const HOLD = "HOLD-MARK run";

/** A prompt whose turn calls the shell tool and then sits in it (`sleep`). */
export const TOOL = "TOOL-MARK run";

/** A prompt whose turn runs two shell calls in one batch (`sleep 3` each), then replies. */
export const PARALLEL = "PARALLEL-MARK run";

/** A prompt whose turn starts a background shell job (`sleep 300`, `async: true`) and then `wait`s on it. */
export const WAIT = "WAIT-MARK run";

export type Frame = {
	type: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	result?: unknown;
	message?: { role?: string; customType?: string; details?: { id?: string } };
};

function sse(text: string): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const chunks = [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		},
	];
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** A reply that calls tools, all in one batch. */
function toolSse(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): string {
	const base = { id: "c2", object: "chat.completion.chunk", created: 1, model: "m1" };
	const toolCalls = calls.map((call, index) => ({
		index,
		id: call.id,
		type: "function",
		function: { name: call.name, arguments: JSON.stringify(call.args) },
	}));
	const chunks = [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] },
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		},
	];
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

export interface Provider {
	url: string;
	/** Main-agent requests seen (side requests such as a title offer no bash tool and are not counted). */
	turns: number;
	/** The body of every main-agent request, in order. */
	bodies: string[];
	/** Resolves once a request of the held prompt arrived; `release` answers it. */
	held: Promise<void>;
	release(): void;
	close(): Promise<void>;
}

export async function startProvider(): Promise<Provider> {
	const arrived = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const provider: Provider = {
		url: "",
		turns: 0,
		bodies: [],
		held: arrived.promise,
		release: () => released.resolve(),
		close: async () => undefined,
	};
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", async () => {
			if (!req.url?.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
			const toolNamed = (end: string) =>
				(parsed.tools ?? []).find(tool => tool.function?.name?.endsWith(end))?.function?.name;
			const shell = toolNamed("bash");
			const main = shell !== undefined;
			if (main) {
				provider.turns++;
				provider.bodies.push(body);
			}
			const results = body.split('"role":"tool"').length - 1;
			const reply = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				res.end(toolSse(calls));
			};
			if (shell && body.includes(TOOL) && results === 0) {
				reply([{ id: "call_1", name: shell, args: { command: "sleep 300" } }]);
				return;
			}
			if (shell && body.includes(PARALLEL) && results === 0) {
				reply([
					{ id: "call_a", name: shell, args: { command: "sleep 3" } },
					{ id: "call_b", name: shell, args: { command: "sleep 3" } },
				]);
				return;
			}
			const wait = toolNamed("wait");
			if (shell && wait && body.includes(WAIT) && results < 2) {
				reply(
					results === 0
						? [{ id: "call_job", name: shell, args: { command: "sleep 300", async: true } }]
						: [{ id: "call_wait", name: wait, args: {} }],
				);
				return;
			}
			if (main && body.includes(HOLD)) {
				arrived.resolve();
				await released.promise;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.end(sse(main ? "DONE" : "side"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	provider.url = `http://127.0.0.1:${port}/v1`;
	provider.close = () => {
		released.resolve();
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	};
	return provider;
}

const cleanups: Array<() => Promise<void> | void> = [];
/** Run by the suite's `afterAll`: closes every omp, provider and folder a test started. */
export async function runCleanups(): Promise<void> {
	for (const cleanup of cleanups.reverse()) await cleanup();
}
export function atEnd(fn: () => Promise<void> | void): void {
	cleanups.push(fn);
}

export interface Omp {
	bridge: GuiBridgeClient;
	frames: Frame[];
	isolated: string;
	root: string;
	/** Closes stdin the way a quit does (stock disposes its session then) and resolves once the process is gone. */
	stop(): Promise<void>;
	/** SIGKILL, as a crash or a force-quit ends it: stock disposes nothing. */
	kill(): Promise<void>;
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** A fresh omp, or (`again`) a second process on the folders and session file an earlier one left, as a relaunch is. */
export async function startOmp(
	provider: Provider,
	again?: { isolated: string; root: string; session: string },
): Promise<Omp> {
	const isolated = again?.isolated ?? mkdtempSync(join(tmpdir(), "ompdesk-mail-"));
	chmodSync(isolated, 0o700);
	const root = again?.root ?? realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-mail-repo-")));
	if (!again)
		atEnd(() => {
			rmSync(isolated, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		});
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
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
			...(again ? ["--resume", again.session] : []),
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const frames: Frame[] = [];
	const responses = new Map<string, (value: Record<string, unknown>) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame & { id?: string };
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	const bridge = new GuiBridgeClient(address);
	atEnd(async () => {
		bridge.close();
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
		removeBridgeAddress(address);
	});
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
	let counter = 0;
	return {
		bridge,
		frames,
		isolated,
		root,
		stop: async () => {
			child.stdin.end();
			await exited;
		},
		kill: async () => {
			child.kill("SIGKILL");
			await exited;
		},
		send: command => {
			const id = `c${++counter}`;
			const { promise, resolve: done, reject: fail } = Promise.withResolvers<Record<string, unknown>>();
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

/** The session files stock wrote under `isolated`. */
export function sessionFiles(isolated: string): string[] {
	const sessions = join(isolated, "agent", "sessions");
	if (!existsSync(sessions)) return [];
	return readdirSync(sessions).flatMap(project =>
		readdirSync(join(sessions, project))
			.filter(name => name.endsWith(".jsonl"))
			.map(file => join(sessions, project, file)),
	);
}

export function journaledMail(isolated: string): string[] {
	const ids: string[] = [];
	for (const file of sessionFiles(isolated)) {
		for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
			const entry = JSON.parse(line) as { type?: string; customType?: string; details?: { id?: string } };
			if (entry.type === "custom_message" && entry.customType === MAIL_CUSTOM_TYPE && entry.details?.id)
				ids.push(entry.details.id);
		}
	}
	return ids;
}

export const shown = (frames: readonly Frame[], id: string) =>
	frames.some(
		frame =>
			frame.type === "message_end" &&
			frame.message?.customType === MAIL_CUSTOM_TYPE &&
			frame.message.details?.id === id,
	);

export function mail(kind: MailKind, id: string) {
	return {
		content: `<ompdesk-mail from="child" title="Child" kind="${kind}">\n${id}\n</ompdesk-mail>`,
		details: { id, from: "child", fromTitle: "Child", kind, text: id },
		...deliveryFor(kind),
	};
}
