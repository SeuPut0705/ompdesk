/**
 * Pure filtering/sorting/shortening helpers behind the inventory window's
 * list tabs, kept separate so they are unit-testable without a DOM.
 */

import type { RpcMarketplaceInfo, RpcPluginInfo, RpcPromptTemplateInfo } from "../../../shared/rpc-types";

/** Display form for a marketplace source URI — strips URL/git ceremony, trims long paths. */
export function shortenSource(source: string): string {
	const trimmed = source.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("git@")) {
		return trimmed
			.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
			.replace(/^git@/, "")
			.replace(/\.git$/i, "")
			.replace(/\/+$/, "");
	}
	const parts = trimmed.split(/[\\/]+/).filter(Boolean);
	if (parts.length > 2) return `…/${parts.slice(-2).join("/")}`;
	return trimmed;
}

/** Alphabetical by name; query matches name, id, marketplace, version, or scope. */
export function filterPlugins(plugins: readonly RpcPluginInfo[], query: string): RpcPluginInfo[] {
	const rows = [...plugins].sort((a, b) => a.name.localeCompare(b.name));
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	return rows.filter(p =>
		[p.name, p.id ?? "", p.marketplace, p.version, p.scope ?? ""].join(" ").toLowerCase().includes(q),
	);
}

/** Alphabetical by name; query matches name or source URI. */
export function filterMarketplaces(marketplaces: readonly RpcMarketplaceInfo[], query: string): RpcMarketplaceInfo[] {
	const rows = [...marketplaces].sort((a, b) => a.name.localeCompare(b.name));
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	return rows.filter(m => `${m.name} ${m.source}`.toLowerCase().includes(q));
}

/** Alphabetical by name; query matches name, description, or source. */
export function filterTemplates(templates: readonly RpcPromptTemplateInfo[], query: string): RpcPromptTemplateInfo[] {
	const rows = [...templates].sort((a, b) => a.name.localeCompare(b.name));
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	return rows.filter(t => `${t.name} ${t.description} ${t.source}`.toLowerCase().includes(q));
}
