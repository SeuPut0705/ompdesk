/**
 * Account rotation, pure half (account-rotation.ts wires it to stock omp).
 * Stock omp picks which stored OAuth account serves a session by usage ranking
 * (pi-ai auth/select.ts + rank.ts, built-in strategies in usage/registry.ts):
 * it drains the account whose window resets first, skips blocked and nearly
 * exhausted ones, and keeps a warm session on the account it started with.
 * In "quota" mode stock's pick holds between turns (see "quota" below).
 *
 * "even" mode spreads sessions over the accounts in turn. Stock has no setting
 * for that, so before a prompt reaches the provider (`before_agent_start`) the
 * bridge gives a session without an account the one even rotation handed out
 * least recently, as an automatic warm pin (`sessions.pin` with
 * `restoredAtMs`, the way stock restores a resumed session's account). From
 * there stock's own pin rules hold: the pin serves the session, a usage-limited
 * account is blocked until its reset and the request fails over to a sibling.
 *
 * - A session keeps its account until that account is blocked; then it moves to
 *   the next unblocked account in turn. A pin past the provider's warm window
 *   (Claude: 60 min idle) is renewed on the same account instead of being
 *   re-ranked by quota, so even mode never hops an idle session either.
 * - "In turn" is least-recently-assigned across every omp this computer runs:
 *   the ledger (account key → last assignment) lives in one file the GUI names,
 *   keyed by stock's account digest (no raw emails).
 *
 * "quota" mode is stock's ranking (it drains the account whose window resets
 * first). Stock only re-ranks an automatic pin that went cold, blocked or
 * spent, so a session used without a 60-minute gap stayed on its first account
 * for days while a sibling that stock itself ranks first sat idle. At each
 * turn start (`before_agent_start`, the main agent only: subagents inherit the
 * parent's pin as stock copies it) the bridge therefore asks stock which
 * account it would pick for a fresh session now, and moves the session there
 * (`sessions.pin` with `restoredAtMs`: an automatic warm pin) only when
 *
 * - the pin is warm, automatic, unrestricted and free of account policies:
 *   an explicit `/session pin`, a pool or a policy is the user's choice, and a
 *   cold or blocked pin is stock's to re-rank;
 * - stock's own comparator still ranks the other account first after the
 *   pin's required drain gets RERANK_DRAIN_MARGIN: every tier stock has (blocked,
 *   spent allowance, reserve, the 85% 5h demotion, unmeasured usage) moves a pin
 *   at once; only the plain drain ordering, which stock decides at 1e-6, gets
 *   the margin, so two accounts near each other never swap a session.
 *
 * A session never moves mid-turn: the hook runs once per prompt.
 *
 * No omp imports (not even types), no Bun globals: the GUI's vitest exercises
 * this file directly (src/main/bridge-account-rotation.test.ts).
 */

export type AccountRotationMode = "quota" | "even";

let mode: AccountRotationMode = process.env.OMP_GUI_ACCOUNT_ROTATION === "even" ? "even" : "quota";

/** `{mode: "quota" | "even"}`; anything else is refused rather than read as quota. */
export function setAccountRotation(params: unknown): { mode: AccountRotationMode } {
	const next = typeof params === "object" && params !== null && "mode" in params ? params.mode : undefined;
	if (next !== "quota" && next !== "even") throw new Error('account_rotation_set needs {mode: "quota" | "even"}');
	mode = next;
	return { mode };
}

/** One stored OAuth account (stock `OAuthAccountSummary`, the fields used here). */
export interface RotationAccount {
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
	/** This session's pinned (sticky) account. */
	active: boolean;
	/** Last use of the session's pin; only on the active account. */
	lastUsedAtMs?: number;
}

/** A persisted credential block (stock `StoredCredentialBlock`). */
export interface RotationBlock {
	credentialId: number;
	providerKey: string;
	blockScope: string;
	blockedUntilMs: number;
}

/** The public AuthStorage namespaces even rotation touches. */
export interface RotationAuth {
	oauth: { accounts(provider: string, sessionId?: string): RotationAccount[] };
	sessions: {
		pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean;
	};
	blocks: { list(credentialIds: readonly number[]): RotationBlock[] };
}

/** Stock knowledge account-rotation.ts hands in (pi-ai auth/blocks, usage/registry, credential-pin). */
export interface RotationStock {
	/** `provider:oauth`, the providerKey OAuth blocks are stored under. */
	providerKey(provider: string): string;
	/** Every block scope stock's selector honours for a request to `modelId` (protected ones included). */
	blockScopes(provider: string, modelId: string): readonly string[];
	/** The provider strategy's `stickyWarmMs`; undefined: stock never lets a pin go cold. */
	warmMs(provider: string): number | undefined;
	/** The ledger key of an account (stock's account digest). */
	accountKey(provider: string, account: RotationAccount): string;
}

/** Where the ledger lives: one shared file, or this process's memory. */
export interface RotationLedgerStore {
	read(): RotationLedger;
	write(text: string): void;
}

/** The prompt about to be sent: its model's provider and the id omp resolves its key under. */
export interface RotationPrompt {
	auth: RotationAuth;
	provider: string;
	modelId: string;
	sessionId: string;
}

/** One stored OAuth account of the provider, as the decision needs it. */
export interface RotationCandidate {
	credentialId: number;
	/** This session's pinned (sticky) account. */
	active: boolean;
	/** Last use of the session's pin; only on the active account. */
	lastUsedAtMs?: number;
	/** Blocked for this request's model right now (usage limit, auth backoff, account policy). */
	blocked: boolean;
	/** When even rotation last handed this account a session, in any process; undefined = never. */
	lastAssignedAtMs?: number;
}

export type RotationStep =
	| { pin: false }
	/** `assign`: a new account for the session (it had none, or its account is blocked); `renew`: same account, idle pin. */
	| { pin: true; credentialId: number; kind: "assign" | "renew" };

const KEEP: RotationStep = { pin: false };

/**
 * What even rotation does for one session before its prompt. `accounts` in
 * stock storage order (ties go to the earlier one); `warmMs` is the provider
 * strategy's `stickyWarmMs` (undefined: stock never lets a pin go cold).
 */
export function planEvenRotation(
	accounts: readonly RotationCandidate[],
	nowMs: number,
	warmMs: number | undefined,
): RotationStep {
	if (accounts.length < 2) return KEEP;
	const active = accounts.find(account => account.active);
	if (active && !active.blocked) {
		const cold = pinIsCold(active, nowMs, warmMs);
		return cold ? { pin: true, credentialId: active.credentialId, kind: "renew" } : KEEP;
	}
	let next: RotationCandidate | undefined;
	for (const account of accounts) {
		if (account.blocked) continue;
		if (!next || (account.lastAssignedAtMs ?? -1) < (next.lastAssignedAtMs ?? -1)) next = account;
	}
	// Every account blocked: stock's last-resort ladder waits for the earliest reset.
	return next ? { pin: true, credentialId: next.credentialId, kind: "assign" } : KEEP;
}

/**
 * The `before_agent_start` step: in even mode, pin this prompt's session to
 * its turn's account; in quota mode nothing is read or written (`prompt` is
 * not even called). Returns what it did.
 */
export function rotateBeforePrompt(
	prompt: () => RotationPrompt | undefined,
	stock: RotationStock,
	ledger: RotationLedgerStore,
	nowMs: number,
): RotationStep {
	if (mode !== "even") return KEEP;
	const target = prompt();
	if (!target) return KEEP;
	const { auth, provider, modelId, sessionId } = target;
	// Empty under a runtime/config key override: stock bypasses the OAuth pool then.
	const accounts = auth.oauth.accounts(provider, sessionId);
	if (accounts.length < 2) return KEEP;
	const blocked = blockedAccounts(auth, accounts, stock, provider, modelId, nowMs);
	const assigned = ledger.read();
	const keys = new Map(accounts.map(account => [account.credentialId, stock.accountKey(provider, account)]));
	const step = planEvenRotation(
		accounts.map(account => ({
			credentialId: account.credentialId,
			active: account.active,
			lastUsedAtMs: account.lastUsedAtMs,
			blocked: blocked.has(account.credentialId),
			lastAssignedAtMs: assigned[keys.get(account.credentialId) ?? ""],
		})),
		nowMs,
		stock.warmMs(provider),
	);
	if (!step.pin) return step;
	// restoredAtMs: an automatic warm pin, so stock's eviction and failover rules still apply.
	if (!auth.sessions.pin(provider, sessionId, step.credentialId, { restoredAtMs: nowMs })) return KEEP;
	const key = keys.get(step.credentialId);
	if (step.kind === "assign" && key) ledger.write(recordAssignment(assigned, key, nowMs));
	return step;
}

/** Stock's warm test (select.ts): a pin without a last-use time counts as warm. */
function pinIsCold(active: { lastUsedAtMs?: number }, nowMs: number, warmMs: number | undefined): boolean {
	return warmMs !== undefined && active.lastUsedAtMs !== undefined && nowMs - active.lastUsedAtMs >= warmMs;
}

/** The accounts blocked for this request's model right now, by the scopes stock's selector reads. */
function blockedAccounts(
	auth: { blocks: RotationAuth["blocks"] },
	accounts: readonly { credentialId: number }[],
	stock: Pick<RotationStock, "providerKey" | "blockScopes">,
	provider: string,
	modelId: string,
	nowMs: number,
): Set<number> {
	const providerKey = stock.providerKey(provider);
	const scopes = new Set(stock.blockScopes(provider, modelId));
	return new Set(
		auth.blocks
			.list(accounts.map(account => account.credentialId))
			.filter(
				block => block.providerKey === providerKey && scopes.has(block.blockScope) && block.blockedUntilMs > nowMs,
			)
			.map(block => block.credentialId),
	);
}

/**
 * The single margin OMPdesk adds to stock's ranking, for quota re-ranking. Stock compares two accounts' required
 * drain (`headroom / hours to reset`) at 1e-6 tolerance, so any gap decides; a session moved on every small gap
 * would swap accounts as fast as its own use shifts the numbers, and every swap rewrites the provider's prompt
 * cache (Anthropic: per account, billed in full). A pin is therefore handicapped by this factor on its drain
 * before stock's comparator runs: it moves only when the other account's drain is more than this many times its
 * own, and having moved, it needs the same factor back, so a round trip takes a 4x swing. The value is OMPdesk's own
 * (stock has no threshold for drain) and a choice, not a measurement: the gap that left the user's session on the
 * worse account was 2.7x, which 2 still moves. Tiers, not drain, are untouched and move a pin at once.
 */
export const RERANK_DRAIN_MARGIN = 2;

/** `row` with its measured windows' required drain multiplied by `margin`; unmeasured windows stay as stock scores them. */
export function withDrainMargin<T extends { primaryRequiredDrain: number; secondaryRequiredDrain: number }>(
	row: T,
	measured: { primary: boolean; secondary: boolean },
	margin: number = RERANK_DRAIN_MARGIN,
): T {
	return {
		...row,
		...(measured.primary ? { primaryRequiredDrain: row.primaryRequiredDrain * margin } : {}),
		...(measured.secondary ? { secondaryRequiredDrain: row.secondaryRequiredDrain * margin } : {}),
	};
}

/** The public AuthStorage namespaces quota re-ranking touches. */
export interface QuotaRerankAuth {
	oauth: {
		accounts(provider: string, sessionId?: string): RotationAccount[];
		/** Stock's configured account policy (`auth.accountPolicies`) matching an account; undefined: none. */
		policy(
			provider: string,
			identity: { accountId?: string; email?: string; projectId?: string; orgId?: string },
		): unknown;
	};
	sessions: RotationAuth["sessions"] & {
		/** False for an account outside a `sessions.restrict` pool of the session. */
		permits(provider: string, sessionId: string, credentialId: number): boolean;
		/** Copies a session's pins to another session; `include` sees each pin's explicitness first. */
		inherit(
			sourceSessionId: string,
			targetSessionId: string,
			include?: (provider: string, explicit: boolean) => boolean,
		): number;
	};
	blocks: RotationAuth["blocks"];
}

/** The prompt about to be sent, as quota re-ranking needs it. */
export interface QuotaRerankPrompt {
	auth: QuotaRerankAuth;
	provider: string;
	modelId: string;
	sessionId: string;
}

/** Stock knowledge quota re-ranking is handed (account-rotation.ts): the block and warm facts of even rotation, and stock's ranking. */
export interface QuotaRerankStock extends Pick<RotationStock, "providerKey" | "blockScopes" | "warmMs"> {
	/**
	 * The account stock's selector picks for a session without a pin on this request, right now (the selection a
	 * fresh session gets, run without recording a pin). undefined: no account could serve.
	 */
	topChoice(prompt: QuotaRerankPrompt): Promise<number | undefined>;
	/**
	 * Whether stock's comparator still ranks `topId` ahead of `pinId` when the pin's required drain is scaled by
	 * RERANK_DRAIN_MARGIN (withDrainMargin). False too when either account has no usage measurement to compare.
	 */
	clearlyBetter(prompt: QuotaRerankPrompt, topId: number, pinId: number): Promise<boolean>;
}

export type RerankSkip =
	| "mode"
	| "no-model"
	| "single-account"
	| "no-pin"
	| "cold"
	| "unknown-provenance"
	| "explicit"
	| "restricted"
	| "policy"
	| "blocked"
	| "no-choice"
	| "same"
	| "within-margin"
	| "pin-refused";

/** `move`: the session's automatic pin went from `from` to `to`; otherwise why it stayed (stock decides from there). */
export type RerankStep = { move: false; why: RerankSkip } | { move: true; from: number; to: number };

/**
 * Whether the session's pin for `provider` is an explicit user pin. Stock keeps the flag off its account list; its
 * only public reader is the `include` callback of `sessions.inherit`, which a stand-in target id and a `false` return
 * turn into a read that copies nothing. undefined: stock reports no pin of the provider's for the session.
 */
function pinIsExplicit(auth: QuotaRerankAuth, provider: string, sessionId: string): boolean | undefined {
	let explicit: boolean | undefined;
	auth.sessions.inherit(sessionId, `${sessionId}:ompdesk-pin-probe`, (candidate, flag) => {
		if (candidate === provider) explicit = flag;
		return false;
	});
	return explicit;
}

const stay = (why: RerankSkip): RerankStep => ({ move: false, why });

/**
 * The quota-mode `before_agent_start` step (main agent only; the caller skips subagents, which inherit the parent's
 * pin): move the session's automatic warm pin to the account stock ranks first when it clearly beats the pin (see
 * the header). Quota mode only; even mode has rotateBeforePrompt. Asks stock only after every cheap check passed.
 */
export async function rerankBeforePrompt(
	prompt: () => QuotaRerankPrompt | undefined,
	stock: QuotaRerankStock,
	nowMs: number,
): Promise<RerankStep> {
	if (mode !== "quota") return stay("mode");
	const target = prompt();
	if (!target) return stay("no-model");
	const { auth, provider, modelId, sessionId } = target;
	// Empty under a runtime/config key override: stock bypasses the OAuth pool then.
	const accounts = auth.oauth.accounts(provider, sessionId);
	if (accounts.length < 2) return stay("single-account");
	const active = accounts.find(account => account.active);
	if (!active) return stay("no-pin");
	// A cold pin is stock's to re-rank on the next key lookup.
	if (pinIsCold(active, nowMs, stock.warmMs(provider))) return stay("cold");
	const explicit = pinIsExplicit(auth, provider, sessionId);
	if (explicit === undefined) return stay("unknown-provenance");
	if (explicit) return stay("explicit");
	if (accounts.some(account => !auth.sessions.permits(provider, sessionId, account.credentialId))) {
		return stay("restricted");
	}
	if (accounts.some(account => auth.oauth.policy(provider, account) !== undefined)) return stay("policy");
	// A blocked pin is unavailable to stock's selector, which then ranks without it.
	if (blockedAccounts(auth, accounts, stock, provider, modelId, nowMs).has(active.credentialId))
		return stay("blocked");
	const top = await stock.topChoice(target);
	if (top === undefined) return stay("no-choice");
	if (top === active.credentialId) return stay("same");
	if (!(await stock.clearlyBetter(target, top, active.credentialId))) return stay("within-margin");
	// restoredAtMs: an automatic warm pin, so stock's eviction and failover rules still apply.
	if (!auth.sessions.pin(provider, sessionId, top, { restoredAtMs: nowMs })) return stay("pin-refused");
	return { move: true, from: active.credentialId, to: top };
}

/** Ledger entries older than this are dropped on write: the file stays small, and a month-old turn decides nothing. */
export const LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type RotationLedger = Record<string, number>;

/** The ledger file's contents; anything malformed reads as empty. */
export function parseLedger(text: string | undefined): RotationLedger {
	if (!text) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return {};
	}
	const assigned = typeof value === "object" && value !== null && "assigned" in value ? value.assigned : undefined;
	if (typeof assigned !== "object" || assigned === null) return {};
	const ledger: RotationLedger = {};
	for (const [key, at] of Object.entries(assigned)) {
		if (typeof at === "number" && Number.isFinite(at)) ledger[key] = at;
	}
	return ledger;
}

/**
 * `ledger` with `key` assigned at `nowMs`, stale entries pruned, serialized for
 * the file. The stamp is kept past every other entry, so two sessions in the
 * same millisecond still take turns instead of tying.
 */
export function recordAssignment(ledger: RotationLedger, key: string, nowMs: number): string {
	const assigned: RotationLedger = {};
	let latest = Number.NEGATIVE_INFINITY;
	for (const [entry, at] of Object.entries(ledger)) {
		if (nowMs - at >= LEDGER_MAX_AGE_MS) continue;
		assigned[entry] = at;
		latest = Math.max(latest, at);
	}
	assigned[key] = Math.max(nowMs, latest + 1);
	return JSON.stringify({ version: 1, assigned });
}
