import { describe, expect, it } from "vitest";
import { AGENT_HIDDEN_PREFS_KEY } from "../../shared/agent-control";
import type { HostLiveSession, IpcTabRunOutcome } from "../../shared/ipc-types";
import type { Mail, MailDelivery } from "./mail";
import { SECRETARY_BRIEF_DAY_PREF, type SecretaryDeps, SecretaryFeed, type SecretaryTab } from "./secretary";

const SECRETARY = "/s/secretary.jsonl";

function tab(tabId: string, extra: Partial<SecretaryTab> = {}): SecretaryTab {
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

function rig(options: { named?: boolean; secretaryTab?: SecretaryTab | null; at?: Date } = {}) {
	const prefs = new Map<string, unknown>();
	if (options.named !== false) prefs.set(AGENT_HIDDEN_PREFS_KEY, { agentHidden: [], secretary: SECRETARY });
	const tabs = new Map<string, SecretaryTab>();
	let secretaryTab: SecretaryTab | null =
		options.secretaryTab === undefined ? tab("sec", { sessionPath: SECRETARY }) : options.secretaryTab;
	if (secretaryTab) tabs.set(secretaryTab.tabId, secretaryTab);
	const sent: { path: string; mail: Mail; delivery: MailDelivery }[] = [];
	const opened: string[] = [];
	const started: string[] = [];
	const localDeviceTabs = new Set<string>();
	let now = (options.at ?? new Date(2026, 9, 31, 7, 0)).getTime();
	let tick: (() => void) | null = null;
	const deps: SecretaryDeps = {
		prefs: { get: key => prefs.get(key), set: (key, value) => void prefs.set(key, value) },
		tab: tabId => tabs.get(tabId) ?? null,
		tabOfSession: (sessionPath, device) =>
			device
				? localDeviceTabs.has(`${device}:${sessionPath}`)
					? tab("device-tab")
					: null
				: sessionPath === SECRETARY
					? secretaryTab
					: null,
		open: async sessionPath => {
			opened.push(sessionPath);
		},
		start: tabId => void started.push(tabId),
		deliver: (path, mail, delivery) => void sent.push({ path, mail, delivery }),
		deviceName: id => `device ${id}`,
		log: () => undefined,
		now: () => now,
		setTimer: fn => {
			tick = fn;
			return 1;
		},
		clearTimer: () => undefined,
	};
	const feed = new SecretaryFeed(deps);
	return {
		feed,
		prefs,
		sent,
		opened,
		started,
		localDeviceTabs,
		add: (entry: SecretaryTab) => tabs.set(entry.tabId, entry),
		setSecretaryTab: (entry: SecretaryTab | null) => {
			secretaryTab = entry;
		},
		at: (date: Date) => {
			now = date.getTime();
			tick?.();
		},
	};
}

const outcome = (extra: Partial<IpcTabRunOutcome> = {}): IpcTabRunOutcome => ({ stopReason: "stop", ...extra });

describe("SecretaryFeed", () => {
	it("wakes the secretary for a question of a session the owner runs, to answer within what the owner asked", () => {
		const r = rig();
		r.add(tab("a"));
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q1", text: "Run the migration?" });
		expect(r.sent).toHaveLength(1);
		const [{ path, mail, delivery }] = r.sent as [(typeof r.sent)[number]];
		expect(path).toBe(SECRETARY);
		expect(delivery).toEqual({ triggerTurn: true, deliverAs: "aside" });
		expect(mail).toMatchObject({ kind: "question", from: "a", card: "q1", text: "Run the migration?", to: "sec" });
		expect(mail.instruction).toContain('ompdesk_session_answer {"session":"a","request":"q1"}');
		expect(mail.instruction).toContain("choose the answer that does not do it");
	});

	it("leaves the secretary's own session, hidden ones and sessions another agent opened alone", () => {
		const r = rig();
		r.add(tab("hidden", { hidden: true }));
		r.add(tab("child", { delegated: true }));
		for (const tabId of ["sec", "hidden", "child", "gone"])
			r.feed.activity({ type: "ask", tabId, requestId: "q", text: "?" });
		expect(r.sent).toHaveLength(0);
	});

	it("reports nothing while no session is the secretary", () => {
		const r = rig({ named: false, secretaryTab: null });
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

	it("answers for the owner's sessions only while its own tab works", () => {
		const r = rig();
		r.add(tab("a"));
		r.add(tab("child", { delegated: true }));
		expect(r.feed.answers("a")).toBe(true);
		expect(r.feed.answers("sec")).toBe(false);
		expect(r.feed.answers("child")).toBe(false);
		r.setSecretaryTab(tab("sec", { sessionPath: SECRETARY, status: "error" }));
		expect(r.feed.answers("a")).toBe(false);
		r.setSecretaryTab(null);
		expect(r.feed.answers("a")).toBe(false);
	});

	it("opens a closed secretary in the background and starts an asleep one", () => {
		const r = rig({ secretaryTab: null });
		r.add(tab("a"));
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q1", text: "?" });
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q2", text: "?" });
		expect(r.sent).toHaveLength(2);
		expect(r.opened).toEqual([SECRETARY]);
		r.setSecretaryTab(tab("sec", { sessionPath: SECRETARY, status: "asleep" }));
		r.feed.activity({ type: "ask", tabId: "a", requestId: "q3", text: "?" });
		expect(r.started).toEqual(["sec"]);
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

	it("sends the morning brief once a day from 8 o'clock", () => {
		const r = rig({ at: new Date(2026, 9, 31, 7, 59) });
		expect(r.sent).toHaveLength(0);
		r.at(new Date(2026, 9, 31, 8, 0));
		r.at(new Date(2026, 9, 31, 12, 0));
		expect(r.sent).toHaveLength(1);
		expect(r.sent[0]?.mail).toMatchObject({ id: "secretary-brief-2026-10-31", kind: "note" });
		expect(r.sent[0]?.delivery.triggerTurn).toBe(true);
		expect(r.prefs.get(SECRETARY_BRIEF_DAY_PREF)).toBe("2026-10-31");
		r.at(new Date(2026, 10, 1, 6, 0));
		r.at(new Date(2026, 10, 1, 9, 30));
		expect(r.sent.map(entry => entry.mail.id)).toEqual(["secretary-brief-2026-10-31", "secretary-brief-2026-11-01"]);
	});

	it("briefs at once when the app starts after the hour, and never without a secretary", () => {
		expect(rig({ at: new Date(2026, 9, 31, 10, 0) }).sent).toHaveLength(1);
		expect(rig({ at: new Date(2026, 9, 31, 10, 0), named: false, secretaryTab: null }).sent).toHaveLength(0);
	});
});
