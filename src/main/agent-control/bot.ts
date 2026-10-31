/**
 * The bot (봇): one session on this computer the owner names from a session's menu (the `bot` field
 * of the sidebar prefs blob, a session file). It does only what the owner asked:
 * - A question or approval of a session the owner runs (a top-level tab here, or a session a paired host works on)
 *   wakes it with a report: it answers by what the owner asked that session, and picks the answer that does not do
 *   a thing the owner did not ask for. While it is there, the owner's own "needs you" notice for such a question is
 *   not shown (`answers`).
 * - A finished or failed turn is written into its conversation quietly, for the brief: it never wakes it, and the
 *   owner's own notices for it stay as they are.
 * - Once a day from `BOT_BRIEF_HOUR` it is woken for the morning brief.
 * Sessions another session or Autopilot opened are their opener's (mail.ts `childAsked`), and a session the owner hid
 * from agents is never reported. Each report is a mail kept in the outbox until the bot's journal holds it.
 */
import { AGENT_CARD_PREFIX, AGENT_HIDDEN_PREFS_KEY } from "../../shared/agent-control";
import type { HostLiveSession, IpcTabRunOutcome, TabStatus } from "../../shared/ipc-types";
import type { TabActivity } from "../sidecar-pool";
import type { Mail, MailDelivery } from "./mail";

/** The local day (YYYY-MM-DD) the last morning brief was sent for. */
export const BOT_BRIEF_DAY_PREF = "botBriefDay";
/** The local hour from which the day's brief is sent. */
export const BOT_BRIEF_HOUR = 8;
/** How often the brief's hour is looked for. */
export const BOT_TICK_MS = 60_000;
/**
 * A question handed to the bot that is still open this long after tells the owner after all, with their own
 * "needs you" notice: the bot may be stuck or its model unreachable, and a wait is never silent.
 */
export const BOT_ANSWER_WAIT_MS = 120_000;
const REPLY_MAX = 300;

const WAKE: MailDelivery = { triggerTurn: true, deliverAs: "aside" };
const QUIET: MailDelivery = { triggerTurn: false };

/** The session file the owner named as bot, if any. */
export function botPath(blob: unknown): string | null {
	const value = blob && typeof blob === "object" ? (blob as { bot?: unknown }).bot : undefined;
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** What the feed needs to know of a live tab. */
export interface BotTab {
	tabId: string;
	title: string;
	status: TabStatus;
	sessionPath?: string;
	/** The owner hid it from agents. */
	hidden: boolean;
	/** Another session or Autopilot opened it, or it is an Autopilot run: its questions are not the bot's. */
	delegated: boolean;
	/** Its failure is not final yet (stock's retry, a scheduled retry, a dropped connection). */
	retrying: boolean;
}

/** A question or approval open in a tab. */
export interface BotAsk {
	id: string;
	title: string;
	/** A stock tool approval (`approvalChoices`): only an agent the owner lets approve may say yes to it. */
	approval: boolean;
}

/** What the owner lets agents do (Settings › Tools & extensions): the control tools at all, and approving for them. */
export interface BotGrants {
	control: boolean;
	approve: boolean;
}

export interface BotDeps {
	prefs: { get(key: string): unknown; set?(key: string, value: unknown): void };
	tab(tabId: string): BotTab | null;
	/** The questions and approvals open in the tab now. */
	openAsks(tabId: string): BotAsk[];
	grants(): BotGrants;
	/** The tab on this computer holding `sessionPath`, if any. */
	tabOfSession(sessionPath: string, device?: string): BotTab | null;
	/** Opens the session in a background tab. */
	open(sessionPath: string): Promise<void>;
	/** Spawns a restored tab's omp nobody has shown yet. */
	start(tabId: string): void;
	/** Keeps the report until the session's journal holds it, and sends it to its tab when there is one. */
	deliver(sessionPath: string, mail: Mail, delivery: MailDelivery): void;
	deviceName(deviceId: string): string;
	log(entry: Record<string, unknown>): void;
	/** Shows the owner the notice of a question the bot left open past `BOT_ANSWER_WAIT_MS`. */
	remind(tabId: string, ask: BotAsk): void;
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function localDay(at: number): { day: string; hour: number } {
	const date = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return { day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, hour: date.getHours() };
}

const DECIDE = [
	"As the owner would, approvals included: read what the owner asked that session (ompdesk_session_read) and stay inside it.",
	"When the question or approval goes beyond what the owner asked, choose the answer that does not do it (Deny, or the option that leaves things as they are).",
	"Do not ask the owner, and do nothing else: start, retry, fix or change no other work.",
	"Then write one line: Decision: <session> — <answer> — <why>.",
].join(" ");

function askInstruction(tabId: string, requestId: string): string {
	return `You are the owner's bot. Answer this for them now with ompdesk_session_answer {"session":"${tabId}","request":"${requestId}"}. ${DECIDE}`;
}

function liveInstruction(device: string, deviceName: string, sessionPath: string): string {
	return `You are the owner's bot. This session runs on ${deviceName} and waits for an answer, but no tab here shows it. Find it with ompdesk_sessions {"scope":"stored","device":"${device}"} (its file is ${sessionPath}), open it with ompdesk_session_open {"reopen":"<its id>"}, then answer its question with ompdesk_session_answer. ${DECIDE}`;
}

const RECORD_INSTRUCTION = "For the owner's next brief only: nothing to do now.";

const BRIEF_INSTRUCTION =
	"Morning brief. Write the owner a short brief from this conversation since the last brief: what finished, what failed, the questions you answered (your Decision lines), what still waits on them. Start, retry or change no work. Then call ompdesk_notify once with the brief's first line as its title.";

/**
 * The bot can answer it: the control tools are on, it is no confirmation card OMPdesk raises for the owner before
 * an agent action (`AGENT_CARD_PREFIX`, which `ompdesk_session_answer` refuses), and a tool approval only while the owner
 * lets agents approve (otherwise only Deny would go through).
 */
function answerable(ask: BotAsk, grants: BotGrants): boolean {
	return grants.control && !ask.title.startsWith(AGENT_CARD_PREFIX) && (!ask.approval || grants.approve);
}

function handedKey(tabId: string, requestId: string): string {
	return `${tabId}\n${requestId}`;
}

export class BotFeed {
	readonly #deps: BotDeps;
	/** Run outcomes already recorded: a compaction may settle the same run again. */
	readonly #recorded = new WeakSet<IpcTabRunOutcome>();
	/** Per paired host, the state of each session it works on as last heard; absent until its first list. */
	readonly #live = new Map<string, Map<string, HostLiveSession["state"]>>();
	#opening: Promise<void> | null = null;
	/** Questions handed to the bot, by tab and request: the wait for its answer, and whether it ran out. */
	readonly #handed = new Map<string, { timer: unknown; overdue: boolean }>();
	#seq = 0;
	#timer: unknown;

	constructor(deps: BotDeps) {
		this.#deps = deps;
		this.#tick();
	}

	#path(): string | null {
		return botPath(this.#deps.prefs.get(AGENT_HIDDEN_PREFS_KEY));
	}

	/** The bot's tab, when one is named and a tab here holds it. */
	#bot(): BotTab | null {
		const path = this.#path();
		return path ? this.#deps.tabOfSession(path) : null;
	}

	/**
	 * The owner's notice for a question of `tabId` would only repeat the bot's work: the bot is there, the
	 * tab is one it reports and the question is one it can answer (`answerable`). `requestId` names the question; a
	 * notice that names none (a desktop banner) is silenced only while every question open in the tab is answerable.
	 * A question no longer open, one the bot cannot answer, or one it left open past `BOT_ANSWER_WAIT_MS`
	 * keeps the owner's notice.
	 */
	answers(tabId: string, requestId?: string): boolean {
		const grants = this.#deps.grants();
		if (!grants.control) return false;
		const bot = this.#bot();
		if (!bot || bot.status === "error" || bot.status === "exited") return false;
		const tab = this.#deps.tab(tabId);
		if (!tab || !this.#reported(tab, bot.tabId)) return false;
		const asks = this.#deps.openAsks(tabId);
		if (requestId !== undefined) {
			const ask = asks.find(entry => entry.id === requestId);
			return ask !== undefined && answerable(ask, grants) && !this.#overdue(tabId, ask.id);
		}
		return asks.length > 0 && asks.every(ask => answerable(ask, grants) && !this.#overdue(tabId, ask.id));
	}

	#overdue(tabId: string, requestId: string): boolean {
		return this.#handed.get(handedKey(tabId, requestId))?.overdue === true;
	}

	/** The bot has `BOT_ANSWER_WAIT_MS` to answer `ask`; still open then, the owner hears of it. */
	#await(tabId: string, ask: BotAsk): void {
		const key = handedKey(tabId, ask.id);
		if (this.#handed.has(key)) return;
		const timer = this.#deps.setTimer(() => {
			const handed = this.#handed.get(key);
			if (!handed) return;
			if (!this.#deps.openAsks(tabId).some(entry => entry.id === ask.id)) {
				this.#handed.delete(key);
				return;
			}
			handed.overdue = true;
			this.#deps.log({ event: "overdue", tabId, request: ask.id });
			this.#deps.remind(tabId, ask);
		}, BOT_ANSWER_WAIT_MS);
		this.#handed.set(key, { timer, overdue: false });
	}

	#settled(tabId: string, requestId?: string): void {
		for (const [key, handed] of this.#handed) {
			if (requestId === undefined ? !key.startsWith(`${tabId}\n`) : key !== handedKey(tabId, requestId)) continue;
			this.#deps.clearTimer(handed.timer);
			this.#handed.delete(key);
		}
	}

	#reported(tab: BotTab, botTabId: string | undefined): boolean {
		return tab.tabId !== botTabId && !tab.hidden && !tab.delegated;
	}

	/** `SidecarPool.observeTabs`'s listener. */
	activity(activity: TabActivity): void {
		if (activity.type === "askClosed") return this.#settled(activity.tabId, activity.requestId);
		if (activity.type === "released") return this.#settled(activity.tabId);
		if (activity.type !== "ask" && activity.type !== "idle") return;
		const path = this.#path();
		if (!path) return;
		const tab = this.#deps.tab(activity.tabId);
		if (!tab || !this.#reported(tab, this.#deps.tabOfSession(path)?.tabId)) return;
		if (activity.type === "ask") {
			// The ask is held before it is announced (SidecarPool `#holdRequest`); a title alone is never an approval.
			const ask = this.#deps.openAsks(tab.tabId).find(entry => entry.id === activity.requestId) ?? {
				id: activity.requestId,
				title: activity.text,
				approval: false,
			};
			if (!answerable(ask, this.#deps.grants())) return;
			this.#send(
				path,
				{
					id: `bot-ask-${tab.tabId}-${activity.requestId}`,
					from: tab.tabId,
					fromTitle: tab.title,
					kind: "question",
					text: activity.text || "(a question card)",
					card: activity.requestId,
					instruction: askInstruction(tab.tabId, activity.requestId),
				},
				WAKE,
			);
			this.#await(tab.tabId, ask);
			return;
		}
		const outcome = activity.outcome;
		// No run ended (a compaction finished), one already recorded, Stop, or a failure still being retried.
		if (!outcome || this.#recorded.has(outcome) || outcome.stopReason === "aborted") return;
		if (outcome.stopReason === "error" && tab.retrying) return;
		this.#recorded.add(outcome);
		const failed = outcome.stopReason === "error";
		this.#send(
			path,
			{
				id: `bot-run-${tab.tabId}-${this.#deps.now()}-${++this.#seq}`,
				from: tab.tabId,
				fromTitle: tab.title,
				kind: failed ? "blocked" : "done",
				text: failed
					? `Its turn failed${outcome.errorMessage ? `: ${clip(outcome.errorMessage, REPLY_MAX)}` : "."}`
					: `Its turn finished${outcome.reply ? `: ${clip(outcome.reply, REPLY_MAX)}` : "."}`,
				instruction: RECORD_INSTRUCTION,
			},
			QUIET,
		);
	}

	/**
	 * A paired host's sessions at work (`host.liveSessions`), or null when its link went down. A session that starts
	 * waiting wakes the bot; one that left the list is recorded as ended. A session a tab here shows is reported
	 * through that tab's own activity instead.
	 */
	liveSessions(device: string, sessions: readonly HostLiveSession[] | null): void {
		const before = this.#live.get(device);
		if (!sessions) {
			this.#live.delete(device);
			return;
		}
		const now = new Map(sessions.map(session => [session.sessionPath, session.state]));
		this.#live.set(device, now);
		const path = this.#deps.grants().control ? this.#path() : null;
		if (!path) return;
		const name = this.#deps.deviceName(device);
		for (const [sessionPath, state] of now) {
			if (state !== "waiting" || before?.get(sessionPath) === "waiting") continue;
			if (this.#deps.tabOfSession(sessionPath, device)) continue;
			this.#send(
				path,
				{
					id: `bot-live-${device}-${sessionPath}-${this.#deps.now()}`,
					from: "ompdesk",
					fromTitle: `${name}: ${sessionPath}`,
					kind: "question",
					text: `A session on ${name} waits for an answer (${sessionPath}).`,
					instruction: liveInstruction(device, name, sessionPath),
				},
				WAKE,
			);
		}
		if (!before) return;
		for (const sessionPath of before.keys()) {
			if (now.has(sessionPath) || this.#deps.tabOfSession(sessionPath, device)) continue;
			this.#send(
				path,
				{
					id: `bot-live-end-${device}-${sessionPath}-${this.#deps.now()}`,
					from: "ompdesk",
					fromTitle: `${name}: ${sessionPath}`,
					kind: "done",
					text: `A session on ${name} stopped working (${sessionPath}); how it ended is in its transcript.`,
					instruction: RECORD_INSTRUCTION,
				},
				QUIET,
			);
		}
	}

	/** The morning brief, once per local day from `BOT_BRIEF_HOUR` (a day the app was closed has none). */
	#tick(): void {
		this.#timer = this.#deps.setTimer(() => this.#tick(), BOT_TICK_MS);
		const path = this.#path();
		if (!path) return;
		const { day, hour } = localDay(this.#deps.now());
		if (hour < BOT_BRIEF_HOUR || this.#deps.prefs.get(BOT_BRIEF_DAY_PREF) === day) return;
		this.#deps.prefs.set?.(BOT_BRIEF_DAY_PREF, day);
		this.#send(
			path,
			{
				id: `bot-brief-${day}`,
				from: "ompdesk",
				fromTitle: "OMPdesk",
				kind: "note",
				text: `Morning brief for ${day}.`,
				instruction: BRIEF_INSTRUCTION,
			},
			WAKE,
		);
	}

	#send(path: string, mail: Omit<Mail, "to" | "at">, delivery: MailDelivery): void {
		const bot = this.#deps.tabOfSession(path);
		this.#deps.log({ event: mail.kind, id: mail.id, from: mail.from, wake: delivery.triggerTurn });
		this.#deps.deliver(path, { ...mail, to: bot?.tabId ?? "", at: this.#deps.now() }, delivery);
		if (!bot) this.#open(path);
		else if (bot.status === "asleep") this.#deps.start(bot.tabId);
	}

	#open(path: string): void {
		this.#opening ??= this.#deps
			.open(path)
			.catch(error => this.#deps.log({ event: "open-failed", error: String(error) }))
			.finally(() => {
				this.#opening = null;
			});
	}

	dispose(): void {
		this.#deps.clearTimer(this.#timer);
		for (const handed of this.#handed.values()) this.#deps.clearTimer(handed.timer);
		this.#handed.clear();
	}
}
