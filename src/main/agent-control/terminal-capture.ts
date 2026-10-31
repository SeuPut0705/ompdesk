/**
 * The lines a person types in Terminal panel sessions, safe to hand a model: what teaching the bot records
 * (`bot-teach.ts`) and what a hand-back after taking over a session tells that session (`bot-takeover.ts`). One
 * capture, two users; nothing here is kept on disk.
 *
 * Never a secret. Every kept line goes through `redactSecretText` (tokens, keys, `Bearer`, URL passwords, `KEY=value`
 * pairs naming a secret; emails and paths stay), and a typed line is dropped, leaving `[hidden: …]` in its place,
 * when it was typed where the terminal hides the typing, which a password is: (a) the last line the terminal printed
 * before the first keystroke asked for one (`SECRET_PROMPT`: `Password:`, `[sudo] password for x:`, `Enter passphrase
 * for key …:`, a PIN, a token, a verification code), or (b) the terminal never echoed it. For (b) the capture watches
 * the terminal's output (`output`, fed by the Terminal IPC) and keeps a line only once its first characters turned up
 * in the output printed since its first keystroke. A line whose echo has not turned up stays hidden, and shows once it
 * does; the terminal's next line break closes the wait.
 * Known limits: typed lines are reassembled from keystrokes (history recall and tab completion are not seen); a secret
 * in a command that is echoed is found by pattern only; a very short secret typed where something else on the screen
 * holds the same characters is kept.
 */
import { redactSecretText } from "../../../resources/gui-bridge/redactor";

export const CAPTURE_HIDDEN_AT_PROMPT = "[hidden: typed at a password prompt]";
export const CAPTURE_HIDDEN_NO_ECHO = "[hidden: typed where the terminal showed nothing, as at a password prompt]";

/** The visible output kept per terminal to see what its last line asked (a prompt that hides the typing). */
const TAIL_CHARS = 2_048;
/** What a line being typed keeps of the output since its first keystroke, to look for its echo in. */
const SEEN_CHARS = 4_096;
/** A typed line is told apart from nothing by its first this-many characters turning up in the output. */
const PROBE_CHARS = 6;
/** An escape sequence cut by a chunk boundary is carried to the next chunk; a longer one is no sequence. */
const ESCAPE_CARRY_CHARS = 256;

/** The last line of the output asks for a secret: `Password:`, `[sudo] password for x:`, `Enter passphrase for key '…':`, `PIN?`, `Verification code:`. */
const SECRET_PROMPT =
	/\b(?:pass(?:word|phrase|code)?|passwd|pin|token|secret|api[ _-]?key|one[- ]?time|otp|(?:verification|security|authenticat\w*|sms|mfa|totp)\s+code|2fa|credentials?)\b[^\n]*[:?>]\s*$/i;

export function cut(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}… (cut at ${max} characters)`;
}

/**
 * Applies raw terminal input to the line being typed: printable text is added, Backspace (`\x7f`, `\b`), Ctrl-U and
 * Ctrl-W edit it, Ctrl-C drops it, an escape sequence (arrow, function key, mode report) and any other control
 * character are dropped, a bracketed paste keeps its text. Returns the line now being typed and the lines Enter ended
 * (`\r`, `\n`) with something on them.
 */
export function typedLines(pending: string, data: string): { pending: string; lines: string[] } {
	const lines: string[] = [];
	let line = [...pending];
	const chars = [...data];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === "\x1b") {
			const next = chars[i + 1];
			if (next === "[") {
				// CSI: parameter and intermediate bytes, then one final byte.
				let end = i + 2;
				while (end < chars.length && /[\x20-\x3f]/.test(chars[end])) end++;
				i = end;
			} else if (next === "]") {
				// OSC: up to BEL or ESC \.
				let end = i + 2;
				while (end < chars.length && chars[end] !== "\x07" && !(chars[end] === "\x1b" && chars[end + 1] === "\\"))
					end++;
				i = chars[end] === "\x1b" ? end + 1 : end;
			} else if (next === "O") i += 2;
			else i += 1;
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			const text = line.join("").trim();
			if (text) lines.push(text);
			line = [];
		} else if (ch === "\x7f" || ch === "\b") line.pop();
		else if (ch === "\x15" || ch === "\x03") line = [];
		else if (ch === "\x17") {
			while (line.length > 0 && line[line.length - 1] === " ") line.pop();
			while (line.length > 0 && line[line.length - 1] !== " ") line.pop();
		} else if (ch >= " ") line.push(ch);
	}
	return { pending: line.join(""), lines };
}

/**
 * What a terminal shows of raw PTY output: CSI and OSC sequences, other escapes and control characters (carriage
 * return, bell) are dropped; newlines stay, and so do backspaces, which `printed` applies. `carry` is an escape
 * sequence the chunk ended in the middle of, to be put in front of the next chunk.
 */
export function visibleOutput(carry: string, chunk: string): { text: string; carry: string } {
	const data = carry + chunk;
	let text = "";
	let i = 0;
	const cutOff = (from: number) => ({
		text,
		carry: data.length - from <= ESCAPE_CARRY_CHARS ? data.slice(from) : "",
	});
	while (i < data.length) {
		const ch = data[i] as string;
		if (ch !== "\x1b") {
			if (ch === "\n" || ch === "\b" || (ch >= " " && ch !== "\x7f" && (ch < "\x80" || ch > "\x9f"))) text += ch;
			i++;
			continue;
		}
		const next = data[i + 1];
		if (next === undefined) return cutOff(i);
		if (next === "[") {
			let end = i + 2;
			while (end < data.length && /[\x20-\x3f]/.test(data[end] as string)) end++;
			if (end >= data.length) return cutOff(i);
			i = end + 1;
		} else if (next === "]") {
			let end = i + 2;
			while (end < data.length && data[end] !== "\x07" && !(data[end] === "\x1b" && data[end + 1] === "\\")) {
				if (data[end] === "\x1b" && end + 1 >= data.length) return cutOff(i);
				end++;
			}
			if (end >= data.length) return cutOff(i);
			i = data[end] === "\x07" ? end + 1 : end + 2;
		} else if ("()*+#%O".includes(next)) {
			if (i + 2 >= data.length) return cutOff(i);
			i += 3;
		} else i += 2;
	}
	return { text, carry: "" };
}

/** `text` printed after `buffer`: a backspace takes back the character before it on the same line (`\b \b` erases one). */
function printed(buffer: string, text: string): string {
	if (!text.includes("\b")) return buffer + text;
	let out = buffer;
	for (const ch of text) {
		if (ch !== "\b") out += ch;
		else if (out !== "" && !out.endsWith("\n")) out = out.slice(0, -1);
	}
	return out;
}

/** Where a captured line goes: the user's own record entry, whose `text` the capture fills (and may fill again). */
export interface CaptureSlot {
	text: string;
}

/** What one line being typed knows: what the terminal's last line asked at its first keystroke, and what came after. */
interface Typing {
	atSecretPrompt: boolean;
	/** The visible output since the first keystroke, from its start (the echo comes first), at most `SEEN_CHARS`. */
	seen: string;
}

/** A finished line whose echo has not been seen: it stays hidden unless the terminal prints it. */
interface Awaiting {
	slot: CaptureSlot;
	/** What the slot shows once the echo is seen (secrets already redacted). */
	kept: string;
	probe: string;
	seen: string;
}

/** What the capture keeps of one terminal session. */
interface TerminalState {
	/** Keystrokes not yet ended by Enter. */
	typing: string;
	line: Typing | null;
	/** The end of the visible output (no escapes, no control characters but newlines). */
	tail: string;
	/** The start of an escape sequence a chunk ended in the middle of. */
	carry: string;
	/** The highest stream offset seen: viewers poll the same terminal, so one stretch of output arrives repeatedly. */
	offset: number | null;
	awaiting: Awaiting[];
}

function startTyping(term: TerminalState): Typing {
	const lastLine = term.tail.slice(term.tail.lastIndexOf("\n") + 1).trim();
	return { atSecretPrompt: SECRET_PROMPT.test(lastLine), seen: "" };
}

/** The typed lines of a set of terminal sessions, each keyed by the caller (e.g. `<tab>|<terminal id>`). */
export class TerminalCapture {
	readonly #terms = new Map<string, TerminalState>();
	readonly #lineChars: number;

	/** `lineChars`: one kept line is cut to this many characters (a pasted log is not a command). */
	constructor(lineChars: number) {
		this.#lineChars = lineChars;
	}

	/**
	 * Raw input typed in `terminal`. Each line Enter ends asks `slot` for its place in the record (null: the record
	 * is full, the line is dropped) and fills it: the line, redacted, once the terminal showed it was typed in the
	 * open, else a `[hidden: …]` marker.
	 */
	write(terminal: string, data: string, slot: () => CaptureSlot | null): void {
		const term = this.#term(terminal);
		const { pending, lines } = typedLines(term.typing, data);
		term.typing = pending;
		let typed = term.line ?? startTyping(term);
		for (const line of lines) {
			this.#completed(term, typed, line, slot);
			typed = startTyping(term);
		}
		term.line = pending ? typed : null;
	}

	/**
	 * What `terminal` printed, as one viewer's poll or write answered it: `output` is the text of the session's stream
	 * that ends at `offset`. Only the part past the highest offset seen so far is new, because every viewer of a
	 * terminal polls it.
	 */
	output(terminal: string, offset: number, output: string): void {
		// A snapshot with no output (the answer to a write) only names where the stream ends: it says nothing new.
		if (output === "") return;
		const term = this.#term(terminal);
		if (term.offset !== null && offset <= term.offset) return;
		const fresh = term.offset === null ? output : output.slice(Math.max(0, output.length - (offset - term.offset)));
		term.offset = offset;
		const { text, carry } = visibleOutput(term.carry, fresh);
		term.carry = carry;
		if (text === "") return;
		term.tail = printed(term.tail, text).slice(-TAIL_CHARS);
		if (term.line) term.line.seen = printed(term.line.seen, text).slice(0, SEEN_CHARS);
		term.awaiting = term.awaiting.filter(entry => {
			entry.seen = printed(entry.seen, text).slice(0, SEEN_CHARS);
			if (entry.seen.includes(entry.probe)) {
				entry.slot.text = entry.kept;
				return false;
			}
			// The terminal moved on to a new line without ever printing what was typed: nothing more will.
			return !text.includes("\n");
		});
	}

	#term(terminal: string): TerminalState {
		let term = this.#terms.get(terminal);
		if (!term) {
			term = { typing: "", line: null, tail: "", carry: "", offset: null, awaiting: [] };
			this.#terms.set(terminal, term);
		}
		return term;
	}

	/** A line Enter ended: its slot is taken now, so the record keeps the order, with the text it may show. */
	#completed(term: TerminalState, typed: Typing, line: string, slot: () => CaptureSlot | null): void {
		const entry = slot();
		if (!entry) return;
		entry.text = CAPTURE_HIDDEN_NO_ECHO;
		if (typed.atSecretPrompt) {
			entry.text = CAPTURE_HIDDEN_AT_PROMPT;
			return;
		}
		const kept = cut(redactSecretText(line), this.#lineChars);
		const probe = [...line].slice(0, PROBE_CHARS).join("");
		if (typed.seen.includes(probe)) entry.text = kept;
		else term.awaiting.push({ slot: entry, kept, probe, seen: typed.seen });
	}
}
