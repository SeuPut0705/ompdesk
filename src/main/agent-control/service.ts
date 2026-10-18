/**
 * OMPdesk control tools (contract `src/shared/agent-control.ts`, definitions `tools.ts`): what a call does, against
 * an `AgentControlHost` (`host.ts`) implemented over the sidecar pool, so the rules are testable without Electron.
 *
 * Every action goes through what the GUI already does for a person: the RPC dispatcher for prompts, steers,
 * follow-ups, aborts and mode commands (a paired host's tab: over the link, where the host's per-device model
 * limit and refusals apply), the tab spawn path for a new session, the renderer's own pick/split/close for the
 * view, the window's notifications, and a stock extension-UI confirmation card for what needs the person.
 *
 * Permission levels (Settings › Tools & extensions › OMPdesk control tools):
 *   always  list, read, send, wait, answer a question, show, notify, open sessions, stop/close/delete the sessions
 *           the caller opened.
 *   card    stopping, closing or deleting a session the caller did not open: one confirmation card each.
 *   pref    `agentControlManage` lifts that card; `agentControlApprove` lets an agent approve another session's
 *           tool approval (without it the answer is "사용자 승인이 필요해요"); a session the user hid from agents refuses all.
 *   never   accounts, settings, permissions.
 */
import {
	AGENT_CARD_PREFIX,
	AGENT_SCHEDULE_MIN_INTERVAL_MINUTES,
	AGENT_SCHEDULE_PREFIX,
	type AgentControlToolName,
	type AgentControlViewEvent,
	type AgentReviewAction,
	type AgentReviewItem,
	type AgentReviewOutcome,
	type AgentReviewResult,
	agentTaskTitle,
	isApprovalSelect,
	LESSON_MAX_CHARS,
	MAX_AGENT_SCHEDULES,
	MAX_AGENT_SESSIONS,
	parseAgentMessage,
	AGENT_CONTROL_TOOLS as T,
	wrapAgentMessage,
} from "../../shared/agent-control";
import type { IpcTabWorktree, TabStatus } from "../../shared/ipc-types";
import type {
	AgentMessage,
	ExtensionUIRequest,
	ExtensionUIResponse,
	MessageContent,
	MessagesPage,
	ModelInfo,
	RpcCommand,
	RpcResponse,
	RpcSessionState,
	SubagentSnapshot,
	TodoPhase,
} from "../../shared/rpc-types";
import type { ScheduleDraft, ScheduleFrequency } from "../../shared/schedules";
import { type BranchFacts, type MergeOutcome, mergeProblem, type WorktreeRef } from "./branches";
import { AgentLimits, LimitError } from "./limits";
import {
	type AnswerArgs,
	ARGS,
	type OpenOne,
	READ_DEFAULT_MESSAGES,
	READ_MAX_CHARS,
	RESULT_MAX_CHARS,
	RESULT_TABLE_ANSWER_CHARS,
	RESULT_WAIT_DEFAULT_SECONDS,
	type ScheduleArgs,
} from "./tools";

/** A blocking request a session waits on, as the pool holds it. */
export interface ControlAsk {
	id: string;
	request: ExtensionUIRequest;
}

/** One tab of the calling session's window, as the pool knows it. */
export interface ControlTab {
	tabId: string;
	/** "" while the session has no title. */
	title: string;
	cwd: string;
	/** The paired host's name when the tab runs there. */
	deviceName?: string;
	status: TabStatus;
	/** A turn runs (stock run state as the pool tracks it). */
	busy: boolean;
	/** Open asks and approvals that wait for the person. */
	asks: ControlAsk[];
	/** The user hid this session from agents (Sidebar › Hide from other agents). */
	hidden: boolean;
	worktree?: IpcTabWorktree;
}

/** What `host.spawn` is asked for. */
export interface SpawnRequest {
	folder?: string;
	/** A git worktree for the new session (`omp/agent/<slug>` branch off `base`, default the caller's HEAD). */
	worktree?: { branch?: string; base?: string };
	/** Who asked for the session (Autopilot passes "autopilot-child"); the host records the caller tab as parent. */
	tag?: string;
}

/** A session opened by `open`, handed to `beforeFirstPrompt` before its first message is sent. */
export interface OpenedChild {
	tabId: string;
	callerTabId: string;
	worktree?: { path: string; branch: string };
	tag?: string;
}

/** A scheduled run as the control tools see it. */
export interface ScheduleRow {
	id: string;
	name: string;
	frequency: ScheduleFrequency;
	cwd: string;
	enabled: boolean;
	/** Next start (ISO), null when it will not run. */
	nextRun: string | null;
	/** How the last run ended; null before the first. */
	lastStatus: string | null;
}

/** The Schedules service seen by `ompdesk_schedule` (`host.ts` adapts `src/main/schedules.ts`). */
export interface ScheduleSource {
	list(): ScheduleRow[];
	save(draft: ScheduleDraft): Promise<ScheduleRow>;
	remove(id: string): Promise<void>;
}

export interface AgentControlHost {
	/** Settings › Tools & extensions switch (this computer's). */
	enabled(): boolean;
	/** `agentControlApprove`: an agent may approve another session's tool approval. */
	approveEnabled(): boolean;
	/** `agentControlManage`: an agent may stop, close or delete sessions it did not open without a card. */
	manageEnabled(): boolean;
	/** Counter of the caller's turns (a new one each time its run starts); resets the per-turn budgets. */
	turn(callerTabId: string): number;
	/** The tabs of the window that owns `callerTabId`, in its order; null when that tab is gone. */
	tabs(callerTabId: string): ControlTab[] | null;
	/** A command through the GUI's RPC dispatcher for `tabId` (local handlers, host link, quota). */
	command(tabId: string, command: RpcCommand, timeoutMs?: number): Promise<RpcResponse>;
	/** Spawn a fresh tab in the caller's window on the caller's machine. Throws a readable error. */
	spawn(callerTabId: string, request: SpawnRequest): Promise<{ tabId: string; worktree?: IpcTabWorktree }>;
	/** Start a tab that has no process yet (a restored, not yet shown tab). */
	start(tabId: string): void;
	/** What an opened session works on (`agentTaskTitle` of its first message): its row shows it until it has a title. */
	setTask(tabId: string, task: string): void;
	view(callerTabId: string, event: AgentControlViewEvent): void;
	notify(callerTabId: string, title: string, body: string): void;
	/** A confirmation card on the calling tab; resolves false on refusal, dismissal or failure. */
	confirm(callerTabId: string, title: string, message: string): Promise<boolean>;
	/** Deliver the answer to the request the tab raised (the pool's side channel). */
	answer(tabId: string, requestId: string, response: ExtensionUIResponse): Promise<void>;
	/** Journal and show "answered by agent" in the session that was answered. Best effort. */
	markAnswered(tabId: string, byTitle: string): Promise<void>;
	/** Close a session's tab and delete its saved file (the sidebar's delete). */
	deleteSession(callerTabId: string, tabId: string): Promise<void>;
	/** Git facts of a session's worktree (this computer's sessions only). Rejects with a readable message. */
	branchFacts(worktree: WorktreeRef): Promise<BranchFacts>;
	/** Merge the worktree's branch into its parent checkout (local, never pushed). */
	mergeBranch(worktree: WorktreeRef, label: string): Promise<MergeOutcome>;
	/** Remove a closed session's worktree and branch. */
	discardWorktree(worktree: WorktreeRef): Promise<void>;
	/** The Schedules service (Settings › Schedules), or null where there is none. */
	schedules(): ScheduleSource | null;
	/** Whether the user's memory backend can save (stock `get_memory_report`; off = no backend or no save hook). */
	memoryOn(callerTabId: string): Promise<boolean>;
	/** Append a note to stock's memory (`memory_save` through the bridge). */
	saveMemory(callerTabId: string, content: string): Promise<void>;
	/** Be called whenever any tab's run, ask or status changes; returns the unsubscribe. */
	observe(listener: () => void): () => void;
	/** Autopilot: a stop of the caller's work is in flight; nothing new may start. */
	isStopping?(callerTabId: string): boolean;
	/** Autopilot: awaited after the child is ready and before its first prompt; a throw closes the child and fails the open. */
	beforeFirstPrompt?(child: OpenedChild): Promise<void>;
	/** Card and label text in the person's language. */
	text(
		key:
			| "stopTitle"
			| "stopMessage"
			| "closeMessage"
			| "deleteMessage"
			| "answeredBy"
			| "mergeTitle"
			| "mergeMessage"
			| "scheduleTitle"
			| "scheduleMessage",
		params: Record<string, string>,
	): string;
}

export interface ToolOutcome {
	text: string;
	isError: boolean;
}

/** A started tab is ready within this; a paired host's first spawn takes longer than a local one. */
const READY_TIMEOUT_MS = 90_000;
/** A wait re-reads the session at least this often even when no tab event arrives. */
const POLL_MS = 3_000;
const STATE_TIMEOUT_MS = 5_000;
const SUMMARY_CHARS = 200;
const SESSION_PREFIX_MIN = 4;
const TOOL_RESULT_CHARS = 300;
const MESSAGE_CHARS = 1_500;

class ToolError extends Error {}

function fail(message: string): never {
	throw new ToolError(message);
}

function responseData<T>(response: RpcResponse, what: string): T {
	if (!response.success) fail(`${what} failed: ${response.error ?? "unknown error"}`);
	return response.data as T;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters)` : text;
}

function todoProgress(phases: readonly TodoPhase[] | undefined): string | null {
	const tasks = (phases ?? []).flatMap(phase => phase.tasks);
	if (tasks.length === 0) return null;
	const done = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const current = tasks.find(task => task.status === "in_progress");
	return `todos ${done}/${tasks.length} done${current ? ` (now: ${oneLine(current.content, 80)})` : ""}`;
}

function label(tab: ControlTab): string {
	return tab.hidden ? `${tab.tabId} (hidden from agents)` : tab.title ? `"${oneLine(tab.title, 80)}"` : "(untitled)";
}

/** "every 30 min", "daily at 09:00", "Mon, Wed at 09:00". */
function describeFrequency(frequency: ScheduleFrequency): string {
	if (frequency.kind === "interval") return `every ${frequency.minutes} min`;
	const days = frequency.days.map(day => WEEKDAYS[day] ?? String(day));
	return `${days.length > 0 ? days.join(", ") : "daily"} at ${frequency.time}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function contentText(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.map((block: MessageContent) => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

/** One transcript message as a line for another agent; null for the rows an agent has no use for. */
export function renderMessage(message: AgentMessage): string | null {
	switch (message.role) {
		case "user": {
			const text = contentText(message.content).trim();
			if (!text) return null;
			const wrapped = parseAgentMessage(text);
			const head = wrapped
				? `[user, sent by an agent${wrapped.from ? ` (${oneLine(wrapped.from, 60)})` : ""}]`
				: "[user]";
			return `${head} ${cut(wrapped?.body ?? text, MESSAGE_CHARS)}`;
		}
		case "assistant": {
			const parts: string[] = [];
			const text = contentText(message.content).trim();
			if (text) parts.push(`[assistant] ${cut(text, MESSAGE_CHARS)}`);
			if (Array.isArray(message.content))
				for (const block of message.content)
					if (block.type === "toolCall")
						parts.push(`[tool call] ${block.name}${block.intent ? `: ${oneLine(block.intent, 120)}` : ""}`);
			return parts.length ? parts.join("\n") : null;
		}
		case "toolResult": {
			const text = oneLine(contentText(message.content), TOOL_RESULT_CHARS);
			return `[tool result${message.isError ? " (error)" : ""}] ${message.toolName ?? ""} ${text}`.trimEnd();
		}
		case "bashExecution":
			return `[bash] ${oneLine(message.command ?? "", 160)} → exit ${message.exitCode ?? "?"}`;
		default:
			return null;
	}
}

/** What a session is doing right now, from the tail of its transcript: a tool call without a result yet. */
export function currentStep(messages: readonly AgentMessage[]): string | null {
	const answered = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const pending = message.content.filter(
			(block): block is Extract<MessageContent, { type: "toolCall" }> =>
				block.type === "toolCall" && !answered.has(block.id),
		);
		const last = pending.at(-1);
		return last ? `running ${last.name}${last.intent ? ` (${oneLine(last.intent, 80)})` : ""}` : null;
	}
	return null;
}

interface SessionState {
	state: RpcSessionState | null;
	last: string | null;
	step: string | null;
	subagents: SubagentSnapshot[];
}

type OpenArgs = OpenOne & { show?: "background" | AgentControlViewEvent["how"] };

export class AgentControl {
	readonly #host: AgentControlHost;
	readonly #limits: AgentLimits;
	/** Tabs each calling tab opened, for the open limit and the "opened by you" marks. */
	readonly #opened = new Map<string, Set<string>>();
	/** Tabs whose stop or close is in flight. */
	readonly #closing = new Set<string>();
	/** Children whose review item the person settled (approved, discarded, dismissed). */
	readonly #reviewed = new Set<string>();
	/** Files a child's last merge conflicted in, until it merges. */
	readonly #conflicts = new Map<string, string[]>();

	constructor(host: AgentControlHost, limits: AgentLimits = new AgentLimits()) {
		this.#host = host;
		this.#limits = limits;
	}

	/** Live tabs `callerTabId` opened. */
	childrenOf(callerTabId: string): string[] {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return [];
		return [...this.#openedBy(callerTabId, tabs)].filter(id => !id.startsWith("pending:"));
	}

	/** Drop a tab's queued steers and follow-ups; the turn that runs is left alone. */
	async clearQueue(tabId: string): Promise<void> {
		responseData(await this.#host.command(tabId, { type: "queue_clear" }, 15_000), "Clearing the queue");
	}

	/** A tab closed. */
	released(tabId: string): void {
		this.#limits.forget(tabId);
		this.#opened.delete(tabId);
		this.#closing.delete(tabId);
		this.#reviewed.delete(tabId);
		this.#conflicts.delete(tabId);
	}

	/** Programmatic open (Autopilot): the same path as the tool, with a tag the tool never sets. */
	async openSessions(callerTabId: string, sessions: readonly OpenOne[], tag?: string): Promise<string[]> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) fail("This session's tab is gone.");
		const caller = tabs.find(tab => tab.tabId === callerTabId);
		if (!caller) fail("This session's tab is gone.");
		return (await this.#openMany(caller, tabs, sessions, undefined, tag)).map(entry => entry.tabId);
	}

	async run(callerTabId: string, tool: AgentControlToolName, args: unknown): Promise<ToolOutcome> {
		try {
			if (!this.#host.enabled())
				fail("OMPdesk control tools are turned off (Settings › Tools & extensions). Ask the user to turn them on.");
			const tabs = this.#host.tabs(callerTabId);
			if (!tabs) fail("This session's tab is gone.");
			return { text: await this.#dispatch(callerTabId, tabs, tool, args), isError: false };
		} catch (error) {
			if (error instanceof ToolError || error instanceof LimitError) return { text: error.message, isError: true };
			return { text: `${tool} failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
		}
	}

	#stopping(callerTabId: string): boolean {
		return this.#closing.has(callerTabId) || this.#host.isStopping?.(callerTabId) === true;
	}

	async #dispatch(callerTabId: string, tabs: ControlTab[], tool: AgentControlToolName, raw: unknown): Promise<string> {
		const parsed = ARGS[tool].safeParse(raw ?? {});
		if (!parsed.success) fail(`Invalid arguments for ${tool}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
		const caller = tabs.find(tab => tab.tabId === callerTabId);
		if (!caller) fail("This session's tab is gone.");
		switch (tool) {
			case T.list:
				return this.#list(caller, tabs);
			case T.open: {
				const args = ARGS[T.open].parse(raw ?? {});
				const { sessions, show, ...single } = args;
				const items = sessions ?? [single as OpenOne];
				const results = await this.#openMany(caller, tabs, items, show);
				const text = this.#openText(results);
				if (!results.some(result => result.tabId)) fail(text);
				return text;
			}
			case T.send: {
				const args = ARGS[T.send].parse(raw);
				return this.#send(caller, this.#resolve(tabs, args.session, caller, "send to"), args);
			}
			case T.result: {
				const args = ARGS[T.result].parse(raw);
				const ids = args.sessions ?? (args.session ? [args.session] : []);
				const targets = ids.map(id => this.#resolve(tabs, id, caller, "read"));
				return this.#result(caller, targets, args, args.sessions !== undefined);
			}
			case T.read: {
				const args = ARGS[T.read].parse(raw);
				return this.#read(this.#resolve(tabs, args.session, caller, "read"), args);
			}
			case T.answer: {
				const args = ARGS[T.answer].parse(raw);
				return this.#answer(caller, this.#resolve(tabs, args.session, caller, "answer"), args);
			}
			case T.focus: {
				const args = ARGS[T.focus].parse(raw);
				const target = this.#resolve(tabs, args.session, null, "show");
				this.#refuseHidden(target, caller);
				this.#host.view(caller.tabId, { tabId: target.tabId, how: args.how ?? "focus" });
				return `Showing ${label(target)} (${args.how ?? "focus"}).`;
			}
			case T.notify: {
				const args = ARGS[T.notify].parse(raw);
				this.#host.notify(caller.tabId, args.title, args.body ?? "");
				return "Notification shown.";
			}
			case T.stop: {
				const args = ARGS[T.stop].parse(raw);
				return this.#stop(caller, tabs, this.#resolve(tabs, args.session, caller, "stop"), args);
			}
			case T.compare: {
				const args = ARGS[T.compare].parse(raw ?? {});
				return this.#compare(caller, tabs, args.sessions);
			}
			case T.merge: {
				const args = ARGS[T.merge].parse(raw);
				return this.#merge(caller, this.#resolve(tabs, args.session, caller, "merge"));
			}
			case T.schedule:
				return this.#schedule(caller, ARGS[T.schedule].parse(raw));
			case T.remember:
				return this.#remember(caller, ARGS[T.remember].parse(raw).lesson);
		}
	}

	/** An id the list printed, or a unique prefix of one; never the caller itself where `self` is passed. */
	#resolve(tabs: ControlTab[], session: string, self: ControlTab | null, verb: string): ControlTab {
		const exact = tabs.find(tab => tab.tabId === session);
		const matches = exact
			? [exact]
			: session.length >= SESSION_PREFIX_MIN
				? tabs.filter(tab => tab.tabId.startsWith(session))
				: [];
		if (matches.length > 1) fail(`"${session}" matches several sessions; use the full id from ompdesk_sessions.`);
		const target = matches[0];
		if (!target) fail(`No session "${session}" in this window. Call ompdesk_sessions for the ids.`);
		if (self && target.tabId === self.tabId) fail(`You cannot ${verb} your own session with this tool.`);
		return target;
	}

	#refuseHidden(target: ControlTab, caller: ControlTab): void {
		if (target.hidden && target.tabId !== caller.tabId)
			fail(
				"The user hid this session from other agents. Ask them to show it or to tell you what they need from it.",
			);
	}

	#openedBy(callerTabId: string, tabs: ControlTab[]): Set<string> {
		const set = this.#opened.get(callerTabId) ?? new Set<string>();
		const live = new Set(tabs.map(tab => tab.tabId));
		for (const id of set) if (!id.startsWith("pending:") && !live.has(id)) set.delete(id);
		this.#opened.set(callerTabId, set);
		return set;
	}

	async #state(tab: ControlTab): Promise<SessionState> {
		const empty: SessionState = { state: null, last: null, step: null, subagents: [] };
		if (tab.hidden || (tab.status !== "ready" && tab.status !== "running")) return empty;
		const call = <T>(command: RpcCommand, pick: (data: unknown) => T | null): Promise<T | null> =>
			this.#host
				.command(tab.tabId, command, STATE_TIMEOUT_MS)
				.then(response => (response.success ? pick(response.data) : null))
				.catch(() => null);
		const [state, last, subagents, page] = await Promise.all([
			call({ type: "get_state" }, data => (data as RpcSessionState | undefined) ?? null),
			call({ type: "get_last_assistant_text" }, data =>
				data && typeof data === "object" && "text" in data && typeof data.text === "string" ? data.text : null,
			),
			tab.busy ? call({ type: "get_subagents" }, subagentRows) : null,
			tab.busy ? call({ type: "get_transcript_page", fromEnd: true, limit: 8 }, transcriptPage) : null,
		]);
		return {
			state,
			last,
			step: page ? currentStep(page.messages) : null,
			subagents: (subagents ?? []).filter(row => row.status === "running" && row.live !== false),
		};
	}

	#stateLine(tab: ControlTab, session: SessionState): string {
		const { state, step } = session;
		const ask = tab.asks[0];
		if (ask) return `waiting for the user's answer: "${oneLine(askTitle(ask.request), 120)}"`;
		switch (tab.status) {
			case "asleep":
				return "not started (it starts when shown or messaged)";
			case "starting":
			case "restarting":
			case "waiting":
				return "starting";
			case "error":
			case "exited":
				return `stopped (${tab.status})`;
		}
		if (tab.busy || state?.isStreaming) return `running${step ? `, ${step}` : ""}`;
		if (state && state.isSettled === false) return "running (background work still going)";
		return "idle";
	}

	async #list(caller: ControlTab, tabs: ControlTab[]): Promise<string> {
		const opened = this.#openedBy(caller.tabId, tabs);
		const rows = await Promise.all(
			tabs.map(async tab => {
				const marks = [
					tab.tabId === caller.tabId ? "this session" : null,
					opened.has(tab.tabId) ? "opened by you" : null,
				].filter(Boolean);
				if (tab.hidden && tab.tabId !== caller.tabId)
					return `- ${tab.tabId} (hidden from agents by the user)${marks.length ? ` [${marks.join(", ")}]` : ""}`;
				const session = await this.#state(tab);
				const parts = [this.#stateLine(tab, session), `folder ${tab.cwd}`];
				if (tab.worktree) parts.push(`worktree ${tab.worktree.branch}`);
				if (tab.deviceName) parts.push(`on ${tab.deviceName}`);
				const model = session.state?.model;
				if (model) parts.push(`model ${model.provider}/${model.id}`);
				if (session.state?.planModeEnabled) parts.push("plan mode");
				if (session.subagents.length) parts.push(`${session.subagents.length} subagent(s) running`);
				const todos = todoProgress(session.state?.todoPhases);
				if (todos) parts.push(todos);
				const head = `- ${tab.tabId} ${label(tab)}${marks.length ? ` [${marks.join(", ")}]` : ""}`;
				const answer = session.last ? `\n  last answer: ${oneLine(session.last, SUMMARY_CHARS)}` : "";
				return `${head}\n  ${parts.join("; ")}${answer}`;
			}),
		);
		return `${tabs.length} session${tabs.length === 1 ? "" : "s"} in this window:\n${rows.join("\n")}`;
	}

	async #whenReady(tabId: string, callerTabId: string): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		for (;;) {
			const tab = this.#host.tabs(callerTabId)?.find(entry => entry.tabId === tabId);
			if (!tab) fail("The new session's tab closed before it was ready.");
			if (tab.status === "ready" || tab.status === "running") return;
			if (tab.status === "error" || tab.status === "exited") fail(`The session could not start (${tab.status}).`);
			if (Date.now() >= deadline) fail("The session did not become ready in time.");
			await this.#nextChange(Math.min(500, deadline - Date.now()));
		}
	}

	/** Resolves on the next tab event or after `ms`, whichever comes first. */
	#nextChange(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const done = (): void => {
			clearTimeout(timer);
			off();
			resolve();
		};
		const timer = setTimeout(done, Math.max(0, ms));
		const off = this.#host.observe(done);
		return promise;
	}

	async #resolveModel(tabId: string, wanted: string): Promise<ModelInfo> {
		const data = responseData<{ models?: ModelInfo[] }>(
			await this.#host.command(tabId, { type: "get_available_models" }, 15_000),
			"Reading the model list",
		);
		const models = data?.models ?? [];
		const lowered = wanted.toLowerCase();
		const exact = models.find(model => `${model.provider}/${model.id}`.toLowerCase() === lowered);
		if (exact) return exact;
		const byId = models.filter(model => model.id.toLowerCase() === lowered);
		if (byId.length === 1 && byId[0]) return byId[0];
		const near = models
			.filter(model => `${model.provider}/${model.id}`.toLowerCase().includes(lowered))
			.slice(0, 8)
			.map(model => `${model.provider}/${model.id}`);
		fail(
			byId.length > 1
				? `Model "${wanted}" is offered by several providers: ${byId.map(m => `${m.provider}/${m.id}`).join(", ")}. Give provider/id.`
				: `No model "${wanted}".${near.length ? ` Close matches: ${near.join(", ")}.` : " Use provider/id as the model picker lists it."}`,
		);
	}

	async #openMany(
		caller: ControlTab,
		tabs: ControlTab[],
		items: readonly OpenOne[],
		show?: OpenArgs["show"],
		tag?: string,
	): Promise<OpenResult[]> {
		if (this.#stopping(caller.tabId)) fail("Autopilot is ending: start nothing new.");
		const opened = this.#openedBy(caller.tabId, tabs);
		const live = [...opened].length;
		if (live + items.length > MAX_AGENT_SESSIONS)
			fail(
				`You have ${live} sessions open that you opened and asked for ${items.length} more (the limit is ${MAX_AGENT_SESSIONS} open at once). Collect their results and close some with ompdesk_session_stop, or reuse one with ompdesk_session_send.`,
			);
		const turn = this.#host.turn(caller.tabId);
		this.#limits.reserveOpens(caller.tabId, turn, items.length);
		// Reserved before the first await, so parallel opens cannot pass the limit together.
		const reservations = items.map(() => `pending:${Math.random()}`);
		for (const key of reservations) opened.add(key);
		const outcomes = await Promise.allSettled(
			items.map((item, index) => this.#openOne(caller, item, reservations[index] as string, opened, tag)),
		);
		const failed = outcomes.filter(outcome => outcome.status === "rejected").length;
		if (failed > 0) this.#limits.refundOpens(caller.tabId, turn, failed);
		const results: OpenResult[] = outcomes.map(outcome =>
			outcome.status === "fulfilled"
				? outcome.value
				: {
						tabId: "",
						error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
					},
		);
		const first = results.find(result => result.tabId);
		if (show && show !== "background" && first) this.#host.view(caller.tabId, { tabId: first.tabId, how: show });
		return results.map(result => {
			const tab = result.tabId
				? this.#host.tabs(caller.tabId)?.find(entry => entry.tabId === result.tabId)
				: undefined;
			return { ...result, where: tab ? `${tab.cwd}${tab.deviceName ? ` on ${tab.deviceName}` : ""}` : undefined };
		});
	}

	async #openOne(
		caller: ControlTab,
		args: OpenOne,
		reservation: string,
		opened: Set<string>,
		tag: string | undefined,
	): Promise<OpenResult> {
		const worktreeArg = args.worktree === true ? {} : args.worktree === false ? undefined : args.worktree;
		let tabId: string;
		let worktree: IpcTabWorktree | undefined;
		try {
			({ tabId, worktree } = await this.#host.spawn(caller.tabId, {
				folder: args.folder,
				worktree: worktreeArg,
				...(tag ? { tag } : {}),
			}));
		} finally {
			opened.delete(reservation);
		}
		opened.add(tabId);
		// Its row reads as the work it was opened for at once, not "New session" until stock names it.
		const task = args.message ? agentTaskTitle(wrapAgentMessage(args.message, caller.title)) : null;
		if (task) this.#host.setTask(tabId, task);
		try {
			await this.#whenReady(tabId, caller.tabId);
			// Journaled in the child, so its main agent gets the worker contract (gui-bridge agent-control.ts) from its
			// first turn on, across relaunches; a session the user opened never carries it.
			responseData(
				await this.#host.command(tabId, { type: "agent_control_worker", from: caller.title || "another session" }),
				"Marking the session as a worker",
			);
			const notes: string[] = [];
			if (args.model) {
				const model = await this.#resolveModel(tabId, args.model);
				responseData(
					await this.#host.command(tabId, { type: "set_model", provider: model.provider, modelId: model.id }),
					"Setting the model",
				);
				notes.push(`model ${model.provider}/${model.id}`);
			}
			if (args.mode === "plan") {
				responseData(
					await this.#host.command(tabId, { type: "set_plan_mode", enabled: true }),
					"Turning on plan mode",
				);
				notes.push("plan mode");
			}
			if (worktree) notes.push(`worktree ${worktree.branch}`);
			await this.#host.beforeFirstPrompt?.({
				tabId,
				callerTabId: caller.tabId,
				...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
				...(tag ? { tag } : {}),
			});
			if (args.message) {
				// Counts against the message budget and the relay chain like any agent message.
				this.#limits.reserveMessage(caller.tabId, tabId, this.#host.turn(caller.tabId));
				if (args.mode === "goal") {
					// The goal command starts the objective turn itself.
					responseData(
						await this.#host.command(tabId, { type: "set_goal", objective: args.message }, 30_000),
						"Setting the goal",
					);
					notes.push("goal set");
				} else {
					responseData(
						await this.#host.command(
							tabId,
							{
								type: "prompt",
								message: wrapAgentMessage(args.message, caller.title),
								streamingBehavior: "followUp",
							},
							30_000,
						),
						"Sending the first message",
					);
				}
			}
			return { tabId, notes, worktree: worktree?.branch, started: args.message !== undefined };
		} catch (error) {
			// A child that cannot be set up does not linger half-configured.
			opened.delete(tabId);
			this.#host.view(caller.tabId, { tabId, how: "close" });
			throw error;
		}
	}

	#openText(results: OpenResult[]): string {
		const lines = results.map(result =>
			result.tabId
				? `Opened session ${result.tabId}${result.where ? ` in ${result.where}` : ""}${result.notes?.length ? ` (${result.notes.join(", ")})` : ""}. ${
						result.started
							? "It is working on your message."
							: `It is idle; give it work with ompdesk_session_send {"session":"${result.tabId}","message":"…"}.`
					}`
				: `Could not open a session: ${result.error}`,
		);
		const ids = results.filter(result => result.tabId).map(result => result.tabId);
		if (ids.length > 0 && results.some(result => result.started))
			lines.push(`Collect: ompdesk_session_result {"sessions":${JSON.stringify(ids)},"wait":true}.`);
		return lines.join("\n");
	}

	async #ensureStarted(target: ControlTab, callerTabId: string): Promise<void> {
		if (target.status === "ready" || target.status === "running") return;
		if (target.status === "error" || target.status === "exited")
			fail(`${label(target)} is stopped (${target.status}); the user has to restart it.`);
		if (target.status === "asleep") this.#host.start(target.tabId);
		await this.#whenReady(target.tabId, callerTabId);
	}

	async #send(
		caller: ControlTab,
		target: ControlTab,
		args: { message: string; delivery?: "follow_up" | "steer" },
	): Promise<string> {
		if (this.#stopping(caller.tabId)) fail("Autopilot is ending: start nothing new.");
		this.#refuseHidden(target, caller);
		// A paired host's tab answers a refused quota or grant itself; the budgets here are the sender's.
		this.#limits.reserveMessage(caller.tabId, target.tabId, this.#host.turn(caller.tabId));
		await this.#ensureStarted(target, caller.tabId);
		const running = target.busy || (await this.#state(target)).state?.isStreaming === true;
		const steer = args.delivery === "steer";
		responseData(
			await this.#host.command(
				target.tabId,
				{
					type: "prompt",
					message: wrapAgentMessage(args.message, caller.title),
					streamingBehavior: steer ? "steer" : "followUp",
				},
				30_000,
			),
			"Sending the message",
		);
		const how = !running
			? "it was idle and started on it"
			: steer
				? "delivered as steer (it reads it between steps)"
				: "queued as a follow-up (it runs when the current turn ends)";
		return `Sent to ${label(target)}: ${how}.`;
	}

	async #sessionSummary(
		caller: ControlTab,
		tab: ControlTab,
		perAnswer: number,
	): Promise<{ settled: boolean; text: string }> {
		this.#refuseHidden(tab, caller);
		const session = await this.#state(tab);
		const line = this.#stateLine(tab, session);
		const settled = line === "idle" || line.startsWith("stopped") || line.startsWith("not started");
		const todos = todoProgress(session.state?.todoPhases);
		const hint = tab.asks.length > 0 ? " It needs an answer: ompdesk_session_answer, or tell the user." : "";
		const body = session.last ? cut(session.last, perAnswer) : "(no answer yet)";
		return {
			settled: settled || tab.asks.length > 0,
			text: `${label(tab)} [${tab.tabId}]: ${line}.${todos ? ` ${todos}.` : ""}${hint}\nLast answer:\n${body}`,
		};
	}

	async #result(
		caller: ControlTab,
		targets: ControlTab[],
		args: { wait?: boolean; until?: "all" | "any"; timeout_seconds?: number },
		table: boolean,
	): Promise<string> {
		const seconds = args.timeout_seconds ?? RESULT_WAIT_DEFAULT_SECONDS;
		const deadline = Date.now() + seconds * 1000;
		const ids = targets.map(tab => tab.tabId);
		for (;;) {
			const current = ids.map(id => this.#host.tabs(caller.tabId)?.find(tab => tab.tabId === id));
			const gone = current.findIndex(tab => !tab);
			if (gone >= 0) fail(`${label(targets[gone] as ControlTab)} was closed while you waited.`);
			const summaries = await Promise.all(
				(current as ControlTab[]).map(tab =>
					this.#sessionSummary(caller, tab, table ? RESULT_TABLE_ANSWER_CHARS : RESULT_MAX_CHARS),
				),
			);
			const done = summaries.filter(summary => summary.settled).length;
			const ready = args.until === "any" ? done > 0 : done === summaries.length;
			const timedOut = Date.now() >= deadline;
			if (!args.wait || ready || timedOut) {
				const note =
					args.wait && timedOut && !ready
						? `Still running after waiting ${seconds} s (${done}/${summaries.length} finished).\n`
						: "";
				const remind =
					table && ready && summaries.length > 1
						? "\nIf the user has memory on and this split taught you something, save one lesson with ompdesk_remember."
						: "";
				return `${note}${summaries.map(summary => summary.text).join("\n\n")}${remind}`;
			}
			await this.#nextChange(Math.min(POLL_MS, deadline - Date.now()));
		}
	}

	async #read(target: ControlTab, args: { limit?: number; before?: string }): Promise<string> {
		const caller = { tabId: "" } as ControlTab;
		this.#refuseHidden(target, caller);
		if (target.status !== "ready" && target.status !== "running")
			fail(`${label(target)} has not started; there is no transcript to read yet.`);
		const limit = args.limit ?? READ_DEFAULT_MESSAGES;
		const page =
			transcriptPage(
				responseData<unknown>(
					await this.#host.command(
						target.tabId,
						args.before
							? { type: "get_transcript_page", cursor: args.before, limit }
							: { type: "get_transcript_page", fromEnd: true, limit },
						30_000,
					),
					"Reading the transcript",
				),
			) ?? fail("The transcript page came back empty.");
		const lines = page.messages.map(renderMessage).filter((line): line is string => line !== null);
		let total = 0;
		const kept: string[] = [];
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i] as string;
			if (total + line.length > READ_MAX_CHARS && kept.length > 0) break;
			total += line.length;
			kept.unshift(line);
		}
		const omitted = lines.length - kept.length;
		const head = `${label(target)}: ${page.messages.length} message(s) of ${page.totalMessages}${omitted ? ` (${omitted} older ones of this page left out; use a smaller limit)` : ""}.`;
		const more = page.prevCursor
			? `\nEarlier messages: ompdesk_session_read {"session":"${target.tabId}","before":"${page.prevCursor}"}.`
			: "";
		return `${head}\n${kept.join("\n") || "(nothing to show)"}${more}`;
	}

	async #answer(caller: ControlTab, target: ControlTab, args: AnswerArgs): Promise<string> {
		this.#refuseHidden(target, caller);
		const asks = target.asks.filter(ask => !askTitle(ask.request).startsWith(AGENT_CARD_PREFIX));
		if (asks.length === 0)
			fail(
				target.asks.length > 0
					? "That is a confirmation card for the user (OMPdesk asks the person before an agent action); only the user answers it."
					: `${label(target)} is not waiting for an answer.`,
			);
		const ask = args.request ? asks.find(entry => entry.id === args.request) : asks[0];
		if (!ask) fail(`No pending request "${args.request}" there. Pending: ${asks.map(entry => entry.id).join(", ")}.`);
		const request = ask.request;
		let response: ExtensionUIResponse;
		let summary: string;
		if (request.method === "select") {
			const approval = isApprovalSelect(request);
			const choice = pickOption(
				request.options,
				args.choice ?? (args.approve === undefined ? undefined : args.approve ? "Approve" : "Deny"),
			);
			if (approval && choice === "Approve" && !this.#host.approveEnabled())
				fail(
					"사용자 승인이 필요해요: this is a tool approval in another session and the user has not let agents approve for them (Settings › Tools & extensions). Tell the user, or show the session with ompdesk_tab_focus. Deny is allowed.",
				);
			response = { type: "extension_ui_response", id: ask.id, value: choice };
			summary = `"${choice}" to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "confirm") {
			if (args.approve === undefined && args.choice === undefined)
				fail("Give approve: true or false for this confirmation.");
			const yes = args.approve ?? /^(y|yes|ok|true|confirm)/i.test(args.choice ?? "");
			response = { type: "extension_ui_response", id: ask.id, confirmed: yes };
			summary = `${yes ? "yes" : "no"} to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "input" || request.method === "editor") {
			if (args.text === undefined) fail("Give text: the answer to type into this prompt.");
			response = { type: "extension_ui_response", id: ask.id, value: args.text };
			summary = `text to "${oneLine(request.title, 100)}"`;
		} else if (request.method === "ask") {
			const given = args.answers ?? [];
			const answers = request.questions.map(question => {
				const mine =
					given.find(entry => entry.id === question.id) ?? (request.questions.length === 1 ? given[0] : undefined);
				if (!mine) fail(`Answer question "${question.id}" (${oneLine(question.question, 80)}).`);
				const labels = question.options.map(option => option.label);
				const selected = (mine.selected ?? []).map(name => pickOption(labels, name));
				if (selected.length === 0 && !mine.text)
					fail(`Question "${question.id}": choose an option (${labels.join(" | ")}) or give text.`);
				if (selected.length > 1 && !question.multi) fail(`Question "${question.id}" takes one option.`);
				return { id: question.id, selectedOptions: selected, ...(mine.text ? { customInput: mine.text } : {}) };
			});
			response = { type: "extension_ui_response", id: ask.id, answers };
			summary = `${answers.length} answer(s)`;
		} else {
			return fail("That request is not a question an agent can answer.");
		}
		await this.#host.answer(target.tabId, ask.id, response);
		await this.#host.markAnswered(target.tabId, caller.title || caller.tabId).catch(() => undefined);
		return `Answered ${label(target)}: ${summary}. It continues now.`;
	}

	/** Own children: free. Others: one confirmation card unless the user turned the card off. */
	async #stop(
		caller: ControlTab,
		tabs: ControlTab[],
		target: ControlTab,
		args: { close?: boolean; delete?: boolean },
	): Promise<string> {
		this.#refuseHidden(target, caller);
		const own = this.#openedBy(caller.tabId, tabs).has(target.tabId);
		const params = { caller: caller.title || "—", target: target.title || target.tabId };
		if (!own && !this.#host.manageEnabled()) {
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("stopTitle", params),
				this.#host.text(args.delete ? "deleteMessage" : args.close ? "closeMessage" : "stopMessage", params),
			);
			if (!approved)
				return `The user declined: ${label(target)} keeps running. Do not ask again unless they tell you to.`;
		}
		this.#closing.add(target.tabId);
		try {
			if (target.status === "ready" || target.status === "running") {
				responseData(await this.#host.command(target.tabId, { type: "abort" }), "Stopping the session");
			}
			if (args.delete) await this.#host.deleteSession(caller.tabId, target.tabId);
			else if (args.close) this.#host.view(caller.tabId, { tabId: target.tabId, how: "close" });
		} finally {
			this.#closing.delete(target.tabId);
		}
		if (args.delete) return `Stopped, closed and deleted ${label(target)}.`;
		return args.close
			? `Stopped and closed ${label(target)} (its session stays saved).`
			: `Stopped ${label(target)}.`;
	}

	async #describe(caller: ControlTab, tab: ControlTab): Promise<string> {
		this.#refuseHidden(tab, caller);
		const session = await this.#state(tab);
		const head = `- ${tab.tabId} ${label(tab)}: ${this.#stateLine(tab, session)}`;
		const answer = session.last ? `final answer: ${oneLine(session.last, 700)}` : "final answer: (none yet)";
		if (!tab.worktree) return `${head}\n  no worktree: nothing to compare as a branch.\n  ${answer}`;
		if (tab.deviceName)
			return `${head}\n  its worktree is on ${tab.deviceName}; comparing branches works on this computer's sessions only.\n  ${answer}`;
		try {
			const facts = await this.#host.branchFacts(tab.worktree);
			const added = facts.files.reduce((sum, file) => sum + file.added, 0);
			const removed = facts.files.reduce((sum, file) => sum + file.removed, 0);
			const shown = facts.files
				.slice(0, 12)
				.map(file => `${file.path} +${file.added} −${file.removed}`)
				.join(", ");
			const more = facts.files.length > 12 ? `, … ${facts.files.length - 12} more` : "";
			const problem = mergeProblem(tab.worktree, facts);
			return [
				head,
				`  branch ${facts.branch} → ${facts.baseBranch ?? "(detached)"}: ${facts.commitsAhead} commit(s) ahead, ${facts.files.length} file(s) changed (+${added} −${removed})${facts.merged ? ", already merged" : ""}`,
				`  uncommitted ${facts.uncommitted}, untracked ${facts.untracked}${shown ? `\n  files: ${shown}${more}` : ""}`,
				`  ${problem ? `cannot merge yet: ${problem}` : "ready to merge with ompdesk_merge"}`,
				`  ${answer}`,
			].join("\n");
		} catch (error) {
			return `${head}\n  could not read its branch: ${error instanceof Error ? error.message : String(error)}\n  ${answer}`;
		}
	}

	/** Facts for each worktree session: diff stat, uncommitted work and the final answer. Runs no tests. */
	async #compare(caller: ControlTab, tabs: ControlTab[], ids: string[] | undefined): Promise<string> {
		const own = this.#openedBy(caller.tabId, tabs);
		const targets = ids
			? ids.map(id => this.#resolve(tabs, id, caller, "compare"))
			: tabs.filter(tab => own.has(tab.tabId) && tab.worktree);
		if (targets.length === 0)
			fail("No worktree sessions to compare. Open sessions with worktree: true, or pass sessions.");
		const blocks = await Promise.all(targets.map(tab => this.#describe(caller, tab)));
		return `${blocks.join("\n")}\nCompare runs no tests: ask each session to run them (ompdesk_session_send) and read its answer.`;
	}

	/** Merge a worktree session's branch into the parent checkout: one card unless the user turned it off. */
	async #merge(caller: ControlTab, target: ControlTab): Promise<string> {
		const worktree = this.#mergeable(caller, target);
		const facts = await this.#host.branchFacts(worktree);
		const problem = mergeProblem(worktree, facts);
		if (problem) fail(problem);
		if (!this.#host.manageEnabled()) {
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("mergeTitle", {}),
				this.#host.text("mergeMessage", {
					caller: caller.title || "—",
					target: target.title || target.tabId,
					branch: worktree.branch,
					base: facts.baseBranch ?? "",
					cwd: worktree.baseCwd,
				}),
			);
			if (!approved)
				return `The user declined the merge of ${worktree.branch}. Do not ask again unless they tell you to.`;
		}
		return this.#runMerge(target, worktree);
	}

	#mergeable(caller: ControlTab, target: ControlTab): WorktreeRef {
		this.#refuseHidden(target, caller);
		if (!target.worktree)
			fail(`${label(target)} has no worktree branch to merge (open sessions with worktree: true).`);
		if (target.deviceName)
			fail(`${label(target)} runs on ${target.deviceName}; merging works on this computer's sessions only.`);
		if (target.busy || target.asks.length > 0)
			fail(`${label(target)} is still working or waiting; collect its result first.`);
		return target.worktree;
	}

	async #runMerge(target: ControlTab, worktree: WorktreeRef): Promise<string> {
		const outcome = await this.#host.mergeBranch(worktree, target.title);
		if (!outcome.merged) {
			this.#conflicts.set(target.tabId, outcome.files);
			fail(
				`Merge conflict in ${outcome.files.join(", ")}: the merge was aborted and ${worktree.baseCwd} is unchanged. Ask ${label(target)} to rebase or resolve against the parent's branch, then try again.`,
			);
		}
		this.#conflicts.delete(target.tabId);
		this.#reviewed.add(target.tabId);
		return `Merged ${worktree.branch} into ${worktree.baseCwd} (${outcome.sha}${outcome.summary ? `: ${outcome.summary}` : ""}). Nothing was pushed.`;
	}

	async #reviewItem(tab: ControlTab): Promise<AgentReviewItem> {
		const session = await this.#state(tab);
		const running = tab.busy || tab.asks.length > 0 || (tab.status !== "ready" && tab.status !== "running");
		const conflict = this.#conflicts.get(tab.tabId);
		const item: AgentReviewItem = {
			tabId: tab.tabId,
			title: tab.title,
			state: running ? "running" : conflict ? "conflict" : "needs-review",
			commitsAhead: 0,
			files: 0,
			added: 0,
			removed: 0,
			uncommitted: 0,
			answer: session.last ? oneLine(session.last, 240) : "",
			...(conflict ? { note: conflict.join(", ") } : {}),
		};
		if (!tab.worktree || tab.deviceName) return item;
		try {
			const facts = await this.#host.branchFacts(tab.worktree);
			return {
				...item,
				branch: facts.branch,
				baseBranch: facts.baseBranch,
				commitsAhead: facts.commitsAhead,
				files: facts.files.length,
				added: facts.files.reduce((sum, file) => sum + file.added, 0),
				removed: facts.files.reduce((sum, file) => sum + file.removed, 0),
				uncommitted: facts.uncommitted,
			};
		} catch {
			return { ...item, branch: tab.worktree.branch };
		}
	}

	/** The sessions `callerTabId` opened that wait for the person (or still run), for the work board. */
	async reviewItems(callerTabId: string): Promise<AgentReviewItem[]> {
		const tabs = this.#host.tabs(callerTabId);
		if (!tabs) return [];
		const own = this.#openedBy(callerTabId, tabs);
		const children = tabs.filter(tab => own.has(tab.tabId) && !this.#reviewed.has(tab.tabId) && !tab.hidden);
		return Promise.all(children.map(tab => this.#reviewItem(tab)));
	}

	/**
	 * The board's buttons: Approve merges a worktree session's branch into the parent checkout (the person's click is
	 * the confirmation) and accepts a session without one; Discard stops and closes the session and removes its
	 * worktree and branch; Dismiss only hides the item. Only sessions this one opened. Throws a readable message.
	 */
	async review(callerTabId: string, action: AgentReviewAction, child?: string): Promise<AgentReviewResult> {
		if (action === "list") return { items: await this.reviewItems(callerTabId) };
		const tabs = this.#host.tabs(callerTabId);
		const caller = tabs?.find(tab => tab.tabId === callerTabId);
		const target = tabs?.find(tab => tab.tabId === child);
		if (!tabs || !caller || !target || !this.#openedBy(callerTabId, tabs).has(target.tabId))
			throw new Error("That session is not one this session opened.");
		let message: string | undefined;
		let outcome: AgentReviewOutcome = action === "discard" ? "discarded" : "dismissed";
		if (action === "approve") {
			if (target.worktree) {
				const worktree = this.#mergeable(caller, target);
				const problem = mergeProblem(worktree, await this.#host.branchFacts(worktree));
				if (problem) throw new Error(problem);
				try {
					message = await this.#runMerge(target, worktree);
					outcome = "merged";
				} catch (error) {
					if (error instanceof ToolError)
						return { items: await this.reviewItems(callerTabId), outcome: "conflict", message: error.message };
					throw error;
				}
			} else {
				this.#reviewed.add(target.tabId);
				outcome = "accepted";
			}
		} else if (action === "discard") {
			this.#closing.add(target.tabId);
			try {
				if (target.status === "ready" || target.status === "running")
					await this.#host.command(target.tabId, { type: "abort" }).catch(() => undefined);
				this.#host.view(callerTabId, { tabId: target.tabId, how: "close" });
				await this.#whenGone(callerTabId, target.tabId);
				if (target.worktree && !target.deviceName) await this.#host.discardWorktree(target.worktree);
			} finally {
				this.#closing.delete(target.tabId);
			}
			this.#reviewed.add(target.tabId);
		} else this.#reviewed.add(target.tabId);
		return { items: await this.reviewItems(callerTabId), outcome, ...(message ? { message } : {}) };
	}

	/** Resolves once the tab is out of the caller's window, or after a few seconds. */
	async #whenGone(callerTabId: string, tabId: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (this.#host.tabs(callerTabId)?.some(tab => tab.tabId === tabId) && Date.now() < deadline)
			await this.#nextChange(Math.min(500, deadline - Date.now()));
	}

	/** `ompdesk_schedule`: create, list or cancel the runs an agent put on the Schedules service. */
	async #schedule(caller: ControlTab, args: ScheduleArgs): Promise<string> {
		const source = this.#host.schedules();
		if (!source) fail("Scheduled runs are not available here.");
		const rows = source.list();
		const mine = rows.filter(row => row.name.startsWith(AGENT_SCHEDULE_PREFIX));
		if (args.action === "list") {
			if (rows.length === 0) return "No scheduled runs.";
			return rows
				.map(
					row =>
						`- ${row.id} “${row.name}” ${describeFrequency(row.frequency)} in ${row.cwd}; ${row.enabled ? `next ${row.nextRun ?? "—"}` : "off"}${row.lastStatus ? `; last run ${row.lastStatus}` : ""}${row.name.startsWith(AGENT_SCHEDULE_PREFIX) ? " [made by an agent: you can cancel it]" : " [the user's own: leave it]"}`,
				)
				.join("\n");
		}
		if (args.action === "cancel") {
			const id = args.id ?? "";
			const row =
				rows.find(entry => entry.id === id) ??
				rows.find(entry => id.length >= SESSION_PREFIX_MIN && entry.id.startsWith(id));
			if (!row) fail(`No scheduled run "${id}". ompdesk_schedule {"action":"list"} shows them.`);
			if (!row.name.startsWith(AGENT_SCHEDULE_PREFIX))
				fail(`“${row.name}” is the user's own schedule; only the user changes it (Settings › Schedules).`);
			await source.remove(row.id);
			return `Cancelled “${row.name}”.`;
		}
		if (caller.deviceName)
			fail("Scheduled runs start on this computer; a session on a paired host cannot create one.");
		if (mine.length >= MAX_AGENT_SCHEDULES)
			fail(
				`${mine.length} agent-made schedules already exist (the limit is ${MAX_AGENT_SCHEDULES}). Cancel one first, or ask the user.`,
			);
		const frequency: ScheduleFrequency =
			args.every_minutes !== undefined
				? { kind: "interval", minutes: args.every_minutes }
				: { kind: "daily", time: args.daily_at ?? "09:00", days: [...new Set(args.days ?? [])].sort() };
		if (frequency.kind === "interval" && frequency.minutes < AGENT_SCHEDULE_MIN_INTERVAL_MINUTES)
			fail(`every_minutes must be at least ${AGENT_SCHEDULE_MIN_INTERVAL_MINUTES}.`);
		const cwd = args.folder ?? caller.cwd;
		if (!(cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd))) fail("folder must be an absolute path.");
		const name = `${AGENT_SCHEDULE_PREFIX}${args.name ?? ""}`;
		if (!this.#host.manageEnabled()) {
			const approved = await this.#host.confirm(
				caller.tabId,
				this.#host.text("scheduleTitle", {}),
				this.#host.text("scheduleMessage", {
					caller: caller.title || "—",
					name: args.name ?? "",
					when: describeFrequency(frequency),
					folder: cwd,
				}),
			);
			if (!approved) return "The user declined the schedule. Do not ask again unless they tell you to.";
		}
		const row = await source.save({
			name,
			prompt: args.prompt ?? "",
			cwd,
			frequency,
			model: args.model ?? null,
			autoApprove: false,
			enabled: true,
		});
		return `Scheduled “${row.name}” ${describeFrequency(frequency)} in ${cwd}; id ${row.id}; next run ${row.nextRun ?? "—"}. It runs only while OMPdesk is open, never with auto-approve; cancel it with ompdesk_schedule {"action":"cancel","id":"${row.id}"}.`;
	}

	/** `ompdesk_remember`: one short lesson about an orchestration, appended to stock's memory when the user has it on. */
	async #remember(caller: ControlTab, lesson: string): Promise<string> {
		if (this.#limits.opensWithinHour(caller.tabId) === 0)
			fail("Save a lesson after you orchestrated sessions: you opened none in the last hour.");
		if (!(await this.#host.memoryOn(caller.tabId)))
			return "The user's memory is off (Settings › Memory), so nothing was saved. Do not try again.";
		this.#limits.reserveLesson(caller.tabId);
		await this.#host.saveMemory(caller.tabId, `OMPdesk delegation lesson: ${oneLine(lesson, LESSON_MAX_CHARS)}`);
		return "Saved to the user's memory.";
	}
}

interface OpenResult {
	tabId: string;
	notes?: string[];
	worktree?: string;
	started?: boolean;
	where?: string;
	error?: string;
}

/** A `get_transcript_page` payload with its messages, or null for anything else. */
function transcriptPage(data: unknown): MessagesPage | null {
	return data && typeof data === "object" && "messages" in data && Array.isArray(data.messages)
		? (data as MessagesPage)
		: null;
}

/** `get_subagents` rows from its `{ subagents }` payload. */
function subagentRows(data: unknown): SubagentSnapshot[] {
	return data && typeof data === "object" && "subagents" in data && Array.isArray(data.subagents)
		? (data.subagents as SubagentSnapshot[])
		: [];
}

function askTitle(request: ExtensionUIRequest): string {
	if (request.method === "ask") return request.questions[0]?.question ?? "";
	return "title" in request && typeof request.title === "string" ? request.title : "";
}

/** The option named `wanted` (case-insensitive, or a unique prefix), or a readable failure listing the options. */
function pickOption(options: readonly string[], wanted: string | undefined): string {
	if (wanted === undefined) fail(`Choose one of: ${options.join(" | ")}.`);
	const lowered = wanted.trim().toLowerCase();
	const exact = options.find(option => option.toLowerCase() === lowered);
	if (exact) return exact;
	const near = options.filter(option => option.toLowerCase().startsWith(lowered));
	if (near.length === 1 && near[0]) return near[0];
	return fail(`"${wanted}" is not one of: ${options.join(" | ")}.`);
}
