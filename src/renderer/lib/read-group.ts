/**
 * React read-tool grouping: consecutive calls with stock collapse metadata
 * fold into ONE group card that accretes across
 * assistant messages for as long as the run is uninterrupted.
 *
 * Break rules (mirrors the TUI): a newly visible assistant text or non-empty
 * thinking block, any non-read tool card, a user/custom/fileMention message,
 * or a turn boundary seals the run. Selector suffixes (`path:1-5,7`) merge
 * for consecutive same-file reads.
 *
 * Both render paths share this module (plan/17 §7.4): buildHistoryRows
 * output is post-processed here for the finalized transcript; the live
 * StreamingRows path groups its read cards using the same host metadata.
 */

import type { AgentMessage, MessageContent } from "../../shared/rpc-types";
import { toolEntryKey } from "../stores/tools";
import { isRenderableMessageText } from "./messages";

/** One read call inside a group. Result/status resolution happens in the card. */
export interface ReadGroupEntry {
	callId: string;
	/** Occurrence-specific key; raw provider ids may repeat across turns. */
	toolKey: string;
	path: string;
	/** Selector suffix split from the path (`1-5,7,20-25`). */
	selector?: string;
	/** Original tool-call arguments (the expanded ToolCard renders from these + the store). */
	args: Record<string, unknown>;
}

export type ReadGroupRow =
	| { kind: "readGroup"; entries: ReadGroupEntry[]; usage?: ReadGroupUsage[] }
	| { kind: "message"; message: AgentMessage };

/**
 * Usage fields carried from a fully-consumed assistant message onto a read
 * group (TUI read-tool-group.ts parity: a pure-read turn keeps its usage row).
 * Rides the same wire shape UsageRow reads; readUsage decides whether to render.
 */
export interface ReadGroupUsage {
	role: "assistant";
	usage: unknown;
	model?: string;
	duration?: number;
	ttft?: number;
	timestamp?: string | number;
}

/**
 * Stock pi-tui/chat/read-tool-group and tools/read attach this metadata in the
 * bridge. Missing metadata renders a full card; no renderer scheme policy.
 */
export function collapsibleReadTarget(args: unknown): { path: string; selector?: string } | null {
	if (args === null || typeof args !== "object") return null;
	const target = (args as Record<string, unknown>).__ompReadGroup;
	if (target === null || typeof target !== "object") return null;
	const record = target as Record<string, unknown>;
	if (typeof record.path !== "string") return null;
	return { path: record.path, ...(typeof record.selector === "string" ? { selector: record.selector } : {}) };
}

/** A visible non-read block seals the run; empty thinking/invisible filler does not. */
function isVisibleBlock(block: MessageContent): boolean {
	switch (block.type) {
		case "text":
			return isRenderableMessageText(block.text);
		case "thinking":
			return isRenderableMessageText(block.thinking);
		case "toolCall":
		case "image":
			return true;
	}
	return false;
}

interface ReadGroupableRow {
	kind: string;
	message?: AgentMessage;
}

/**
 * Post-process finalized history rows: extract collapsible read blocks from
 * assistant messages into `readGroup` rows that accrete across messages.
 * Messages left with remaining visible content keep rendering (trimmed).
 */
export function groupReadRows<R extends ReadGroupableRow>(rows: R[]): Array<R | ReadGroupRow> {
	const out: Array<R | ReadGroupRow> = [];
	let run: ReadGroupEntry[] = [];
	let runUsage: ReadGroupUsage[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const row: ReadGroupRow = { kind: "readGroup", entries: run };
		if (runUsage.length > 0) row.usage = runUsage;
		out.push(row);
		run = [];
		runUsage = [];
	};

	for (const row of rows) {
		const message = row.kind === "message" ? row.message : undefined;
		if (
			message?.role !== "assistant" ||
			message.errorMessage ||
			message.steering ||
			!Array.isArray(message.content)
		) {
			flush();
			out.push(row);
			continue;
		}

		const kept: MessageContent[] = [];
		for (const block of message.content) {
			if (block.type === "toolCall" && block.name === "read") {
				const read = collapsibleReadTarget(block.arguments);
				if (read) {
					run.push({
						callId: block.id,
						toolKey: toolEntryKey(block),
						...read,
						args: block.arguments as Record<string, unknown>,
					});
					continue;
				}
			}
			if (isVisibleBlock(block)) flush();
			kept.push(block);
		}
		if (kept.some(isVisibleBlock)) {
			out.push({ kind: "message", message: { ...message, content: kept } } as R);
		} else if (message.usage != null && typeof message.usage === "object") {
			// The message was fully consumed into the run (no visible content
			// left to render a bubble) — keep its usage so a pure-read turn
			// still shows tokens/cost/duration on the group card.
			runUsage.push({
				role: "assistant",
				usage: message.usage,
				model: typeof message.model === "string" ? message.model : undefined,
				duration: typeof message.duration === "number" ? message.duration : undefined,
				ttft: typeof message.ttft === "number" ? message.ttft : undefined,
				timestamp: message.timestamp,
			});
		}
	}
	flush();
	return out;
}

/** Display rows after same-file selector merge (consecutive batches only). */
export interface ReadGroupDisplayRow {
	path: string;
	selector?: string;
	callIds: string[];
	toolKeys: string[];
}

export function mergeReadGroupEntries(entries: ReadGroupEntry[]): ReadGroupDisplayRow[] {
	const rows: ReadGroupDisplayRow[] = [];
	for (const entry of entries) {
		const last = rows[rows.length - 1];
		if (last && last.path === entry.path) {
			last.callIds.push(entry.callId);
			last.toolKeys.push(entry.toolKey);
			if (entry.selector) last.selector = last.selector ? `${last.selector},${entry.selector}` : entry.selector;
			continue;
		}
		rows.push({ path: entry.path, selector: entry.selector, callIds: [entry.callId], toolKeys: [entry.toolKey] });
	}
	return rows;
}
