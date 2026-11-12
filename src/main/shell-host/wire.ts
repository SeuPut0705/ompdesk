/**
 * The host protocol's frames (native/ompdesk/crates/shell/PROTOCOL.md §0), the core's wire
 * (`native/ompdesk/crates/core/src/wire.rs`): one JSON object per line, UTF-8; a frame whose JSON carries
 * `"bin": n` is followed by exactly `n` raw bytes after its newline, which belong to it.
 */

/** One frame as read: its JSON head (an object) and the raw bytes its `bin` announced. */
export interface Frame {
	head: Record<string, unknown>;
	bin?: Buffer;
}

/** A frame as the line and the tail to write; `bin` is already counted in `head`. */
export function encodeFrame(head: Record<string, unknown>, bin?: Uint8Array): Buffer {
	const line = Buffer.from(`${JSON.stringify(bin === undefined ? head : { ...head, bin: bin.byteLength })}\n`, "utf8");
	return bin === undefined || bin.byteLength === 0 ? line : Buffer.concat([line, bin]);
}

const NEWLINE = 0x0a;

/**
 * Splits a byte stream into frames. A line that is not a JSON object is reported to `onSkip` and dropped (its bytes
 * are unknown, so a `bin` it may have announced is read as lines, as the core's reader does); a `bin` tail that
 * has not fully arrived waits for the next `push`.
 */
export class FrameReader {
	#buffered: Buffer = Buffer.alloc(0);
	#pending: { head: Record<string, unknown>; length: number } | null = null;
	readonly #onSkip: (reason: string) => void;

	constructor(onSkip: (reason: string) => void = () => undefined) {
		this.#onSkip = onSkip;
	}

	/** Bytes read that no complete frame has used yet. */
	get buffered(): number {
		return this.#buffered.length;
	}

	push(chunk: Uint8Array): Frame[] {
		this.#buffered = this.#buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffered, chunk]);
		const frames: Frame[] = [];
		for (;;) {
			if (this.#pending) {
				if (this.#buffered.length < this.#pending.length) break;
				const bin = Buffer.from(this.#buffered.subarray(0, this.#pending.length));
				this.#buffered = this.#buffered.subarray(this.#pending.length);
				frames.push({ head: this.#pending.head, bin });
				this.#pending = null;
				continue;
			}
			const newline = this.#buffered.indexOf(NEWLINE);
			if (newline < 0) break;
			let end = newline;
			if (end > 0 && this.#buffered[end - 1] === 0x0d) end -= 1;
			const text = this.#buffered.subarray(0, end).toString("utf8");
			this.#buffered = this.#buffered.subarray(newline + 1);
			const head = parseHead(text);
			if (typeof head === "string") {
				this.#onSkip(head);
				continue;
			}
			const length = head.bin;
			if (length === undefined) {
				frames.push({ head });
				continue;
			}
			delete head.bin;
			if (length === 0) frames.push({ head, bin: Buffer.alloc(0) });
			else this.#pending = { head, length };
		}
		// A copy: `subarray` views would keep every earlier chunk alive for as long as a tail waits.
		if (this.#buffered.length > 0) this.#buffered = Buffer.from(this.#buffered);
		return frames;
	}
}

function parseHead(text: string): (Record<string, unknown> & { bin?: number }) | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return `malformed line: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "a frame that is not an object";
	const head = value as Record<string, unknown> & { bin?: unknown };
	if (head.bin === undefined) return head as Record<string, unknown> & { bin?: number };
	if (typeof head.bin !== "number" || !Number.isSafeInteger(head.bin) || head.bin < 0)
		return "a frame whose bin is not a length";
	return head as Record<string, unknown> & { bin: number };
}
