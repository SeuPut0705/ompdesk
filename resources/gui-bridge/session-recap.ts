/**
 * Idle recap for GUI tabs. Stock's `recap.enabled` / `recap.idleSeconds` and the
 * recap itself exist, but the timer that makes one lives only in the TUI's event
 * controller (`#scheduleIdleRecap`), so in RPC mode the setting did nothing.
 * This module runs the same timer (rules in session-recap-core.ts) on the live
 * session's events, after a terminal `agent_end`, and makes the recap the way the
 * controller does (`#runIdleRecap`): stock's own prompt template
 * (`prompts/system/recap-user.md`, never re-derived) rendered with the goal
 * (or the session title) and the next todo task, one ephemeral side turn
 * (`runEphemeralTurn`, the same pipeline as /btw), `previewLine` to the stock
 * display length, and the reply journaled with `recordRecap` (history.db).
 *
 * Delivery: stock shows the recap as a TUI-only notice that is not in the
 * conversation. The GUI has no such transient row, so the preview becomes a
 * `recap` custom message (a `custom_message` journal entry the transcript
 * replays like an advisor card; the renderer draws a quiet line), and the
 * `context` hook below keeps it out of every model request, so a recap never
 * becomes something the model said or was told.
 *
 * The TUI reads its editor; the bridge cannot see the GUI draft, so the renderer's
 * draft report (`idle_compaction_draft`, src/renderer/hooks/use-idle-compaction-draft.ts)
 * also reaches `recap_draft` here (src/main/local/settings.ts), which attaches the
 * timer once per live session.
 */
import type { ContextEvent, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { armContextHook, installContextHook } from "./context-hook";
import { guard } from "./health";
import { ompPrompt } from "./modes/shared";
import { type Recap, type RecapSettings, RecapTimer } from "./session-recap-core";
import type { BridgeMethods } from "./types";

/** `customType` of the recap's custom message (the renderer's RecapCard). */
export const RECAP_MESSAGE_TYPE = "recap";

/** The slice of stock's Setting handle read here (`lookup("recap.enabled")`). */
interface SettingHandle {
	get(settings: unknown): unknown;
}

/** Session members the prompt's anchors come from; either may be missing on another omp. */
interface RecapAnchors {
	getGoalModeState?(): { goal?: { objective?: string } } | undefined;
	getTodoPhases?(): unknown[];
	sessionManager: { getSessionName(): string | undefined };
}

async function readRecapSettings(session: AgentSession): Promise<RecapSettings> {
	const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
	const enabled = lookup("recap.enabled") as SettingHandle | undefined;
	const idleSeconds = lookup("recap.idleSeconds") as SettingHandle | undefined;
	return {
		enabled: enabled?.get(session.settings) === true,
		idleSeconds: Number(idleSeconds?.get(session.settings) ?? 240),
	};
}

/** Stock's `#runIdleRecap` up to the reply: undefined when there is nothing to recap. */
export async function generateRecap(session: AgentSession, signal: AbortSignal): Promise<Recap | undefined> {
	if (!session.model || session.messages.length === 0) return undefined;
	// Deferred like idle-compaction.ts: stock internals load only after `guard` checked the feature.
	const { prompt } = await import("@oh-my-pi/pi-utils");
	const { nextActionableTask } = await import("@oh-my-pi/pi-coding-agent/tools/todo");
	const { previewLine, TRUNCATE_LENGTHS } = await import("@oh-my-pi/pi-tui/render/render-utils");
	const anchors = session as unknown as RecapAnchors;
	const goal =
		anchors.getGoalModeState?.()?.goal?.objective?.trim() || anchors.sessionManager.getSessionName()?.trim();
	const phases = anchors.getTodoPhases?.() ?? [];
	const task = nextActionableTask(phases as Parameters<typeof nextActionableTask>[0])?.content;
	const promptText = prompt.render(ompPrompt("system/recap-user.md"), { goal: goal ?? "", task: task ?? "" });
	const { replyText } = await session.runEphemeralTurn({ promptText, signal });
	const preview = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
	return preview ? { reply: replyText, preview } : undefined;
}

/** What stock does once the recap is current: journal the reply, then show it (here: a `recap` custom message). */
export async function deliverRecap(session: AgentSession, recap: Recap): Promise<void> {
	session.sessionManager.recordRecap(recap.reply);
	// The hook may have left the request path of a session that held no recap: back before the recap lands, and held
	// there until it is in the branch (a side request meanwhile, idle compaction or an ephemeral turn, cannot take it off).
	const release = armContextHook(RECAP_MESSAGE_TYPE, session.sessionManager);
	try {
		await session.sendCustomMessage({
			customType: RECAP_MESSAGE_TYPE,
			content: recap.preview,
			display: true,
			details: { recap: recap.reply },
		});
	} finally {
		release();
	}
}

const timer = new RecapTimer<AgentSession>({ read: readRecapSettings, generate: generateRecap, deliver: deliverRecap });
const subscribed = new WeakSet<AgentSession>();
let attached: AgentSession | undefined;

/** Called by settings.ts after a write: rearm inside a pending idle window when a `recap.*` setting changed. */
export function recapSettingChanged(path: string): void {
	if (attached) void timer.settingChanged(path, attached)?.catch(() => {});
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	// A recap is for the person: drop it from what the model is sent (the journal keeps it).
	installContextHook(pi, RECAP_MESSAGE_TYPE, (event: ContextEvent) => {
		const messages = event.messages.filter(
			message => !(message.role === "custom" && message.customType === RECAP_MESSAGE_TYPE),
		);
		return messages.length === event.messages.length ? undefined : { messages };
	});
	for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, () => timer.reset());
	}
}

export const methods: BridgeMethods = guard("sessionRecap", {
	/** `{empty}`: the tab's composer draft is (not) empty. Attaches the timer to the live session. */
	recap_draft: async (params, env) => {
		const empty = typeof params === "object" && params !== null && "empty" in params ? params.empty : undefined;
		if (typeof empty !== "boolean") throw new Error("recap_draft needs {empty: boolean}");
		const session = env.session();
		attached = session;
		if (!subscribed.has(session)) {
			subscribed.add(session);
			session.subscribe(event => void timer.onEvent(event, session)?.catch(() => {}));
		}
		await timer.setDraftEmpty(empty, session);
		return { armed: timer.armed };
	},
});
