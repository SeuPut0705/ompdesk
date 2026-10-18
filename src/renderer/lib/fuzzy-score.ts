/** Subsequence fuzzy score; null = no match. Earlier + denser wins. */
export function fuzzyScore(query: string, target: string): number | null {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	if (q.length === 0) return 0;
	let qi = 0;
	let score = 0;
	let last = -2;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += ti === last + 1 ? 2 : 1;
			last = ti;
			qi++;
		}
	}
	return qi === q.length ? score : null;
}

/** A path match: its score (higher is better) and the matched `[start, end)` UTF-16 spans of the path. */
export interface PathMatch {
	score: number;
	ranges: [number, number][];
}

// Positional scoring in the manner of fzy: a run of consecutive hits and hits that start a segment, word,
// extension or CamelCase hump earn bonuses; gaps cost a little, so the tighter alignment wins.
const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const CONSECUTIVE = 1;
const BONUS_SLASH = 0.9;
const BONUS_WORD = 0.8;
const BONUS_CAMEL = 0.7;
const BONUS_DOT = 0.6;
/** The whole query lands inside the file name (not its folders). */
const BASENAME_BONUS = 3;
const BASENAME_STARTS_BONUS = 10;
const STEM_EXACT_BONUS = 40;
const BASENAME_EXACT_BONUS = 50;
/** A path-shaped query (`src/ren`) that opens the path. */
const PATH_PREFIX_BONUS = 20;
/** Equal scores: the shorter path wins. */
const LENGTH_PENALTY = 0.003;
const NO_SCORE = Number.NEGATIVE_INFINITY;

const HANGUL_SYLLABLE_FIRST = 0xac00;
const HANGUL_SYLLABLE_LAST = 0xd7a3;
/** Compatibility jamo of the 19 initial consonants, in syllable order. */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** Index of an initial consonant (ㄱ…ㅎ, or conjoining U+1100–1112) in syllable order, else -1. */
function choseongIndex(code: number): number {
	if (code >= 0x1100 && code <= 0x1112) return code - 0x1100;
	if (code >= 0x3131 && code <= 0x314e) return CHOSEONG.indexOf(String.fromCharCode(code));
	return -1;
}

/**
 * How one query character may match a target character: itself (case-folded); a lone initial consonant
 * (`ㅎ`) matches any syllable that starts with it (`한`); and the LAST query character, if it is a syllable
 * without a final consonant (`하`, the IME is still composing `한`), matches every syllable that shares its
 * initial and vowel.
 */
interface QueryChar {
	code: number;
	lead: number;
	/** `lead * 21 + vowel` of an open syllable still being composed, else -1. */
	open: number;
}

function queryChars(lower: string): QueryChar[] {
	const chars: QueryChar[] = [];
	for (let index = 0; index < lower.length; index++) {
		const code = lower.charCodeAt(index);
		const syllable =
			code >= HANGUL_SYLLABLE_FIRST && code <= HANGUL_SYLLABLE_LAST ? code - HANGUL_SYLLABLE_FIRST : -1;
		chars.push({
			code,
			lead: choseongIndex(code),
			open: index === lower.length - 1 && syllable >= 0 && syllable % 28 === 0 ? syllable / 28 : -1,
		});
	}
	return chars;
}

function charMatches(query: QueryChar, targetCode: number): boolean {
	if (query.code === targetCode) return true;
	if (targetCode < HANGUL_SYLLABLE_FIRST || targetCode > HANGUL_SYLLABLE_LAST) return false;
	const syllable = targetCode - HANGUL_SYLLABLE_FIRST;
	if (query.lead >= 0) return Math.floor(syllable / 588) === query.lead;
	return query.open >= 0 && Math.floor(syllable / 28) === query.open;
}

/** A lower-case letter followed by an upper-case one: the start of a CamelCase hump. */
function isCamelHump(previous: number, code: number): boolean {
	if (previous < 128 && code < 128) return previous >= 97 && previous <= 122 && code >= 65 && code <= 90;
	const before = String.fromCharCode(previous);
	const after = String.fromCharCode(code);
	return before !== before.toUpperCase() && after !== after.toLowerCase();
}

/** What the character before each position says about how good a match there is. */
function positionBonuses(text: string, from: number, out: Float64Array): void {
	let previous = 47; // the start of the string counts as after a "/"
	for (let index = from; index < text.length; index++) {
		const code = text.charCodeAt(index);
		let bonus = 0;
		if (previous === 47) bonus = BONUS_SLASH;
		else if (previous === 45 || previous === 95 || previous === 32) bonus = BONUS_WORD;
		else if (previous === 46) bonus = BONUS_DOT;
		else if (isCamelHump(previous, code)) bonus = BONUS_CAMEL;
		out[index - from] = bonus;
		previous = code;
	}
}

let scratchD = new Float64Array(0);
let scratchM = new Float64Array(0);
let scratchBonus = new Float64Array(0);

/** The best alignment of the query inside `text[from..]`, as its score and (on request) matched positions. */
function align(
	query: QueryChar[],
	lower: string,
	text: string,
	from: number,
	wantPositions: boolean,
): { score: number; positions: number[] } | null {
	const m = query.length;
	const n = text.length - from;
	if (n < m) return null;
	// Cheap reject before the quadratic fill: the query must be a subsequence.
	let probe = 0;
	for (let j = from; j < text.length && probe < m; j++) {
		if (charMatches(query[probe] as QueryChar, lower.charCodeAt(j))) probe++;
	}
	if (probe < m) return null;
	if (scratchD.length < m * n) {
		scratchD = new Float64Array(m * n);
		scratchM = new Float64Array(m * n);
	}
	if (scratchBonus.length < n) scratchBonus = new Float64Array(n);
	positionBonuses(text, from, scratchBonus);
	const D = scratchD;
	const M = scratchM;
	for (let i = 0; i < m; i++) {
		const q = query[i] as QueryChar;
		const gap = i === m - 1 ? GAP_TRAILING : GAP_INNER;
		let previous = NO_SCORE;
		for (let j = 0; j < n; j++) {
			const at = i * n + j;
			let score = NO_SCORE;
			if (charMatches(q, lower.charCodeAt(from + j))) {
				if (i === 0) score = j * GAP_LEADING + (scratchBonus[j] as number);
				else if (j > 0) {
					const diagonal = (i - 1) * n + j - 1;
					score = Math.max(
						(M[diagonal] as number) + (scratchBonus[j] as number),
						(D[diagonal] as number) + CONSECUTIVE,
					);
				}
			}
			D[at] = score;
			previous = Math.max(score, previous + gap);
			M[at] = previous;
		}
	}
	const best = M[m * n - 1] as number;
	if (best === NO_SCORE) return null;
	const positions: number[] = [];
	if (wantPositions) {
		positions.length = m;
		let required = false;
		let j = n - 1;
		for (let i = m - 1; i >= 0; i--) {
			for (; j >= 0; j--) {
				const at = i * n + j;
				const d = D[at] as number;
				if (d !== NO_SCORE && (required || d === M[at])) {
					required = i > 0 && j > 0 && M[at] === (D[(i - 1) * n + j - 1] as number) + CONSECUTIVE;
					positions[i] = from + j;
					j--;
					break;
				}
			}
		}
	}
	return { score: best, positions };
}

function toRanges(positions: number[]): [number, number][] {
	const ranges: [number, number][] = [];
	for (const position of positions) {
		const last = ranges[ranges.length - 1];
		if (last && last[1] === position) last[1] = position + 1;
		else ranges.push([position, position + 1]);
	}
	return ranges;
}

/** A target's lower-case twin of the same length (a few letters fold to a longer string: then compare as is). */
function foldCase(text: string): string {
	const lower = text.toLowerCase();
	return lower.length === text.length ? lower : text;
}

/**
 * How well a typed query names a workspace path, for the `@` menu; null = no match. The query matches as a
 * subsequence of the path (or of its file name, which earns a bonus), scoring runs of consecutive characters
 * and hits that start a folder, word, extension or CamelCase hump; the file name equal to the query (or its
 * stem before the first dot) and one that starts with it rank first, a path that opens with a path-shaped
 * query next, and among equals the shorter path wins. Hangul: a lone initial consonant (`ㅎㄱ`) matches
 * every syllable that starts with it (`한글`), and a trailing syllable still being composed (`하`) matches
 * `한`. `query` and every path must be NFC-normalised by the caller; `ranges` index the path. The query is
 * read once; the matcher scores many paths (`wantRanges` false skips the span trace for the bulk pass).
 */
export function pathMatcher(query: string): (path: string, wantRanges?: boolean) => PathMatch | null {
	if (query.length === 0) return () => ({ score: 0, ranges: [] });
	const lowerQuery = foldCase(query);
	const chars = queryChars(lowerQuery);
	const pathShaped = lowerQuery.includes("/");
	return (path, wantRanges = true) => {
		const lowerPath = foldCase(path);
		const full = align(chars, lowerPath, path, 0, wantRanges);
		if (!full) return null;
		let score = full.score;
		let positions = full.positions;
		const baseStart = path.lastIndexOf("/") + 1;
		if (baseStart === 0 && !pathShaped) {
			score += BASENAME_BONUS; // a top-level file is all file name
		} else if (!pathShaped) {
			const base = align(chars, lowerPath, path, baseStart, wantRanges);
			if (base && base.score + BASENAME_BONUS > score) {
				score = base.score + BASENAME_BONUS;
				positions = base.positions;
			}
		}
		if (pathShaped) {
			if (lowerPath.startsWith(lowerQuery)) score += PATH_PREFIX_BONUS;
		} else {
			const base = lowerPath.slice(baseStart);
			const dot = base.indexOf(".", 1);
			if (base === lowerQuery) score += BASENAME_EXACT_BONUS;
			else if (dot > 0 && base.slice(0, dot) === lowerQuery) score += STEM_EXACT_BONUS;
			else if (base.startsWith(lowerQuery)) score += BASENAME_STARTS_BONUS;
		}
		score -= path.length * LENGTH_PENALTY;
		return { score, ranges: wantRanges ? toRanges(positions) : [] };
	};
}
