import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelInfo, RpcCommand, RpcResponse, RpcSessionState } from "../shared/rpc-types";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { handlers } from "./local/composer";
import type { LocalCommandContext } from "./local/types";
import { withoutSessionEnv } from "./omp-launch";
import { ompPackageRoot } from "./omp-runtime";
import { RpcClient } from "./rpc-client";
import { INSTALLED_OMP } from "./test-bridge-probe";
import { removeWhenFree } from "./test-folders";

/**
 * A retry fallback never becomes the person's model, as OMPdesk reads the session (models-accounts.md › Fallback
 * models, composer.md › Toolbar). The owner's setup in miniature on the installed omp with the gui bridge: the session's
 * model A (`modelRoles.default`), `retry.fallbackChains` A → B, `retry.fallbackOn: usage-limit`. A fake A on 127.0.0.1
 * answers a usage limit with a short retry-after, a fake B answers, and a `--preload` guard refuses every request that
 * would leave loopback. State is read through main's `get_state` (local/composer.ts), which every window, paired
 * computer and phone page gets:
 *
 * - while B answers the fallback turn and after it, stock runs B and `chosenModel` names A, the model the composer shows;
 * - a message inside A's wait runs on B again; the first one after it runs on A, and `chosenModel` goes;
 * - stock journals B only as an ephemeral `fallback` model change, config.yml stays byte for byte, a new tab starts
 *   on A, and the tab's omp restarted on its session file (a relaunch, an omp restart, a resume) starts on A;
 * - under `retry.fallbackRevertPolicy: never` B stays for the omp's life, A still named the choice, and a restart
 *   starts on A.
 */

const A = "fakea/a1";
const B = "fakeb/b1";
/** A's retry-after. Above `retry.maxDelayMs` (1 s), so stock switches at once, as for a real multi-hour limit. */
const WAIT_S = 3;
const CREDENTIAL_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ELECTRON_RUN_AS_NODE",
];

/** Replaces `fetch` before any omp module loads: only loopback is reachable. */
const GUARD = `
const LOOPBACK = { "127.0.0.1": true, localhost: true, "[::1]": true };
const realFetch = globalThis.fetch;
const target = input => { try { return new URL(input instanceof Request ? input.url : String(input)); } catch { return undefined; } };
const allowed = url => url && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK[url.hostname] === true;
async function guarded(input, init) {
 if (!allowed(target(input))) throw new TypeError("ompdesk test guard: non-loopback request refused");
 return realFetch(input, init);
}
guarded.preconnect = (input, options) => { if (allowed(target(input))) realFetch.preconnect(input, options); };
globalThis.fetch = guarded;
`;

type Frame = { type: string; willRetry?: boolean; from?: string; to?: string };

function sse(text: string): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "fake" };
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

interface Fake {
	url: string;
	/** Every main-agent request, `A:429` or `B:200`, in order. */
	requests: string[];
	/** A answers a usage limit while true. */
	limited: boolean;
	/** Holds B's next main answer: `arrived` once it is asked, answered on `release`. */
	holdB(): { arrived: Promise<void>; release(): void };
	close(): Promise<void>;
}

async function startFake(): Promise<Fake> {
	let hold: { arrived: PromiseWithResolvers<void>; released: PromiseWithResolvers<void> } | undefined;
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", chunk => {
			body += chunk;
		});
		request.on("end", async () => {
			const route = /^\/(a|b)\/v1\/chat\/completions$/.exec(request.url ?? "");
			if (!route) {
				response.writeHead(404).end();
				return;
			}
			const parsed: { tools?: unknown[] } = JSON.parse(body);
			const main = (parsed.tools ?? []).length > 0;
			if (route[1] === "a" && fake.limited) {
				if (main) fake.requests.push("A:429");
				// `x-should-retry: false` keeps the provider client from retrying by itself, as for a hard limit.
				response.writeHead(429, {
					"content-type": "application/json",
					"retry-after": String(WAIT_S),
					"x-should-retry": "false",
				});
				response.end(
					JSON.stringify({
						error: {
							message: `You have reached your usage limit. Try again in ${WAIT_S} seconds.`,
							type: "usage_limit_reached",
						},
					}),
				);
				return;
			}
			if (main) fake.requests.push(route[1] === "a" ? "A:200" : "B:200");
			const held = route[1] === "b" && main ? hold : undefined;
			if (held) {
				hold = undefined;
				held.arrived.resolve();
				await held.released.promise;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.end(sse(main ? "DONE" : "side"));
		});
	});
	const fake: Fake = {
		url: "",
		requests: [],
		limited: true,
		holdB: () => {
			hold = { arrived: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
			const current = hold;
			return { arrived: current.arrived.promise, release: () => current.released.resolve() };
		},
		close: () => {
			hold?.released.resolve();
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return fake;
}

interface Home {
	home: string;
	agentDir: string;
	repo: string;
	guard: string;
	configYml: string;
}

/** A private home whose omp knows only the two fake models, with the owner's fallback settings. */
function makeHome(fake: Fake, revertPolicy: "cooldown-expiry" | "never"): Home {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-fallback-")));
	chmodSync(home, 0o700);
	const agentDir = join(home, ".omp", "agent");
	const repo = join(home, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(repo);
	const guard = join(home, "net-guard.js");
	writeFileSync(guard, GUARD);
	const provider = (id: string, path: string, model: string) => [
		`  ${id}:`,
		`    baseUrl: ${fake.url}/${path}/v1`,
		`    apiKey: not-a-real-key-${path}`,
		"    api: openai-completions",
		"    models:",
		`      - id: ${model}`,
		`        name: Model ${path.toUpperCase()}`,
		"        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }",
	];
	writeFileSync(
		join(agentDir, "models.yml"),
		["providers:", ...provider("fakea", "a", "a1"), ...provider("fakeb", "b", "b1"), ""].join("\n"),
	);
	const configYml = [
		"modelRoles:",
		`  default: ${A}`,
		"retry:",
		"  fallbackOn: usage-limit",
		`  fallbackRevertPolicy: ${revertPolicy}`,
		"  maxDelayMs: 1000",
		"  fallbackChains:",
		`    ${A}:`,
		`      - ${B}`,
		"",
	].join("\n");
	writeFileSync(join(agentDir, "config.yml"), configYml);
	return { home, agentDir, repo, guard, configYml };
}

interface Omp {
	frames: Frame[];
	/** `get_state` as main answers the renderer: stock's state with the bridge's extras. */
	state(): Promise<RpcSessionState>;
	/** Sends a prompt and resolves once its run, retries and fallbacks included, has ended. */
	prompt(message: string): Promise<void>;
	stop(): Promise<void>;
}

const running = new Set<Omp>();
const homes: string[] = [];
afterAll(async () => {
	for (const omp of running) await omp.stop();
	for (const home of homes) await removeWhenFree(home);
});

/** The installed omp as a tab starts it: a new session (`fresh-launch.yml`) or `--session <file>`, with the bridge. */
async function startOmp(at: Home, session?: string): Promise<Omp> {
	const root = ompPackageRoot(INSTALLED_OMP);
	if (!root) throw new Error(`no omp package behind ${INSTALLED_OMP}`);
	const address = newBridgeAddress();
	const env: NodeJS.ProcessEnv = {
		...withoutSessionEnv(process.env),
		HOME: at.home,
		USERPROFILE: at.home,
		PI_CODING_AGENT_DIR: at.agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	for (const key of CREDENTIAL_ENV) delete env[key];
	const child: ChildProcessWithoutNullStreams = spawn(
		"bun",
		[
			"--preload",
			at.guard,
			join(root, "dist", "cli.js"),
			...["--mode", "rpc-ui"],
			...(session ? ["--session", session] : ["--config", resolve("resources/gui-bridge/fresh-launch.yml")]),
			...["-e", resolve("resources/gui-bridge/index.ts")],
		],
		{ cwd: at.repo, env },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const frames: Frame[] = [];
	const rpc = new RpcClient(frame => child.stdin.write(`${JSON.stringify(frame)}\n`), { timeout: 60_000 });
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame | RpcResponse;
			if (frame.type === "response") rpc.onResponse(frame as RpcResponse);
			else frames.push(frame as Frame);
		} catch {
			// Stock may print startup diagnostics.
		}
	});
	const bridge = new GuiBridgeClient(address);
	let stopped: Promise<void> | undefined;
	const omp: Omp = {
		frames,
		state: async () => (await handlers.get_state({ type: "get_state", brief: true }, context)) as RpcSessionState,
		prompt: async message => {
			const mark = frames.length;
			const sent = await rpc.stock({ type: "prompt", message } as RpcCommand);
			expect(sent.success, JSON.stringify(sent)).toBe(true);
			await expect
				.poll(() => frames.slice(mark).some(frame => frame.type === "agent_end" && frame.willRetry !== true), {
					timeout: 60_000,
					message: `the end of "${message}"\n${stderr.slice(-1500)}`,
				})
				.toBe(true);
			await expect.poll(async () => (await omp.state()).isStreaming, { timeout: 30_000 }).toBe(false);
		},
		stop: () => {
			stopped ??= (async () => {
				running.delete(omp);
				bridge.close();
				child.stdin.end();
				const kill = setTimeout(() => child.kill("SIGKILL"), 30_000);
				await exited;
				clearTimeout(kill);
				removeBridgeAddress(address);
			})();
			return stopped;
		},
	};
	const context: LocalCommandContext = {
		cwd: at.repo,
		bridge,
		omp: {
			bin: INSTALLED_OMP,
			version: "18.18.9",
			async run() {
				throw new Error("not used");
			},
		},
		async send<T>(command: { type: string; [key: string]: unknown }) {
			const response = await rpc.stock(command as RpcCommand);
			if (!response.success) throw new Error(response.error);
			return response.data as T;
		},
	};
	running.add(omp);
	await expect
		.poll(() => frames.some(frame => frame.type === "ready"), {
			timeout: 60_000,
			message: `omp's ready frame\n${stderr.slice(-2000)}`,
		})
		.toBe(true);
	await expect
		.poll(
			() =>
				bridge.connect(1_000).then(
					() => true,
					() => false,
				),
			{ timeout: 60_000, message: `the bridge\n${stderr.slice(-2000)}` },
		)
		.toBe(true);
	return omp;
}

const ref = (model: ModelInfo | null | undefined): string | null => (model ? `${model.provider}/${model.id}` : null);

/** The model-change entries stock journaled, as `model role`. */
function journaledModels(file: string): string[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type?: string; model?: string; role?: string })
		.filter(entry => entry.type === "model_change")
		.map(entry => `${entry.model} ${entry.role ?? "default"}`);
}

/** The fallback turn: A answers a usage limit, stock walks the chain to B; read while B holds its answer. */
async function fallBack(omp: Omp, fake: Fake): Promise<{ during: RpcSessionState; events: string[] }> {
	const mark = omp.frames.length;
	const held = fake.holdB();
	const turn = omp.prompt("first message");
	await held.arrived;
	const during = await omp.state();
	held.release();
	await turn;
	const events = omp.frames
		.slice(mark)
		.filter(frame => frame.type.startsWith("retry_fallback") || frame.type === "model_changed")
		.map(frame => (frame.from ? `${frame.type} ${frame.from} -> ${frame.to}` : frame.type));
	return { during, events };
}

/**
 * Until A's wait, counted from the fallback, is over. Real time on purpose: stock's cooldown runs on the omp
 * process's own clock, which no fake timer reaches.
 */
function outwaitA(fellBackAt: number): Promise<void> {
	const { promise, resolve: done } = Promise.withResolvers<void>();
	setTimeout(done, Math.max(0, fellBackAt + WAIT_S * 1000 + 500 - Date.now()));
	return promise;
}

describe.skipIf(!existsSync(INSTALLED_OMP))("a retry fallback on the installed omp leaves the person's model", () => {
	it("cooldown-expiry (stock's default): B stands in until A's wait is over; nothing makes B the choice", async () => {
		const fake = await startFake();
		const at = makeHome(fake, "cooldown-expiry");
		homes.push(at.home);
		try {
			const tab = await startOmp(at);
			const start = await tab.state();
			expect([ref(start.model), ref(start.chosenModel)]).toEqual([A, null]);

			const { during, events } = await fallBack(tab, fake);
			const fellBackAt = Date.now();
			expect(fake.requests).toEqual(["A:429", "B:200"]);
			expect(events).toEqual(["model_changed", `retry_fallback_applied ${A} -> ${B}`, "retry_fallback_succeeded"]);
			expect([ref(during.model), ref(during.chosenModel)], "while B answers").toEqual([B, A]);
			const after = await tab.state();
			expect([ref(after.model), ref(after.chosenModel)], "after the fallback turn").toEqual([B, A]);

			fake.requests.length = 0;
			const sentAfter = Date.now() - fellBackAt;
			await tab.prompt("inside A's wait");
			expect(sentAfter, "the second message went out well inside A's wait").toBeLessThan(WAIT_S * 1000 - 1000);
			expect(fake.requests).toEqual(["B:200"]);
			const inside = await tab.state();
			expect([ref(inside.model), ref(inside.chosenModel)], "inside A's wait").toEqual([B, A]);

			const sessionFile = after.sessionFile as string;
			expect(journaledModels(sessionFile)).toEqual([`${A} default`, `${B} fallback`]);
			expect(readFileSync(join(at.agentDir, "config.yml"), "utf8")).toBe(at.configYml);

			const newTab = await startOmp(at);
			const fresh = await newTab.state();
			expect([ref(fresh.model), ref(fresh.chosenModel)], "a new tab while the other runs on B").toEqual([A, null]);
			await newTab.stop();

			await outwaitA(fellBackAt);
			fake.limited = false;
			fake.requests.length = 0;
			await tab.prompt("after A's wait");
			expect(fake.requests).toEqual(["A:200"]);
			const back = await tab.state();
			expect([ref(back.model), ref(back.chosenModel)], "back on A").toEqual([A, null]);
			expect(journaledModels(sessionFile)).toEqual([`${A} default`, `${B} fallback`, `${A} fallback`]);
			await tab.stop();

			const relaunched = await startOmp(at, sessionFile);
			const restored = await relaunched.state();
			expect([ref(restored.model), ref(restored.chosenModel)], "the tab's omp started again").toEqual([A, null]);
			await relaunched.stop();
			expect(readFileSync(join(at.agentDir, "config.yml"), "utf8")).toBe(at.configYml);
		} finally {
			await fake.close();
		}
	}, 120_000);

	it("restarted on its session while B stands in, the tab's omp starts on A", async () => {
		const fake = await startFake();
		const at = makeHome(fake, "cooldown-expiry");
		homes.push(at.home);
		try {
			const tab = await startOmp(at);
			await fallBack(tab, fake);
			const onB = await tab.state();
			expect([ref(onB.model), ref(onB.chosenModel)]).toEqual([B, A]);
			await tab.stop();

			const relaunched = await startOmp(at, onB.sessionFile as string);
			const restored = await relaunched.state();
			expect([ref(restored.model), ref(restored.chosenModel)], "the relaunch's omp").toEqual([A, null]);
			await relaunched.stop();
			expect(readFileSync(join(at.agentDir, "config.yml"), "utf8")).toBe(at.configYml);
		} finally {
			await fake.close();
		}
	}, 120_000);

	it("never: B stays for the omp's life with A still the choice, and a restart starts on A", async () => {
		const fake = await startFake();
		const at = makeHome(fake, "never");
		homes.push(at.home);
		try {
			const tab = await startOmp(at);
			const { during } = await fallBack(tab, fake);
			const fellBackAt = Date.now();
			expect([ref(during.model), ref(during.chosenModel)]).toEqual([B, A]);
			await outwaitA(fellBackAt);
			fake.limited = false;
			fake.requests.length = 0;
			await tab.prompt("after A's wait");
			expect(fake.requests).toEqual(["B:200"]);
			const stays = await tab.state();
			expect([ref(stays.model), ref(stays.chosenModel)], "under never").toEqual([B, A]);
			await tab.stop();

			const relaunched = await startOmp(at, stays.sessionFile as string);
			const restored = await relaunched.state();
			expect([ref(restored.model), ref(restored.chosenModel)], "the relaunch's omp").toEqual([A, null]);
			await relaunched.stop();
			expect(readFileSync(join(at.agentDir, "config.yml"), "utf8")).toBe(at.configYml);
		} finally {
			await fake.close();
		}
	}, 120_000);
});
