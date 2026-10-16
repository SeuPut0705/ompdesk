/**
 * OMPdesk control tools (src/shared/agent-control.ts, executed in main by src/main/agent-control/): the parts that
 * need the live session.
 * - A risky tool call (stopping, closing, deleting or merging for another session) is held in main until the person
 *   approves it on a confirmation card, and that card is stock's own extension-UI `confirm` raised by the calling
 *   tab's omp (`ctx.ui.confirm`, as /omfg asks where to save a rule), so it renders, survives a reload, is answered
 *   once across windows and reaches a paired device exactly like every other approval.
 * - When an agent answers another session's question, the answered session journals it (`ompdesk.agent-answer`
 *   custom entry, so the answer is auditable there) and says so (`ctx.ui.notify`, a toast in its window).
 */
import type { BridgeMethods } from "./types";

const TEXT_MAX = 2000;
export const AGENT_ANSWER_ENTRY = "ompdesk.agent-answer";

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`agent_control needs a ${field}`);
	return value.slice(0, TEXT_MAX);
}

export const methods: BridgeMethods = {
	/** `{title, message}` → `{approved}`: a dismissed or cancelled card is a refusal. */
	"agent_control.confirm": async (params, env) => {
		const record = (params ?? {}) as Record<string, unknown>;
		const approved = await env.context().ui.confirm(text(record.title, "title"), text(record.message, "message"));
		return { approved: approved === true };
	},
	/** `{text}` → `{}`: this session was answered by an agent. */
	"agent_control.note": async (params, env) => {
		const label = text((params as Record<string, unknown> | null)?.text, "text");
		env.session().sessionManager.appendCustomEntry(AGENT_ANSWER_ENTRY, { text: label, at: Date.now() });
		env.context().ui.notify(label, "info");
		return {};
	},
};
