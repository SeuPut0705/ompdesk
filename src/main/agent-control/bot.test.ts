import { describe, expect, it } from "vitest";
import { AGENT_HIDDEN_PREFS_KEY, BOT_PREF } from "../../shared/agent-control";
import type { HostLiveSession, IpcTabRunOutcome } from "../../shared/ipc-types";
import { BOT_ANSWER_WAIT_MS, type BotAsk, type BotDeps, BotFeed, type BotGrants, type BotTab } from "./bot";
import type { Mail, MailDelivery } from "./mail";

const BOT = "/s/bot.jsonl";

function tab(tabId: string, extra: Partial<BotTab> = {}): BotTab {
	return {
		tabId,
		title: `title ${tabId}`,
		status: "ready",
		sessionPath: `/s/${tabId}.jsonl`,
		hidden: false,
		delegated: false,
		retrying: false,
		...extra,
	};
}

function rig(options: { named?: boolean; botTab?: BotTab | null } = {}) {
	const prefs = new Map<string, unknown>();
	if (options.named !== false) prefs.set(BOT_PREF, BOT);
	const tabs = new Map<string, BotTab>();
	let botTab: BotTab | null = options.botTab === undefined ? tab("sec", { sessionPath: BOT }) : options.botTab;
	if (botTab) tabs.set(botTab.tabId, botTab);
	const sent: { path: string; mail: Mail; delivery: MailDelivery }[] = [];
	const opened: string[] = [];
	const started: string[] = [];
	const localDeviceTabs = new Set<string>();
	/** The questions open per tab. */
	const asks = new Map<string, BotAsk[]>();
	const grants: BotGrants = { control: true, approve: true };
	const now = new Date(2026, 9, 31, 7, 0).getTime();
	/** Pending timers by handle; `run` fires those armed with that delay. */
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let nextTimer = 1;
	const run = (ms: number) => {
		for (const [handle, timer] of [...timers])
			if (timer.ms === ms) {
				timers.delete(handle);
				timer.fn();
			}
	};
	const reminded: { tabId: string; ask: BotAsk }[] = [];
	const closed: string[] = [];
	/** Session files a tab here holds (besides the bot's own). */
	const held = new Set<string>();
	const deps: BotDeps = {
		prefs: { get: key => prefs.get(key), set: (key, value) => void prefs.set(key, value) },
		tab: tabId => tabs.get(tabId) ?? null,
		openAsks: tabId => asks.get(tabId) ?? [],
		grants: () => grants,
		tabOfSession: (sessionPath, device) =>
			device
				? localDeviceTabs.has(`${device}:${sessionPath}`)
					? tab("device-tab")
					: null
				: sessionPath === BOT
					? botTab
					: held.has(sessionPath)
						? tab(`held:${sessionPath}`)
						: null,
		open: async sessionPath => {
			opened.push(sessionPath);
		},
		close: sessionPath => void closed.push(sessionPath),
		start: tabId => void started.push(tabId),
		deliver: (path, mail, delivery) => void sent.push({ path, mail, delivery }),
		deviceName: id => `device ${id}`,
		log: () => undefined,
		remind: (tabId, ask) => void reminded.push({ tabId, ask }),
		now: () => now,
		setTimer: (fn, ms) => {
			const handle = nextTimer++;
			timers.set(handle, { fn, ms });
			return handle;
		},
		clearTimer: handle => void timers.delete(handle as number),
	};
	const feed = new BotFeed(deps);
	return {
		feed,
		prefs,
		sent,
		opened,
		closed,
		held,
		started,
		localDeviceTabs,
		asks,
		grants,
		reminded,
		timers,
		add: (entry: BotTab) => tabs.set(entry.tabId, entry),
		setBotTab: (entry: BotTab | null) => {
			botTab = entry;
		},
		/** The bot's answer deadline runs out. */
		overdue: () => run(BOT_ANSWER_WAIT_MS),
	};
}

const outcome = (extra: Partial<IpcTabRunOutcome> = {}): IpcTabRunOutcome => ({ stopReason: "stop", ...extra });

describe("BotFeed", () => {
	it("tells the owner after all when the bot leaves a question open past its wait", () => {
		const r = rig();
		r.add(tab("a"));
		const question = { id: "q1", title: "Which branch?", approval: false };
		const other = { id: "q2", title: "Push now?", approval: false };
		r.asks.set("a", [question, other]);
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q1", text: question.title });
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q2", text: other.title });
		expect(r.feed.answers("a", "q1")).toBe(true);
		// q2 is answered in time: its wait ends with it.
		r.asks.set("a", [question]);
		r.feed.activity({ type: "askClosed", tabId: "a", requestId: "q2" });
		r.overdue();
		expect(r.reminded).toEqual([{ tabId: "a", ask: question }]);
		// From then on the owner's own notices for it come through, its push and the tab's banner alike.
		expect(r.feed.answers("a", "q1")).toBe(false);
		expect(r.feed.answers("a")).toBe(false);
		// A question answered before the wait ran out tells nobody, and a closed tab leaves no wait behind.
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q3", text: "Retry?" });
		r.feed.activity({ type: "released", tabId: "a" });
		r.overdue();
		expect(r.reminded).toHaveLength(1);
		expect([...r.timers.values()].some(timer => timer.ms === BOT_ANSWER_WAIT_MS)).toBe(false);
	});

	it("wakes the bot for a question of a session the owner runs, to answer within what the owner asked", () => {
		const r = rig();
		r.add(tab("a"));
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q1", text: "Run the migration?" });
		expect(r.sent).toHaveLength(1);
		const [{ path, mail, delivery }] = r.sent as [(typeof r.sent)[number]];
		expect(path).toBe(BOT);
		expect(delivery).toEqual({ triggerTurn: true, deliverAs: "aside" });
		expect(mail).toMatchObject({ kind: "question", from: "a", card: "q1", text: "Run the migration?", to: "sec" });
		expect(mail.instruction).toContain('ompdesk_session_answer {"session":"a","request":"q1"}');
		expect(mail.instruction).toContain("choose the answer that does not do it");
	});

	it("leaves the bot's own session, hidden ones and sessions another agent opened alone", () => {
		const r = rig();
		r.add(tab("hidden", { hidden: true }));
		r.add(tab("child", { delegated: true }));
		for (const tabId of ["sec", "hidden", "child", "gone"])
			r.feed.activity({ type: "ask", tabId, requestId: "q", text: "?" });
		expect(r.sent).toHaveLength(0);
	});

	it("reports nothing while no session is the bot (the sidebar blob's old bot field names none)", () => {
		const r = rig({ named: false, botTab: null });
		r.prefs.set(AGENT_HIDDEN_PREFS_KEY, { agentHidden: [], bot: BOT });
		r.add(tab("a"));
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q", text: "?" });
		r.feed.activity({ type: "idle", tabId: "a", outcome: outcome() });
		expect(r.sent).toHaveLength(0);
		expect(r.feed.answers("a")).toBe(false);
	});

	it("records finished and failed turns quietly, once each, never a stop or a failure still being retried", () => {
		const r = rig();
		r.add(tab("a"));
		const done = outcome({ reply: "All tests pass." });
		r.feed.activity({ type: "idle", tabId: "a", outcome: done });
		r.feed.activity({ type: "idle", tabId: "a", outcome: done });
		r.feed.activity({ type: "idle", tabId: "a", outcome: outcome({ stopReason: "aborted" }) });
		r.feed.activity({ type: "idle", tabId: "a", outcome: undefined });
		r.add(tab("b", { retrying: true }));
		r.feed.activity({ type: "idle", tabId: "b", outcome: outcome({ stopReason: "error", errorMessage: "429" }) });
		r.add(tab("c"));
		r.feed.activity({ type: "idle", tabId: "c", outcome: outcome({ stopReason: "error", errorMessage: "boom" }) });
		expect(r.sent.map(entry => [entry.mail.from, entry.mail.kind, entry.delivery.triggerTurn])).toEqual([
			["a", "done", false],
			["c", "blocked", false],
		]);
		expect(r.sent[0]?.mail.text).toContain("All tests pass.");
		expect(r.sent[1]?.mail.text).toContain("boom");
	});

	it("keeps a quiet record for a closed or asleep bot without opening or starting it; a question still does", () => {
		const r = rig({ botTab: null });
		r.add(tab("a"));
		r.feed.activity({ type: "idle", tabId: "a", outcome: outcome({ reply: "Done." }) });
		expect(r.sent).toHaveLength(1);
		expect(r.opened).toEqual([]);
		r.setBotTab(tab("sec", { sessionPath: BOT, status: "asleep" }));
		r.feed.activity({ type: "idle", tabId: "a", outcome: outcome({ reply: "Again." }) });
		expect(r.sent).toHaveLength(2);
		expect(r.started).toEqual([]);
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q", text: "?" });
		expect(r.started).toEqual(["sec"]);
	});

	it("leaves a confirmation card OMPdesk raises for the owner to the owner, and keeps the owner's notice for it", () => {
		const r = rig();
		r.add(tab("a"));
		const card = { id: "c1", title: "[OMPdesk] Delete a session?", approval: false };
		const question = { id: "q1", title: "Which branch?", approval: false };
		r.asks.set("a", [card, question]);
		// The bot cannot answer such a card (ompdesk_session_answer refuses it): it is never reported to it.
		r.feed.activity({ type: "ask", tabId: "a", requestId: "c1", text: card.title });
		expect(r.sent).toHaveLength(0);
		// Its push still goes out; one for an ordinary question of the same tab does not.
		expect(r.feed.answers("a", "c1")).toBe(false);
		expect(r.feed.answers("a", "q1")).toBe(true);
		// A banner names no request: a tab holding such a card still notifies, one holding only questions does not.
		expect(r.feed.answers("a")).toBe(false);
		r.asks.set("a", [question]);
		expect(r.feed.answers("a")).toBe(true);
		// A question no longer open keeps its notice.
		expect(r.feed.answers("a", "gone")).toBe(false);
	});

	it("hands nothing over and silences nothing while the owner turned the agents' control tools off", () => {
		const r = rig();
		r.add(tab("a"));
		r.asks.set("a", [{ id: "q1", title: "Which branch?", approval: false }]);
		r.grants.control = false;
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q1", text: "Which branch?" });
		r.feed.liveSessions("mini", [{ sessionPath: "/h/a.jsonl", state: "waiting" }]);
		expect(r.sent).toHaveLength(0);
		expect(r.feed.answers("a", "q1")).toBe(false);
		expect(r.feed.answers("a")).toBe(false);
		// Switched back on, the bot answers again.
		r.grants.control = true;
		expect(r.feed.answers("a", "q1")).toBe(true);
	});

	it("leaves a tool approval to the owner while agents may not approve, and still takes plain questions", () => {
		const r = rig();
		r.add(tab("a"));
		const approval = { id: "t1", title: "Allow tool: bash", approval: true };
		const question = { id: "q1", title: "Which branch?", approval: false };
		r.asks.set("a", [approval, question]);
		r.grants.approve = false;
		r.feed.activity({ type: "ask", tabId: "a", requestId: "t1", text: approval.title });
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q1", text: question.title });
		expect(r.sent.map(entry => entry.mail.card)).toEqual(["q1"]);
		expect(r.feed.answers("a", "t1")).toBe(false);
		expect(r.feed.answers("a", "q1")).toBe(true);
		expect(r.feed.answers("a")).toBe(false);
		r.grants.approve = true;
		expect(r.feed.answers("a", "t1")).toBe(true);
		expect(r.feed.answers("a")).toBe(true);
	});

	it("answers for the owner's sessions only while its own tab works", () => {
		const r = rig();
		r.add(tab("a"));
		r.add(tab("child", { delegated: true }));
		for (const tabId of ["a", "sec", "child"]) r.asks.set(tabId, [{ id: "q", title: "?", approval: false }]);
		expect(r.feed.answers("a")).toBe(true);
		expect(r.feed.answers("sec")).toBe(false);
		expect(r.feed.answers("child")).toBe(false);
		r.setBotTab(tab("sec", { sessionPath: BOT, status: "error" }));
		expect(r.feed.answers("a")).toBe(false);
		r.setBotTab(null);
		expect(r.feed.answers("a")).toBe(false);
	});

	it("opens a closed bot in the background and starts an asleep one", () => {
		const r = rig({ botTab: null });
		r.add(tab("a"));
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q1", text: "?" });
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q2", text: "?" });
		expect(r.sent).toHaveLength(2);
		expect(r.opened).toEqual([BOT]);
		r.setBotTab(tab("sec", { sessionPath: BOT, status: "asleep" }));
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q3", text: "?" });
		expect(r.started).toEqual(["sec"]);
	});

	it("opens a session a paired device runs here once it waits, so its question reaches the bot, and closes it after", () => {
		const r = rig();
		const hosted = (awaitingInput: boolean, sessionPath = "/h/desk.jsonl") => ({ sessionPath, awaitingInput });
		r.feed.hostedSessions([hosted(false)]);
		expect(r.opened).toEqual([]);
		r.feed.hostedSessions([hosted(true)]);
		r.feed.hostedSessions([hosted(true)]);
		expect(r.opened).toEqual(["/h/desk.jsonl"]);
		// One a tab here already shows, one hidden from agents and the bot's own session are left as they are.
		r.held.add("/h/shown.jsonl");
		r.prefs.set(AGENT_HIDDEN_PREFS_KEY, { agentHidden: ["/h/hidden.jsonl"] });
		r.feed.hostedSessions([
			hosted(true),
			hosted(true, "/h/shown.jsonl"),
			hosted(true, "/h/hidden.jsonl"),
			hosted(true, BOT),
		]);
		expect(r.opened).toEqual(["/h/desk.jsonl"]);
		// Answered, it no longer waits: the tab the bot opened closes again.
		r.feed.hostedSessions([hosted(false)]);
		expect(r.closed).toEqual(["/h/desk.jsonl"]);
		// With the control tools off nothing is opened.
		r.grants.control = false;
		r.feed.hostedSessions([hosted(true, "/h/next.jsonl")]);
		expect(r.opened).toEqual(["/h/desk.jsonl"]);
	});

	it("follows a paired host's sessions: a new wait wakes it, an end is recorded, a tab here speaks for itself", () => {
		const r = rig();
		const list = (entries: [string, HostLiveSession["state"]][]) =>
			entries.map(([sessionPath, state]) => ({ sessionPath, state }));
		r.localDeviceTabs.add("mini:/h/shown.jsonl");
		r.feed.liveSessions(
			"mini",
			list([
				["/h/a.jsonl", "waiting"],
				["/h/b.jsonl", "turn"],
				["/h/shown.jsonl", "waiting"],
			]),
		);
		r.feed.liveSessions(
			"mini",
			list([
				["/h/a.jsonl", "waiting"],
				["/h/b.jsonl", "waiting"],
			]),
		);
		r.feed.liveSessions("mini", list([["/h/b.jsonl", "waiting"]]));
		expect(r.sent.map(entry => [entry.mail.kind, entry.mail.text, entry.delivery.triggerTurn])).toEqual([
			["question", "A session on device mini waits for an answer (/h/a.jsonl).", true],
			["question", "A session on device mini waits for an answer (/h/b.jsonl).", true],
			["done", "A session on device mini stopped working (/h/a.jsonl); how it ended is in its transcript.", false],
		]);
		expect(r.sent[0]?.mail.instruction).toContain('ompdesk_sessions {"scope":"stored","device":"mini"}');
		// The link dropped: what the host did meanwhile is unknown, so nothing is called ended.
		r.feed.liveSessions("mini", null);
		r.feed.liveSessions("mini", []);
		expect(r.sent).toHaveLength(3);
	});
});
