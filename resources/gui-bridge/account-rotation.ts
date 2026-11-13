/**
 * Account rotation, live half (the decision is account-rotation-core.ts). The
 * GUI passes the mode in `OMP_GUI_ACCOUNT_ROTATION` at spawn and
 * `account_rotation_set` whenever Settings changes it, and names the shared
 * ledger file in `OMP_GUI_ACCOUNT_ROTATION_STATE`.
 * Stock defaultRankingStrategy ranks by quota, but has no even-rotation switch;
 * keep only this GUI ledger/pinning policy around the stock credential selector.
 * In quota mode the hook re-ranks a main session's automatic pin at turn start
 * (rules and margin in the core: rerankBeforePrompt), asking stock's own selector
 * and comparator; nothing here ranks by itself. A long turn is checked again
 * between two model calls (`after_provider_response`, at most once a minute, not
 * awaited): `rerankMidTurn` moves only on a near block or a large gain. Every
 * decision, moved or not, is logged with its reason code, and the last one per
 * session is what the usage view shows (`decisionOf`).
 *
 * Only public AuthStorage namespaces are touched (`oauth.accounts`, `oauth.policy`,
 * `sessions.pin|inherit|permits`, `blocks.list`, `keys.getWithCredential`,
 * `credentials.list`, `usage.report`) plus stock's ranking functions (`auth/rank`,
 * `auth/usage-report`); the selector, its strategies and the 429 failover stay
 * stock. The turn-start hook runs once per prompt, before omp resolves the request's key;
 * subagents rebind this extension and inherit their parent's pin (sdk.ts
 * `credentialSourceSessionId`), so they already have an account and never re-rank.
 */
import * as fs from "node:fs";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	ACCOUNT_POLICY_BLOCK_SCOPE,
	AUTH_BLOCK_SCOPE,
	credentialBlockScopesForRequest,
	providerTypeKey,
} from "@oh-my-pi/pi-ai/auth/blocks";
import { orderUsageRankedCandidates, planPriority, type RankedOAuthCandidate } from "@oh-my-pi/pi-ai/auth/rank";
import { normalizeUsageFraction, remainingUsageFraction, windowRequiredDrain } from "@oh-my-pi/pi-ai/auth/usage-report";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import {
	type AccountFacts,
	lastDecision,
	parseLedger,
	type QuotaRerankPrompt,
	type QuotaRerankStock,
	type RankRead,
	type RerankPhase,
	type RerankStep,
	type RotationDecision,
	type RotationLedger,
	type RotationLedgerStore,
	type RotationPrompt,
	type RotationStock,
	recordDecision,
	rerankBeforePrompt,
	rerankMidTurn,
	rotateBeforePrompt,
	setAccountRotation,
	withDrainMargin,
} from "./account-rotation-core";
import { guard } from "./health";

const STOCK: RotationStock = {
	providerKey: provider => providerTypeKey(provider, "oauth"),
	// The scopes stock's selector reads blocks under (select.ts resolveOAuth, blocks.ts #blockedUntilById).
	blockScopes: (provider, modelId) => {
		const strategy = defaultRankingStrategy(provider);
		const context = { modelId };
		return [
			"",
			AUTH_BLOCK_SCOPE,
			ACCOUNT_POLICY_BLOCK_SCOPE,
			...credentialBlockScopesForRequest(provider, strategy, context, strategy?.blockScope?.(context)),
		];
	},
	warmMs: provider => defaultRankingStrategy(provider)?.stickyWarmMs,
	accountKey: (provider, account) => credentialPinHash(provider, account) ?? `${provider}#${account.credentialId}`,
};

const LEDGER_PATH = process.env.OMP_GUI_ACCOUNT_ROTATION_STATE || undefined;
/** Without a ledger file (a bare `-e` load) turns are kept per process. */
let memoryLedger: RotationLedger = {};

const LEDGER: RotationLedgerStore = {
	read: () => {
		if (!LEDGER_PATH) return memoryLedger;
		try {
			return parseLedger(fs.readFileSync(LEDGER_PATH, "utf8"));
		} catch {
			return {};
		}
	},
	write: text => {
		if (!LEDGER_PATH) {
			memoryLedger = parseLedger(text);
			return;
		}
		// Rename over the file so a concurrent reader never sees half a write.
		const temp = `${LEDGER_PATH}.${process.pid}.tmp`;
		fs.writeFileSync(temp, text, { mode: 0o600 });
		fs.renameSync(temp, LEDGER_PATH);
	},
};

function promptOf(pi: ExtensionAPI, ctx: ExtensionContext): (RotationPrompt & QuotaRerankPrompt) | undefined {
	const model = ctx.model;
	// The id omp resolves keys under (AgentSession.sessionId), not the session file's id.
	const sessionId =
		pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session?.sessionId ?? ctx.sessionManager.getSessionId();
	if (!model || !sessionId) return undefined;
	return { auth: ctx.modelRegistry.authStorage, provider: model.provider, modelId: model.id, sessionId };
}

/** Stock `UsageService.report` (one stored credential); not on the `UsageApi` interface (settings.ts reads it the same way). */
interface CredentialUsageReporter {
	report(provider: string, credential: unknown, options?: { baseUrl?: string }): Promise<UsageReport | null>;
}

/** Stock's ranking, for the turn's model: its selector's pick, and its comparator over the two accounts' own reports. */
function quotaStock(ctx: ExtensionContext, onRead?: (read: RankRead) => void): QuotaRerankStock {
	return {
		providerKey: STOCK.providerKey,
		blockScopes: STOCK.blockScopes,
		warmMs: STOCK.warmMs,
		// What a session without a pin gets from stock's selector on this request: the same options model-registry.ts
		// `getApiKey` passes (usage reports are cached by base URL), without recording the answer as a pin. A fresh
		// stand-in id per call, so an omp that ignored `recordAffinity` could never answer from its own earlier pin.
		topChoice: async prompt => {
			const model = ctx.model;
			if (!model) return undefined;
			const authStorage = ctx.modelRegistry.authStorage;
			const probeId = `${prompt.sessionId}:ompdesk-rank-${crypto.randomUUID()}`;
			try {
				const resolved = await authStorage.keys.getWithCredential(prompt.provider, probeId, {
					baseUrl: model.baseUrl,
					modelId: model.id,
					accountIds: model.accountAccess && Object.keys(model.accountAccess),
					recordAffinity: false,
				});
				return resolved?.credentialId;
			} catch {
				// Transient refresh failure or no account: stock's own lookup on the real request decides.
				return undefined;
			} finally {
				authStorage.sessions.release(prompt.provider, probeId);
			}
		},
		// The candidate rows are built from stock's own metrics (select.ts #rankOAuthSelections, minus reserve and
		// priority: a session with account policies is never re-ranked) and ordered by stock's own comparator.
		compare: async (prompt, topId, pinId) => {
			const model = ctx.model;
			const strategy = defaultRankingStrategy(prompt.provider);
			const unreadable: RankRead = { pin: undefined, top: undefined, topFirstWithMargin: false };
			if (!model || !strategy) return unreadable;
			const authStorage = ctx.modelRegistry.authStorage;
			const reporter = authStorage.usage as unknown as CredentialUsageReporter;
			const stored = authStorage.credentials.list(prompt.provider);
			const rankingContext = { modelId: prompt.modelId };
			const planGate = strategy.planGate?.(rankingContext);
			const nowMs = Date.now();
			const rowFor = async (credentialId: number, orderPos: number) => {
				const entry = stored.find(row => row.id === credentialId);
				if (entry?.credential.type !== "oauth") return undefined;
				const usage = await reporter.report(prompt.provider, entry.credential, { baseUrl: model.baseUrl });
				if (!usage) return undefined;
				const { primary, secondary } = strategy.findWindowLimits(usage, rankingContext);
				const candidate: RankedOAuthCandidate = {
					// `index` carries the stored row id: stock's comparator never reads the selection.
					selection: { credential: entry.credential, index: credentialId },
					usage,
					usageChecked: true,
					blocked: false,
					inReserve: false,
					accountPriority: 0,
					allowanceSpent: remainingUsageFraction(strategy, usage, rankingContext, nowMs) === 0,
					usageMeasured: primary !== undefined || secondary !== undefined,
					hasPriorityBoost:
						strategy.hasPriorityBoost?.(
							primary,
							primary === undefined && secondary !== undefined,
							rankingContext,
						) ?? false,
					planPriority: planPriority(planGate, usage),
					secondaryUsed: normalizeUsageFraction(secondary),
					secondaryRequiredDrain: windowRequiredDrain(secondary, nowMs, strategy.windowDefaults.secondaryMs),
					primaryUsed: normalizeUsageFraction(primary),
					primaryRequiredDrain: windowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
					orderPos,
				};
				const measured = { primary: primary !== undefined, secondary: secondary !== undefined };
				const facts: AccountFacts = {
					spent: candidate.allowanceSpent,
					...(measured.primary
						? { primaryUsed: candidate.primaryUsed, primaryDrain: candidate.primaryRequiredDrain }
						: {}),
					...(measured.secondary ? { secondaryDrain: candidate.secondaryRequiredDrain } : {}),
				};
				return { candidate, measured, facts };
			};
			// The pin goes first, so a genuine tie stays on it (select.ts seeds the pinned account first the same way).
			const [pin, top] = await Promise.all([rowFor(pinId, 0), rowFor(topId, 1)]);
			// Only measured accounts compare: a failed usage fetch must not read as "unmeasured, so the sibling wins".
			const pinRead = pin?.candidate.usageMeasured ? pin : undefined;
			const topRead = top?.candidate.usageMeasured ? top : undefined;
			const read: RankRead = {
				pin: pinRead?.facts,
				top: topRead?.facts,
				topFirstWithMargin: false,
			};
			if (pinRead && topRead) {
				const ordered = orderUsageRankedCandidates(
					[withDrainMargin(pinRead.candidate, pinRead.measured), topRead.candidate],
					planGate !== undefined,
				);
				read.topFirstWithMargin = ordered[0]?.selection.index === topId;
			}
			onRead?.(read);
			return read;
		},
	};
}

/**
 * When even rotation last handed each of `accounts` a session, in any omp this computer runs (epoch ms by
 * credential id; accounts the ledger never named are left out). Empty in quota mode, which keeps no ledger.
 */
export function ledgerAssignedAt(
	provider: string,
	accounts: readonly {
		credentialId: number;
		accountId?: string;
		email?: string;
		projectId?: string;
		orgId?: string;
	}[],
): Map<number, number> {
	const assigned = LEDGER.read();
	const at = new Map<number, number>();
	for (const account of accounts) {
		const key = STOCK.accountKey(provider, { ...account, active: false });
		const when = assigned[key];
		if (when !== undefined) at.set(account.credentialId, when);
	}
	return at;
}

/** Between two model calls a check runs at most this often per session (stock's usage reports it reads are cached 5 min). */
const MID_TURN_CHECK_MS = 60_000;
const checkedAt = new Map<string, number>();
const checking = new Set<string>();

/** Subagents of this session still running: they hold the account they were spawned on, so the session stays put. */
function runningSubagents(pi: ExtensionAPI): number {
	const registry = pi.pi.AgentRegistry.global();
	return registry.list().filter(ref => ref.kind === "sub" && registry.isRunning(ref)).length;
}

/** A decision as the log and the usage view carry it (credential ids and fractions, never an address or a token). */
function logDecision(
	pi: ExtensionAPI,
	phase: RerankPhase,
	sessionId: string,
	step: RerankStep,
	read: RankRead | undefined,
): void {
	recordDecision(sessionId, { why: step.why, moved: step.move, phase, at: Date.now() });
	const detail = {
		sessionId,
		phase,
		why: step.why,
		...(step.move ? { from: step.from, to: step.to } : {}),
		...(read ? { pin: read.pin, top: read.top, topFirstWithMargin: read.topFirstWithMargin } : {}),
	};
	// Every decision leaves a line, so "why did it not switch" is answered from the log; a mid-turn stay is the
	// frequent one, so it is a debug line.
	if (step.move) pi.logger.info("gui-bridge: quota re-rank moved the session's account", detail);
	else if (phase === "turn-start") pi.logger.info("gui-bridge: quota re-rank kept the session's account", detail);
	else pi.logger.debug("gui-bridge: quota re-rank kept the session's account mid-turn", detail);
}

/** One decision, with the usage read it took (for the log). */
async function decide(pi: ExtensionAPI, ctx: ExtensionContext, phase: RerankPhase, nowMs: number): Promise<void> {
	const prompt = promptOf(pi, ctx);
	if (!prompt) return;
	let read: RankRead | undefined;
	const stock = quotaStock(ctx, taken => {
		read = taken;
	});
	checkedAt.set(prompt.sessionId, nowMs);
	const step =
		phase === "turn-start"
			? await rerankBeforePrompt(() => prompt, stock, nowMs)
			: await rerankMidTurn(() => prompt, stock, nowMs, runningSubagents(pi));
	logDecision(pi, phase, prompt.sessionId, step, read);
}

/**
 * The mid-turn decision after a model response: main agent only, at most once per MID_TURN_CHECK_MS and session,
 * one at a time, and a failure only costs the check. Resolves when it is done; undefined when there is nothing to do.
 */
export function checkBetweenCalls(pi: ExtensionAPI, ctx: ExtensionContext, nowMs: number): Promise<void> | undefined {
	if (ctx.agent.kind !== "main") return undefined;
	const sessionId = promptOf(pi, ctx)?.sessionId;
	if (!sessionId || checking.has(sessionId)) return undefined;
	if (nowMs - (checkedAt.get(sessionId) ?? 0) < MID_TURN_CHECK_MS) return undefined;
	checking.add(sessionId);
	return decide(pi, ctx, "mid-turn", nowMs)
		.catch(err => {
			pi.logger.warn("gui-bridge: mid-turn account check skipped", {
				error: err instanceof Error ? err.message : String(err),
			});
		})
		.finally(() => checking.delete(sessionId));
}

/** The last quota decision of `sessionId` in this omp, for the usage view; undefined before its first one. */
export function decisionOf(sessionId: string): RotationDecision | undefined {
	return lastDecision(sessionId);
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			rotateBeforePrompt(() => promptOf(pi, ctx), STOCK, LEDGER, Date.now());
			// Subagents take the parent's pin when stock spawns them (and the parent re-ranked at its own turn start),
			// so a subagent's own turn never re-ranks: it would split a task across two accounts.
			if (ctx.agent.kind === "main") await decide(pi, ctx, "turn-start", Date.now());
		} catch (err) {
			// Stock selection still runs; the prompt must not fail over a rotation hint.
			pi.logger.warn("gui-bridge: account rotation skipped", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return undefined;
	});
	// Between two model calls of a long turn: the response of a request has arrived and the next request's key is
	// not resolved yet, so a pin written now serves the next call (an in-flight stream keeps the account it began
	// on). Not awaited: stock holds the response body until these handlers return, and the check may read usage.
	pi.on("after_provider_response", (_event, ctx) => {
		void checkBetweenCalls(pi, ctx, Date.now());
		return undefined;
	});
}

export const methods = guard("accountRotation", {
	/** `{mode: "quota" | "even"}`: main sends it to every live local sidecar on change and on bridge connect. */
	account_rotation_set: async params => setAccountRotation(params),
});
