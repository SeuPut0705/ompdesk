/**
 * The transcript virtualizer's first guess at a row's height, before the row is measured. A guess that misses moves
 * the reader's view when the row is measured: above the fold the virtualizer corrects the scroll offset by the miss,
 * and on iOS it holds that correction during a fling and applies it when the fling ends (TanStack virtual-core
 * `_flushIosDeferredIfReady`), so every miss of the rows a fling mounted lands as one jump after the content stopped.
 *
 * The desktop keeps its fixed guesses (a finished work card is rarely under 136 px, an assistant reply under 145 px).
 * A phone's column is a third as wide and its work cards are compact: there those guesses were 60 px (a work card,
 * 73-76 px measured) and 104 px (a one-line reply, 40 px) too tall, a 164 px jump per turn (e2e/phone-day.e2e.ts
 * `read-long`, iPhone 15). So on a phone a message is guessed from its text at the column's width, and every other
 * kind from what rows of that kind measured in this transcript so far; a tablet (desktop type, a wider column; 100 px
 * a fling on an iPad) guesses every kind from what it measured.
 */
import type { AgentMessage } from "../../../shared/rpc-types";
import { messageText } from "../../lib/messages";
import type { Row } from "./chat-stream-utils";

/** The desktop's guesses, by kind. */
export function desktopRowEstimate(row: Row | undefined): number {
	if (row?.kind === "streaming") return 80;
	if (row?.kind === "pending") return 56;
	if (row?.kind === "process") return 136;
	if (row?.kind === "expander" || row?.kind === "todoSnapshot") return 48;
	if (row?.kind === "message") return row.message.role === "user" ? 64 : 144;
	return 160;
}

/** What rows of each kind measured so far (a phone's guess for a kind whose height its content does not tell). */
export class RowSizeLearner {
	readonly #sums = new Map<string, { total: number; count: number }>();

	add(kind: string, size: number): void {
		const entry = this.#sums.get(kind) ?? { total: 0, count: 0 };
		entry.total += size;
		entry.count += 1;
		this.#sums.set(kind, entry);
	}

	/** The mean once three rows of the kind were measured, else undefined. */
	mean(kind: string): number | undefined {
		const entry = this.#sums.get(kind);
		return entry && entry.count >= 3 ? Math.round(entry.total / entry.count) : undefined;
	}
}

// Phone geometry (13 px transcript type, measured on the built app and the dev harness at 393 px): a reply's line is
// 20 px with 20 px around its block and 8 px between paragraphs; a prompt's bubble is 44 px around its lines.
const LINE_PX = 20;
const REPLY_FRAME_PX = 20;
const PARAGRAPH_GAP_PX = 8;
const PROMPT_FRAME_PX = 44;
const CHAR_PX = 5.4;
const PROMPT_WIDTH_SHARE = 0.8;
/** A code block's frame (its header and padding) and a thinking disclosure's row. */
const CODE_FRAME_PX = 40;
const THINKING_PX = 32;

function textLines(text: string, charsPerLine: number): { lines: number; paragraphs: number; code: number } {
	let lines = 0;
	let paragraphs = 0;
	let code = 0;
	let inCode = false;
	let blank = true;
	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			if (!inCode) {
				code++;
				paragraphs++;
			}
			inCode = !inCode;
			blank = true;
			continue;
		}
		if (line.trim() === "" && !inCode) {
			blank = true;
			continue;
		}
		if (blank && !inCode) paragraphs++;
		blank = false;
		// Code does not wrap (it scrolls sideways); prose wraps at the column.
		lines += inCode ? 1 : Math.max(1, Math.ceil(line.length / charsPerLine));
	}
	return { lines, paragraphs, code };
}

function messageEstimate(message: AgentMessage, width: number): number {
	const text = messageText(message);
	if (message.role === "user") {
		const { lines } = textLines(text, Math.max(10, Math.floor((width * PROMPT_WIDTH_SHARE - 24) / CHAR_PX)));
		return PROMPT_FRAME_PX + LINE_PX * Math.max(1, lines);
	}
	const { lines, paragraphs, code } = textLines(text, Math.max(10, Math.floor((width - 24) / CHAR_PX)));
	const thinking =
		Array.isArray(message.content) && message.content.some(part => part.type === "thinking") ? THINKING_PX : 0;
	return (
		REPLY_FRAME_PX +
		LINE_PX * Math.max(1, lines) +
		PARAGRAPH_GAP_PX * Math.max(0, paragraphs - 1) +
		CODE_FRAME_PX * code +
		thinking
	);
}

/** The learned-size key of a row: its kind, a message's by role (a prompt and a reply differ). */
export function rowSizeKey(row: Row): string {
	return row.kind === "message" ? `message:${row.message.role}` : row.kind;
}

/**
 * The guess for `row`. `column` is the transcript column of a web page on a phone or tablet (null in a desktop
 * window: its guesses, unchanged); `learned` is what rows of a key measured so far. A phone guesses a message from its
 * text at the column's width; a tablet keeps the desktop's type, so it guesses every kind from what it measured.
 */
export function estimateRowSize(
	row: Row | undefined,
	column: { width: number; phone: boolean } | null,
	learned?: (key: string) => number | undefined,
): number {
	if (column === null || !row) return desktopRowEstimate(row);
	if (column.phone && (row.kind === "message" || row.kind === "streaming"))
		return messageEstimate(row.message, column.width);
	return learned?.(rowSizeKey(row)) ?? desktopRowEstimate(row);
}
