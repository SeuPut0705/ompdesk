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
 * Spending a Claude reset pass: OMPdesk's bridge hands the confirmed pass straight to stock's redeem
 * (`AgentSession.redeemResetCredit`, reset-passes-core.ts `verifiesOffer`) and lists nothing first, because Claude's
 * `/usage` is rate-limited per source IP and stock's redeem (pi-ai auth/resets.ts `#redeemAccountReset`) already reads
 * the live offer and refuses a changed, unusable or missing one before it spends. This pins that on the installed omp,
 * so an omp that dropped the check fails here.
 *
 * Nothing real is contacted: a made-up OAuth credential in an empty private agent dir, Claude's base URL pointed at a
 * fake server on 127.0.0.1, and a `--preload` that replaces `fetch` before any omp module loads, refusing (and
 * recording) every request to a host other than loopback. Stock's usage fetch is that `fetch` (auth-storage.ts
 * `usageFetch ?? fetch`).
 */

const FUTURE = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
const ORG = "org-probe";
const USAGE = "/api/oauth/usage?cedar_ember=1&skip_spend=1";
const CONSUME = `/api/organizations/${ORG}/reset_rate_limits`;

const grant = (extra: Record<string, unknown> = {}) => ({
	id: "grant-live",
	label: "Probe reset",
	resets_left: 1,
	resets_total: 1,
	ends_at: FUTURE,
	clears: ["five_hour"],
	blocking: [],
	usable_now: true,
	...extra,
});
const offer = (status: Record<string, unknown>) => ({ status: 200, body: { cedar_ember: status } });
const live = offer({ eligible: true, grants: [grant()], next_grant_id: "grant-live" });

/**
 * An account with two kinds of pass, both usable by Claude's own word: a Fable reset, which Claude names next, and a
 * regular one. Claude Code lets a person pick either; stock omp spends only the one named next.
 */
const kinds = (regular: Record<string, unknown> = {}, next = "grant-fable") =>
	offer({
		eligible: true,
		grants: [
			grant({ id: "grant-fable", label: "Fable reset", clears: ["five_hour", "seven_day_overage_included"] }),
			grant({
				id: "grant-regular",
				label: "Limit reset",
				clears: ["five_hour", "seven_day"],
				resets_left: 2,
				...regular,
			}),
		],
		next_grant_id: next,
	});
const KINDS = kinds();
/** The fake's route for the listing of that account (no redeem). */
const LISTED = "kinds";

/**
 * A picked pass whose claim reached Claude and applied, with the answer lost on the way back (the fake answers 502
 * and counts the claim), after which Claude names that same pass next. The person tries again. Stock's redeem would
 * now claim it under a new request id and spend a second use; the bridge must repeat its own claim, or send nothing
 * once it sees a use gone. Per route, what the pass's `resets_left` reads after the lost claim: unchanged (Claude has
 * not caught up) or one less.
 */
const LOST: Record<string, { leftAfter: number; claims: number }> = {
	"lost-unchanged": { leftAfter: 2, claims: 2 },
	"lost-counted": { leftAfter: 1, claims: 1 },
};

/**
 * The account as Settings' accounts list read it (the bridge's `provider_accounts`: stock's plain `/usage`, whose answer
 * carries the offer), then a confirm of the pass it showed whose pre-spend check Claude turns away (429). Per route, what
 * the person confirmed, the answer, and how many claims reach Claude.
 */
const PLAIN_USAGE = "/api/oauth/usage";
const LISTED_USAGE = {
	five_hour: { utilization: 100, resets_at: FUTURE },
	cedar_ember: { eligible: true, grants: [grant()], next_grant_id: "grant-live" },
};
const STORED: Record<string, { confirm: string; expected: { ok: boolean; code: string }; claims: number }> = {
	"stored-throttled": { confirm: "grant-live", expected: { ok: true, code: "reset" }, claims: 1 },
};

/**
 * The same redeems through OMPdesk's bridge method (`reset_pass_redeem`, reset-passes.ts), each of a pass a person
 * picked. The one stock refuses only because Claude names another next is the one the bridge sends itself
 * (reset-passes-core.ts `spendChosenPass`): stock's read, the bridge's read, then one claim of exactly that grant.
 */
const PICKS: Record<string, Case> = {
	picked: { confirm: "grant-regular", usage: KINDS, expected: { ok: true, code: "reset" }, spends: true },
	// Picked, then gone from the offer, spent, or paused by Claude before the confirm: nothing is sent.
	"picked-gone": {
		confirm: "grant-regular",
		usage: live,
		expected: { ok: false, code: "offer_changed" },
		spends: false,
	},
	"picked-spent": {
		confirm: "grant-regular",
		usage: kinds({ resets_left: 0 }),
		expected: { ok: false, code: "offer_changed" },
		spends: false,
	},
	"picked-paused": {
		confirm: "grant-regular",
		usage: kinds({ paused: true }),
		expected: { ok: false, code: "offer_changed" },
		spends: false,
	},
	// The pass Claude names next goes through stock's own redeem alone: one read, one claim.
	"picked-next": { confirm: "grant-fable", usage: KINDS, expected: { ok: true, code: "reset" }, spends: true },
};
interface Case {
	/** The pass the person confirmed; absent = the target carries no `creditId`. */
	confirm?: string;
	/** What the fake `/usage` discovery read answers. */
	usage: { status: number; body?: unknown };
	expected: { ok: boolean; code: string };
	spends: boolean;
}

const CASES: Record<string, Case> = {
	changed: { confirm: "grant-confirmed", usage: live, expected: { ok: false, code: "offer_changed" }, spends: false },
	// Stock drops `nextCreditId` from an ineligible offer, so a confirmed pass reads as a changed offer.
	"ineligible-offer": {
		confirm: "grant-live",
		usage: offer({
			eligible: false,
			ineligible_reason: "not_at_limit",
			grants: [grant()],
			next_grant_id: "grant-live",
		}),
		expected: { ok: false, code: "offer_changed" },
		spends: false,
	},
	"not-usable": {
		confirm: "grant-live",
		usage: offer({ eligible: true, grants: [grant({ usable_now: false })], next_grant_id: "grant-live" }),
		expected: { ok: false, code: "ineligible" },
		spends: false,
	},
	"used-up": {
		confirm: "grant-live",
		usage: offer({ eligible: true, grants: [grant({ resets_left: 0 })], next_grant_id: "grant-live" }),
		expected: { ok: false, code: "no_credit" },
		spends: false,
	},
	throttled: {
		confirm: "grant-live",
		usage: { status: 429 },
		expected: { ok: false, code: "credit_list_failed" },
		spends: false,
	},
	// Why the bridge sends a picked pass itself (PICKS below): stock refuses, unspent, a grant Claude calls usable but
	// did not name next. When stock takes a chosen grant this case changes, and that path can go.
	"other-kind": {
		confirm: "grant-regular",
		usage: KINDS,
		expected: { ok: false, code: "offer_changed" },
		spends: false,
	},
	// No confirmed pass: stock still checks the offer is usable, then spends its own live pick.
	unconfirmed: { usage: live, expected: { ok: true, code: "reset" }, spends: true },
	confirmed: { confirm: "grant-live", usage: live, expected: { ok: true, code: "reset" }, spends: true },
};

interface Received {
	method: string;
	path: string;
	body: string;
}

const GUARD = `
const LOOPBACK = { "127.0.0.1": true, localhost: true, "[::1]": true };
const realFetch = globalThis.fetch;
const record = { blocked: [], loopback: [] };
Object.defineProperty(globalThis, "__ompdeskNetGuard", { value: record });
const target = input => {
 try { return new URL(input instanceof Request ? input.url : String(input)); } catch { return undefined; }
};
const allowed = url => url && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK[url.hostname] === true;
async function guarded(input, init) {
 const url = target(input);
 if (!allowed(url)) {
  record.blocked.push(url ? url.protocol + "//" + url.host + url.pathname : String(input));
  throw new TypeError("ompdesk test guard: non-loopback request refused");
 }
 record.loopback.push(url.origin + url.pathname + url.search);
 return realFetch(input, init);
}
guarded.preconnect = (input, options) => {
 const url = target(input);
 if (allowed(url)) realFetch.preconnect(input, options);
 else record.blocked.push("preconnect " + String(input));
};
globalThis.fetch = guarded;
`;

// The probe sits beside a copy of resources/gui-bridge (as `runBridgeProbe`'s does), so the bridge's own modules and
// their `@oh-my-pi/*` imports resolve the way they do in the app.
const PROBE = `
import { resetTickets } from "./reset-passes-core";
import { methods } from "./reset-passes";
import { methods as settings } from "./settings";
export default function (pi) {
 const run = async () => {
  try {
   const guard = globalThis.__ompdeskNetGuard;
   if (!guard || globalThis.fetch.name !== "guarded") throw new Error("the network guard preload did not run");
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   await session.modelRegistry.awaitInitialBackgroundRefresh(AbortSignal.timeout(60_000));
   const startup = guard.blocked.length;
   const auth = session.modelRegistry.authStorage;
   await auth.credentials.upsert("anthropic", {
    type: "oauth",
    access: "probe-access-not-a-real-token",
    refresh: "probe-refresh-not-a-real-token",
    expires: Date.now() + 10 * 365 * 24 * 3600_000,
    email: "reset-probe@example.invalid",
    orgId: "${ORG}",
   });
   const stored = auth.credentials.list("anthropic");
   if (stored.length !== 1) throw new Error("expected one stored Claude credential, got " + stored.length);
   const credentialId = stored[0].id;
   const results = {};
   for (const { name, confirm } of JSON.parse(process.env.OMPDESK_RESET_CASES)) {
    pi.registerProvider("anthropic", { baseUrl: process.env.OMPDESK_RESET_FAKE + "/" + name });
    const outcome = await session.redeemResetCredit({
     provider: "anthropic",
     credentialId,
     ...(confirm ? { creditId: confirm } : {}),
    });
    results[name] = {
     baseUrl: session.modelRegistry.getProviderBaseUrl("anthropic"),
     ok: outcome.ok,
     code: outcome.code,
     creditId: outcome.creditId,
    };
   }
   pi.registerProvider("anthropic", { baseUrl: process.env.OMPDESK_RESET_FAKE + "/${LISTED}" });
   const [listed] = await session.listResetCredits(undefined, "anthropic");
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const picks = {};
   for (const { name, confirm } of JSON.parse(process.env.OMPDESK_RESET_PICKS)) {
    pi.registerProvider("anthropic", { baseUrl: process.env.OMPDESK_RESET_FAKE + "/" + name });
    const result = await methods.reset_pass_redeem({ providerId: "anthropic", credentialId, creditId: confirm }, env);
    picks[name] = { ok: result.ok, code: result.code, message: result.message };
   }
   const lost = {};
   for (const name of JSON.parse(process.env.OMPDESK_RESET_LOST)) {
    pi.registerProvider("anthropic", { baseUrl: process.env.OMPDESK_RESET_FAKE + "/" + name });
    const tries = [];
    for (let attempt = 0; attempt < 2; attempt++) {
     const result = await methods.reset_pass_redeem({ providerId: "anthropic", credentialId, creditId: "grant-regular" }, env);
     tries.push({ ok: result.ok, code: result.code });
    }
    lost[name] = tries;
   }
   const storedReads = {};
   for (const { name, confirm } of JSON.parse(process.env.OMPDESK_RESET_STORED)) {
    pi.registerProvider("anthropic", { baseUrl: process.env.OMPDESK_RESET_FAKE + "/" + name });
    const listedAccounts = await settings.provider_accounts({ providerId: "anthropic" }, env);
    const shown = listedAccounts.accounts.find(entry => entry.credentialId === credentialId)?.resetPasses;
    const result = await methods.reset_pass_redeem({ providerId: "anthropic", credentialId, creditId: confirm }, env);
    storedReads[name] = { shown: shown?.creditId, ok: result.ok, code: result.code };
   }
   console.error("RESET_REDEEM_PROBE=" + JSON.stringify({
    results,
    picks,
    lost,
    stored: storedReads,
    listed: { count: listed?.availableCount, tickets: resetTickets(listed?.credits ?? []) },
    startupRefused: guard.blocked.slice(0, startup),
    blocked: guard.blocked.slice(startup),
    loopback: guard.loopback,
   }));
   process.exit(0);
  } catch (error) {
   console.error("RESET_REDEEM_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
   process.exit(1);
  }
 };
 pi.on("session_start", () => {
  void run();
 });
}
`;

function fakeClaude(received: Received[]) {
	return createServer((request: IncomingMessage, response: ServerResponse) => {
		let body = "";
		request.on("data", chunk => {
			body += chunk;
		});
		request.on("end", () => {
			const path = request.url ?? "";
			received.push({ method: request.method ?? "", path, body });
			const [, name = "", ...rest] = path.split("/");
			const route = `/${rest.join("/")}`;
			const scripted = CASES[name] ?? PICKS[name];
			const answer = (status: number, payload?: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(payload === undefined ? "" : JSON.stringify(payload));
			};
			const claimsBefore = received
				.slice(0, -1)
				.filter(entry => entry.method === "POST" && entry.path.startsWith(`/${name}/`))
				.map(entry => String((JSON.parse(entry.body) as { request_id?: unknown }).request_id));
			const lost = LOST[name];
			const usage =
				name === LISTED
					? KINDS
					: lost
						? claimsBefore.length === 0
							? KINDS
							: kinds({ resets_left: lost.leftAfter }, "grant-regular")
						: scripted?.usage;
			if (STORED[name]) {
				if (request.method === "GET" && route === PLAIN_USAGE) answer(200, LISTED_USAGE);
				else if (request.method === "GET" && route === USAGE) answer(429, {});
				else if (request.method === "POST" && route === CONSUME)
					answer(200, { result: "reset", cleared: ["five_hour"] });
				else answer(404, { error: "not scripted" });
				return;
			}
			if (usage && request.method === "GET" && route === USAGE) {
				answer(usage.status, usage.body);
			} else if (lost && request.method === "POST" && route === CONSUME) {
				const requestId = String((JSON.parse(body) as { request_id?: unknown }).request_id);
				// The first claim applies and its answer is lost; a claim repeated under the same id is the same claim,
				// one under a new id would spend a second use.
				if (claimsBefore.length === 0) answer(502, {});
				else answer(200, { result: claimsBefore.includes(requestId) ? "already_used" : "reset" });
			} else if (scripted && request.method === "POST" && route === CONSUME) {
				answer(200, { result: "reset", cleared: ["five_hour"] });
			} else {
				answer(404, { error: "not scripted" });
			}
		});
	});
}

function runRedeemProbe(fake: string): Promise<Record<string, unknown>> {
	const root = ompPackageRoot(INSTALLED_OMP);
	if (!root) throw new Error(`no omp package behind ${INSTALLED_OMP}`);
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-reset-redeem-"));
	chmodSync(isolated, 0o700);
	const guard = join(isolated, "net-guard.js");
	cpSync(absolute("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
	const extension = join(isolated, "bridge", "reset-redeem-probe.ts");
	writeFileSync(guard, GUARD);
	writeFileSync(extension, PROBE);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: isolated,
		USERPROFILE: isolated,
		PI_CODING_AGENT_DIR: isolated,
		PI_CONFIG_DIR: configDirName(isolated, isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		// omp refuses to start without a model; this made-up key gives it one and is never sent (no turn runs).
		OPENAI_API_KEY: "probe-not-a-real-key",
		OMPDESK_RESET_FAKE: fake,
		OMPDESK_RESET_CASES: JSON.stringify(Object.entries(CASES).map(([name, { confirm }]) => ({ name, confirm }))),
		OMPDESK_RESET_PICKS: JSON.stringify(Object.entries(PICKS).map(([name, { confirm }]) => ({ name, confirm }))),
		OMPDESK_RESET_STORED: JSON.stringify(Object.entries(STORED).map(([name, { confirm }]) => ({ name, confirm }))),
		OMPDESK_RESET_LOST: JSON.stringify(Object.keys(LOST)),
	};
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"OPENROUTER_API_KEY",
		"TYPESAFE_API_KEY",
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
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	// stdin stays open: its end would start omp's shutdown under the redeems; the probe exits by itself.
	const child = spawn("bun", args, { env, stdio: ["pipe", "ignore", "pipe"], timeout: 120_000 });
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", chunk => {
		stderr += chunk;
	});
	child.on("error", reject);
	child.on("close", () => {
		rmSync(isolated, { recursive: true, force: true });
		const line = stderr.split("\n").find(value => value.startsWith("RESET_REDEEM_PROBE="));
		if (!line) reject(new Error(`no probe result; omp stderr:\n${stderr.slice(-2500)}`));
		else resolve(JSON.parse(line.slice("RESET_REDEEM_PROBE=".length)) as Record<string, unknown>);
	});
	return promise;
}

describe.skipIf(!existsSync(INSTALLED_OMP))("stock omp's Claude reset redeem checks the live offer itself", () => {
	const received: Received[] = [];
	const server = fakeClaude(received);
	let probe: Record<string, unknown> = {};
	let base = "";

	beforeAll(async () => {
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		probe = await runRedeemProbe(base);
	}, 120_000);
	afterAll(() => {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	});

	it("redeems through a guard that let no request leave loopback", () => {
		expect(probe.error).toBeUndefined();
		// omp's startup model discovery (catalogs, the made-up OpenAI key's /v1/models) runs before the redeems and is
		// refused by the guard; nothing at all may try to leave loopback once the credential exists.
		expect(probe.blocked).toEqual([]);
		// Every request stock sent to the fake went through the guarded fetch (other loopback ports are omp's local
		// engine probes at startup).
		const toFake = (probe.loopback as string[]).filter(url => url.startsWith(`${base}/`));
		expect(toFake.map(url => url.slice(base.length)).sort()).toEqual(received.map(entry => entry.path).sort());
		const routes = [
			...Object.keys(CASES),
			...Object.keys(PICKS),
			...Object.keys(LOST),
			...Object.keys(STORED),
			LISTED,
		];
		expect(received.every(entry => routes.some(name => entry.path.startsWith(`/${name}/`)))).toBe(true);
	});

	it.each(Object.entries(CASES))("%s: one live offer read, then a spend only when it holds", (name, scripted) => {
		const results = probe.results as Record<string, { baseUrl: string; ok: boolean; code: string }>;
		expect(results[name]).toMatchObject({ baseUrl: `${base}/${name}`, ...scripted.expected });
		const routes = received.filter(entry => entry.path.startsWith(`/${name}/api/`));
		expect(routes.map(entry => `${entry.method} ${entry.path}`)).toEqual([
			`GET /${name}${USAGE}`,
			...(scripted.spends ? [`POST /${name}${CONSUME}`] : []),
		]);
	});

	it("spends exactly the live offer's pass", () => {
		const spends = received
			.filter(entry => entry.method === "POST" && CASES[entry.path.split("/")[1] ?? ""])
			.map(entry => JSON.parse(entry.body));
		expect(spends).toHaveLength(2);
		for (const body of spends) {
			expect(body).toMatchObject({ program: "cedar_ember", grant_id: "grant-live", request_id: expect.any(String) });
		}
	});

	it.each(Object.entries(PICKS))(
		"through the bridge, %s: only the pass the person picked is ever claimed",
		(name, pick) => {
			const picks = probe.picks as Record<string, { ok: boolean; code: string; message: string }>;
			expect(picks[name]).toMatchObject(pick.expected);
			const routes = received.filter(entry => entry.path.startsWith(`/${name}/api/`));
			const claims = routes.filter(entry => entry.method === "POST");
			expect(routes.filter(entry => entry.method === "GET").every(entry => entry.path === `/${name}${USAGE}`)).toBe(
				true,
			);
			expect(claims.map(entry => entry.path)).toEqual(pick.spends ? [`/${name}${CONSUME}`] : []);
			for (const claim of claims) {
				expect(JSON.parse(claim.body)).toEqual({
					program: "cedar_ember",
					grant_id: pick.confirm,
					request_id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
				});
			}
		},
	);

	it("reads a picked pass's offer once more than stock did, and the next pass's not at all", () => {
		const reads = (name: string) =>
			received.filter(entry => entry.method === "GET" && entry.path.startsWith(`/${name}/`)).length;
		expect(reads("picked")).toBe(2);
		expect(reads("picked-next")).toBe(1);
		expect((probe.picks as Record<string, { message: string }>).picked?.message).toContain(
			"reset-probe@example.invalid",
		);
	});

	it.each(Object.entries(LOST))(
		"through the bridge, %s: a claim whose answer was lost is never followed by a second one of the same pass",
		(name, scripted) => {
			const tries = (probe.lost as Record<string, Array<{ ok: boolean; code: string }>>)[name];
			expect(tries).toEqual([
				{ ok: false, code: "http_502" },
				{ ok: false, code: "already_redeemed" },
			]);
			const claims = received
				.filter(entry => entry.method === "POST" && entry.path.startsWith(`/${name}/`))
				.map(entry => JSON.parse(entry.body) as { grant_id: string; request_id: string });
			expect(claims).toHaveLength(scripted.claims);
			expect(claims.every(claim => claim.grant_id === "grant-regular")).toBe(true);
			// One request id is one use spent, however often it is sent.
			expect(new Set(claims.map(claim => claim.request_id)).size).toBe(1);
		},
	);

	it.each(Object.entries(STORED))(
		"through the bridge, %s: the pass the accounts list showed is spent from that read when the check is turned away",
		(name, scripted) => {
			const result = (probe.stored as Record<string, { shown?: string; ok: boolean; code: string }>)[name];
			expect(result).toEqual({ shown: scripted.confirm, ...scripted.expected });
			const routes = received.filter(entry => entry.path.startsWith(`/${name}/api/`));
			// Stock's one pre-spend check, turned away; the bridge asks Claude for nothing more before it claims.
			expect(routes.filter(entry => entry.path === `/${name}${USAGE}`).map(entry => entry.method)).toEqual(["GET"]);
			const claims = routes
				.filter(entry => entry.method === "POST")
				.map(entry => ({ path: entry.path, ...(JSON.parse(entry.body) as { request_id?: unknown }) }));
			expect(claims).toHaveLength(scripted.claims);
			for (const claim of claims) {
				expect(claim).toEqual({
					path: `/${name}${CONSUME}`,
					program: "cedar_ember",
					grant_id: scripted.confirm,
					request_id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
				});
			}
			expect(new Set(claims.map(claim => claim.request_id)).size).toBe(Math.min(1, claims.length));
		},
	);

	it("lists two kinds of pass as two tickets, each naming the pass a pick of it spends", () => {
		expect(probe.listed).toEqual({
			count: 3,
			tickets: [
				{
					clears: ["anthropic:5h", "anthropic:7d:fable"],
					title: "Fable reset",
					count: 1,
					expiresAt: Date.parse(FUTURE),
					early: false,
					creditId: "grant-fable",
				},
				{
					clears: ["anthropic:5h", "anthropic:7d"],
					title: "Limit reset",
					count: 2,
					expiresAt: Date.parse(FUTURE),
					early: false,
					creditId: "grant-regular",
				},
			],
		});
		expect(received.filter(entry => entry.path.startsWith(`/${LISTED}/`)).map(entry => entry.method)).toEqual([
			"GET",
		]);
	});
});
