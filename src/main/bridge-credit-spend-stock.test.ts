import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve as absolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ompPackageRoot } from "./omp-runtime";
import { configDirName, INSTALLED_OMP } from "./test-bridge-probe";

/**
 * What a turn sends once an account's plan is spent but it still has credits (ChatGPT) or extra usage (Claude), on
 * the installed omp, with OMPdesk's credit-use switch off and on (resources/gui-bridge/credit-spend.ts). Nothing real
 * is contacted: made-up OAuth credentials in an empty private home, Claude's base URL on a fake on 127.0.0.1 (plain
 * http, so stock's `node:https` Cowork transport hands it to `fetch`), and a `--preload` that sends every `fetch` for
 * chatgpt.com (where stock always reads Codex usage) to the fake, refuses and records every other non-loopback
 * `fetch`, and refuses every `node:https` / `node:tls` connection. The fake answers by the account's token.
 */

const HOUR = 3_600_000;
const resetSec = (hours: number) => Math.floor((Date.now() + hours * HOUR) / 1000);

type ProviderId = "openai-codex" | "anthropic";

interface Account {
	/** Codex `/wham/usage` or Claude `/api/oauth/usage` body. */
	usage: unknown;
	/** Response headers the model request carries. */
	headers: Record<string, string>;
}

interface Scenario {
	provider: ProviderId;
	accounts: Record<string, Account>;
	prompts: number;
	/** `none`: stock alone; `off`/`on`: the bridge's credit-spend switch installed in that state. */
	mode: "none" | "off" | "on";
	/** A Claude model the turn falls back to (`retry.fallbackChains`), served by account `fallback`. */
	fallback?: boolean;
	/** Read the accounts list (Settings) after the turns, for the credits figure. */
	credits?: boolean;
}

const codexSpent = (credits: boolean, used = 100) => ({
	plan_type: "plus",
	rate_limit: {
		allowed: used < 100,
		limit_reached: used >= 100,
		primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_at: resetSec(3) },
		secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: resetSec(100) },
	},
	credits: credits ? { has_credits: true, unlimited: false, balance: "500" } : { has_credits: false },
});

const codexHeaders = (used: number) => ({
	"x-codex-primary-used-percent": String(used),
	"x-codex-primary-window-minutes": "300",
	"x-codex-primary-reset-at": String(resetSec(3)),
	"x-codex-secondary-used-percent": "40",
	"x-codex-secondary-window-minutes": "10080",
	"x-codex-secondary-reset-at": String(resetSec(100)),
});

const claudeUsage = (fiveHour: number) => ({
	five_hour: { utilization: fiveHour, resets_at: new Date(Date.now() + 3 * HOUR).toISOString() },
	seven_day: { utilization: 40, resets_at: new Date(Date.now() + 100 * HOUR).toISOString() },
	extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 120, utilization: 2.4 },
});

const claudeHeaders = (fiveHour: number, overage: boolean) => ({
	"anthropic-ratelimit-unified-5h-utilization": String(fiveHour / 100),
	"anthropic-ratelimit-unified-5h-reset": String(resetSec(3)),
	"anthropic-ratelimit-unified-7d-utilization": "0.4",
	"anthropic-ratelimit-unified-7d-reset": String(resetSec(100)),
	"anthropic-ratelimit-unified-representative-claim": "five_hour",
	"anthropic-ratelimit-unified-overage-status": overage ? "allowed" : "rejected",
	"anthropic-ratelimit-unified-overage-in-use": overage ? "true" : "false",
});

const GUARD = `
const LOOPBACK = { "127.0.0.1": true, localhost: true, "[::1]": true };
const realFetch = globalThis.fetch;
const record = { blocked: [] };
Object.defineProperty(globalThis, "__ompdeskNetGuard", { value: record });
const target = input => {
 try { return new URL(input instanceof Request ? input.url : String(input)); } catch { return undefined; }
};
async function guarded(input, init) {
 const url = target(input);
 if (url && url.hostname === "chatgpt.com") {
  const faked = process.env.OMPDESK_CREDIT_FAKE + "/chatgpt.com" + url.pathname + url.search;
  return realFetch(input instanceof Request ? new Request(faked, input) : faked, init);
 }
 if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || LOOPBACK[url.hostname] !== true) {
  record.blocked.push(url ? url.protocol + "//" + url.host + url.pathname : String(input));
  throw new TypeError("ompdesk test guard: non-loopback request refused");
 }
 return realFetch(input, init);
}
guarded.preconnect = () => {};
globalThis.fetch = guarded;
for (const [name, module, method] of [["https", require("node:https"), "request"], ["https", require("node:https"), "get"], ["tls", require("node:tls"), "connect"]]) {
 module[method] = (...args) => {
  const first = args[0];
  record.blocked.push(name + "." + method + " " + (typeof first === "string" || first instanceof URL ? String(first) : (first && (first.hostname || first.host)) || "?"));
  throw new TypeError("ompdesk test guard: " + name + "." + method + " refused");
 };
}
`;

// Static imports: the probe sits beside a copy of resources/gui-bridge, so these resolve the way they do in the app.
const PROBE = `
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { install, methods as credit } from "./credit-spend";
import { methods as settings } from "./settings";
export default function (pi) {
 const scenario = JSON.parse(process.env.OMPDESK_CREDIT_SCENARIO);
 if (scenario.mode !== "none") install(pi);
 pi.on("session_start", () => {
  void (async () => {
   try {
    const guard = globalThis.__ompdeskNetGuard;
    if (!guard || globalThis.fetch.name !== "guarded") throw new Error("the network guard preload did not run");
    pi.registerProvider("anthropic", { baseUrl: process.env.OMPDESK_CREDIT_FAKE + "/api.anthropic.com" });
    const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
    const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
    const auth = session.modelRegistry.authStorage;
    for (const name of Object.keys(scenario.accounts)) {
     const provider = name === "fallback" ? "anthropic" : scenario.provider;
     const token = provider === "anthropic" ? "sk-ant-oat01-probe-" + name : "probe-" + name;
     await auth.credentials.upsert(provider, {
      type: "oauth",
      access: token,
      refresh: "probe-refresh-" + name,
      expires: Date.now() + 10 * 365 * 24 * 3600_000,
      email: name + "@example.invalid",
      accountId: "acct-" + name,
     });
    }
    const models = session.modelRegistry.getAll();
    if (scenario.fallback) {
     const fallback = models.find(candidate => candidate.provider === "anthropic");
     lookup("retry.fallbackChains").set(session.settings, { [scenario.provider + "/*"]: ["anthropic/" + fallback.id] });
    }
    await session.setModel(models.find(candidate => candidate.provider === scenario.provider));
    if (scenario.mode !== "none") await credit.credit_spend_set({ enabled: scenario.mode === "on" }, env);
    const turns = [];
    for (let index = 0; index < scenario.prompts; index++) {
     let thrown;
     try {
      await session.prompt("hello " + index);
     } catch (error) {
      thrown = String((error && error.message) || error);
     }
     const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
     turns.push({
      thrown,
      stopReason: last?.stopReason,
      error: last?.errorMessage,
      provider: last?.provider,
      text: last?.content?.filter(part => part.type === "text").map(part => part.text).join(""),
     });
    }
    const listed = scenario.credits ? await settings.provider_accounts({ providerId: scenario.provider }, env) : undefined;
    const credits = listed?.accounts.map(account => account.credits ?? null);
    const model = session.model;
    const providerBase = session.modelRegistry.getProviderBaseUrl?.(scenario.provider);
    const [row] = auth.credentials.list(scenario.provider);
    const statuses = async baseUrl => (await auth.usage.report(scenario.provider, row.credential, { baseUrl }))?.limits.map(limit => limit.id + ":" + limit.status);
    const reports = { modelBase: model?.baseUrl, providerBase, viaModel: await statuses(model?.baseUrl), viaProvider: await statuses(providerBase) };
    console.error("CREDIT_PROBE=" + JSON.stringify({ turns, credits, reports, blocked: guard.blocked }));
    process.exit(0);
   } catch (error) {
    console.error("CREDIT_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
    process.exit(1);
   }
  })();
 });
}
`;

interface Received {
	method: string;
	host: string;
	path: string;
	account: string;
}

function sse(events: Array<[string, unknown]>): string {
	return events
		.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`)
		.join("");
}

const CODEX_REPLY = sse([
	["response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }],
	[
		"response.output_item.added",
		{
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
	],
	["response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "served" }],
	[
		"response.output_item.done",
		{
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "served", annotations: [] }],
			},
		},
	],
	[
		"response.completed",
		{
			response: {
				id: "resp_1",
				status: "completed",
				output: [],
				usage: {
					input_tokens: 10,
					output_tokens: 2,
					total_tokens: 12,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			},
		},
	],
]);

const claudeReply = (model: string) =>
	sse([
		[
			"message_start",
			{
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model,
					content: [],
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
		],
		["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { index: 0, delta: { type: "text_delta", text: "served" } }],
		["content_block_stop", { index: 0 }],
		["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
		["message_stop", {}],
	]);

function fakeProviders(received: Received[], scenarios: () => Scenario) {
	return createServer((request: IncomingMessage, response: ServerResponse) => {
		let body = "";
		request.on("data", chunk => {
			body += chunk;
		});
		request.on("end", () => {
			const [, host = "", ...rest] = (request.url ?? "").split("/");
			const path = `/${rest.join("/")}`;
			const token = String(request.headers.authorization ?? request.headers["x-api-key"] ?? "");
			const account = token.match(/probe-([a-z]+)/)?.[1] ?? "";
			received.push({ method: request.method ?? "", host, path: path.split("?")[0] ?? path, account });
			const scenario = scenarios();
			const scripted = scenario.accounts[account];
			const answer = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
				response.writeHead(status, { "content-type": "application/json", ...headers });
				response.end(JSON.stringify(payload));
			};
			if (!scripted) return answer(404, { error: "no such account" });
			if (
				request.method === "GET" &&
				(path.startsWith("/backend-api/wham/usage") || path.startsWith("/api/oauth/usage"))
			) {
				return answer(200, scripted.usage);
			}
			if (request.method === "POST" && path.startsWith("/backend-api/codex/responses")) {
				response.writeHead(200, { "content-type": "text/event-stream", ...scripted.headers });
				return response.end(CODEX_REPLY);
			}
			if (request.method === "POST" && path.startsWith("/v1/messages")) {
				const model = String((JSON.parse(body || "{}") as { model?: unknown }).model ?? "claude");
				response.writeHead(200, { "content-type": "text/event-stream", ...scripted.headers });
				return response.end(claudeReply(model));
			}
			return answer(404, { error: "not scripted" });
		});
	});
}

interface ProbeResult {
	turns?: Array<{ thrown?: string; stopReason?: string; error?: string; provider?: string; text?: string }>;
	credits?: unknown[];
	reports?: unknown;
	blocked?: string[];
	error?: string;
}

function runProbe(fake: string, scenario: Scenario): Promise<ProbeResult> {
	const root = ompPackageRoot(INSTALLED_OMP);
	if (!root) throw new Error(`no omp package behind ${INSTALLED_OMP}`);
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-credit-spend-"));
	chmodSync(isolated, 0o700);
	const guard = join(isolated, "net-guard.js");
	cpSync(absolute("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
	const extension = join(isolated, "bridge", "credit-spend-probe.ts");
	writeFileSync(guard, GUARD);
	writeFileSync(extension, PROBE);
	writeFileSync(
		join(isolated, "config.yml"),
		"retry:\n  maxRetries: 1\n  baseDelayMs: 50\n  maxDelayMs: 1000\n  fallbackOn: usage-limit\n",
	);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: isolated,
		USERPROFILE: isolated,
		PI_CODING_AGENT_DIR: isolated,
		PI_CONFIG_DIR: configDirName(isolated, isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		PI_NO_TITLE: "1",
		PI_CODEX_WEBSOCKET: "0",
		OPENAI_API_KEY: "probe-not-a-real-key",
		OMPDESK_CREDIT_FAKE: fake,
		OMPDESK_CREDIT_SCENARIO: JSON.stringify(scenario),
	};
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"OPENROUTER_API_KEY",
		"TYPESAFE_API_KEY",
		"OMP_GUI_BRIDGE",
	]) {
		Reflect.deleteProperty(env, key);
	}
	const args = [
		"--preload",
		guard,
		join(root, "dist", "cli.js"),
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"-e",
		extension,
	];
	const { promise, resolve, reject } = Promise.withResolvers<ProbeResult>();
	const child = spawn("bun", args, { env, stdio: ["pipe", "ignore", "pipe"], timeout: 60_000 });
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", chunk => {
		stderr += chunk;
	});
	child.on("error", reject);
	child.on("close", () => {
		rmSync(isolated, { recursive: true, force: true });
		const line = stderr.split("\n").find(value => value.startsWith("CREDIT_PROBE="));
		if (!line) reject(new Error(`no probe result; omp stderr:\n${stderr.slice(-2500)}`));
		else resolve(JSON.parse(line.slice("CREDIT_PROBE=".length)) as ProbeResult);
	});
	return promise;
}

describe.skipIf(!existsSync(INSTALLED_OMP))("credit spend on the installed omp", () => {
	const received: Received[] = [];
	let current: Scenario | undefined;
	const server = fakeProviders(received, () => {
		if (!current) throw new Error("no scenario");
		return current;
	});
	let base = "";

	beforeAll(async () => {
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	});

	const run = async (scenario: Scenario) => {
		received.length = 0;
		current = scenario;
		const probe = await runProbe(base, scenario);
		const sent = received
			.filter(
				entry => entry.method === "POST" && (entry.path.includes("/responses") || entry.path.includes("/messages")),
			)
			.map(entry => entry.account);
		return { probe, sent, received: [...received] };
	};

	const codexSingle = (mode: Scenario["mode"], extra: Partial<Scenario> = {}): Scenario => ({
		provider: "openai-codex",
		accounts: { spent: { usage: codexSpent(true), headers: codexHeaders(100) } },
		prompts: 2,
		mode,
		...extra,
	});
	const claudeSingle = (mode: Scenario["mode"], usage: number, headerUse: number): Scenario => ({
		provider: "anthropic",
		accounts: { spent: { usage: claudeUsage(usage), headers: claudeHeaders(headerUse, true) } },
		prompts: 2,
		mode,
	});
	const served = { stopReason: "stop", text: "served" };
	const refused = (brand: string) => ({
		stopReason: "error",
		error: expect.stringMatching(new RegExp(`^usage_limit_reached: this ${brand} account's plan limit is used up`)),
	});
	// Every case: nothing left the machine but loopback.
	const quiet = (probe: ProbeResult) =>
		expect(probe.blocked?.filter(entry => !entry.endsWith("/models") && !entry.includes("models.json"))).toEqual([]);

	it("stock alone (and credit use on) sends a spent ChatGPT account with credits every request", async () => {
		for (const mode of ["none", "on"] as const) {
			const { probe, sent } = await run(codexSingle(mode));
			expect(probe.error, mode).toBeUndefined();
			expect(sent, mode).toEqual(["spent", "spent"]);
			expect(probe.turns, mode).toMatchObject([served, served]);
			quiet(probe);
		}
	}, 120_000);

	it("off: a spent ChatGPT account with credits gets no request, the turn ends in the usage limit, and the credits still show", async () => {
		const { probe, sent } = await run(codexSingle("off", { credits: true }));
		expect(probe.error).toBeUndefined();
		expect(sent).toEqual([]);
		expect(probe.turns).toMatchObject([refused("ChatGPT"), refused("ChatGPT")]);
		expect(probe.credits).toEqual([
			{ kind: "balance", limitId: "openai-codex:credits", remaining: 500, unit: "credits" },
		]);
		quiet(probe);
	}, 60_000);

	it("off: with an account that has plan left, that one serves", async () => {
		const { probe, sent } = await run(
			codexSingle("off", {
				accounts: {
					spent: { usage: codexSpent(true), headers: codexHeaders(100) },
					fresh: { usage: codexSpent(false, 20), headers: codexHeaders(20) },
				},
			}),
		);
		expect(sent).toEqual(["fresh", "fresh"]);
		expect(probe.turns).toMatchObject([served, served]);
		quiet(probe);
	}, 60_000);

	it("off: with a fallback chain the turn goes on on the fallback model", async () => {
		const { probe, sent } = await run(
			codexSingle("off", {
				fallback: true,
				accounts: {
					spent: { usage: codexSpent(true), headers: codexHeaders(100) },
					fallback: { usage: claudeUsage(20), headers: claudeHeaders(20, false) },
				},
			}),
		);
		expect(probe.error).toBeUndefined();
		expect(sent.filter(account => account === "spent")).toEqual([]);
		expect(sent.length).toBeGreaterThan(0);
		expect(new Set(sent)).toEqual(new Set(["fallback"]));
		expect(probe.turns?.at(-1)).toMatchObject({ ...served, provider: "anthropic" });
		quiet(probe);
	}, 60_000);

	// Known gap, measured: stock's response-header ingest never reached the account's report on the Codex SSE path
	// (the report still read 90 % after a 2xx at 100 %), though the same headers handed to `usage.ingestHeaders`
	// directly make it read spent; a hook ingest from `after_provider_response` did not help either. So the account
	// keeps serving until its next usage report (stock's report life, about 5 minutes). This case pins that size and
	// flips the day stock's ingest reaches it.
	it("off: a 2xx answer whose headers put the plan at 100 % does not stop the next request before the next report (gap)", async () => {
		const { probe, sent } = await run(
			codexSingle("off", { accounts: { spent: { usage: codexSpent(true, 90), headers: codexHeaders(100) } } }),
		);
		expect(probe.error).toBeUndefined();
		expect(sent, JSON.stringify(probe.reports)).toEqual(["spent", "spent"]);
		expect(probe.turns).toMatchObject([served, served]);
		quiet(probe);
	}, 60_000);

	it("Claude at 100 %: stock and on send both requests, off sends none", async () => {
		for (const mode of ["none", "on"] as const) {
			const { probe, sent } = await run(claudeSingle(mode, 100, 100));
			expect(sent, mode).toEqual(["spent", "spent"]);
			expect(probe.turns, mode).toMatchObject([served, served]);
			quiet(probe);
		}
		const { probe, sent } = await run(claudeSingle("off", 100, 100));
		expect(sent).toEqual([]);
		expect(probe.turns).toMatchObject([refused("Claude"), refused("Claude")]);
		quiet(probe);
	}, 120_000);

	it("Claude under 100 % in its usage answer but served on extra usage: off sends the first request only", async () => {
		const { probe, sent } = await run(claudeSingle("off", 60, 98));
		expect(sent).toEqual(["spent"]);
		expect(probe.turns).toMatchObject([served, refused("Claude")]);
		quiet(probe);
	}, 60_000);
});
