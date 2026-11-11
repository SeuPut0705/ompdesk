/**
 * `?accounts=1`: a computer signed in to several subscriptions (several Claude and ChatGPT accounts, one
 * Gemini, a Grok), an OpenRouter key and an API-key provider, as stock lists them (names are stock's
 * own, long ones included), so Settings › Models & accounts shows the grouped Providers & accounts list.
 */

import type { ProviderAccount } from "../../shared/rpc-types";

const MINUTE = 60_000;

export const ACCOUNT_PROVIDERS = [
	{
		id: "anthropic",
		name: "Anthropic (Claude Pro/Max)",
		authenticated: true,
		authKind: "oauth",
		loginAvailable: true,
		disabled: false,
		modelCount: 8,
	},
	{
		id: "openai-codex",
		name: "ChatGPT Plus/Pro (Codex Subscription)",
		authenticated: true,
		authKind: "oauth",
		loginAvailable: true,
		disabled: false,
		modelCount: 6,
	},
	{
		id: "google-gemini-cli",
		name: "Google Cloud Code Assist (Gemini CLI)",
		authenticated: true,
		authKind: "oauth",
		loginAvailable: true,
		disabled: false,
		modelCount: 4,
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		authenticated: true,
		authKind: "apikey",
		loginAvailable: true,
		disabled: false,
		modelCount: 595,
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		authenticated: true,
		authKind: "apikey",
		loginAvailable: true,
		disabled: false,
		modelCount: 3,
	},
	{
		id: "xai-oauth",
		name: "xAI Grok OAuth (SuperGrok or X Premium+)",
		authenticated: false,
		authKind: "oauth",
		loginAvailable: true,
		disabled: false,
		modelCount: 0,
	},
];

function account(
	credentialId: number,
	label: string,
	prefix: string,
	five: number,
	seven: number,
	extra: Partial<ProviderAccount> = {},
): ProviderAccount {
	const now = Date.now();
	return {
		credentialId,
		label,
		detail: `oauth #${credentialId}`,
		type: "oauth",
		inUse: false,
		state: five >= 1 ? "depleted" : "healthy",
		remainingFraction: 1 - Math.max(five, seven),
		identityKey: `${prefix}:${credentialId}`,
		fetchedAt: now - 20_000,
		limits: [
			{ id: `${prefix}:5h`, label: "5 Hour", windowId: "5h", usedFraction: five, resetsAt: now + 140 * MINUTE },
			{
				id: `${prefix}:7d`,
				label: "7 Day",
				windowId: "7d",
				usedFraction: seven,
				resetsAt: now + 3 * 24 * 60 * MINUTE,
			},
		],
		...extra,
	};
}

/** Claude's model-scoped weekly cap, as stock reports it beside the whole-account windows. */
function fable(usedFraction: number) {
	return {
		id: "anthropic:7d:fable",
		label: "Claude 7 Day (Fable)",
		windowId: "7d",
		windowLabel: "Claude 7 Day",
		usedFraction,
		resetsAt: Date.now() + 3 * 24 * 60 * MINUTE,
	};
}

const PASSES = { count: 2, usableCount: 1, clears: ["anthropic:7d"], early: false, redeemable: true };

/**
 * An account holding two kinds of pass, as stock omp reports them: a Fable reset Claude names next (the only one omp
 * can spend) and two regular ones.
 */
function twoKinds(): NonNullable<ProviderAccount["resetPasses"]> {
	const day = 24 * 60 * MINUTE;
	const fable = {
		clears: ["anthropic:5h", "anthropic:7d:fable"],
		title: "Fable launch reset",
		early: false,
		creditId: "fable",
	};
	return {
		...fable,
		count: 3,
		usableCount: 1,
		expiresAt: Date.now() + 30 * day,
		redeemable: true,
		tickets: [
			{ ...fable, count: 1, expiresAt: Date.now() + 120 * day },
			{
				clears: ["anthropic:5h", "anthropic:7d"],
				title: "Limit reset",
				count: 2,
				expiresAt: Date.now() + 30 * day,
				early: false,
			},
		],
	};
}

/** What `get_provider_accounts` answers for one of the providers above. */
export function accountsFor(providerId: string): ProviderAccount[] {
	switch (providerId) {
		case "anthropic": {
			const work = account(1, "work@example.com", "anthropic", 0.34, 0.52, { inUse: true });
			const home = account(2, "home@example.com", "anthropic", 1, 0.9, {
				limitedUntil: Date.now() + 95 * MINUTE,
				resetPasses: twoKinds(),
			});
			const studio = account(3, "studio@example.com", "anthropic", 0.08, 0.31, {
				resetPasses: { ...PASSES, count: 1, usableCount: 0, redeemable: false },
			});
			const lab = account(4, "a-rather-long-address-for-the-lab@example-company.com", "anthropic", 0.61, 0.7);
			return [
				{ ...work, limits: [...work.limits, fable(0.07)] },
				{ ...home, limits: [...home.limits, fable(0.44)] },
				// Claude reports no 5 hour window for some accounts.
				{ ...studio, limits: [...studio.limits.slice(1), fable(0.43)] },
				{ ...lab, limits: [...lab.limits, fable(0.86)] },
			];
		}
		case "openai-codex":
			return [
				account(11, "personal@example.com", "openai-codex", 0.12, 0.2),
				account(12, "team@example.org", "openai-codex", 0.77, 0.4),
				account(13, "spare@example.net", "openai-codex", 0, 0.05),
			];
		case "google-gemini-cli":
			return [account(21, "me@example.com", "google-gemini-cli", 0.2, 0.1)];
		default:
			return [];
	}
}
