/**
 * Prompt origins (A85; contracts and labelling in ./prompt-origin-contracts.ts).
 * In an omp a host runs for a paired device (`OMP_GUI_PROMPT_ORIGIN` set),
 * every user message is that device's prompt: journal it once stock ends the
 * message, as a custom entry (not LLM context) keyed by the message's
 * timestamp. A local tab has no origin and journals nothing. sessions.ts
 * labels the transcript from these entries.
 *
 * No omp imports (not even types): the GUI's vitest installs it on a fake `pi`
 * (src/main/bridge-prompt-origin.test.ts).
 */
import {
	PROMPT_ORIGIN_ENTRY,
	type PromptOriginEntry,
	type PromptOriginEnv,
	parsePromptOriginEnv,
} from "./prompt-origin-contracts";

/** The slice of omp's ExtensionAPI this module needs. */
export interface PromptOriginHost {
	on(
		event: "message_end",
		handler: (
			event: { message: { role: string; timestamp?: number } },
			ctx: { sessionManager: { appendCustomEntry(customType: string, data: unknown): unknown } },
		) => void,
	): void;
}

/** Read once: a host tab's device never changes for the life of its omp. */
export const promptOrigin: PromptOriginEnv | null = parsePromptOriginEnv(process.env.OMP_GUI_PROMPT_ORIGIN);

/** Called once per extension instance by index.ts. */
export function install(pi: PromptOriginHost, origin: PromptOriginEnv | null = promptOrigin): void {
	if (!origin) return;
	pi.on("message_end", (event, ctx) => {
		const { role, timestamp } = event.message;
		if (role !== "user" || typeof timestamp !== "number") return;
		const entry: PromptOriginEntry = { deviceId: origin.deviceId, name: origin.name, timestamp };
		ctx.sessionManager.appendCustomEntry(PROMPT_ORIGIN_ENTRY, entry);
	});
}

export const methods = {};
