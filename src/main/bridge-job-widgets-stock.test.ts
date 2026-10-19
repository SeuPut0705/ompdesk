import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * Stock's live job widgets (`async.widgets`, omp ≥ 18.12.3) on the installed omp, with a scripted OpenAI-compatible
 * provider on loopback (no model spend). A background bash job that runs past 15 s and prints lines gets one model
 * request (tool `respond`, the `widget` role, resolved like `smol`) to write its widget spec, as soon as anything
 * *views* the job. Stock's `inspectAsyncJob` views it, and the bridge's `composer.jobs` (the GUI's one jobs poll) calls
 * it for every job; stock has no job read that does not view. The GUI never draws those widgets, so OMPdesk holds
 * `async.widgets` off (thinking-default-core.ts); a value in config.yml is the user's and wins.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
/** A background job that outlives stock's 15 s `authorAfterMs` and prints one line a second. */
const JOB = "for i in $(seq 1 24); do echo line $i; sleep 1; done";

interface Provider {
	url: string;
	/** Widget-spec requests: the only ones that offer the `respond` tool. */
	widgetRequests: number;
	/** Bytes of those requests' bodies (system prompt, schema and the job's samples). */
	widgetBytes: number;
	/** Resolves once the main agent's turn has a tool result: the background job is running. */
	jobStarted: Promise<void>;
	close(): Promise<void>;
}

/** The tool names and the count of tool messages of an OpenAI chat request body. */
function requestShape(body: string): { tools: string[]; toolResults: number } {
	const parsed: unknown = JSON.parse(body);
	const field = (key: string): unknown[] => {
		if (!parsed || typeof parsed !== "object" || !(key in parsed)) return [];
		const value: unknown = Reflect.get(parsed, key);
		return Array.isArray(value) ? value : [];
	};
	const tools = field("tools").map(tool => {
		const fn: unknown = tool && typeof tool === "object" ? Reflect.get(tool, "function") : undefined;
		const name: unknown = fn && typeof fn === "object" ? Reflect.get(fn, "name") : undefined;
		return typeof name === "string" ? name : "";
	});
	const toolResults = field("messages").filter(
		message => message && typeof message === "object" && Reflect.get(message, "role") === "tool",
	).length;
	return { tools, toolResults };
}

function sse(chunks: unknown[]): string {
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function reply(content: { text: string } | { tool: string; args: Record<string, unknown> }, tools: string[]): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const usage = { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 };
	if ("text" in content) {
		return sse([
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: content.text }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
		]);
	}
	const name = tools.find(tool => tool === content.tool || tool.endsWith(`_${content.tool}`)) ?? content.tool;
	const call = {
		index: 0,
		id: "call_0",
		type: "function",
		function: { name, arguments: JSON.stringify(content.args) },
	};
	return sse([
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
	]);
}

/** The main agent starts {@link JOB} in the background, then ends its turn; a widget request gets a plain answer. */
async function startProvider(): Promise<Provider> {
	const started = Promise.withResolvers<void>();
	const provider: Provider = {
		url: "",
		widgetRequests: 0,
		widgetBytes: 0,
		jobStarted: started.promise,
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
			const { tools, toolResults } = requestShape(body);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (tools.includes("respond")) {
				provider.widgetRequests++;
				provider.widgetBytes += Buffer.byteLength(body);
				res.end(reply({ text: "no widget" }, tools));
				return;
			}
			const main = tools.some(tool => tool.endsWith("bash"));
			if (main && toolResults > 0) started.resolve();
			res.end(
				reply(
					main && toolResults === 0 ? { tool: "bash", args: { command: JOB, async: true } } : { text: "STARTED" },
					tools,
				),
			);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	provider.url = `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}/v1`;
	provider.close = () => {
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	};
	return provider;
}

/**
 * A real wait: stock decides on its own clock (a job younger than 15 s gets no spec, `authorAfterMs`), in another
 * process, so fake timers cannot stand in for it.
 */
function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Omp {
	bridge: GuiBridgeClient;
	send(command: Record<string, unknown>): void;
}

/** One omp over `--mode rpc-ui` with the GUI bridge, the fake model as default and `smol`, `config` appended to config.yml. */
async function startOmp(provider: Provider, config: string): Promise<Omp> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-widgets-"));
	chmodSync(isolated, 0o700);
	cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
	const agentDir = join(isolated, "agent");
	const root = join(isolated, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(root, { recursive: true });
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
	writeFileSync(join(agentDir, "config.yml"), `modelRoles:\n  smol: fake/m1\n${config}`);
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
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	let ready = false;
	createInterface({ input: child.stdout }).on("line", line => {
		if (line.includes('"type":"ready"')) ready = true;
	});
	const bridge = new GuiBridgeClient(address);
	cleanups.push(async () => {
		bridge.close();
		child.kill("SIGKILL");
		await exited;
		removeBridgeAddress(address);
	});
	await expect
		.poll(() => ready, { timeout: 60_000, message: `omp never got ready\n${stderr.slice(-2000)}` })
		.toBe(true);
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
	return { bridge, send: command => child.stdin.write(`${JSON.stringify({ id: "p1", ...command })}\n`) };
}

interface Run {
	widgetRequests: number;
	widgetBytes: number;
	/** `composer.jobs` polls made while the job ran. */
	polls: number;
}

/** The job's whole life (24 s) and a margin: past it nothing is running and a settled job never gets a spec. */
const JOB_LIFE_MS = 27_000;

/**
 * Start the job through the agent, then read the jobs the way the GUI does (every second) or not at all, through
 * the job's whole life, and count the widget requests.
 */
async function scenario(config: string, poll: boolean): Promise<Run> {
	const provider = await startProvider();
	cleanups.push(() => provider.close());
	const session = await startOmp(provider, config);
	session.send({ type: "prompt", message: "start the background job" });
	await provider.jobStarted;
	let polls = 0;
	const end = Date.now() + JOB_LIFE_MS;
	while (Date.now() < end) {
		if (poll) {
			const rows = await session.bridge.request<unknown[]>("composer.jobs", {});
			if (rows.length > 0) polls++;
		}
		await pause(1_000);
	}
	return { widgetRequests: provider.widgetRequests, widgetBytes: provider.widgetBytes, polls };
}

describe.skipIf(!existsSync(omp))("job widgets on stock omp", () => {
	it("costs no widget request under the GUI's jobs poll, while a config.yml `async.widgets: true` gets stock's", async () => {
		const [held, userOn, userOnUnpolled] = await Promise.all([
			scenario("", true),
			scenario("async:\n  widgets: true\n", true),
			scenario("async:\n  widgets: true\n", false),
		]);
		console.info(`job widgets: ${JSON.stringify({ held, userOn, userOnUnpolled })}`);
		// The poll is what views the job: unread, even stock's widgets cost nothing.
		expect(userOnUnpolled.widgetRequests).toBe(0);
		// Stock's behaviour under the GUI's poll: a spec request (and its one retry on a rejected answer).
		expect(userOn.polls).toBeGreaterThan(15);
		expect(userOn.widgetRequests).toBeGreaterThan(0);
		// OMPdesk's held default: the same poll, no request.
		expect(held.polls).toBeGreaterThan(15);
		expect(held.widgetRequests).toBe(0);
	}, 180_000);
});
