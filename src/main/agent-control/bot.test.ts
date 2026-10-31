import { describe, expect, it } from "vitest";
import { BOT_ENABLED_PREF, BOT_PREF } from "../../shared/agent-control";
import { BOT_RULES_PREF, botRulesText, DEFAULT_BOT_RULES } from "../../shared/bot-rules";
import { BOT_ANSWER_WAIT_MS, type BotAsk, type BotDeps, BotFeed, type BotGrants, type BotTab } from "./bot";

const BOT = "/s/bot.jsonl";

function tab(tabId: string, extra: Partial<BotTab> = {}): BotTab {
	return { tabId, status: "ready", hidden: false, ...extra };
}

/** A session the bot opened. */
const kid = (tabId: string, extra: Partial<BotTab> = {}) => tab(tabId, { openedBy: "sec", ...extra });

function rig(options: { named?: boolean; botTab?: BotTab | null; enabled?: boolean } = {}) {
	const prefs = new Map<string, unknown>();
	if (options.named !== false) prefs.set(BOT_PREF, BOT);
	if (options.enabled !== false) prefs.set(BOT_ENABLED_PREF, true);
	const tabs = new Map<string, BotTab>();
	let botTab: BotTab | null = options.botTab === undefined ? tab("sec") : options.botTab;
	if (botTab) tabs.set(botTab.tabId, botTab);
	/** The questions open per tab. */
	const asks = new Map<string, BotAsk[]>();
	const grants: BotGrants = { control: true, approve: true };
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
	/** What the bot's omp (and a side chat's) was told (`role`), and an error the next tell fails with. */
	const told: { tabId: string; rules: string; duties: string; memory?: string; channel?: string }[] = [];
	let tellError: Error | null = null;
	let duties = "";
	let memory = "";
	const channels: { id: string; sessionPath: string; title: string }[] = [];
	const deps: BotDeps = {
		prefs: { get: key => prefs.get(key) },
		tab: tabId => tabs.get(tabId) ?? null,
		openAsks: tabId => asks.get(tabId) ?? [],
		grants: () => grants,
		tabOfSession: sessionPath =>
			sessionPath === BOT ? botTab : ([...tabs.values()].find(entry => entry.tabId === sessionPath) ?? null),
		desk: () => ({ duties, memory, identity: "" }),
		channels: () => channels,
		tell: async (tabId, rules, desk, channel) => {
			if (tellError) {
				const error = tellError;
				tellError = null;
				throw error;
			}
			told.push({
				tabId,
				rules,
				duties: desk.duties,
				...(desk.memory ? { memory: desk.memory } : {}),
				...(channel === undefined ? {} : { channel }),
			});
		},
		log: () => undefined,
		remind: (tabId, ask) => void reminded.push({ tabId, ask }),
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
		told,
		setDuties: (text: string) => {
			duties = text;
		},
		setMemory: (text: string) => {
			memory = text;
		},
		/** A side chat whose session path is also the id of the tab holding it, when one does. */
		addChannel: (sessionPath: string, title: string) =>
			void channels.push({ id: `c-${sessionPath}`, sessionPath, title }),
		tellFails: (error: Error) => {
			tellError = error;
		},
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

const QUESTION = { id: "q", title: "Which branch?", approval: false };

describe("BotFeed", () => {
	it("answers only for the sessions it opened: the owner's own, another agent's and a hidden one keep their notice", () => {
		const r = rig();
		r.add(kid("kid"));
		r.add(tab("own"));
		r.add(tab("other", { openedBy: "own" }));
		r.add(kid("hidden", { hidden: true }));
		for (const tabId of ["kid", "own", "other", "hidden", "sec"]) r.asks.set(tabId, [QUESTION]);
		for (const tabId of ["kid", "own", "other", "hidden"])
			r.feed.activity({ type: "ask", tabId, requestId: "q", text: QUESTION.title });
		expect(r.feed.answers("kid", "q")).toBe(true);
		expect(r.feed.answers("kid")).toBe(true);
		for (const tabId of ["own", "other", "hidden", "sec"]) expect(r.feed.answers(tabId, "q"), tabId).toBe(false);
		// Only the bot's own session's question is waited on; nothing else is ever reminded of.
		r.overdue();
		expect(r.reminded.map(entry => entry.tabId)).toEqual(["kid"]);
	});

	it("tells the owner after all when the bot leaves a question open past its wait", () => {
		const r = rig();
		r.add(kid("a"));
		const other = { id: "q2", title: "Push now?", approval: false };
		r.asks.set("a", [QUESTION, other]);
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q", text: QUESTION.title });
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q2", text: other.title });
		// q2 is answered in time: its wait ends with it.
		r.asks.set("a", [QUESTION]);
		r.feed.activity({ type: "askClosed", tabId: "a", requestId: "q2" });
		r.overdue();
		expect(r.reminded).toEqual([{ tabId: "a", ask: QUESTION }]);
		// From then on the owner's own notices for it come through, its push and the tab's banner alike.
		expect(r.feed.answers("a", "q")).toBe(false);
		expect(r.feed.answers("a")).toBe(false);
		// A question answered before the wait ran out tells nobody, and a closed tab leaves no wait behind.
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q3", text: "Retry?" });
		r.feed.activity({ type: "released", tabId: "a" });
		r.overdue();
		expect(r.reminded).toHaveLength(1);
		expect([...r.timers.values()].some(timer => timer.ms === BOT_ANSWER_WAIT_MS)).toBe(false);
	});

	it("leaves a confirmation card OMPdesk raises for the owner to the owner, and keeps the owner's notice for it", () => {
		const r = rig();
		r.add(kid("a"));
		const card = { id: "c1", title: "[OMPdesk] Delete a session?", approval: false };
		r.asks.set("a", [card, QUESTION]);
		r.feed.activity({ type: "ask", tabId: "a", requestId: "c1", text: card.title });
		expect(r.feed.answers("a", "c1")).toBe(false);
		expect(r.feed.answers("a", "q")).toBe(true);
		// A banner names no request: a tab holding such a card still notifies, one holding only questions does not.
		expect(r.feed.answers("a")).toBe(false);
		r.asks.set("a", [QUESTION]);
		expect(r.feed.answers("a")).toBe(true);
		// A question no longer open keeps its notice.
		expect(r.feed.answers("a", "gone")).toBe(false);
		r.overdue();
		expect(r.reminded).toEqual([]);
	});

	it("silences nothing while the control tools are off, or a tool approval while agents may not approve", () => {
		const r = rig();
		r.add(kid("a"));
		const approval = { id: "t1", title: "Allow tool: bash", approval: true };
		r.asks.set("a", [approval, QUESTION]);
		r.grants.control = false;
		expect(r.feed.answers("a", "q")).toBe(false);
		r.grants.control = true;
		r.grants.approve = false;
		expect(r.feed.answers("a", "t1")).toBe(false);
		expect(r.feed.answers("a", "q")).toBe(true);
		expect(r.feed.answers("a")).toBe(false);
		r.grants.approve = true;
		expect(r.feed.answers("a")).toBe(true);
	});

	it("answers only while the owner has it on and its own tab works", () => {
		const r = rig();
		r.add(kid("a"));
		r.asks.set("a", [QUESTION]);
		expect(r.feed.answers("a")).toBe(true);
		r.setBotTab(tab("sec", { status: "error" }));
		expect(r.feed.answers("a")).toBe(false);
		r.setBotTab(null);
		expect(r.feed.answers("a")).toBe(false);
		const off = rig({ enabled: false });
		off.add(kid("a"));
		off.asks.set("a", [QUESTION]);
		off.feed.activity({ type: "ask", tabId: "a", requestId: "q", text: QUESTION.title });
		expect(off.feed.answers("a")).toBe(false);
		off.overdue();
		expect(off.reminded).toEqual([]);
	});

	describe("its role (the owner's rules for its actions)", () => {
		it("tells the bot's omp the default rules once per tab, and again only when they change", async () => {
			const r = rig();
			await r.feed.role();
			expect(r.told).toEqual([{ tabId: "sec", rules: botRulesText(DEFAULT_BOT_RULES), duties: "" }]);
			// Heard already: the sweep and every bot activity ask again at no cost.
			await r.feed.role();
			r.feed.activity({ type: "busy", tabId: "sec" });
			await r.feed.role();
			expect(r.told).toHaveLength(1);
			// The owner edits the rules: the next call carries them.
			r.prefs.set(BOT_RULES_PREF, [{ id: "deploy", action: "Deploy or release", behavior: "auto" }]);
			await r.feed.role();
			expect(r.told[1]?.rules).toBe("- Deploy or release: take it without asking.");
			// An empty list is the owner's choice too, and is told as nothing.
			r.prefs.set(BOT_RULES_PREF, []);
			await r.feed.role();
			expect(r.told[2]?.rules).toBe("");
		});

		it("tells the duties with the rules, and again when they change", async () => {
			const r = rig();
			r.setDuties("- Check the nightly build every morning (id 0a1b2c3d)");
			await r.feed.role();
			expect(r.told).toEqual([
				{
					tabId: "sec",
					rules: botRulesText(DEFAULT_BOT_RULES),
					duties: "- Check the nightly build every morning (id 0a1b2c3d)",
				},
			]);
			await r.feed.role();
			expect(r.told).toHaveLength(1);
			r.setDuties("");
			await r.feed.role();
			expect(r.told[1]?.duties).toBe("");
			r.setDuties("- Watch the release (id 11223344)");
			await r.feed.role();
			expect(r.told.map(entry => entry.duties)).toEqual([
				"- Check the nightly build every morning (id 0a1b2c3d)",
				"",
				"- Watch the release (id 11223344)",
			]);
		});

		it("tells a new tab of the bot's session again, and nothing while it has no omp, no tab or is off", async () => {
			const r = rig({ botTab: tab("asleep", { status: "asleep" }) });
			await r.feed.role();
			r.setBotTab(tab("failed", { status: "error" }));
			await r.feed.role();
			r.setBotTab(null);
			await r.feed.role();
			expect(r.told).toEqual([]);
			r.setBotTab(tab("first", { status: "starting" }));
			await r.feed.role();
			r.setBotTab(tab("second"));
			await r.feed.role();
			expect(r.told.map(entry => entry.tabId)).toEqual(["first", "second"]);
			for (const none of [rig({ named: false }), rig({ enabled: false })]) {
				await none.feed.role();
				expect(none.told).toEqual([]);
			}
		});

		it("retries a failed tell at the next call and never rejects", async () => {
			const r = rig();
			r.tellFails(new Error("omp is not ready"));
			await expect(r.feed.role()).resolves.toBeUndefined();
			expect(r.told).toEqual([]);
			await r.feed.role();
			expect(r.told).toHaveLength(1);
		});

		it("tells each side chat's tab the same desk with its topic, and the memories with the rules", async () => {
			const r = rig();
			r.setMemory("- Deploys on Fridays (id m1)");
			r.addChannel("side", "Release notes");
			r.addChannel("/s/closed.jsonl", "No tab holds this one");
			r.add(tab("side"));
			await r.feed.role();
			const rules = botRulesText(DEFAULT_BOT_RULES);
			expect(r.told).toEqual([
				{ tabId: "sec", rules, duties: "", memory: "- Deploys on Fridays (id m1)" },
				{ tabId: "side", rules, duties: "", memory: "- Deploys on Fridays (id m1)", channel: "Release notes" },
			]);
			expect(r.feed.isBotTab("side")).toBe(true);
			expect(r.feed.channelOf("side")).toEqual({ id: "c-side", title: "Release notes" });
			// A memory the bot keeps reaches every chat of its, once each.
			r.setMemory("");
			await r.feed.role();
			await r.feed.role();
			expect(r.told.slice(2).map(entry => [entry.tabId, entry.memory])).toEqual([
				["sec", undefined],
				["side", undefined],
			]);
			// Off, no side chat is the bot's either.
			r.prefs.set(BOT_ENABLED_PREF, false);
			expect(r.feed.isBotTab("side")).toBe(false);
		});
	});
});
