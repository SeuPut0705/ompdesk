/**
 * ⌘P quick open ranking over workspace-relative paths. The file name is what
 * people type, so name hits lead: prefix, then substring, then subsequence;
 * a query that only matches across directories ("layout/shell") comes last.
 * Ties prefer the shorter file name, then the shallower path.
 */

import { fuzzyScore } from "./fuzzy-score";

const Tier = { pathFuzzy: 1, nameFuzzy: 2, nameSubstring: 3, namePrefix: 4 } as const;

interface Ranked {
	path: string;
	tier: number;
	score: number;
	nameLength: number;
}

export function rankQuickOpen(paths: readonly string[], query: string, limit: number): string[] {
	const needle = query.trim().toLowerCase().replace(/\s+/g, "");
	if (!needle) return paths.slice(0, limit);
	const ranked: Ranked[] = [];
	for (const path of paths) {
		const name = path.slice(path.lastIndexOf("/") + 1);
		const lowerName = name.toLowerCase();
		let tier = 0;
		let score = 0;
		if (lowerName.startsWith(needle)) tier = Tier.namePrefix;
		else if (lowerName.includes(needle)) tier = Tier.nameSubstring;
		else {
			const nameScore = fuzzyScore(needle, lowerName);
			if (nameScore !== null) {
				tier = Tier.nameFuzzy;
				score = nameScore;
			} else {
				const pathScore = fuzzyScore(needle, path);
				if (pathScore === null) continue;
				tier = Tier.pathFuzzy;
				score = pathScore;
			}
		}
		ranked.push({ path, tier, score, nameLength: name.length });
	}
	ranked.sort(
		(a, b) =>
			b.tier - a.tier ||
			b.score - a.score ||
			a.nameLength - b.nameLength ||
			a.path.length - b.path.length ||
			a.path.localeCompare(b.path),
	);
	return ranked.slice(0, limit).map(entry => entry.path);
}
