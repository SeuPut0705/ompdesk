/**
 * Account rotation, live half (the decision is account-rotation-core.ts). The
 * GUI passes the mode in `OMP_GUI_ACCOUNT_ROTATION` at spawn and
 * `account_rotation_set` whenever Settings changes it, and names the shared
 * ledger file in `OMP_GUI_ACCOUNT_ROTATION_STATE`.
 * Stock defaultRankingStrategy ranks by quota, but has no even-rotation switch;
 * keep only this GUI ledger/pinning policy around the stock credential selector.
 *
 * Only public AuthStorage namespaces are touched (`oauth.accounts`,
 * `sessions.pin`, `blocks.list`); the selector, its strategies and the 429
 * failover stay stock. The hook runs once per prompt, before omp resolves the
 * request's key; subagents rebind this extension and inherit their parent's pin
 * (sdk.ts `credentialSourceSessionId`), so they already have an account.
 */
import * as fs from "node:fs";
import {
	ACCOUNT_POLICY_BLOCK_SCOPE,
	AUTH_BLOCK_SCOPE,
	credentialBlockScopesForRequest,
	providerTypeKey,
} from "@oh-my-pi/pi-ai/auth/blocks";
import { defaultRankingStrategy } from "@oh-my-pi/pi-ai/usage/registry";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import {
	parseLedger,
	type RotationLedger,
	type RotationLedgerStore,
	type RotationPrompt,
	type RotationStock,
	rotateBeforePrompt,
	setAccountRotation,
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

function promptOf(pi: ExtensionAPI, ctx: ExtensionContext): RotationPrompt | undefined {
	const model = ctx.model;
	// The id omp resolves keys under (AgentSession.sessionId), not the session file's id.
	const sessionId =
		pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session?.sessionId ?? ctx.sessionManager.getSessionId();
	if (!model || !sessionId) return undefined;
	return { auth: ctx.modelRegistry.authStorage, provider: model.provider, modelId: model.id, sessionId };
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => {
		try {
			rotateBeforePrompt(() => promptOf(pi, ctx), STOCK, LEDGER, Date.now());
		} catch (err) {
			// Stock selection still runs; the prompt must not fail over a rotation hint.
			pi.logger.warn("gui-bridge: account rotation skipped", { error: err instanceof Error ? err.message : String(err) });
		}
		return undefined;
	});
}

export const methods = guard("accountRotation", {
	/** `{mode: "quota" | "even"}`: main sends it to every live local sidecar on change and on bridge connect. */
	account_rotation_set: async params => setAccountRotation(params),
});
