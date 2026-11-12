/**
 * Credit use, live half (the rules are credit-spend-core.ts). The GUI passes the switch in `OMP_GUI_CREDIT_SPEND` at
 * spawn and `credit_spend_set` whenever Settings changes it; it acts on the omp's next request.
 *
 * While off, three stock seams carry it, all on the process's one `AuthStorage` (subagents in this process and in
 * worker threads resolve their keys through it):
 *
 * - ChatGPT's usage provider is stock's own wrapped as a runtime override (`usage.providerFor` then
 *   `usage.setProvider`): its `/wham/usage` answer reaches stock's parser without the `credits` block, so a spent plan
 *   reads spent and stock's selector blocks the account from the report and ranks a sibling first; the report's `raw`
 *   keeps the provider's real answer for the credits figure (account-credits.ts `rawCredits`). A response's
 *   `x-codex-*` headers are parsed without the 2xx verdict, so a window at 100 % reads spent, not "allowed". The
 *   override keeps its reports apart from other omps' (`cacheVersion`; stock auth-storage.ts keys the cache by it), so
 *   a terminal omp's report that says "allowed on credits" never reaches this one, and this one's never reaches it.
 * - Every request's key (`keys.getWithCredential`, the request path; `keys.get` is the prompt-time availability probe
 *   and stays stock) is checked after stock picked the account: one whose plan is spent by its own report, or that
 *   Claude last served on extra usage, is refused with a usage-limit error. Stock then blocks it until the reset
 *   (`limits.markReached`), moves the session to an account with plan left, or walks `retry.fallbackChains`.
 * - `after_provider_response` reads Claude's `overage-in-use` header and remembers the account until the claimed
 *   window resets, because Claude's usage answer can still read under 100 % while extra usage serves.
 *
 * On: the override is removed (`usage.removeProvider`), the check passes every key, and nothing is remembered.
 */
import type { AuthStorage, UsageFetchContext, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { appendRetryAfterHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	type CreditProvider,
	creditSpendEnabled,
	isCreditProvider,
	overageCoversAccount,
	overageUntil,
	planSpentError,
	planSpentUntil,
	setCreditSpend,
	withoutCredits,
} from "./credit-spend-core";
import { guard } from "./health";

/** Stock `UsageService.report` (one stored credential); not on the `UsageApi` interface (settings.ts reads it the same way). */
interface CredentialUsageReporter {
	report(provider: string, credential: unknown, options?: { baseUrl?: string }): Promise<UsageReport | null>;
}

const CODEX = "openai-codex";

/**
 * The cache namespace of the credits-hidden ChatGPT reports: stock's own version under a prefix no stock provider
 * uses, so it moves with stock's (a stock bump retires these rows as well) and never meets a stock row.
 */
const HIDDEN_CREDITS_CACHE_BASE = 9_000_000;

/** Marks the override, so a later apply finds stock's provider under it. */
const WRAPPED = Symbol.for("ompdesk.credit-spend.wrapped");
type WrappedProvider = UsageProvider & { [WRAPPED]: UsageProvider };

function isWrapped(provider: UsageProvider | undefined): provider is WrappedProvider {
	return provider !== undefined && WRAPPED in provider;
}

function codexWithoutCredits(stock: UsageProvider): WrappedProvider {
	const parseHeaders = stock.parseRateLimitHeaders;
	return {
		...stock,
		[WRAPPED]: stock,
		cacheVersion: HIDDEN_CREDITS_CACHE_BASE + (stock.cacheVersion ?? 0),
		async fetchUsage(params, ctx) {
			let answer: unknown;
			const hiding: UsageFetchContext["fetch"] = Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					const response = await ctx.fetch(input, init);
					const url = input instanceof Request ? input.url : String(input);
					if (!response.ok || !new URL(url).pathname.endsWith("/wham/usage")) return response;
					answer = await response.json();
					return new Response(JSON.stringify(withoutCredits(answer)), {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				},
				{ preconnect: ctx.fetch.preconnect },
			);
			const report = await stock.fetchUsage(params, { ...ctx, fetch: hiding });
			return report && answer !== undefined ? { ...report, raw: answer } : report;
		},
		...(parseHeaders
			? { parseRateLimitHeaders: (headers: Record<string, string>, now?: number) => parseHeaders(headers, now, {}) }
			: {}),
	};
}

/** Puts ChatGPT's usage provider in the state the switch names; a no-op when it already is. */
function applyUsageProvider(auth: AuthStorage): void {
	const current = auth.usage.providerFor(CODEX);
	if (creditSpendEnabled()) {
		if (isWrapped(current)) auth.usage.removeProvider(CODEX);
		return;
	}
	if (current && !isWrapped(current)) auth.usage.setProvider(CODEX, codexWithoutCredits(current));
}

/**
 * Claude accounts its answers said extra usage served, until the claimed window resets: `provider\0credentialId` when
 * the window is one all its models share, `provider\0credentialId\0modelId` when it is the served model's own.
 */
const overage = new Map<string, number>();

/** Until when the account must not serve `modelId`, by Claude's last answer or its own report; undefined when it may. */
async function limitedUntil(
	auth: AuthStorage,
	provider: CreditProvider,
	credentialId: number,
	options: { baseUrl?: string; modelId?: string } | undefined,
	now: number,
): Promise<number | undefined> {
	const account = `${provider}\0${credentialId}`;
	for (const key of options?.modelId ? [account, `${account}\0${options.modelId}`] : [account]) {
		const remembered = overage.get(key);
		if (remembered !== undefined && remembered > now) return remembered;
		overage.delete(key);
	}
	const entry = auth.credentials.list(provider).find(row => row.id === credentialId);
	if (entry?.credential.type !== "oauth") return undefined;
	const reporter = auth.usage as unknown as CredentialUsageReporter;
	const report = await reporter.report(provider, entry.credential, { baseUrl: options?.baseUrl });
	return planSpentUntil(provider, report, now);
}

/** The key check, installed once per AuthStorage (it passes everything while credit use is on). */
const gated = new WeakSet<object>();

function gateKeys(auth: AuthStorage): void {
	if (gated.has(auth.keys)) return;
	gated.add(auth.keys);
	const stock = auth.keys.getWithCredential.bind(auth.keys);
	auth.keys.getWithCredential = async (provider, sessionId, options) => {
		const resolved = await stock(provider, sessionId, options);
		if (creditSpendEnabled() || resolved?.credentialId === undefined || !isCreditProvider(provider)) return resolved;
		const now = Date.now();
		const until = await limitedUntil(auth, provider, resolved.credentialId, options, now);
		if (until === undefined) return resolved;
		const message = planSpentError(provider, until, now);
		throw new Error(appendRetryAfterHint(message, { "retry-after-ms": String(until - now) }));
	};
}

function apply(auth: AuthStorage): void {
	gateKeys(auth);
	applyUsageProvider(auth);
	if (creditSpendEnabled()) overage.clear();
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		// A subagent in a worker thread holds a proxy of the main thread's AuthStorage, which already carries it.
		if (ctx.agent.kind !== "main") return undefined;
		try {
			apply(ctx.modelRegistry.authStorage);
		} catch (err) {
			pi.logger.warn("gui-bridge: credit use setting not applied", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return undefined;
	});
	pi.on("after_provider_response", (event, ctx) => {
		const model = ctx.model;
		if (creditSpendEnabled() || model?.provider !== "anthropic") return;
		const auth = ctx.modelRegistry.authStorage;
		const sessionId = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session?.sessionId;
		const now = Date.now();
		const until = overageUntil(event.headers, now);
		if (until === undefined) return;
		const active = auth.oauth.accounts(model.provider, sessionId).find(entry => entry.active);
		if (!active) return;
		const account = `${model.provider}\0${active.credentialId}`;
		overage.set(overageCoversAccount(event.headers) ? account : `${account}\0${model.id}`, until);
	});
}

export const methods = guard("creditSpend", {
	/** `{enabled: boolean}`: main sends it to every live local omp on change and on bridge connect. */
	credit_spend_set: async (params, env) => {
		const state = setCreditSpend(params);
		apply(env.session().modelRegistry.authStorage);
		return state;
	},
});
