/**
 * Prompt origins (A85; contracts and labelling in ./prompt-origin-contracts.ts).
 * In an omp a host runs for a paired device (`OMP_GUI_PROMPT_ORIGIN` set),
 * every user message is that device's prompt: journal it once stock ends the
 * message, as a custom entry (not LLM context) keyed by the message's
 * timestamp. A local tab has no origin of its own, but main may name one per
 * prompt (`prompt_origin_set`, for a prompt a paired web device sends to a tab
 * other windows show too): the next user message with that text is journaled
 * as that device's. Everything else journals nothing. sessions.ts labels the
 * transcript from these entries.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`
 * (src/main/bridge-prompt-origin.test.ts).
 */
import {
	PROMPT_ORIGIN_ENTRY,
	type PromptOrigin,
	type PromptOriginEntry,
	type PromptOriginEnv,
	parsePromptOriginEnv,
	parsePromptOriginSet,
} from "./prompt-origin-contracts";
import type { BridgeMethods } from "./types";

/** The slice of omp's ExtensionAPI this module needs. */
export interface PromptOriginHost {
	on(
		event: "message_end",
		handler: (
			event: { message: { role: string; timestamp?: number; content?: unknown } },
			ctx: { sessionManager: { appendCustomEntry(customType: string, data: unknown): unknown } },
		) => void,
	): void;
}

/** Read once: a host tab's device never changes for the life of its omp. */
export const promptOrigin: PromptOriginEnv | null = parsePromptOriginEnv(process.env.OMP_GUI_PROMPT_ORIGIN);

/** Origins named by `prompt_origin_set` whose message has not ended yet: a steer waits for its turn. */
const PENDING_MAX = 32;
const PENDING_TTL_MS = 10 * 60_000;
interface Pending {
	origin: PromptOrigin;
	text: string;
	at: number;
}
let pending: Pending[] = [];

/** The text a user message carries: a string, or its text blocks joined. */
function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/** The oldest live pending origin for this text, removed; expired ones are dropped on the way. */
function takePending(text: string, now: number): PromptOrigin | undefined {
	pending = pending.filter(entry => now - entry.at < PENDING_TTL_MS);
	const index = pending.findIndex(entry => entry.text === text);
	if (index < 0) return undefined;
	const [taken] = pending.splice(index, 1);
	return taken?.origin;
}

/** Called once per extension instance by index.ts. */
export function install(
	pi: PromptOriginHost,
	origin: PromptOriginEnv | null = promptOrigin,
	now: () => number = Date.now,
): void {
	pi.on("message_end", (event, ctx) => {
		const { role, timestamp } = event.message;
		if (role !== "user" || typeof timestamp !== "number") return;
		const named = takePending(userText(event.message.content), now());
		const from = named ?? origin;
		if (!from) return;
		const entry: PromptOriginEntry = { deviceId: from.deviceId, name: from.name, timestamp };
		ctx.sessionManager.appendCustomEntry(PROMPT_ORIGIN_ENTRY, entry);
	});
}

export const methods: BridgeMethods = {
	/** `prompt_origin_set {origin, text}`: the next user message with this text came from this device. */
	prompt_origin_set: async params => {
		const { origin, text } = parsePromptOriginSet(params);
		pending = [...pending.slice(-(PENDING_MAX - 1)), { origin, text, at: Date.now() }];
		return { pending: pending.length };
	},
};
