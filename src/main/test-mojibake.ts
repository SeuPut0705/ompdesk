/**
 * `value`'s UTF-8 bytes read back as Windows-1252: what a model writes when it spells UTF-8 in cp1252 ("지금" →
 * "ì§€ê¸ˆ"). Built from the code page itself, not `TextDecoder("windows-1252")`: Node 24 decodes that label as
 * Latin-1 (0x80–0x9F become C1 controls instead of "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"), which garbled the tests'
 * text differently from the reported answers and failed three suites under vitest while Bun passed.
 */
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";

export function garbled(value: string): string {
	let text = "";
	for (const byte of new TextEncoder().encode(value)) {
		text += byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH.charAt(byte - 0x80) : String.fromCharCode(byte);
	}
	return text;
}
