/**
 * A todo list left from earlier work (rules; wiring: todo-stale.ts). Stock keeps a session's list until the agent
 * changes it and has no reminder when a NEW request arrives: its eager prelude runs only on the first turn of a
 * session without a list, its completion reminder and mid-run nudge only push the agent to finish open items. So a
 * long session that takes request after request kept showing one finished task's list (the work board read 9/10 of
 * a bug fixed hours before). At the start of a turn a new request opens, a list counts as stale when
 *
 * - every item is done or dropped (the previous task's list), or
 * - items are open and a whole earlier request went by without a todo change (`UNTOUCHED_REQUESTS`),
 *
 * and the agent then gets one hidden line naming the list and what to do. Questions and short replies never get it
 * (`isNewRequest`, no model call); one list gets it at most twice, the second time only after `REMIND_AGAIN_REQUESTS`
 * more requests left it as it was. Everything is read from the journal, so a relaunch keeps the count.
 *
 * Whether the list's items name work the conversation moved past cannot be read without a model; the
 * untouched-request rule stands in for it.
 *
 * No omp imports: the GUI's vitest runs it (src/main/bridge-todo-stale.test.ts).
 */

export const STALE_TODO_MESSAGE_TYPE = "ompdesk-todo-stale";

/** Earlier requests (after the list's last change) that must have left an open list alone before it is stale. */
export const UNTOUCHED_REQUESTS = 1;
/** Requests after a reminder that must leave the list alone again before a second reminder. */
export const REMIND_AGAIN_REQUESTS = 3;
/** Reminders one list can get. */
export const MAX_REMINDERS = 2;

/** One journal entry as this rule reads it (stock's `SessionEntry`, only the fields used). */
export interface TodoStaleEntry {
	id?: string;
	type?: unknown;
	customType?: unknown;
	details?: { snapshotId?: unknown } | null;
	message?: { role?: unknown; synthetic?: unknown; attribution?: unknown; content?: unknown; toolName?: unknown };
}

export interface TodoPhaseLike {
	name: string;
	tasks: ReadonlyArray<{ content: string; status: string }>;
}

export interface TodoStaleInput {
	branch: readonly TodoStaleEntry[];
	/** The journal entry holding the list (stock `getLatestTodoSnapshotIdentity().sourceEntryId`). */
	snapshotId: string | undefined;
	/** The list (stock `getLatestTodoPhasesFromEntries`). */
	phases: readonly TodoPhaseLike[];
	/** The prompt this turn starts with. */
	prompt: string;
}

export interface StaleTodo {
	kind: "finished" | "untouched";
	done: number;
	total: number;
	phases: string[];
	snapshotId: string;
}

const DONE: Record<string, true> = { completed: true, abandoned: true };

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			const text = typeof part === "object" && part !== null && part.type === "text" ? part.text : undefined;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

/** A request a person (or an opening agent) sent: stock's synthetic continuations and agent-written turns are none. */
function promptText(entry: TodoStaleEntry): string | undefined {
	const message = entry.type === "message" ? entry.message : undefined;
	if (message?.role !== "user" || message.synthetic === true || message.attribution === "agent") return undefined;
	return messageText(message.content);
}

function isReminderFor(entry: TodoStaleEntry, snapshotId: string): boolean {
	return (
		entry.type === "custom_message" &&
		entry.customType === STALE_TODO_MESSAGE_TYPE &&
		entry.details?.snapshotId === snapshotId
	);
}

const AGENT_MESSAGE_START = /^\s*<ompdesk-agent-message\b/;
const MIN_REQUEST_CHARS = 8;
const LONG_REQUEST_CHARS = 240;
/** Words that ask for work, also inside a question ("이거 고쳐줄래?", "Can you add …?"); an English verb only as the first word. */
const REQUEST_CUE =
	/(줄래|주세요|해줘|해 줘|해봐|해 봐|하자|고쳐|추가|만들|바꿔|지워|넣어|붙여|옮겨)|\b(?:can|could|would|will) you\b|\bplease\b|^(?:add|fix|make|change|implement|write|remove|update|create|build|rename|refactor|move|delete|ship|release|port)\b/i;
const EN_QUESTION = /^(?:what|which|when|where|why|how|who|whose|is|are|does|do|did|was|were|has|have)\b/i;
const KO_QUESTION_START = /^(?:왜|어떻게|뭐가|무엇|언제|어디|누가|어느)\s/;
const KO_QUESTION_END = /(?:까|나요|가요|니|냐|는지|죠|어때|뭐야|뭐지|인가|는가)[.!~]*$/;

/** Whether `prompt` asks for new work rather than asking a question or replying in a word. No model call. */
export function isNewRequest(prompt: string): boolean {
	const text = prompt.trim();
	if (text === "" || /^[/!$]/.test(text)) return false;
	if (AGENT_MESSAGE_START.test(text)) return true;
	if ([...text].length < MIN_REQUEST_CHARS) return false;
	if (text.length > LONG_REQUEST_CHARS || /\n\s*\n/.test(text) || text.split("\n").length >= 3) return true;
	if (REQUEST_CUE.test(text)) return true;
	const question =
		/[?？]$/.test(text) || EN_QUESTION.test(text) || KO_QUESTION_START.test(text) || KO_QUESTION_END.test(text);
	return !question;
}

/** The stale list this turn's prompt meets, or undefined to say nothing. */
export function todoStaleness(input: TodoStaleInput): StaleTodo | undefined {
	const { branch, snapshotId, phases, prompt } = input;
	if (!snapshotId) return undefined;
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return undefined;
	const at = branch.findIndex(entry => entry.id === snapshotId);
	if (at < 0 || !isNewRequest(prompt)) return undefined;
	// Stock may already have journaled the prompt this turn starts with: it is not an earlier request.
	const current = promptText(branch[branch.length - 1] ?? {})?.trim() === prompt.trim() ? branch.length - 1 : -1;
	let reminders = 0;
	let since = 0;
	for (let index = at + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (isReminderFor(entry, snapshotId)) {
			reminders++;
			since = 0;
		} else if (index !== current && promptText(entry) !== undefined) since++;
	}
	if (reminders >= MAX_REMINDERS) return undefined;
	const done = tasks.filter(task => DONE[task.status]).length;
	const kind = done === tasks.length ? "finished" : "untouched";
	const needed = reminders > 0 ? REMIND_AGAIN_REQUESTS : kind === "finished" ? 0 : UNTOUCHED_REQUESTS;
	if (since < needed) return undefined;
	return { kind, done, total: tasks.length, phases: phases.map(phase => phase.name), snapshotId };
}

const MAX_NAMED_PHASES = 3;
const MAX_PHASE_CHARS = 60;

function listName(stale: StaleTodo): string {
	const names = stale.phases.slice(0, MAX_NAMED_PHASES).map(name => {
		const chars = [...name.trim()];
		return chars.length > MAX_PHASE_CHARS ? `${chars.slice(0, MAX_PHASE_CHARS).join("")}…` : chars.join("");
	});
	const more = stale.phases.length > MAX_NAMED_PHASES ? ` (+${stale.phases.length - MAX_NAMED_PHASES})` : "";
	return `"${names.join(" · ")}"${more}, ${stale.done}/${stale.total} done`;
}

/** The one line the agent reads, wrapped like stock's own todo reminders. */
export function staleTodoText(stale: StaleTodo): string {
	const what =
		stale.kind === "finished"
			? `Your todo list (${listName(stale)}) is finished: it belongs to an earlier task.`
			: `Your todo list (${listName(stale)}) has not changed since an earlier request.`;
	return `<system-reminder>\n${what} If this request is new work with steps, replace the list with its steps (todo op "init"); if it continues that work, mark the finished items done. Never leave an old task's list on screen.\n</system-reminder>`;
}

/** The hidden custom message `before_agent_start` returns; `details` mark which list it was for. */
export function staleTodoMessage(stale: StaleTodo): {
	customType: string;
	content: string;
	display: false;
	attribution: "agent";
	details: { snapshotId: string; kind: StaleTodo["kind"] };
} {
	return {
		customType: STALE_TODO_MESSAGE_TYPE,
		content: staleTodoText(stale),
		display: false,
		attribution: "agent",
		details: { snapshotId: stale.snapshotId, kind: stale.kind },
	};
}
