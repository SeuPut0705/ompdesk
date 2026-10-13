/**
 * Account rotation, pure half (account-rotation.ts wires it to stock omp).
 * Stock omp picks which stored OAuth account serves a session by usage ranking
 * (pi-ai auth/select.ts + rank.ts, built-in strategies in usage/registry.ts):
 * it drains the account whose window resets first, skips blocked and nearly
 * exhausted ones, and keeps a warm session on the account it started with.
 * That is the GUI's "quota" mode, and the bridge does nothing in it.
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
		// Stock's warm test (select.ts): a pin without a last-use time counts as warm.
		const cold = warmMs !== undefined && active.lastUsedAtMs !== undefined && nowMs - active.lastUsedAtMs >= warmMs;
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
	const providerKey = stock.providerKey(provider);
	const scopes = new Set(stock.blockScopes(provider, modelId));
	const blocked = new Set(
		auth.blocks
			.list(accounts.map(account => account.credentialId))
			.filter(
				block => block.providerKey === providerKey && scopes.has(block.blockScope) && block.blockedUntilMs > nowMs,
			)
			.map(block => block.credentialId),
	);
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
