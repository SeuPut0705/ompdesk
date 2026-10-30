/**
 * How the Providers & accounts list and the featured cards name and group providers. Pure; no React, no
 * IPC. Kept apart from provider-catalog.ts, which the phone page's first screen loads: this file pulls in the
 * brand-mark table (`sortProvidersByCompany`) and is needed only where a provider list is drawn.
 */

import type { ProviderInfo } from "../../../../shared/rpc-types";
import { groupProviders } from "./provider-catalog";
import { sortProvidersByCompany } from "./provider-marks";

/**
 * The brand a provider goes by in the lists (the mark beside it already says who it is), by stock
 * provider id. Brands only, never a plan: stock's names are long and its plan wording changes.
 * Any other provider is its stock name without the parenthetical (`shortProviderName`).
 */
export const PROVIDER_SHORT_NAMES: Readonly<Record<string, string>> = {
	anthropic: "Claude",
	"openai-codex": "ChatGPT",
	openrouter: "OpenRouter",
	"google-gemini-cli": "Gemini",
	"xai-oauth": "Grok",
};

/** The brand name of a provider: the table's, else stock's name with its parenthetical removed. */
export function shortProviderName(provider: { id: string; name: string }): string {
	const known = PROVIDER_SHORT_NAMES[provider.id];
	if (known) return known;
	const bare = provider.name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
	return bare || provider.name;
}

function withoutBrand(text: string, brand: string): string | null {
	const lower = text.toLowerCase();
	const prefix = brand.toLowerCase();
	if (!lower.startsWith(prefix)) return null;
	const rest = text.slice(brand.length);
	return rest === "" || /^\s/.test(rest) ? rest.trim() : null;
}

/**
 * The plan or tier stock's name carries, read from the live name at run time: what follows the
 * brand in the name ("ChatGPT Plus/Pro (Codex Subscription)" → "Plus/Pro"), else its parenthetical
 * without a leading brand word ("Anthropic (Claude Pro/Max)" → "Pro/Max"). `null` when there is none.
 */
export function providerPlan(provider: { id: string; name: string }): string | null {
	const brand = shortProviderName(provider);
	const match = provider.name.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
	const head = match ? match[1] : provider.name;
	const parenthetical = match ? match[2].trim() : "";
	const afterBrand = withoutBrand(head.trim(), brand);
	if (afterBrand) return afterBrand;
	if (!parenthetical) return null;
	const plan = withoutBrand(parenthetical, brand) ?? parenthetical;
	return plan && plan.toLowerCase() !== brand.toLowerCase() ? plan : null;
}

/** Brand plus the plan stock's name carries: "Claude (Pro/Max)"; just the brand when stock names none. */
export function providerLabel(provider: { id: string; name: string }): string {
	const plan = providerPlan(provider);
	return plan ? `${shortProviderName(provider)} (${plan})` : shortProviderName(provider);
}

/** A subscription sign-in can hold several accounts (stock lists them for OAuth providers). */
export function listsAccounts(provider: ProviderInfo): boolean {
	return provider.authenticated && provider.authKind === "oauth" && provider.loginAvailable;
}

/** One connected provider of the Providers & accounts list. */
export interface ProviderGroup {
	provider: ProviderInfo;
	/** The brand: the header's name. */
	shortName: string;
	/** Stock's own name: the tooltip and the accessible name. */
	fullName: string;
	/** The plan stock's name carries, when it names one. */
	plan: string | null;
	/** `accounts`: a subscription holding one or more sign-ins (rows under the header, an add button); `single`: one row. */
	kind: "accounts" | "single";
}

/** The list's groups, one per connected provider, sorted by company with a company's providers adjacent. */
export function buildProviderGroups(providers: readonly ProviderInfo[]): ProviderGroup[] {
	return sortProvidersByCompany(groupProviders(providers).connected).map(provider => ({
		provider,
		shortName: shortProviderName(provider),
		fullName: provider.name,
		plan: providerPlan(provider),
		kind: listsAccounts(provider) ? "accounts" : "single",
	}));
}
