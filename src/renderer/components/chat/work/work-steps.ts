/**
 * How a finished work card lists its steps when opened: consecutive calls that carry the same stock
 * intent ("Checking the types" ×3) sit under one line, and consecutive collapsible reads fold into
 * the transcript's own read-group card. Every call stays one `ToolCard` in the list; nothing is
 * hidden, only lined up. Pure: the component decides what is open (`StepGroups.tsx`).
 *
 * A message is split into its blocks (the very same block objects, which `toolEntryKey` keys its
 * store entries by), so a text between two calls still reads in place. Only thinking may sit
 * between two calls of one intent; a visible reply or a note ends the line.
 */
import type { AgentMessage, MessageContent, ReadGroupTarget, ToolCallContent } from "../../../../shared/rpc-types";
import { isRenderableMessageText } from "../../../lib/messages";
import { collapsibleReadTarget, type ReadGroupEntry, type ReadGroupUsage } from "../../../lib/read-group";
import { toolEntryKey } from "../../../stores/tools";
import { GENERIC_INTENT } from "./work-view";

export type StepItem =
	| { kind: "message"; key: string; message: AgentMessage; thinkingOnly: boolean }
	| { kind: "call"; key: string; call: ToolCallContent; usage?: ReadGroupUsage }
	| { kind: "reads"; key: string; entries: ReadGroupEntry[]; usage?: ReadGroupUsage[] };

/** Consecutive calls of one intent. `callKeys` are the entry keys of every call inside, folded reads too. */
export interface StepGroup {
	kind: "intent";
	key: string;
	label: string;
	items: StepItem[];
	callKeys: string[];
}

export type StepRow = StepItem | StepGroup;

/** The intent a call states: stock's wire intent, then the arguments' own. A generic one names nothing. */
export function stepIntent(call: Pick<ToolCallContent, "intent" | "arguments">): string | undefined {
	for (const intent of [call.intent, call.arguments.intent, call.arguments.i]) {
		if (typeof intent === "string" && intent.trim() && !GENERIC_INTENT.test(intent.trim())) return intent.trim();
	}
	return undefined;
}

function isVisible(block: MessageContent): boolean {
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

function usageSlice(message: AgentMessage): ReadGroupUsage | undefined {
	if (message.usage == null || typeof message.usage !== "object") return undefined;
	return {
		role: "assistant",
		usage: message.usage,
		model: typeof message.model === "string" ? message.model : undefined,
		duration: typeof message.duration === "number" ? message.duration : undefined,
		ttft: typeof message.ttft === "number" ? message.ttft : undefined,
		timestamp: message.timestamp,
	};
}

/** The card's messages as one flat line of text pieces and calls, in order. */
function splitSteps(messages: readonly AgentMessage[]): StepItem[] {
	const items: StepItem[] = [];
	messages.forEach((message, index) => {
		if (message.role === "toolResult") return;
		const key = typeof message.id === "string" ? message.id : `${String(message.timestamp ?? "step")}-${index}`;
		if (message.role !== "assistant" || message.errorMessage || message.steering || !Array.isArray(message.content)) {
			items.push({ kind: "message", key, message, thinkingOnly: false });
			return;
		}
		const pieces: StepItem[] = [];
		let kept: MessageContent[] = [];
		const flush = () => {
			if (kept.some(isVisible)) {
				pieces.push({
					kind: "message",
					key: `${key}#${pieces.length}`,
					message: { ...message, content: kept, usage: undefined },
					thinkingOnly: kept.every(block => block.type === "thinking" || !isVisible(block)),
				});
			}
			kept = [];
		};
		for (const block of message.content) {
			if (block.type !== "toolCall") {
				kept.push(block);
				continue;
			}
			flush();
			pieces.push({ kind: "call", key: toolEntryKey(block), call: block });
		}
		flush();
		// The message's usage rides on its last piece, as the message's own row showed it under its last block.
		const last = pieces.at(-1);
		if (last?.kind === "message") last.message = { ...last.message, usage: message.usage };
		else if (last?.kind === "call") last.usage = usageSlice(message);
		items.push(...pieces);
	});
	return items;
}

/** Consecutive collapsible reads become one read-group item (`groupReadRows`' rule, within a card). */
function foldReads(items: readonly StepItem[], readTargets?: ReadonlyMap<string, ReadGroupTarget | null>): StepItem[] {
	const out: StepItem[] = [];
	let run: ReadGroupEntry[] = [];
	let usage: ReadGroupUsage[] = [];
	const flush = () => {
		if (run.length === 0) return;
		out.push({ kind: "reads", key: `reads:${run[0]?.toolKey}`, entries: run, ...(usage.length ? { usage } : {}) });
		run = [];
		usage = [];
	};
	for (const item of items) {
		if (item.kind === "call" && item.call.name === "read") {
			const read = collapsibleReadTarget(
				"__ompReadGroup" in item.call.arguments || !readTargets?.has(item.call.id)
					? item.call.arguments
					: { __ompReadGroup: readTargets.get(item.call.id) },
			);
			if (read) {
				run.push({ callId: item.call.id, toolKey: item.key, ...read, args: item.call.arguments });
				if (item.usage) usage.push(item.usage);
				continue;
			}
		}
		flush();
		out.push(item);
	}
	flush();
	return out;
}

/** The entry keys of every call inside an item. */
export function itemCallKeys(item: StepItem): string[] {
	return item.kind === "call" ? [item.key] : item.kind === "reads" ? item.entries.map(entry => entry.toolKey) : [];
}

/**
 * A finished card's step rows. Two or more consecutive calls of one intent become a `StepGroup`;
 * every other call stays a row of its own, and reads fold wherever they are consecutive.
 */
export function groupSteps(
	messages: readonly AgentMessage[],
	readTargets?: ReadonlyMap<string, ReadGroupTarget | null>,
): StepRow[] {
	const items = splitSteps(messages);
	const rows: StepRow[] = [];
	let loose: StepItem[] = [];
	const flushLoose = () => {
		rows.push(...foldReads(loose, readTargets));
		loose = [];
	};
	let index = 0;
	while (index < items.length) {
		const item = items[index];
		const label = item?.kind === "call" ? stepIntent(item.call) : undefined;
		if (!item || !label) {
			if (item) loose.push(item);
			index++;
			continue;
		}
		const run: StepItem[] = [item];
		let calls = 1;
		let end = index + 1;
		for (let next = index + 1, pending: StepItem[] = []; next < items.length; next++) {
			const candidate = items[next];
			if (candidate?.kind === "message" && candidate.thinkingOnly) {
				pending.push(candidate);
				continue;
			}
			if (
				candidate?.kind !== "call" ||
				stepIntent(candidate.call)?.toLocaleLowerCase() !== label.toLocaleLowerCase()
			)
				break;
			run.push(...pending, candidate);
			pending = [];
			calls++;
			end = next + 1;
		}
		if (calls < 2) {
			loose.push(item);
			index++;
			continue;
		}
		flushLoose();
		const folded = foldReads(run, readTargets);
		const only = folded.length === 1 ? folded[0] : undefined;
		if (only?.kind === "reads") rows.push(only);
		else
			rows.push({
				kind: "intent",
				key: `intent:${item.key}`,
				label,
				items: folded,
				callKeys: folded.flatMap(itemCallKeys),
			});
		index = end;
	}
	flushLoose();
	return rows;
}
