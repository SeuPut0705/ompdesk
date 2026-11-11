import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
const KINDS = offer({
	eligible: true,
	grants: [
		grant({ id: "grant-fable", label: "Fable reset", clears: ["five_hour", "seven_day_overage_included"] }),
		grant({ id: "grant-regular", label: "Limit reset", clears: ["five_hour", "seven_day"], resets_left: 2 }),
	],
	next_grant_id: "grant-fable",
});
/** The fake's route for the listing of that account (no redeem). */
const LISTED = "kinds";
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
	// What keeps the other kinds of an account's passes unpickable in OMPdesk (reset-passes-core.ts `resetTickets`): a
	// grant Claude calls usable but did not name next is refused unspent. When stock takes a chosen grant, this case
	// and the listing below change with it, and the dialog's other cards open by themselves.
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

/** The bridge's pure ticket rules, read from this checkout by the probe (a file outside omp's package). */
const CORE = pathToFileURL(resolve("resources/gui-bridge/reset-passes-core.ts")).href;

const PROBE = `
import { resetTickets } from "${CORE}";
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
   console.error("RESET_REDEEM_PROBE=" + JSON.stringify({
    results,
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
			const scripted = CASES[name];
			const answer = (status: number, payload?: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(payload === undefined ? "" : JSON.stringify(payload));
			};
			const usage = name === LISTED ? KINDS : scripted?.usage;
			if (usage && request.method === "GET" && route === USAGE) {
				answer(usage.status, usage.body);
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
	const extension = join(isolated, "reset-redeem-probe.js");
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
		const routes = [...Object.keys(CASES), LISTED];
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
		const spends = received.filter(entry => entry.method === "POST").map(entry => JSON.parse(entry.body));
		expect(spends).toHaveLength(2);
		for (const body of spends) {
			expect(body).toMatchObject({ program: "cedar_ember", grant_id: "grant-live", request_id: expect.any(String) });
		}
	});

	it("lists two kinds of pass as two tickets, a pass to spend only on the one Claude names next", () => {
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
				},
			],
		});
		expect(received.filter(entry => entry.path.startsWith(`/${LISTED}/`)).map(entry => entry.method)).toEqual([
			"GET",
		]);
	});
});
