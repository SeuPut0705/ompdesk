/**
 * Settings search: one index over every place a setting lives — the
 * sections themselves, renderer-owned preferences, curated agent rows, and
 * every GUI-relevant agent schema entry (which land in Advanced). Matches
 * any UI language and wire names; title prefix matches rank first.
 */

import type { SettingEntry } from "../../../shared/rpc-types";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { zh } from "../../locales/zh";
import { schemaSearchTexts } from "./schema-i18n";
import {
	ADVANCED_OTHER_CATEGORY,
	CURATED_SCHEMA_ROWS,
	GUI_SEARCH_ITEMS,
	SETTINGS_SECTION_IDS,
	type SettingsSectionId,
} from "./settings-catalog";
import { isSettingVisibleInGui } from "./settings-schema-utils";

export interface SettingsSearchResult {
	key: string;
	title: string;
	/** Where it lives ("Appearance", "Advanced › Model"). */
	location: string;
	/** `openSettings` target. */
	target: string;
	/** Row to scroll to and focus. */
	rowId?: string;
	/** Wire name shown for agent settings. */
	path?: string;
}

/** Extra match terms per section (wire words and the things a section manages). */
const SECTION_ALIASES: Record<SettingsSectionId, string> = {
	general: "general language notifications steering follow-up interrupt compaction",
	appearance: "appearance theme dark light font size density color transcript display",
	keyboard: "keyboard shortcuts hotkeys keymap",
	models: "models providers login logout api key model roles compare benchmark thinking retry",
	permissions: "permissions security approval secrets scan",
	features: "features capabilities plan goal loop ttsr advisor memory palette",
	extensions: "extensions skills mcp servers hooks commands",
	plugins: "plugins marketplace templates memory resources inventory",
	workspace: "workspace project folders directories dirs",
	ssh: "ssh hosts remote",
	updates: "updates version upgrade omp update",
	advanced: "advanced proxy launch profile system prompt schema",
};

const DICTIONARIES = [en, ko, zh] as const;

function allLanguages(key: string): string {
	return DICTIONARIES.map(dictionary => (dictionary as Record<string, string>)[key] ?? "").join(" ");
}

function normalize(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

interface Candidate extends SettingsSearchResult {
	haystack: string;
}

export interface SettingsSearchInput {
	query: string;
	t: (key: string) => string;
	entries: readonly SettingEntry[];
	values: Record<string, unknown>;
	/** Label of an agent schema tab (`settings.tabs.<id>` or the schema label). */
	schemaTabLabel: (tabId: string) => string;
	/** Localized schema label for an entry. */
	schemaLabel: (entry: SettingEntry) => string;
	limit?: number;
}

export function searchSettings({
	query,
	t,
	entries,
	values,
	schemaTabLabel,
	schemaLabel,
	limit = 60,
}: SettingsSearchInput): SettingsSearchResult[] {
	const words = normalize(query).trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	const sectionLabel = (id: SettingsSectionId) => t(`settings.section.${id}`);
	const candidates: Candidate[] = [];

	for (const id of SETTINGS_SECTION_IDS) {
		candidates.push({
			key: `section:${id}`,
			title: sectionLabel(id),
			location: t("settings.search.page"),
			target: id,
			haystack: `${id} ${allLanguages(`settings.section.${id}`)} ${allLanguages(`settings.section.${id}.desc`)} ${SECTION_ALIASES[id]}`,
		});
	}
	for (const item of GUI_SEARCH_ITEMS) {
		candidates.push({
			key: `gui:${item.id}`,
			title: t(item.labelKey),
			location: sectionLabel(item.section),
			target: item.sub ? `${item.section}:${item.sub}` : item.section,
			rowId: `setting-gui-${item.id}`,
			haystack: `${item.id} ${allLanguages(item.labelKey)} ${item.aliases}`,
		});
	}
	for (const entry of entries) {
		if (!isSettingVisibleInGui(entry, values)) continue;
		const curated = CURATED_SCHEMA_ROWS[entry.path];
		const schemaText = `${entry.path} ${entry.label ?? ""} ${entry.description ?? ""} ${schemaSearchTexts(entry.path).join(" ")}`;
		if (curated) {
			candidates.push({
				key: `curated:${entry.path}`,
				title: t(`settings.field.${entry.path}`),
				location: sectionLabel(curated),
				target: curated,
				rowId: `setting-${entry.path}`,
				path: entry.path,
				haystack: `${allLanguages(`settings.field.${entry.path}`)} ${schemaText}`,
			});
		}
		const category = entry.advanced === true || entry.tab === undefined ? ADVANCED_OTHER_CATEGORY : entry.tab;
		candidates.push({
			key: `schema:${entry.path}`,
			title: schemaLabel(entry),
			location: `${sectionLabel("advanced")} › ${
				category === ADVANCED_OTHER_CATEGORY ? t("settings.advanced.other") : schemaTabLabel(category)
			}`,
			target: `advanced:${category}`,
			rowId: `setting-${entry.path}`,
			path: entry.path,
			haystack: schemaText,
		});
	}

	const ranked: { candidate: Candidate; rank: number; order: number }[] = [];
	candidates.forEach((candidate, order) => {
		const haystack = normalize(`${candidate.title} ${candidate.haystack}`);
		if (!words.every(word => haystack.includes(word))) return;
		const title = normalize(candidate.title);
		const phrase = words.join(" ");
		const rank = title === phrase ? 0 : title.startsWith(phrase) ? 1 : title.includes(phrase) ? 2 : 3;
		ranked.push({ candidate, rank, order });
	});
	ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
	return ranked.slice(0, limit).map(({ candidate: { haystack: _haystack, ...result } }) => result);
}
