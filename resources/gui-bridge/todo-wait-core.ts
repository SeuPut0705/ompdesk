/**
 * When stock's stop-time todo reminder (pi-coding-agent session/todo-tracker.ts `checkCompletion`: "You stopped with N
 * incomplete todo item(s) … (Reminder k/3)") wakes a session for nothing. A session that ended its turn with items
 * that only wait on another session's answer has nothing to continue: the reminder woke it, it wrote a second "still
 * waiting" answer, and the person read the same thing twice (dozens of times in one day, about $0.13 each).
 *
 * Stock already stays silent while a background job of the session runs (`hasPendingAsyncWake`: a `task` or a bash job
 * it started in the background). What it cannot know, and this decides:
 * - the session sent a message or opened a session (`ompdesk_session_send`, `ompdesk_session_open`) and that session
 *   has not answered yet: a report from it (`ompdesk.mail` done, blocked, question or review) or a message it sent
 *   back ends the wait;
 * - every open item is one the session wrote as waiting ("Wait for the reply of …", "대기: …").
 * Anything else, an actionable open item included, keeps stock's reminder. A person's own prompt ends every wait: the
 * session is asked something new, and a wait that could never be matched must not silence the reminder for good.
 *
 * Pure: no omp imports, so the GUI's vitest imports it.
 */

/** The tools whose unanswered messages a session waits on. */
export const OPEN_TOOL = "ompdesk_session_open";
export const SEND_TOOL = "ompdesk_session_send";

/** `ompdesk.mail` kinds in which the sender answered (agent-control-contracts.ts `MAIL_CUSTOM_TYPE`). */
const ANSWER_KINDS: ReadonlySet<string> = new Set(["done", "blocked", "question", "review"]);

/** The start of a message another agent sent (src/shared/agent-control.ts `wrapAgentMessage`). */
const AGENT_MESSAGE = /^\s*<ompdesk-agent-message\b([^>]*)>/;

/** What names a session in a result or a message: its tab id, saved id or title, lowercased. */
type Alias = string;

interface PendingReply {
	aliases: readonly Alias[];
}

/** One finished tool call as the bridge's `tool_result` hook sees it. */
export interface ControlCall {
	toolName: string;
	input: unknown;
	isError: boolean;
	text: string;
}

/** What arrived in the session: a report mail, or the person's or another agent's user message. */
export type Arrival =
	| { kind: "mail"; from?: string; title?: string; mailKind?: string }
	| { kind: "user"; text: string };

function alias(value: unknown): Alias | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().toLowerCase();
	return text ? text : undefined;
}

function aliasList(values: readonly unknown[]): Alias[] {
	return [...new Set(values.flatMap(value => alias(value) ?? []))];
}

function attribute(attributes: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
	return match?.[1];
}

/** The `ompdesk_session_*` call an `xd://` device write makes, as stock reports it under the `write` tool. */
export function controlCall(event: {
	toolName: string;
	input: unknown;
	isError: boolean;
	text: string;
}): ControlCall | undefined {
	if (event.toolName === OPEN_TOOL || event.toolName === SEND_TOOL) return event;
	if (event.toolName !== "write" || typeof event.input !== "object" || event.input === null) return undefined;
	const { path, content } = event.input as { path?: unknown; content?: unknown };
	const device = typeof path === "string" ? /^xd:\/\/(ompdesk_session_(?:open|send))\/?$/.exec(path)?.[1] : undefined;
	if (!device || typeof content !== "string") return undefined;
	try {
		return { ...event, toolName: device, input: JSON.parse(content) };
	} catch {
		return undefined;
	}
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Each "Opened session <tab id> …" line of an open's result that says the session works (an idle one answers nothing). */
function openedSessions(text: string): PendingReply[] {
	const opened: PendingReply[] = [];
	for (const line of text.split("\n")) {
		const match = /^Opened session ([\w-]+)/.exec(line.trim());
		if (match && !line.includes("It is idle")) opened.push({ aliases: aliasList([match[1]]) });
	}
	return opened;
}

/** The send's receipt names its target: `"<title>" (saved id <id>, on <computer>)`. */
function sentTo(input: unknown, text: string): PendingReply {
	const saved = /saved id ([0-9a-f-]{8,})/i.exec(text)?.[1];
	const title = /"([^"\n]{1,200})"/.exec(text)?.[1];
	return { aliases: aliasList([record(input).session, saved, title]) };
}

/**
 * The replies one session still waits on. Fed by the hooks of that session (`noteCall`, `noteArrival`), asked by the
 * stock reminder's check (`waiting`). Unmatched facts fail open: a result this does not understand adds no wait.
 */
export class WaitBook {
	#pending: PendingReply[] = [];
	/** Calls already counted: a nested `xd://` dispatch reports under the model's call id twice. */
	#seen = new Set<string>();

	/** A finished call of this session; `callId` is the model's tool call id. */
	noteCall(callId: string | undefined, event: ControlCall): void {
		if (event.isError) return;
		if (callId) {
			if (this.#seen.has(callId)) return;
			this.#seen.add(callId);
			if (this.#seen.size > 200) this.#seen.delete(this.#seen.values().next().value as string);
		}
		if (event.toolName === OPEN_TOOL) this.#pending.push(...openedSessions(event.text));
		else if (event.toolName === SEND_TOOL) this.#pending.push(sentTo(event.input, event.text));
	}

	/** A report or a message reached the session. */
	noteArrival(arrival: Arrival): void {
		if (arrival.kind === "mail") {
			if (!arrival.mailKind || !ANSWER_KINDS.has(arrival.mailKind)) return;
			this.#answered(aliasList([arrival.from, arrival.title]));
			return;
		}
		const agent = AGENT_MESSAGE.exec(arrival.text);
		if (agent) {
			const attributes = agent[1] ?? "";
			this.#answered(aliasList([attribute(attributes, "session"), attribute(attributes, "from")]));
			return;
		}
		this.#pending = [];
	}

	#answered(from: readonly Alias[]): void {
		if (from.length === 0) return;
		this.#pending = this.#pending.filter(reply => !reply.aliases.some(name => from.includes(name)));
	}

	/** Replies still owed to the session. */
	get size(): number {
		return this.#pending.length;
	}
}

/** The shape of a stock todo phase this reads. */
export interface PhaseLike {
	tasks: ReadonlyArray<{ content: string; status: string }>;
}

const WAITING_LEAD =
	/^[\s([{"'`*_>-]*(?:(?:waiting|wait|awaiting|await|blocked (?:on|by)|on hold)\b|대기(?![가-힣])|기다리)/i;
const WAITING_TAIL = /(?:대기|기다리기|기다림)(?:\s*중)?[\s).\]}"'`*_]*$/;

/** An item text the session wrote as waiting on something: "Wait for the reply of …", "대기: …", "… 응답 대기". */
export function isWaitingItem(content: string): boolean {
	const text = content.trim();
	return WAITING_LEAD.test(text) || WAITING_TAIL.test(text);
}

/** True when the list has open items and every one of them is written as waiting. */
export function onlyWaitingItems(phases: readonly PhaseLike[]): boolean {
	const open = phases
		.flatMap(phase => phase.tasks)
		.filter(task => task.status === "pending" || task.status === "in_progress");
	return open.length > 0 && open.every(task => isWaitingItem(task.content));
}

/** Why the reminder would wake the session for nothing, or undefined when it should stay stock's. */
export function waitReason(facts: {
	book: WaitBook | undefined;
	phases: readonly PhaseLike[];
}): "reply" | "marked" | undefined {
	if (facts.book && facts.book.size > 0) return "reply";
	return onlyWaitingItems(facts.phases) ? "marked" : undefined;
}
