/**
 * A first-time user's words reach the row that owns them: the page search ranks
 * the right section's row first for accounts, model roles, updates and resuming
 * interrupted work, in English and Korean.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../lib/i18n";
import { searchSettings } from "./settings-search";

const top = (query: string) =>
	searchSettings({
		query,
		t: key => translate(key),
		entries: [],
		values: {},
		schemaTabLabel: id => id,
		schemaLabel: entry => entry.path,
	}).slice(0, 3);

const CASES: readonly [query: string, target: string][] = [
	["account", "models"],
	["accounts", "models"],
	["sign in", "models"],
	["model roles", "models"],
	["role", "models"],
	["update", "updates"],
	["updates", "updates"],
	["omp update", "updates"],
	["resume", "general"],
	["continue interrupted", "general"],
	["계정", "models"],
	["역할", "models"],
	["모델 역할", "models"],
	["업데이트", "updates"],
	["이어서", "general"],
	["중단된 작업", "general"],
];

describe("settings findability", () => {
	it.each(CASES)("%s → %s", (query, target) => {
		const results = top(query);
		expect(results.length, query).toBeGreaterThan(0);
		expect(
			results.map(result => result.target.split(":")[0]),
			`${query}: ${results.map(result => `${result.title} (${result.location})`).join(" | ")}`,
		).toContain(target);
	});
});
