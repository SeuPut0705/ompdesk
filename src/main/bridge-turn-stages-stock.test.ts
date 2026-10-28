import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { TURN_STAGES_EVENT, TURN_STAGES_LATE_ENV } from "../../resources/gui-bridge/turn-stages-contracts";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { turnStagesReport } from "./turn-stages-log";

/**
 * Pins the bridge's turn-stage tracing (resources/gui-bridge/turn-stages.ts) to the installed omp: a real stock omp
 * in RPC mode against a scripted Anthropic-compatible provider on loopback (no model spend), the bridge's frames read
 * off its socket. Each scenario is a way a turn can wait without saying why (28 Oct 2026: two silent waits of 346 and
 * 364 s in a main session), and the line it must produce:
 *
 * - a normal turn: no frame at all;
 * - a provider that accepts the request and never answers: stock's first-event timer (300 s by default, shortened here
 *   by `PI_STREAM_FIRST_EVENT_TIMEOUT_MS`) aborts the attempt and the Anthropic provider sends the request again
 *   (up to 10 retries, backoff 0.5 s doubling to 8 s); the user's Stop ends the run and the line says it sat in the
 *   request: provider request sent, no response, no output;
 * - a slow `before_agent_start` handler: the first output came late, and the longest wait is inside the handlers;
 * - a connection that is refused: the same retries, then the run ends errored with the provider's message.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
/** Stock's first-event timer, shortened from its 300 s default (pi-ai `idle-iterator.ts`). */
const FIRST_EVENT_TIMEOUT_MS = 3_000;
/** The bridge's "late" threshold, shortened from 30 s. */
const LATE_MS = 1_500;
const SLOW_HANDLER_MS = 2_500;

const ANSWER = [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "m1",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 10, output_tokens: 1 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
];

interface Provider {
	url: string;
	/** `answer`: a normal reply; `silent`: the request is accepted and never answered. */
	mode: "answer" | "silent";
	/** When each request arrived (`Date.now()`), in order. */
	arrivals: number[];
	/** Closes the listening socket, so the next connection is refused. */
	stop(): Promise<void>;
	/** Listens again on the same port. */
	start(): Promise<void>;
}

async function startProvider(): Promise<Provider> {
	let server: http.Server | undefined;
	let port = 0;
	const provider: Provider = {
		url: "",
		mode: "answer",
		arrivals: [],
		stop: async () => {
			const closing = server;
			server = undefined;
			if (!closing) return;
			closing.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			closing.close(() => closed.resolve());
			await closed.promise;
		},
		start: async () => {
			const created = http.createServer((req, res) => {
				req.resume();
				req.on("end", () => {
					provider.arrivals.push(Date.now());
					if (provider.mode === "silent") return;
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
					res.end(ANSWER.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join(""));
				});
			});
			server = created;
			const listening = Promise.withResolvers<void>();
			created.listen(port, "127.0.0.1", () => listening.resolve());
			await listening.promise;
			const address = created.address();
			if (address === null || typeof address === "string") throw new Error("provider has no port");
			port = address.port;
			provider.url = `http://127.0.0.1:${port}`;
		},
	};
	await provider.start();
	return provider;
}

type Frame = { type: string; id?: string; [key: string]: unknown };

interface Omp {
	frames: Frame[];
	bridge: GuiBridgeClient;
	bridgeEvents: Frame[];
	send(command: Record<string, unknown>): Promise<Frame>;
	/** Sends a prompt; the returned function resolves once the run it started has ended. */
	prompt(message: string): Promise<() => Promise<void>>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

async function startOmp(provider: Provider, isolated: string, extension: string): Promise<Omp> {
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: ${provider.url}`,
			"    apiKey: x",
			"    api: anthropic-messages",
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
		PI_STREAM_FIRST_EVENT_TIMEOUT_MS: String(FIRST_EVENT_TIMEOUT_MS),
		[TURN_STAGES_LATE_ENV]: String(LATE_MS),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		omp,
		[
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts"), "-e", extension],
		],
		{ cwd: isolated, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
	child.once("exit", () => onExit());
	const frames: Frame[] = [];
	const responses = new Map<string, (value: Frame) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame;
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	const bridge = new GuiBridgeClient(address);
	cleanups.push(async () => {
		bridge.close();
		child.kill("SIGKILL");
		await exited;
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
	const bridgeEvents: Frame[] = [];
	bridge.onEvent(event => bridgeEvents.push(event as Frame));
	let counter = 0;
	const send: Omp["send"] = command => {
		const id = `c${++counter}`;
		const { promise, resolve: done, reject: fail } = Promise.withResolvers<Frame>();
		const timer = setTimeout(() => fail(new Error(`no response\n${stderr.slice(-1500)}`)), 60_000);
		responses.set(id, value => {
			clearTimeout(timer);
			done(value);
		});
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return promise;
	};
	return {
		frames,
		bridge,
		bridgeEvents,
		send,
		prompt: async message => {
			const ended = frames.filter(frame => frame.type === "agent_end").length;
			const response = await send({ type: "prompt", message });
			expect(response.success, JSON.stringify(response)).toBe(true);
			return async () => {
				await expect
					.poll(() => frames.filter(frame => frame.type === "agent_end").length > ended, {
						timeout: 90_000,
						message: `the run never ended\n${stderr.slice(-1500)}`,
					})
					.toBe(true);
			};
		},
	};
}

/** `before_agent_start` handler that holds the turn while the flag file exists (a stand-in for any slow handler). */
function slowHandlerExtension(dir: string, flag: string): string {
	const file = join(dir, "slow-handler.mjs");
	writeFileSync(
		file,
		[
			'import { existsSync } from "node:fs";',
			"export default function (pi) {",
			'\tpi.on("before_agent_start", async () => {',
			`\t\tif (existsSync(${JSON.stringify(flag)})) await new Promise(done => setTimeout(done, ${SLOW_HANDLER_MS}));`,
			"\t\treturn undefined;",
			"\t});",
			"}",
			"",
		].join("\n"),
	);
	return file;
}

describe.skipIf(!existsSync(omp))("turn stages on stock omp", () => {
	it("writes no line for a normal turn and names the stage of each way a turn waits", async () => {
		const provider = await startProvider();
		cleanups.push(() => provider.stop());
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-turn-stages-"));
		chmodSync(isolated, 0o700);
		cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
		const flag = join(isolated, "slow");
		const run = await startOmp(provider, isolated, slowHandlerExtension(isolated, flag));
		expect((await run.send({ type: "set_auto_retry", enabled: false })).success).toBe(true);
		// The omp internals the tracing uses are all there (capabilities.ts `turnStages`).
		const { unavailable } = await run.bridge.request<{ unavailable: Array<{ feature: string }> }>("capabilities", {});
		expect(unavailable.map(entry => entry.feature)).not.toContain("turnStages");
		const lines = () => run.bridgeEvents.filter(event => event.type === TURN_STAGES_EVENT);
		const details = (index: number): Record<string, unknown> => {
			const found = lines()[index]?.details;
			return typeof found === "object" && found !== null ? Object.fromEntries(Object.entries(found)) : {};
		};

		// 1. A normal turn: no frame.
		await (await run.prompt("hello"))();
		expect(provider.arrivals).toHaveLength(1);

		// 2. Accepted and never answered. Stock's first-event timer aborts each attempt at its timeout and the provider
		// sends the request again; the user's Stop ends the run (as after the 28 Oct stalls).
		provider.mode = "silent";
		const first = provider.arrivals.length;
		const stalled = await run.prompt("hello again");
		await expect.poll(() => provider.arrivals.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(first + 2);
		const [asked, askedAgain] = provider.arrivals.slice(first);
		// The attempt was given up at the shortened timeout (not earlier, not left to run), then sent again after the backoff.
		expect(askedAgain - asked).toBeGreaterThanOrEqual(FIRST_EVENT_TIMEOUT_MS);
		expect(askedAgain - asked).toBeLessThan(FIRST_EVENT_TIMEOUT_MS + 10_000);
		expect((await run.send({ type: "abort" })).success).toBe(true);
		await stalled();
		await expect.poll(() => lines().length, { timeout: 30_000 }).toBe(1);
		const silent = details(0);
		expect(silent).toMatchObject({
			outcome: "aborted",
			call: 0,
			providerRequestSent: true,
			providerRequests: 1,
			lastStage: "stream_open",
		});
		// The gap is the request phase: the abort's own message opens the stream a moment before the run ends.
		expect(String(silent.longestGap)).toMatch(/^provider_request>stream_open \d+ms$/);
		expect(silent).not.toHaveProperty("at.provider_response");
		expect(silent).not.toHaveProperty("at.first_output");
		expect(Number(silent.waitedMs)).toBeGreaterThanOrEqual(FIRST_EVENT_TIMEOUT_MS);

		// 3. A slow before_agent_start handler: the output comes, late, and the longest wait is the handlers'.
		provider.mode = "answer";
		writeFileSync(flag, "");
		await (await run.prompt("hello a third time"))();
		await expect.poll(() => lines().length, { timeout: 30_000 }).toBe(2);
		const slow = details(1);
		expect(slow).toMatchObject({ outcome: "late", call: 0, providerRequestSent: true });
		expect(String(slow.longestGap)).toMatch(/^handlers_start>handlers_end \d+ms$/);
		expect(Number(slow["at.handlers_end"])).toBeGreaterThanOrEqual(SLOW_HANDLER_MS);
		expect(Number(slow["at.first_output"])).toBeGreaterThanOrEqual(Number(slow["at.handlers_end"]));
		rmSync(flag);

		// 4. Connection refused: stock retries the request (backoff 0.5 s doubling to 8 s, ten times), then the run ends
		// errored with the provider's message; the request was sent, nothing answered.
		await provider.stop();
		await (await run.prompt("hello a fourth time"))();
		await expect.poll(() => lines().length, { timeout: 30_000 }).toBe(3);
		const refused = details(2);
		expect(refused).toMatchObject({ outcome: "error", call: 0, providerRequestSent: true });
		expect(String(refused.error)).toMatch(/connection refused/i);
		expect(String(refused.longestGap)).toMatch(/^provider_request>stream_open \d+ms$/);
		expect(refused).not.toHaveProperty("at.provider_response");
		expect(refused).not.toHaveProperty("at.first_output");

		// Each frame is one runtime-log line of the registered source, and the normal turn sent none.
		expect(lines()).toHaveLength(3);
		for (const frame of lines()) expect(turnStagesReport(frame)?.source).toBe("turn-stages");
	}, 240_000);
});
