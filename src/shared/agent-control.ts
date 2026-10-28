/**
 * OMPdesk control tools (agent-control): host tools every tab's omp gets through stock RPC `set_host_tools`
 * (like `gui_terminal_read`), executed in main by `src/main/agent-control/`. They let the main agent open
 * sessions, message them, read their results, show them and notify the user. Stock registers host tools on
 * the RPC session only; subagents are separate sessions built without them, so only the main agent has them.
 *
 * Dependency-free: main, the renderer and their tests import it (and the bridge's dependency-free title rule).
 */

import { assignmentHeadline } from "../../resources/gui-bridge/modes/subagent-title-contracts";

/** Prefs key; on unless stored `false`. Off: the tools are unregistered from every live local session. */
export const AGENT_CONTROL_PREF = "agentControl";

/**
 * Session files (`.jsonl` paths) the user kept other agents away from (Sidebar session menu › Hide from other
 * agents), stored in the `sidebar` prefs blob as `agentHidden`. Such a session is listed as hidden and refuses
 * read, send, wait, answer, show and stop; the session's own agent still uses the tools. Sessions on this computer.
 */
export const AGENT_HIDDEN_PREFS_KEY = "sidebar";

export function agentHiddenPaths(sidebarBlob: unknown): Set<string> {
	const list =
		sidebarBlob && typeof sidebarBlob === "object" && "agentHidden" in sidebarBlob ? sidebarBlob.agentHidden : [];
	return new Set(Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
}

/**
 * Prefs key, default ON (unset counts as on; only a stored `false` is off; the user's decision, 29 Oct 2026: agents
 * have every power by default): an orchestrating agent may approve another session's pending tool approval.
 */
export const AGENT_CONTROL_APPROVE_PREF = "agentControlApprove";

/**
 * Prefs key, default ON (unset counts as on; only a stored `false` is off): an orchestrating agent may stop or close
 * sessions it did not open, merge a session's branch, create or cancel a schedule and start Autopilot without a
 * confirmation card. Permanently deleting a saved session it did not open (and every app action that deletes user
 * data) asks regardless.
 */
export const AGENT_CONTROL_MANAGE_PREF = "agentControlManage";

/**
 * Prefs key, default ON (unset counts as on; only a stored `false` is off): "Give agents full control of OMPdesk".
 * While on, no control tool or app action raises an `[OMPdesk]` card (the `always` set, a foreign delete and
 * Autopilot release or main included), an agent may approve another session's tool approval, and it may change the
 * agent-power switches themselves. Secrets stay unreadable and cards stay unanswerable whatever it says. Off: the
 * manage, approve and `always` rules apply as before.
 */
export const AGENT_CONTROL_FULL_PREF = "agentControlFull";

/** Title prefix of every confirmation card the control tools raise; `ompdesk_session_answer` never answers one. */
export const AGENT_CARD_PREFIX = "[OMPdesk] ";

export function agentControlEnabled(value: unknown): boolean {
	return value !== false;
}

/** `agentControlFull` as stored: unset is on. */
export function agentControlFullEnabled(value: unknown): boolean {
	return value !== false;
}

/** `agentControlManage` as stored: unset is on. */
export function agentControlManageEnabled(value: unknown): boolean {
	return value !== false;
}

/** `agentControlApprove` as stored: unset is on. */
export function agentControlApproveEnabled(value: unknown): boolean {
	return value !== false;
}

/** Tool names (stock mounts each as `xd://<name>`). */
export const AGENT_CONTROL_TOOLS = {
	list: "ompdesk_sessions",
	open: "ompdesk_session_open",
	send: "ompdesk_session_send",
	result: "ompdesk_session_result",
	read: "ompdesk_session_read",
	answer: "ompdesk_session_answer",
	focus: "ompdesk_tab_focus",
	notify: "ompdesk_notify",
	stop: "ompdesk_session_stop",
	compare: "ompdesk_compare",
	merge: "ompdesk_merge",
	schedule: "ompdesk_schedule",
	autopilot: "ompdesk_autopilot",
	appList: "ompdesk_app_list",
	app: "ompdesk_app",
	report: "ompdesk_report",
} as const;

/** main → window (`AGENT_CONTROL_APP`): what `ompdesk_app` changed, for the window to show or apply. */
export const AGENT_CONTROL_APP = "agent-control:app";

/** The side panel's views an agent may open (mirrors `PANEL_TABS` of the renderer's ui store; a test keeps them equal). */
export const AGENT_PANEL_TABS = ["terminal", "diff", "preview", "files"] as const;

/** The session views an agent may open as a sheet (mirrors `VIEW_SHEETS` of the renderer's ui store; a test keeps them equal). */
export const AGENT_VIEW_SHEETS = ["jobs", "plan", "logs", "tree", "work"] as const;

/** What one step back restores: a stored preference or a stock setting, as the user's own Settings control writes it. */
export type AppUndo = { kind: "pref"; key: string; value: unknown } | { kind: "setting"; path: string; value: unknown };

/**
 * A sidebar arrangement the person would make from a project's or a session's menu. The window applies it through the
 * sidebar prefs store, the one writer of the `sidebar` blob (main never writes it: the window's cached copy would
 * overwrite it with its next write).
 */
export type SidebarArrange =
	| { op: "pin-project"; path: string; pinned: boolean }
	| { op: "order-projects"; paths: string[] }
	| { op: "rename-project"; path: string; name: string | null }
	| { op: "pin-session"; sessionPath: string; pinned: boolean }
	| { op: "archive-sessions"; sessionPaths: string[]; archived: boolean };

/** What an agent may read of the `sidebar` blob: never `agentHidden`, which only the person sets. */
export interface SidebarView {
	pinnedProjects: string[];
	pinnedSessions: string[];
	aliases: Record<string, string>;
	/** Project order the person (or an agent) set, top first; empty = by recency. */
	projectOrder: string[];
}

export function sidebarViewOf(blob: unknown): SidebarView {
	const record = blob && typeof blob === "object" ? (blob as Record<string, unknown>) : {};
	const strings = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	const aliases: Record<string, string> = {};
	if (record.groupAliases && typeof record.groupAliases === "object")
		for (const [path, name] of Object.entries(record.groupAliases))
			if (typeof name === "string") aliases[path] = name;
	return {
		pinnedProjects: strings(record.pinnedGroups),
		pinnedSessions: strings(record.pinnedSessions),
		aliases,
		projectOrder: strings(record.groupOrder).filter(entry => !entry.includes("\n")),
	};
}

/** The macOS Privacy & Security panes an agent may open (it only opens the pane; the person toggles). */
export const PRIVACY_PANES = {
	accessibility: "Privacy_Accessibility",
	screen_recording: "Privacy_ScreenCapture",
	input_monitoring: "Privacy_ListenEvent",
	automation: "Privacy_Automation",
	full_disk_access: "Privacy_AllFiles",
	files_and_folders: "Privacy_FilesAndFolders",
	microphone: "Privacy_Microphone",
	camera: "Privacy_Camera",
} as const;
export type PrivacyPane = keyof typeof PRIVACY_PANES;

export const privacyPaneUrl = (pane: PrivacyPane): string =>
	`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[pane]}`;

export type AgentAppEvent =
	| { kind: "panel"; tab: (typeof AGENT_PANEL_TABS)[number] | (typeof AGENT_VIEW_SHEETS)[number] | null }
	| { kind: "settings"; section: string; sub?: string }
	| { kind: "provider-sign-in"; tabId: string; providerId: string }
	| { kind: "pref"; key: string; value: unknown }
	| { kind: "sidebar"; change: SidebarArrange }
	| { kind: "toast"; message: string; undo?: AppUndo };

export type AgentControlToolName = (typeof AGENT_CONTROL_TOOLS)[keyof typeof AGENT_CONTROL_TOOLS];

export function isAgentControlTool(name: string): name is AgentControlToolName {
	return (Object.values(AGENT_CONTROL_TOOLS) as string[]).includes(name);
}

/** Schedules an agent creates start with this, so the person sees whose they are in Settings › Schedules and only these may be cancelled by an agent. */
export const AGENT_SCHEDULE_PREFIX = "[agent] ";

/** How a session is shown in the calling session's window. */
export type AgentControlPlacement = "focus" | "split-right" | "split-down";

/**
 * main → window (`AGENT_CONTROL_VIEW`): show `tabId` the way a user's pick (`focus`) or split does, or `close` it
 * the way the user's close does (after the person approved `ompdesk_session_stop` with `close`), so unsaved Files
 * edits, split membership and the closed-tab history follow the same rules.
 */
export const AGENT_CONTROL_VIEW = "agent-control:view";

export interface AgentControlViewEvent {
	tabId: string;
	how: AgentControlPlacement | "close";
	/** A close main decided on itself (an opened session's work landed): the window refuses it for a tab the person is using. */
	auto?: true;
}

/** Prefs key (written by main): opened sessions whose tab was closed automatically, so the opener's family still lists them. */
export const AGENT_CLOSED_CHILDREN_PREF = "agentClosedChildren";
/** Records kept; the oldest go first. */
export const MAX_CLOSED_CHILDREN = 200;

/** An opened session main closed after its work landed: the session file stays; the opener's "n done" row opens it again. */
export interface ClosedChild {
	/** The child's session file. */
	path: string;
	/** The opener's session file (a tab id does not survive a relaunch). */
	openedBySession: string;
	/** What its row reads. */
	title: string;
	/** The folder to open it in: its worktree while that exists, else the checkout it was made from. */
	cwd: string;
	/** The paired device it ran on, whose stock helper holds its saved file; absent = this computer. */
	device?: string;
	closedAt: number;
	/** What it ran on and had cost when main closed it (an opener's family cost keeps counting it). */
	model?: string;
	cost?: number;
	/** That cost split by billing on the child's own host (`get_session_spend`); absent from an older record or host. */
	split?: CostSplit;
}

/** The stored list, tolerating anything else a hand-edited prefs file holds. */
export function parseClosedChildren(value: unknown): ClosedChild[] {
	if (!Array.isArray(value)) return [];
	const rows: ClosedChild[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const { path, openedBySession, title, cwd, closedAt, model, cost, split, device } = entry as Record<
			string,
			unknown
		>;
		if (typeof path !== "string" || !path || typeof openedBySession !== "string" || !openedBySession) continue;
		rows.push({
			path,
			openedBySession,
			title: typeof title === "string" ? title : "",
			cwd: typeof cwd === "string" ? cwd : "",
			closedAt: typeof closedAt === "number" ? closedAt : 0,
			...(typeof device === "string" && device ? { device } : {}),
			...(typeof model === "string" ? { model } : {}),
			...(typeof cost === "number" ? { cost } : {}),
			...(isCostSplit(split) ? { split } : {}),
		});
	}
	return rows.slice(-MAX_CLOSED_CHILDREN);
}

/**
 * The opened-session list (work board rows): the sessions an agent opened, with their status, step, clock, report and
 * diff stat. Nobody approves or discards them on the board: the opener's agent reviews and lands them with
 * `ompdesk_compare` / `ompdesk_merge` / `ompdesk_session_stop`. Main pushes the whole list for a parent session on
 * every change (`AGENT_CONTROL_REVIEW`); the renderer asks once on mount through the `agent_control_review` command.
 */
export const AGENT_CONTROL_REVIEW = "agent-control:review";

export interface AgentReviewItem {
	tabId: string;
	/**
	 * Its session file, once omp has one: a window that holds no tab of it (a phone or tablet viewing the opener a
	 * desktop window holds) ties the sidebar's stored row to this item by it.
	 */
	sessionPath?: string;
	title: string;
	/** `running`: still working (shown as progress); `needs-review`: finished; `conflict`: Approve found a merge conflict (`note` names the files). */
	state: "running" | "needs-review" | "conflict";
	/** The worktree branch and the parent's branch it would merge into; absent for a session without a worktree. */
	branch?: string;
	baseBranch?: string | null;
	commitsAhead: number;
	files: number;
	added: number;
	removed: number;
	/** Files the branch does not hold yet: tracked edits plus untracked files in the worktree. */
	uncommitted: number;
	/** The start of its last answer. */
	answer: string;
	/** What a running session is doing now (its transcript's open tool call). */
	step?: string;
	/** When its current turn started (epoch ms); absent while idle. */
	runningSince?: number;
	/** Its last turn ended in an error or was stopped. */
	failed?: true;
	note?: string;
	/** Its last report to its opener (`ompdesk_report`): kind, text and when. */
	report?: { kind: string; text: string; at: number };
	/** Its last report is a question or a blocker its opener has not answered yet. */
	waiting?: true;
	/** What it waits on when `waiting`: its open card's question (a stock `ask`, an approval) or its plan's title. */
	question?: string;
	/** The paired device the child runs on (its id), as the computer that built the list sees it; absent = that computer. */
	device?: string;
	/**
	 * The list came from a paired host (a window viewing that host's session): its tab ids are the host's, so this
	 * window opens the child by its session file on `device` (absent = this computer).
	 */
	foreign?: true;
}

/** A child that stopped with work its branch has not landed: commits nothing merged, or uncommitted files. */
export function reviewUnmerged(item: AgentReviewItem | undefined): boolean {
	return item?.branch !== undefined && item.state !== "running" && (item.commitsAhead > 0 || item.uncommitted > 0);
}

/**
 * A paired host's review list as this computer's windows read it. Each child keeps the machine it runs on: the host
 * for its own (`device` absent there), the device the host named for one opened elsewhere, and none for one that runs
 * on this computer (`self`, this computer's own id), which opens here.
 */
export function reviewFromDevice<T extends { items: readonly AgentReviewItem[] }>(
	review: T,
	host: string,
	self: string | undefined,
): T {
	return {
		...review,
		items: review.items.map(({ device, ...item }) => {
			const runsOn = device ?? host;
			return { ...item, foreign: true as const, ...(runsOn === self ? {} : { device: runsOn }) };
		}),
	};
}

/**
 * A session's spend as its two kinds, never one sum: what metered providers charged (API key, OpenRouter: judge
 * calls included) and what a subscription's calls cost at API prices, an estimate nobody is billed. Classed on the
 * host that runs the session (`get_session_spend`: its journal per provider, its own auth data), so a child's mixed
 * journal (a model switch, the judge) splits correctly whatever model it runs on now.
 */
export interface CostSplit {
	charged: number;
	estimate: number;
}

function isCostSplit(value: unknown): value is CostSplit {
	if (!value || typeof value !== "object") return false;
	const { charged, estimate } = value as Record<string, unknown>;
	return typeof charged === "number" && typeof estimate === "number";
}

/** `get_session_spend`'s providers folded into the two kinds (a free provider costs nothing). */
export function costSplitOf(providers: Readonly<Record<string, { billing: string; cost: number }>>): CostSplit {
	const split: CostSplit = { charged: 0, estimate: 0 };
	for (const row of Object.values(providers)) {
		if (!Number.isFinite(row.cost) || row.cost <= 0) continue;
		if (row.billing === "metered") split.charged += row.cost;
		else if (row.billing === "subscription") split.estimate += row.cost;
	}
	return split;
}

/**
 * What an opened session runs on and has cost so far (stock `get_state`'s model, `get_session_stats`' whole-journal
 * cost, and that cost split by billing on its own host), by its session file (its tab id until it has one): every
 * session the parent opened that has a tab, listed on the board or not.
 */
export interface AgentChildUsage {
	/** `provider/id`; absent until its omp answered. */
	model?: string;
	cost: number;
	/** Absent while its omp cannot say (an older host): the renderer then classes `cost` by `model`'s provider. */
	split?: CostSplit;
}

export interface AgentReviewEvent {
	/** The parent session whose board lists these. */
	tabId: string;
	items: AgentReviewItem[];
	/** Session file (else tab id) → what it runs on and has cost. */
	usage?: Record<string, AgentChildUsage>;
}

/** What the `agent_control_review` command answers: the opened sessions' list and what each runs on and cost. */
export interface AgentReviewResult {
	items: AgentReviewItem[];
	usage?: Record<string, AgentChildUsage>;
}

/**
 * A message one session's agent sends another session arrives as an ordinary stock prompt, steer or follow-up
 * wrapped in this tag, so the receiving model knows another agent wrote it and every surface that renders
 * the transcript (live, reloaded, a paired host's tab) shows it as "sent by an agent".
 */
export const AGENT_MESSAGE_TAG = "ompdesk-agent-message";

const WRAPPED = new RegExp(`^<${AGENT_MESSAGE_TAG} from="([^"]*)">\\n([\\s\\S]*)\\n</${AGENT_MESSAGE_TAG}>$`);

/** The text a session receives: `body` from the session titled `from` (empty when it has no title yet). */
export function wrapAgentMessage(body: string, from: string): string {
	const attribute = from
		.replaceAll(/\s+/g, " ")
		.trim()
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	// A body cannot carry its own wrapper (an agent forging another sender, or closing this one early).
	const safe = body
		.replaceAll(`<${AGENT_MESSAGE_TAG}`, `<\u200b${AGENT_MESSAGE_TAG}`)
		.replaceAll(`</${AGENT_MESSAGE_TAG}`, `</\u200b${AGENT_MESSAGE_TAG}`);
	return `<${AGENT_MESSAGE_TAG} from="${attribute}">\n${safe}\n</${AGENT_MESSAGE_TAG}>`;
}

export interface AgentMessage {
	/** The sending session's title; "" when it had none. */
	from: string;
	body: string;
}

/** The sender title an attribute carries, with the entities `wrapAgentMessage` wrote. */
function unescapeAttribute(value: string): string {
	return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** The parts of a wrapped message; null for anything else (a person's own prompt). */
export function parseAgentMessage(text: string): AgentMessage | null {
	const match = WRAPPED.exec(text);
	if (!match) return null;
	return { from: unescapeAttribute(match[1] ?? ""), body: match[2] ?? "" };
}

/**
 * The sender of a prompt that is (the start of) a wrapped message, `""` when it had no title; null for a person's own
 * prompt. Reads a message cut short, as a session listing's first-prompt prefix is.
 */
export function agentMessageSender(text: string): string | null {
	const match = WRAPPED_START.exec(text.trimStart());
	return match ? unescapeAttribute(match[1] ?? "") : null;
}

const WRAPPED_START = new RegExp(`^<${AGENT_MESSAGE_TAG} from="([^"]*)">\\n`);
const WRAPPED_END = new RegExp(`\\n</${AGENT_MESSAGE_TAG}>$`);
/** What a worker's final answer says about its own work: its last line, `Result: ok` or `Result: problem — <reason>`. */
export type WorkerResult = { kind: "ok" } | { kind: "problem"; reason: string };

const RESULT_LINE = /^[>*_\s]*Result:[*_\s]*(ok|problem)\b[*_\s]*(?:[—–:-]+\s*(.*?))?[*_\s]*$/i;

/**
 * The structured verdict a worker (`WORKER_CONTRACT`) ends its answer with; null when the last line is no such line.
 * Prose is never read: an answer that says "tests failed" without the line has no verdict.
 */
export function parseWorkerResult(answer: string | null | undefined): WorkerResult | null {
	const last = (answer ?? "").trimEnd().split("\n").at(-1) ?? "";
	const match = RESULT_LINE.exec(last);
	if (!match) return null;
	return match[1]?.toLowerCase() === "ok" ? { kind: "ok" } : { kind: "problem", reason: match[2]?.trim() ?? "" };
}

/** A task line longer than this is cut: it names a row, the transcript holds the rest. */
const TASK_TITLE_MAX = 120;

/**
 * What a session another session's agent opened (`ompdesk_session_open`, an Autopilot child) is about, from the
 * message it was opened with: the body's `Title:` line (`assignmentTitle`, the rule `task` assignments follow), else
 * its first line. Null for a person's own prompt. A message cut short (a listing's first-prompt prefix) reads too.
 */
export function agentTaskTitle(prompt: string): string | null {
	const text = prompt.trim();
	const start = WRAPPED_START.exec(text);
	if (!start) return null;
	const body = text.slice(start[0].length).replace(WRAPPED_END, "");
	const line = assignmentHeadline(body);
	if (!line) return null;
	return line.length > TASK_TITLE_MAX ? `${line.slice(0, TASK_TITLE_MAX - 1)}…` : line;
}
