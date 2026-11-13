/**
 * Whether the answer to a todo reminder says nothing the answer before it did not. Stock's reminder wakes a session
 * that stopped with open items; one that only waits writes "still waiting" again, and the person read the same answer
 * twice. The rule is text only (no model call): the two answers' character trigrams overlap by at least
 * `SAME_ANSWER`, a Dice coefficient. Letters and digits alone count, so punctuation, markdown and casing never make a
 * rewrite look new; trigrams over characters, not words, so Korean (no spaces inside a phrase) reads the same way.
 */

import { WORD_CHAR } from "../../../../resources/gui-bridge/word-char";

export const SAME_ANSWER = 0.6;

function lettersOf(text: string): string {
	return [...text.toLowerCase().normalize("NFKC")].filter(char => WORD_CHAR.test(char)).join("");
}

function trigrams(letters: string): Map<string, number> {
	const grams = new Map<string, number>();
	for (let index = 0; index + 3 <= letters.length; index++) {
		const gram = letters.slice(index, index + 3);
		grams.set(gram, (grams.get(gram) ?? 0) + 1);
	}
	return grams;
}

/** Dice coefficient of two texts' trigram multisets: 1 for the same letters, 0 for nothing in common. */
export function answerOverlap(a: string, b: string): number {
	const first = lettersOf(a);
	const second = lettersOf(b);
	if (first.length === 0 || second.length === 0) return 0;
	if (first === second) return 1;
	const left = trigrams(first);
	const right = trigrams(second);
	const total = Math.max(first.length - 2, 0) + Math.max(second.length - 2, 0);
	if (total === 0) return 0;
	let shared = 0;
	for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
	return (2 * shared) / total;
}

/** True when `answer` repeats any of the `earlier` answers. */
export function repeatsAnswer(answer: string, earlier: readonly string[]): boolean {
	return earlier.some(text => answerOverlap(answer, text) >= SAME_ANSWER);
}
