/**
 * Settings, model catalog, providers, usage and model roles. Stock omp has no
 * RPC for most of these (its `get_available_models` lacks discovery state), so
 * each one is answered by the gui-bridge's `settings` methods over the live
 * session, keeping the fork's wire shapes. Provider accounts reuse stock
 * `get_logout_accounts` / `logout` and add only the per-account quota stock lacks.
 */
import { z } from "zod";
import type {
	AccountUsageState,
	ProviderAccount,
	ProviderAccountsResult,
	ResetPasses,
	ResetPassRedeemResult,
	UsageLimit,
} from "../../shared/rpc-types";
import { stockHelperRequest } from "../stock-helper";
import { LocalCommandError, type LocalHandler } from "./types";

/** Stock `get_logout_accounts` row (`LogoutAccount`). */
export interface StockLogoutAccount {
	credentialId: number;
	label: string;
	detail: string;
	type: "oauth" | "api_key";
	active: boolean;
}

/** gui-bridge `provider_accounts` result (resources/gui-bridge/settings.ts). */
export interface BridgeProviderAccounts {
	providerId: string;
	pinnedCredentialId?: number;
	/** Only on omp with account pools (bridge feature `accountPools`). */
	credentialProvider?: string;
	accounts: Array<{
		credentialId: number;
		state: AccountUsageState;
		remainingFraction?: number;
		resetsAt?: number;
		limits: UsageLimit[];
		/** The account's stock usage report `fetchedAt`; absent while stock has none. */
		fetchedAt?: number;
		/** Only on omp with account pools; `null` when the account has no identity. */
		identityKey?: string | null;
		/** The account's saved rate-limit resets (bridge feature `resetPasses`). */
		resetPasses?: ResetPasses;
	}>;
}

/**
 * Stock's account list joined with the bridge's per-account quota by
 * credentialId. "In use" is the session's actual pin: stock's `active` falls
 * back to the first account before the session has used any. Identity keys
 * pass through only when the bridge reported them (omp with account pools).
 */
export function mergeProviderAccounts(
	providerId: string,
	stock: readonly StockLogoutAccount[],
	usage: BridgeProviderAccounts | undefined,
	usageError?: string,
): ProviderAccountsResult {
	const usageById = new Map(usage?.accounts.map(account => [account.credentialId, account]));
	const pools = usage?.credentialProvider !== undefined;
	const accounts = stock.map((account): ProviderAccount => {
		const quota = usageById.get(account.credentialId);
		return {
			credentialId: account.credentialId,
			label: account.label,
			detail: account.detail,
			type: account.type,
			inUse: usage?.pinnedCredentialId === account.credentialId,
			state: quota?.state ?? "unknown",
			...(quota?.remainingFraction !== undefined ? { remainingFraction: quota.remainingFraction } : {}),
			...(quota?.state === "depleted" && quota.resetsAt !== undefined ? { limitedUntil: quota.resetsAt } : {}),
			limits: quota?.limits ?? [],
			...(quota?.fetchedAt !== undefined ? { fetchedAt: quota.fetchedAt } : {}),
			...(pools ? { identityKey: quota?.identityKey ?? null } : {}),
			...(quota?.resetPasses ? { resetPasses: quota.resetPasses } : {}),
		};
	});
	return {
		providerId,
		accounts,
		...(usageError ? { usageError } : {}),
		...(usage?.credentialProvider !== undefined ? { credentialProvider: usage.credentialProvider } : {}),
	};
}

const providerIdParam = z.string().min(1);

/** What a history read passes on: the command's own `id` and `type` stay here. */
const historyRead = z.object({ limit: z.number().int().optional(), cwd: z.string().optional() });
const historySearch = historyRead.extend({ query: z.string() });

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/**
 * Ends a browser sign-in stock's `login` RPC is waiting on. That RPC takes no
 * cancel (rpc-mode `login` passes its flow no signal), an empty answer to the
 * code paste it races against the callback only makes it ask again, and while
 * it waits it holds omp's serial command queue, up to the flow's 5-minute
 * callback timeout. The one stop stock has is the one a provider's Deny button
 * takes: its loopback callback reached with `error` and the flow's `state`
 * rejects the login at once (pi-ai callback-server.ts `#handleCallback`).
 * Runs where omp runs (a paired host's main for its tabs), so the loopback
 * address is omp's own.
 */
export async function cancelBrowserLogin(authorizationUrl: string): Promise<void> {
	const authorize = new URL(authorizationUrl);
	const redirect = authorize.searchParams.get("redirect_uri");
	const callback = redirect && URL.canParse(redirect) ? new URL(redirect) : null;
	if (callback?.protocol !== "http:" || !Object.hasOwn(LOOPBACK_HOSTS, callback.hostname)) {
		throw new LocalCommandError("This sign-in has no loopback callback to end", "no_loopback_callback");
	}
	const state = authorize.searchParams.get("state");
	callback.search = "";
	callback.hash = "";
	callback.searchParams.set("error", "access_denied");
	callback.searchParams.set("error_description", "Sign-in cancelled in OMPdesk");
	if (state) callback.searchParams.set("state", state);
	// Stock answers a denial with its error page (500); a closed server means the login already ended.
	await fetch(callback, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
}

export const handlers: Record<string, LocalHandler> = {
	get_settings_schema: (_command, ctx) => ctx.bridge.request("settings_schema"),
	get_settings: (command, ctx) => ctx.bridge.request("settings_get", { paths: command.paths }),
	set_setting: (command, ctx) => ctx.bridge.request("settings_set", { path: command.path, value: command.value }),
	get_available_models: (command, ctx) =>
		ctx.bridge.request("models_catalog", { forceRefresh: command.forceRefresh === true }),
	get_providers: (command, ctx) => ctx.bridge.request("providers", { forceRefresh: command.forceRefresh === true }),
	login_cancel: async command => cancelBrowserLogin(z.string().url().parse(command.url)),
	// One account goes through stock `logout`; the whole provider only when asked for explicitly.
	logout: async (command, ctx) => {
		const providerId = providerIdParam.parse(command.providerId);
		if (command.all === true) return ctx.bridge.request("provider_logout", { providerId });
		const credentialId = z.number().int().parse(command.credentialId);
		return ctx.send({ type: "logout", providerId, credentialId });
	},
	get_provider_accounts: async (command, ctx) => {
		const providerId = providerIdParam.parse(command.providerId);
		const [stock, usage] = await Promise.allSettled([
			ctx.send<{ accounts: StockLogoutAccount[] }>({ type: "get_logout_accounts", providerId }),
			ctx.bridge.request<BridgeProviderAccounts>("provider_accounts", {
				providerId,
				refresh: command.refresh === true,
			}),
		]);
		if (stock.status === "rejected") throw stock.reason;
		return usage.status === "fulfilled"
			? mergeProviderAccounts(providerId, stock.value.accounts, usage.value)
			: mergeProviderAccounts(
					providerId,
					stock.value.accounts,
					undefined,
					usage.reason instanceof Error ? usage.reason.message : String(usage.reason),
				);
	},
	// Through the tab's own bridge, so a paired host's tab spends the host's account.
	redeem_reset_pass: async (command, ctx) =>
		ctx.bridge.request<ResetPassRedeemResult>("reset_pass_redeem", {
			providerId: providerIdParam.parse(command.providerId),
			credentialId: z.number().int().parse(command.credentialId),
			creditId: z.string().min(1).optional().parse(command.creditId),
		}),
	get_usage: (command, ctx) => ctx.bridge.request("usage", { refresh: command.refresh === true }),
	get_model_roles: (command, ctx) => ctx.bridge.request("model_roles", { compact: command.compact === true }),
	set_model_role: (command, ctx) =>
		ctx.bridge.request("model_role_set", { role: command.role, modelId: command.modelId ?? null }),
	get_model_role_metadata: (_command, ctx) => ctx.bridge.request("model_role_metadata"),
	get_model_setup_facts: (_command, ctx) => ctx.bridge.request("model_setup_facts"),
	get_session_spend: (_command, ctx) => ctx.bridge.request("session_spend"),
	get_compaction_points: (command, ctx) =>
		ctx.bridge.request("compaction_points", command.selector === undefined ? {} : { selector: command.selector }),
	compaction_limits: (command, ctx) => ctx.bridge.request("compaction_limits", command),
	get_recent_models: (_command, ctx) => ctx.bridge.request("recent_models"),
	set_output_style: async (command, ctx) =>
		ctx.bridge.request("output_style_set", { style: z.object({ style: z.string() }).parse(command).style }),
	// One draft report serves both idle timers; an omp without the recap feature answers unsupported_omp, which is no failure here.
	set_idle_compaction_draft: async (command, ctx) => {
		const { empty } = z.object({ empty: z.boolean() }).parse(command);
		const recap = ctx.bridge.request("recap_draft", { empty }).catch(() => undefined);
		const armed = await ctx.bridge.request("idle_compaction_draft", { empty });
		await recap;
		return armed;
	},
	// Reads go to the stock helper's one handle on the history.db every omp on this computer writes: never through the
	// tab's omp, whose thread is busy mid-turn (stock-helper/history.ts). The write stays there, for the session id.
	history_recent: async command => stockHelperRequest("history.recent", historyRead.parse(command)),
	history_search: async command => stockHelperRequest("history.search", historySearch.parse(command)),
	history_record: (command, ctx) => ctx.bridge.request("history_record", command),
};
