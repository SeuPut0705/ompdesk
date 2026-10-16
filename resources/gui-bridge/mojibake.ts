/**
 * Text a model wrote as UTF-8 bytes read back as Windows-1252 (or Latin-1): "지금" comes out as "ì§€ê¸ˆ". Seen on
 * the prompt suggestions on 17 Oct 2026 (claude-sonnet-5-5 as the smol role): one request answered 220 output
 * tokens in 5.6 s where its neighbours took ~65 in ~2.5 s, and every candidate was garbled. Nothing on OMPdesk's side
 * decodes that text (the bridge socket, stdout and IPC are UTF-8 end to end, and the session's next requests came
 * back clean through the same path): the model wrote those characters. So the bridge refuses such text where it
 * shows a model's answer in the GUI (suggestions, inline ghost text, automatic titles, the idle recap) rather than
 * repairing it: a model rarely spells every byte (Windows-1252 has no character for 0x81, 0x8D, 0x8F, 0x90 and 0x9D,
 * and a no-break space 0xA0 becomes a plain space once whitespace is folded).
 *
 * Dependency-free: the cores that call it run in main's vitest and the packaged bridge alike.
 */

/** Windows-1252's characters for 0x80–0x9F; every other byte from 0x80 up is the Latin-1 character of that code. */
const CP1252_BYTE: Record<string, number> = {
	"€": 0x80,
	"‚": 0x82,
	ƒ: 0x83,
	"„": 0x84,
	"…": 0x85,
	"†": 0x86,
	"‡": 0x87,
	ˆ: 0x88,
	"‰": 0x89,
	Š: 0x8a,
	"‹": 0x8b,
	Œ: 0x8c,
	Ž: 0x8e,
	"‘": 0x91,
	"’": 0x92,
	"“": 0x93,
	"”": 0x94,
	"•": 0x95,
	"–": 0x96,
	"—": 0x97,
	"˜": 0x98,
	"™": 0x99,
	š: 0x9a,
	"›": 0x9b,
	œ: 0x9c,
	ž: 0x9e,
	Ÿ: 0x9f,
};

/** The byte a Windows-1252 (or Latin-1) reading turned into `text[index]`; undefined for ASCII and the rest. */
function byteOf(text: string, index: number): number | undefined {
	const unit = text.charCodeAt(index);
	return unit >= 0x80 && unit <= 0xff ? unit : CP1252_BYTE[text.charAt(index)];
}

/**
 * Whether `text` reads as UTF-8 mojibake: at least two whole UTF-8 sequences spelled in Windows-1252 characters,
 * each one a character nobody writes that way: three or four bytes (Hangul, CJK, kana, emoji, most symbols: "ì§€"),
 * or two bytes led by Â or Ã (Latin-1 letters: "Ã©" for "é"). Real text in a Latin script does not form them: an
 * accented letter is followed by letters, "é…" stops short of a sequence, and a pair such as "ß“" (German quotes)
 * has another lead byte.
 */
export function isUtf8Mojibake(text: string): boolean {
	let found = 0;
	for (let index = 0; index < text.length; index++) {
		const lead = byteOf(text, index);
		if (lead === undefined) continue;
		const tail =
			lead >= 0xc2 && lead <= 0xc3 ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
		if (tail === 0 || index + tail >= text.length) continue;
		// The lead byte's payload bits: 5 for a two-byte sequence, 4 for three, 3 for four.
		let point = lead & (0xff >> (tail + 2));
		let whole = true;
		for (let offset = 1; offset <= tail; offset++) {
			const next = byteOf(text, index + offset);
			if (next === undefined || next > 0xbf) {
				whole = false;
				break;
			}
			point = (point << 6) | (next & 0x3f);
		}
		// Overlong forms, surrogates and code points past U+10FFFF are no UTF-8 at all.
		if (!whole || (tail === 2 && (point < 0x800 || (point >= 0xd800 && point <= 0xdfff)))) continue;
		if (tail === 3 && (point < 0x10000 || point > 0x10ffff)) continue;
		found++;
		if (found === 2) return true;
		index += tail;
	}
	return false;
}
