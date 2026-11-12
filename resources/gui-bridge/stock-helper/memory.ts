import { isAbsolute, join } from "node:path";
import {
	conclusionExcerpt,
	explicitTitle,
	firstMeaningfulLine,
	isAgentPrompt,
	isJunkTitle,
	promptTitle,
	unwrapPrompt,
} from "../memory-prompt";
import type { HelperMethods } from "./dispatch";

/**
 * What the memory upkeep and care (the core's `upkeep`/`care`) ask of `memory-prompt.ts` and of a stored journal,
 * which they do not copy: stock worker methods `memory.promptFacts` and `memory.journal`, and the two pure functions
 * behind them, which main answers a test's asks with too (`src/main/ai-memory/core-asks.ts`). Nothing from omp is
 * imported at the top level, so main can import this file.
 */

/** One prompt to ask about: its text exactly as the caller passed it, and the omp session's own title when it is
 * the session's first prompt. */
export interface PromptItem {
	text: string;
	sessionName?: string;
}

export interface PromptFacts {
	agent: boolean;
	junk: boolean;
	title: string | null;
	explicit: string | null;
	body: string;
	firstLine: string | null;
}

/** What `memory-prompt.ts` says of each prompt, in order. */
export function promptFacts(items: readonly PromptItem[]): PromptFacts[] {
	return items.map(({ text, sessionName }) => ({
		agent: isAgentPrompt(text),
		junk: isJunkTitle(text),
		title: promptTitle(text, { sessionName }) ?? null,
		explicit: explicitTitle(text) ?? null,
		body: unwrapPrompt(text).body,
		firstLine: firstMeaningfulLine(text) ?? null,
	}));
}

interface Turn {
	at: number;
	body: string;
}

interface Message {
	role?: unknown;
	content?: unknown;
	stopReason?: unknown;
	timestamp?: unknown;
}

/** A run's final reply: an assistant message that stopped (not for a tool call) and said something in words. */
export function turnsOf(messages: readonly unknown[]): Turn[] {
	const turns: Turn[] = [];
	for (const raw of messages) {
		const message = raw as Message | null;
		if (message?.role !== "assistant" || message.stopReason !== "stop") continue;
		if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) continue;
		const body = conclusionExcerpt([message]);
		if (body) turns.push({ at: message.timestamp, body });
	}
	return turns;
}

export function firstPrompt(messages: readonly unknown[]): string | undefined {
	for (const raw of messages) {
		const message = raw as Message | null;
		if (message?.role !== "user") continue;
		const parts: unknown[] =
			typeof message.content === "string"
				? [message.content]
				: Array.isArray(message.content)
					? message.content
					: [];
		const text = parts
			.map(part => {
				if (typeof part === "string") return part;
				const isText = part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part;
				return isText ? String(part.text) : "";
			})
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

/** What backfill reads of a stored conversation: its first prompt and its final replies (whole transcripts never
 * leave this process). */
export function journalFacts(messages: readonly unknown[]): { firstPrompt: string | null; turns: Turn[] } {
	return { firstPrompt: firstPrompt(messages) ?? null, turns: turnsOf(messages) };
}

/** `value[key]` when `value` is an object holding it. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

function items(params: unknown): PromptItem[] {
	const list = field(params, "items");
	if (!Array.isArray(list)) throw new Error("Invalid prompt items");
	return list.map(entry => {
		const text = field(entry, "text");
		const sessionName = field(entry, "sessionName");
		if (typeof text !== "string") throw new Error("Invalid prompt items");
		return typeof sessionName === "string" ? { text, sessionName } : { text };
	});
}

/** Stock `loadSessionMessagesReadOnly` as `sessions.messages` loads it: no writer, no lock, safe against a file a
 * live omp writes; the messages along the persisted leaf. */
async function readMessages(sessionPath: string): Promise<unknown[]> {
	const root = process.env.OMP_PACKAGE_ROOT;
	if (!root) throw new Error("OMP_PACKAGE_ROOT is not set");
	// Runtime-selected: the loader belongs to the user's resolved omp installation.
	const loader = await import(
		Bun.resolveSync("@oh-my-pi/pi-coding-agent/session/session-loader", join(root, "package.json"))
	);
	const read = loader.loadSessionMessagesReadOnly;
	if (typeof read !== "function")
		throw new Error("This omp cannot read stored sessions (loadSessionMessagesReadOnly).");
	return (await (read as (path: string) => Promise<unknown[]>)(sessionPath)) ?? [];
}

export const methods: HelperMethods = {
	"memory.promptFacts": params => promptFacts(items(params)),
	"memory.journal": async params => {
		const sessionPath = field(params, "sessionPath");
		if (typeof sessionPath !== "string" || !isAbsolute(sessionPath) || !sessionPath.endsWith(".jsonl"))
			throw new Error("Invalid session path");
		return journalFacts(await readMessages(sessionPath));
	},
};
