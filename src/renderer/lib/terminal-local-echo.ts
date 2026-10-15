/**
 * Predictive local echo for a paired host's terminal (C109): every keystroke
 * otherwise waits a network round trip plus a poll before it appears.
 *
 * Each printable keystroke (and a backspace over one) is queued with the echo
 * bytes it expects. Predictions are painted only after the shell has echoed
 * `streak` keystrokes exactly as typed, and the painted region is erased the
 * moment the host's output disagrees (or nothing arrives within 2 s). Shells
 * that repaint their line per key, full-screen programs and password prompts
 * never pass that check, so nothing is painted there. The approach follows
 * mosh's and mixdog's `terminal-local-echo.ts` typeahead; this is OMPdesk's own
 * implementation around xterm's write path.
 */

interface Prediction {
	kind: "char" | "erase";
	/** The typed character, or the character a backspace erases. */
	text: string;
	width: 1 | 2;
	/** Painted locally already: its echo is swallowed instead of written twice. */
	painted: boolean;
	at: number;
}

export interface LocalEchoHooks {
	/** Writes into the terminal in order with the host's output. */
	write(data: string): void;
	/** Cursor column when a first prediction may paint (normal buffer, cursor at line end), else null. */
	anchor(): number | null;
	cols(): number;
	now?(): number;
	/** Clean echoes needed before painting; default 2. */
	streak?: number;
}

const PREDICTION_TIMEOUT_MS = 2_000;
/** An unterminated escape this long is not a title or colour; stop holding it back. */
const MAX_HELD = 4_096;

/** East Asian wide and emoji code points take two cells. */
export function cellWidth(char: string): 1 | 2 {
	const cp = char.codePointAt(0) ?? 0;
	if (cp < 0x1100) return 1;
	return cp <= 0x115f ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
		? 2
		: 1;
}

/** The erase echoes shells send for one character at the end of the line, longest first. */
function eraseEchoes(width: 1 | 2): string[] {
	return width === 2 ? ["\b\b  \b\b", "\b\b\x1b[K"] : ["\b \b", "\b\x1b[K"];
}

/**
 * Length of a leading sequence that leaves the cursor where it is (BEL, SGR,
 * private mode set/reset, OSC, keypad mode), `"partial"` while it is still
 * arriving, null for anything else.
 */
function cursorNeutral(input: string): number | "partial" | null {
	if (input[0] === "\x07") return 1;
	if (input[0] !== "\x1b") return null;
	if (input.length === 1) return "partial";
	const kind = input[1];
	if (kind === "=" || kind === ">") return 2;
	if (kind === "]") {
		const bel = input.indexOf("\x07", 2);
		const st = input.indexOf("\x1b\\", 2);
		if (bel === -1 && st === -1) return "partial";
		return bel !== -1 && (st === -1 || bel < st) ? bel + 1 : st + 2;
	}
	if (kind !== "[") return null;
	for (let i = 2; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) {
			const final = input[i];
			if (final === "m") return i + 1;
			if ((final === "h" || final === "l") && input[2] === "?") return i + 1;
			return null;
		}
		if (code < 0x20 || code > 0x3f) return null;
	}
	return "partial";
}

export class TerminalLocalEcho {
	readonly #hooks: LocalEchoHooks;
	#queue: Prediction[] = [];
	/** Host output held back while it may still turn into an expected echo. */
	#held = "";
	#streak = 0;
	/** Column where the painted, unconfirmed region starts; -1 = none. */
	#startCol = -1;
	#timer: NodeJS.Timeout | undefined;

	constructor(hooks: LocalEchoHooks) {
		this.#hooks = hooks;
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#queue = [];
		this.#held = "";
	}

	/** A keystroke on its way to the host. */
	input(data: string): void {
		this.#expire();
		if (data === "\x7f") {
			this.#backspace();
			return;
		}
		const points = [...data];
		const cp = points.length === 1 ? (points[0]?.codePointAt(0) ?? 0) : -1;
		if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return;
		const width = cellWidth(data);
		let painted = false;
		if (this.#streak >= (this.#hooks.streak ?? 2) && this.#queue.every(item => item.painted)) {
			const col = this.#queue.length > 0 ? this.#startCol + this.#netWidth() : this.#hooks.anchor();
			if (col !== null && col >= 0 && col + width <= this.#hooks.cols() - 2) {
				if (this.#queue.length === 0) this.#startCol = col;
				this.#hooks.write(data);
				painted = true;
			}
		}
		this.#queue.push({ kind: "char", text: data, width, painted, at: this.#now() });
		this.#arm();
	}

	/** Host output; returns what should reach the terminal (a rollback first, painted echoes removed). */
	output(data: string): string {
		this.#expire();
		if (!data || (this.#queue.length === 0 && !this.#held)) return data;
		let input = this.#held + data;
		this.#held = "";
		let out = "";
		while (this.#queue.length > 0 && input) {
			const head = this.#queue[0] as Prediction;
			const echoes = head.kind === "char" ? [head.text] : eraseEchoes(head.width);
			const matched = echoes.find(echo => input.startsWith(echo));
			if (matched) {
				this.#queue.shift();
				if (!head.painted) out += matched;
				else if (head.kind === "char") this.#startCol += head.width;
				input = input.slice(matched.length);
				this.#streak = Math.min(this.#streak + 1, 99);
				if (this.#queue.length === 0) this.#startCol = -1;
				continue;
			}
			const neutral = echoes.some(echo => echo.startsWith(input)) ? "partial" : cursorNeutral(input);
			if (neutral === "partial") {
				if (input.length > MAX_HELD) return this.#mismatch() + out + input;
				this.#held = input;
				return out;
			}
			if (neutral === null) return this.#mismatch() + out + input;
			out += input.slice(0, neutral);
			input = input.slice(neutral);
		}
		return out + input;
	}

	#backspace(): void {
		// Only a still-unconfirmed predicted character can be erased predictably.
		const chars: Prediction[] = [];
		for (const item of this.#queue) {
			if (item.kind === "char") chars.push(item);
			else chars.pop();
		}
		const target = chars.at(-1);
		if (!target) return;
		if (target.painted) this.#hooks.write(target.width === 2 ? "\b\b  \b\b" : "\b \b");
		this.#queue.push({
			kind: "erase",
			text: target.text,
			width: target.width,
			painted: target.painted,
			at: this.#now(),
		});
		this.#arm();
	}

	/** Forget every prediction; returns the sequence that erases the painted ones. */
	#mismatch(): string {
		const rollback =
			this.#startCol >= 0 && this.#queue.some(item => item.painted) ? `\x1b[${this.#startCol + 1}G\x1b[K` : "";
		this.#queue = [];
		this.#held = "";
		this.#streak = 0;
		this.#startCol = -1;
		return rollback;
	}

	#netWidth(): number {
		return this.#queue.reduce((sum, item) => sum + (item.kind === "char" ? item.width : -item.width), 0);
	}

	#expire(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const oldest = this.#queue[0];
		if (oldest && this.#now() - oldest.at > PREDICTION_TIMEOUT_MS) {
			const rollback = this.#mismatch();
			if (rollback) this.#hooks.write(rollback);
			return;
		}
		this.#arm();
	}

	#arm(): void {
		const oldest = this.#queue[0];
		if (this.#timer || !oldest) return;
		const delay = Math.max(50, PREDICTION_TIMEOUT_MS - (this.#now() - oldest.at) + 50);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#expire();
		}, delay);
	}

	#now(): number {
		return this.#hooks.now?.() ?? Date.now();
	}
}
