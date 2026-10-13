/**
 * Command palette ranking and the Enter guard.
 *
 * Ranking tiers (best first): exact > prefix > word-prefix > substring >
 * subsequence fuzzy. Hangul is matched on its jamo, so a query typed mid-
 * composition ("틀" on the way to "트리") already hits, and a query of only
 * initial consonants ("ㅌㄹ") matches syllable initials. Matches on the
 * command's own words (label, name, aliases) outrank matches that only hit
 * its description; within a tier, recently used commands come first.
 *
 * The guard: a turn-starting or destructive command never runs from Enter on
 * a fuzzy hit. It runs only when the query names it exactly, when the user
 * moved the selection onto it explicitly, or after a second confirming Enter.
 */

import { fuzzyScore } from "./fuzzy-score";

export const MatchTier = {
	none: 0,
	fuzzy: 1,
	substring: 2,
	wordPrefix: 3,
	prefix: 4,
	exact: 5,
} as const;
export type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

/** What a command does when it runs, for the Enter guard. */
export type CommandGuard = "turn" | "destructive";

export interface SearchableCommand {
	name: string;
	label: string;
	description?: string;
	aliases?: string[];
}

export interface CommandMatch {
	/** Best tier over the command's own words (label, name, aliases). */
	tier: MatchTier;
	/** Best tier over the description only. */
	descriptionTier: MatchTier;
	/** Fuzzy density score of the best primary hit (higher = tighter). */
	score: number;
}

// ── Hangul ─────────────────────────────────────────────────────────────

const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
/** Compatibility jamo, so composed text and a lone typed jamo compare equal. */
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** Compound medials and finals split into their typing order (ㅘ = ㅗ+ㅏ, ㄺ = ㄹ+ㄱ). */
const MEDIALS = [
	"ㅏ",
	"ㅐ",
	"ㅑ",
	"ㅒ",
	"ㅓ",
	"ㅔ",
	"ㅕ",
	"ㅖ",
	"ㅗ",
	"ㅗㅏ",
	"ㅗㅐ",
	"ㅗㅣ",
	"ㅛ",
	"ㅜ",
	"ㅜㅓ",
	"ㅜㅔ",
	"ㅜㅣ",
	"ㅠ",
	"ㅡ",
	"ㅡㅣ",
	"ㅣ",
];
const FINALS = [
	"",
	"ㄱ",
	"ㄲ",
	"ㄱㅅ",
	"ㄴ",
	"ㄴㅈ",
	"ㄴㅎ",
	"ㄷ",
	"ㄹ",
	"ㄹㄱ",
	"ㄹㅁ",
	"ㄹㅂ",
	"ㄹㅅ",
	"ㄹㅌ",
	"ㄹㅍ",
	"ㄹㅎ",
	"ㅁ",
	"ㅂ",
	"ㅂㅅ",
	"ㅅ",
	"ㅆ",
	"ㅇ",
	"ㅈ",
	"ㅊ",
	"ㅋ",
	"ㅌ",
	"ㅍ",
	"ㅎ",
];
/** Lone compatibility jamo a user can type, split the same way as above. */
const COMPAT_SPLIT: Record<string, string> = {
	ㄳ: "ㄱㅅ",
	ㄵ: "ㄴㅈ",
	ㄶ: "ㄴㅎ",
	ㄺ: "ㄹㄱ",
	ㄻ: "ㄹㅁ",
	ㄼ: "ㄹㅂ",
	ㄽ: "ㄹㅅ",
	ㄾ: "ㄹㅌ",
	ㄿ: "ㄹㅍ",
	ㅀ: "ㄹㅎ",
	ㅄ: "ㅂㅅ",
	ㅘ: "ㅗㅏ",
	ㅙ: "ㅗㅐ",
	ㅚ: "ㅗㅣ",
	ㅝ: "ㅜㅓ",
	ㅞ: "ㅜㅔ",
	ㅟ: "ㅜㅣ",
	ㅢ: "ㅡㅣ",
};

/** Lowercase + NFC, Hangul syllables spelled out as compatibility jamo. */
export function decomposeHangul(text: string): string {
	let out = "";
	for (const ch of text.normalize("NFC").toLowerCase()) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= SYLLABLE_BASE && code <= SYLLABLE_LAST) {
			const index = code - SYLLABLE_BASE;
			out += INITIALS[Math.floor(index / 588)] + MEDIALS[Math.floor((index % 588) / 28)] + FINALS[index % 28];
		} else {
			out += COMPAT_SPLIT[ch] ?? ch;
		}
	}
	return out;
}

/** Syllables reduced to their initial consonant; everything else lowercased. */
export function hangulInitials(text: string): string {
	let out = "";
	for (const ch of text.normalize("NFC").toLowerCase()) {
		const code = ch.codePointAt(0) ?? 0;
		out += code >= SYLLABLE_BASE && code <= SYLLABLE_LAST ? INITIALS[Math.floor((code - SYLLABLE_BASE) / 588)] : ch;
	}
	return out;
}

const INITIALS_ONLY = new RegExp(`^[${INITIALS}\\s]+$`);

// ── Tiers ──────────────────────────────────────────────────────────────

const SEPARATOR = /[\s/\-_.:,()[\]·›]/;

/** Exact / prefix / word-prefix / substring of `query` within `target` (both pre-normalized). */
function literalTier(query: string, target: string): MatchTier {
	if (target === query) return MatchTier.exact;
	if (target.startsWith(query)) return MatchTier.prefix;
	let index = target.indexOf(query);
	if (index === -1) return MatchTier.none;
	while (index !== -1) {
		if (index === 0 || SEPARATOR.test(target[index - 1] ?? "")) return MatchTier.wordPrefix;
		index = target.indexOf(query, index + 1);
	}
	return MatchTier.substring;
}

/** Normalize a typed query: trimmed, without a leading slash, collapsed spaces. */
export function normalizeQuery(query: string): string {
	return query.trim().replace(/^\/+/, "").replace(/\s+/g, " ");
}

/** Best tier of a normalized query against one target string. */
export function matchTier(query: string, target: string): { tier: MatchTier; score: number } {
	if (!query || !target) return { tier: MatchTier.none, score: 0 };
	const cleanTarget = target.trim().replace(/^\/+/, "");
	const lowerQuery = query.toLowerCase();
	const lowerTarget = cleanTarget.toLowerCase();
	let tier = literalTier(lowerQuery, lowerTarget);
	// Jamo spelling: catches a syllable still being composed ("틀" → "트리").
	if (tier < MatchTier.wordPrefix) {
		const jamoTier = literalTier(decomposeHangul(query), decomposeHangul(cleanTarget));
		// A jamo-only hit can't be exact: the user hasn't finished the syllable.
		tier = Math.max(tier, Math.min(jamoTier, MatchTier.prefix)) as MatchTier;
	}
	// Initial consonants only ("ㅌㄹ" → "트리").
	if (tier < MatchTier.wordPrefix && INITIALS_ONLY.test(query)) {
		const initialsTier = literalTier(query.replace(/\s+/g, ""), hangulInitials(cleanTarget).replace(/\s+/g, ""));
		const wordInitialsTier = literalTier(query, hangulInitials(cleanTarget));
		tier = Math.max(tier, Math.min(Math.max(initialsTier, wordInitialsTier), MatchTier.prefix)) as MatchTier;
	}
	const fuzzy = fuzzyScore(lowerQuery, lowerTarget);
	if (tier === MatchTier.none && fuzzy !== null) tier = MatchTier.fuzzy;
	return { tier, score: fuzzy ?? 0 };
}

/** Match a command against a query; null when nothing matches. */
export function matchCommand(rawQuery: string, command: SearchableCommand): CommandMatch | null {
	const query = normalizeQuery(rawQuery);
	if (!query) return { tier: MatchTier.none, descriptionTier: MatchTier.none, score: 0 };
	let tier: MatchTier = MatchTier.none;
	let score = 0;
	for (const target of [command.label, command.name, ...(command.aliases ?? [])]) {
		const hit = matchTier(query, target);
		if (hit.tier > tier || (hit.tier === tier && hit.score > score)) {
			tier = hit.tier;
			score = hit.score;
		}
	}
	// Descriptions are prose: subsequence hits there are noise, so literal only.
	const descriptionHit = command.description ? matchTier(query, command.description) : null;
	const descriptionTier =
		descriptionHit && descriptionHit.tier >= MatchTier.substring ? descriptionHit.tier : MatchTier.none;
	if (tier === MatchTier.none && descriptionTier === MatchTier.none) return null;
	return { tier, descriptionTier, score };
}

export interface RankedCommand<T> {
	item: T;
	match: CommandMatch;
}

/**
 * Filter and rank commands for a query. Order: primary tier, description
 * tier, recency (`recent` is most-recent-first), fuzzy density, then the
 * registry order. An empty query keeps the registry order.
 */
export function rankCommands<T extends SearchableCommand>(
	items: readonly T[],
	query: string,
	recent: readonly string[] = [],
): RankedCommand<T>[] {
	const recency = new Map(recent.map((name, index) => [name, index]));
	const ranked: (RankedCommand<T> & { index: number })[] = [];
	items.forEach((item, index) => {
		const match = matchCommand(query, item);
		if (match) ranked.push({ item, match, index });
	});
	if (!normalizeQuery(query)) return ranked;
	return ranked
		.sort(
			(a, b) =>
				b.match.tier - a.match.tier ||
				b.match.descriptionTier - a.match.descriptionTier ||
				(recency.get(a.item.name) ?? Number.POSITIVE_INFINITY) -
					(recency.get(b.item.name) ?? Number.POSITIVE_INFINITY) ||
				b.match.score - a.match.score ||
				a.index - b.index,
		)
		.map(({ item, match }) => ({ item, match }));
}

// ── Enter guard ────────────────────────────────────────────────────────

/**
 * Whether Enter may run a guarded command right away. Unguarded commands
 * always may. A guarded one needs the query to name it exactly (label, name
 * or alias) or a selection the user made explicitly (arrow keys); anything
 * else — the auto-selected top hit of a partial query — must be confirmed.
 */
export function enterNeedsConfirm(
	guard: CommandGuard | undefined,
	match: CommandMatch | null,
	explicitSelection: boolean,
): boolean {
	if (!guard || explicitSelection) return false;
	return match?.tier !== MatchTier.exact;
}
