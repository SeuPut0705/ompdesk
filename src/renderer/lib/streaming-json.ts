/**
 * Arguments of a tool call whose JSON is still streaming: a copy of stock
 * `parseStreamingJson` and the growth rule of `parseStreamingJsonThrottled`
 * (pi-utils `src/json-parse.ts`, partial `RelaxedJson` over `json-lexer.ts`).
 *
 * Why a copy: over RPC the only live source of those arguments is the raw
 * `toolcall_delta` text. Stock feeds its own parse from the symbol-keyed
 * `partialJson`, which never crosses the wire, and providers refresh
 * `partial.arguments` only every 256 bytes, so a short bash command reads `{}`
 * until `toolcall_end`; the renderer cannot import pi-utils. The copy covers the
 * strict JSON grammar providers stream (stock additionally recovers comments,
 * single quotes and unquoted values) and returns what stock returns for every
 * prefix of a strict JSON object — `streaming-json.test.ts` pins that against
 * the installed stock module. Like stock: an open string keeps what arrived
 * (a split escape stays literal), a number or keyword at the edge counts once
 * it reads as one, any other open token rolls its container back to the last
 * complete member, and open containers close.
 */
const INCOMPLETE = Symbol("incomplete");
const KEYWORDS: readonly (readonly [string, boolean | null])[] = [
	["true", true],
	["false", false],
	["null", null],
	["True", true],
	["False", false],
	["None", null],
];
const ESCAPES: Record<string, string> = {
	'"': '"',
	"'": "'",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};
const HEX4 = /^[0-9a-f]{4}$/i;
const NUMBER_START = /[-+.\d]/;
const NUMBER_CHAR = /[-+.\da-fx]/i;
const IDENT_CHAR = /[\w$]/;
const WHITESPACE = /[ \t\n\r]/;
const KEY_END = /[:,} \t\n\r]/;

export function parseStreamingArgs(text: string): Record<string, unknown> {
	let pos = 0;
	const ws = (): void => {
		while (pos < text.length && WHITESPACE.test(text[pos] ?? "")) pos++;
	};

	function string(): string {
		let out = "";
		let i = pos + 1;
		let runStart = i;
		for (; i < text.length; i++) {
			const char = text[i];
			if (char === '"') {
				pos = i + 1;
				return out + text.slice(runStart, i);
			}
			if (char !== "\\") continue;
			out += text.slice(runStart, i);
			const escaped = text[i + 1];
			if (escaped === undefined) out += "\\";
			else if (escaped !== "u") {
				out += ESCAPES[escaped] ?? `\\${escaped}`;
				i++;
			} else if (HEX4.test(text.slice(i + 2, i + 6))) {
				out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
				i += 5;
			} else {
				out += "\\u";
				i++;
			}
			runStart = i + 1;
		}
		pos = text.length;
		return out + text.slice(runStart);
	}

	function value(): unknown {
		const char = text[pos] ?? "";
		if (char === "{") return object();
		if (char === "[") return array();
		if (char === '"') return string();
		if (NUMBER_START.test(char)) {
			const start = pos;
			while (pos < text.length && NUMBER_CHAR.test(text[pos] ?? "")) pos++;
			const number = Number(text.slice(start, pos));
			return Number.isFinite(number) ? number : INCOMPLETE;
		}
		for (const [word, literal] of KEYWORDS) {
			if (text.startsWith(word, pos) && !IDENT_CHAR.test(text[pos + word.length] ?? "")) {
				pos += word.length;
				return literal;
			}
		}
		pos = text.length;
		return INCOMPLETE;
	}

	function object(): Record<string, unknown> {
		pos++;
		const out: Record<string, unknown> = {};
		for (;;) {
			ws();
			const char = text[pos];
			if (char === undefined) return out;
			if (char === "}") {
				pos++;
				return out;
			}
			if (char === ",") {
				pos++;
				continue;
			}
			let key: string;
			if (char === '"') key = string();
			else {
				const start = pos;
				while (pos < text.length && !KEY_END.test(text[pos] ?? "")) pos++;
				key = text.slice(start, pos);
			}
			ws();
			if (text[pos] !== ":") return out;
			pos++;
			ws();
			if (pos >= text.length) return out;
			const item = value();
			if (item === INCOMPLETE) return out;
			out[key] = item;
			ws();
			if (text[pos] === ",") {
				pos++;
				continue;
			}
			if (text[pos] === "}") pos++;
			return out;
		}
	}

	function array(): unknown[] {
		pos++;
		const out: unknown[] = [];
		for (;;) {
			ws();
			const char = text[pos];
			if (char === undefined) return out;
			if (char === "]") {
				pos++;
				return out;
			}
			if (char === ",") {
				pos++;
				continue;
			}
			const item = value();
			if (item === INCOMPLETE) return out;
			out.push(item);
			ws();
			if (text[pos] === ",") {
				pos++;
				continue;
			}
			if (text[pos] === "]") pos++;
			return out;
		}
	}

	ws();
	if (pos >= text.length) return {};
	const parsed = value();
	// Tool arguments are objects; stock would hand back a stray top-level array or scalar.
	return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

/**
 * `parseStreamingJsonThrottled`'s geometric gate as a step of the buffer
 * length: re-parse when the step changes. Past 256 characters a step is ~1/32
 * of the length (stock's `len >> 5`), so a long `write` payload is parsed
 * O(log n) times. Below that the GUI re-parses on every delta where stock
 * waits for 256 bytes: stock's terminal reveals the raw `partialJson` in the
 * meantime, the GUI has only this parse to show a short command.
 */
export function streamingParseStep(length: number): number {
	return length < 256 ? length : 256 + Math.floor(Math.log(length / 256) / Math.log(33 / 32));
}
