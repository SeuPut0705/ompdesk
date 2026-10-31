/**
 * The bot (봇): the one session on this computer that works for the owner while they have it on. Main keeps it
 * (`bot-home.ts`: pref `bot` names its session file). It answers only for the sessions it manages, the ones it opened
 * (the owner's rule, 31 Oct 2026: "봇이 관리하는 세션만 봇이 대답해야지"): their questions reach it as any opener's do
 * (`AgentControl.childAsked`), and the owner's own sessions, a paired device's, and those another agent opened are never
 * handed to it.
 * - While it can answer such a question (`answers`), the owner's own "needs you" notice for it is not shown; one it
 *   leaves open past `BOT_ANSWER_WAIT_MS` notifies the owner after all.
 * - Its omp is told the owner's action rules and its standing duties (`role`: `agent_control_bot`, journaled by the
 *   bridge, which adds the bot role, the duties and those rules to its prompt), at each start of its tab and when
 *   either changes.
 */
import { AGENT_CARD_PREFIX, activeBotPath } from "../../shared/agent-control";
import { BOT_RULES_PREF, botRulesText, parseBotRules } from "../../shared/bot-rules";
import type { TabStatus } from "../../shared/ipc-types";
import type { TabActivity } from "../sidecar-pool";

/**
 * A question handed to the bot that is still open this long after tells the owner after all, with their own
 * "needs you" notice: the bot may be stuck or its model unreachable, and a wait is never silent.
 */
export const BOT_ANSWER_WAIT_MS = 120_000;

/** What the feed needs to know of a live tab. */
export interface BotTab {
	tabId: string;
	status: TabStatus;
	/** The owner hid it from agents. */
	hidden: boolean;
	/** The tab of the session that opened it through the control tools, if one did. */
	openedBy?: string;
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
	prefs: { get(key: string): unknown };
	tab(tabId: string): BotTab | null;
	/** The questions and approvals open in the tab now. */
	openAsks(tabId: string): BotAsk[];
	grants(): BotGrants;
	/** The tab on this computer holding `sessionPath`, if any. */
	tabOfSession(sessionPath: string): BotTab | null;
	/** Tells the bot's omp its rules and its duties as its prompt lists them (`agent_control_bot`); rejects when it could not. */
	tell(tabId: string, rules: string, duties: string): Promise<void>;
	/** The bot's standing duties as its prompt lists them (`botDutiesText`); empty when there are none. */
	duties(): string;
	log(entry: Record<string, unknown>): void;
	/** Shows the owner the notice of a question the bot left open past `BOT_ANSWER_WAIT_MS`. */
	remind(tabId: string, ask: BotAsk): void;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

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
	/** Questions the bot is answering, by tab and request: the wait for its answer, and whether it ran out. */
	readonly #handed = new Map<string, { timer: unknown; overdue: boolean }>();
	/** The tab, rules and duties the bot's omp was last told (`role`), as one JSON line. */
	#told: string | null = null;
	#telling: Promise<void> = Promise.resolve();

	constructor(deps: BotDeps) {
		this.#deps = deps;
	}

	/** The bot's tab, while the owner has the bot on and a tab here holds its session. */
	#bot(): BotTab | null {
		const path = activeBotPath(key => this.#deps.prefs.get(key));
		return path ? this.#deps.tabOfSession(path) : null;
	}

	/** `tab` is one the bot manages: it opened it, and the owner did not hide it from agents. */
	#manages(tab: BotTab, bot: BotTab): boolean {
		return tab.openedBy === bot.tabId && !tab.hidden;
	}

	/**
	 * The owner's notice for a question of `tabId` would only repeat the bot's work: the bot is there and working, it
	 * opened the tab, and the question is one it can answer (`answerable`). `requestId` names the question; a notice
	 * that names none (a desktop banner) is silenced only while every question open in the tab is answerable. A
	 * question no longer open, one the bot cannot answer, or one it left open past `BOT_ANSWER_WAIT_MS` keeps the
	 * owner's notice.
	 */
	answers(tabId: string, requestId?: string): boolean {
		const grants = this.#deps.grants();
		if (!grants.control) return false;
		const bot = this.#bot();
		if (!bot || bot.status === "error" || bot.status === "exited") return false;
		const tab = this.#deps.tab(tabId);
		if (!tab || !this.#manages(tab, bot)) return false;
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

	/** `SidecarPool.observeTabs`'s listener. */
	activity(activity: TabActivity): void {
		// Whatever the bot's tab does proves its omp is up: tell it the rules if it has not heard them yet.
		if (activity.type !== "released" && this.isBotTab(activity.tabId)) void this.role();
		if (activity.type === "askClosed") return this.#settled(activity.tabId, activity.requestId);
		if (activity.type === "released") return this.#settled(activity.tabId);
		if (activity.type !== "ask") return;
		const bot = this.#bot();
		const tab = this.#deps.tab(activity.tabId);
		if (!bot || !tab || !this.#manages(tab, bot)) return;
		// The ask is held before it is announced (SidecarPool `#holdRequest`); a title alone is never an approval.
		const ask = this.#deps.openAsks(tab.tabId).find(entry => entry.id === activity.requestId) ?? {
			id: activity.requestId,
			title: activity.text,
			approval: false,
		};
		if (!answerable(ask, this.#deps.grants())) return;
		this.#deps.log({ event: "question", tabId: tab.tabId, request: ask.id });
		this.#await(tab.tabId, ask);
	}

	/**
	 * Tells the bot's omp the owner's rules for its actions and its standing duties (`deps.tell`; its bridge adds the
	 * bot role to the prompt), once per tab and text: at each start of its tab, and again when the rules or the duties
	 * change. A tab with no omp (asleep, exited, failed) is told when it starts. Never rejects: a failed tell is logged
	 * and tried again by the next call.
	 */
	role(): Promise<void> {
		this.#telling = this.#telling.then(() => this.#tell());
		return this.#telling;
	}

	/** The tab holding the bot's session is `tabId`. */
	isBotTab(tabId: string): boolean {
		return this.#bot()?.tabId === tabId;
	}

	async #tell(): Promise<void> {
		const bot = this.#bot();
		if (!bot || bot.status === "asleep" || bot.status === "exited" || bot.status === "error") return;
		const rules = botRulesText(parseBotRules(this.#deps.prefs.get(BOT_RULES_PREF)));
		const duties = this.#deps.duties();
		const told = JSON.stringify([bot.tabId, rules, duties]);
		if (this.#told === told) return;
		try {
			await this.#deps.tell(bot.tabId, rules, duties);
			this.#told = told;
		} catch (error) {
			this.#deps.log({ event: "role-failed", tabId: bot.tabId, error: String(error) });
		}
	}

	dispose(): void {
		for (const handed of this.#handed.values()) this.#deps.clearTimer(handed.timer);
		this.#handed.clear();
	}
}
