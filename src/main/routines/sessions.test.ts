import { describe, expect, it } from "vitest";
import type { TabActivity } from "../sidecar-pool";
import { createSessionSource, type SessionPorts, type SessionTab } from "./sessions";
import { fakeContext } from "./test-context";

const BOT = "/s/bot.jsonl";

/** A pool whose tabs the test lists; `emit` is the tab activity the pool announces. */
function fakePool(tabs: SessionTab[], botPath: string | null = BOT) {
	const observers = new Set<(activity: TabActivity) => void>();
	const ports: SessionPorts = {
		observeTabs: observer => {
			observers.add(observer);
			return () => observers.delete(observer);
		},
		tabs: () => tabs,
		botPath: () => botPath,
	};
	const emit = (activity: TabActivity) => {
		for (const observer of observers) observer(activity);
	};
	return { ports, observers, emit };
}

const tab = (tabId: string, extra: Partial<SessionTab> = {}): SessionTab => ({
	tabId,
	sessionFile: `/s/${tabId}.jsonl`,
	cwd: "/x/y",
	title: "Refactor",
	...extra,
});
const idle = (tabId: string, stopReason = "stop", errorMessage?: string): TabActivity => ({
	type: "idle",
	tabId,
	outcome: { stopReason, ...(errorMessage ? { errorMessage } : {}) },
});

describe("session source", () => {
	it("fires once when a session finishes a turn, naming its title and folder, and again after its next turn", () => {
		const pool = fakePool([tab("a")]);
		const { context, fired } = fakeContext();
		createSessionSource({ events: ["done"], sessions: pool.ports, context });
		pool.emit(idle("a"));
		pool.emit(idle("a"));
		expect(fired).toEqual(['Session "Refactor" in /x/y finished its turn']);
		pool.emit({ type: "busy", tabId: "a" });
		pool.emit(idle("a"));
		expect(fired).toHaveLength(2);
	});

	it("tells a failed turn with its error, a waiting session with its question, and only the kinds it follows", () => {
		const pool = fakePool([tab("a")]);
		const failed = fakeContext();
		createSessionSource({ events: ["failed"], sessions: pool.ports, context: failed.context });
		const waiting = fakeContext();
		createSessionSource({ events: ["waiting"], sessions: pool.ports, context: waiting.context });
		pool.emit(idle("a", "error", "Rate limited"));
		pool.emit(idle("a", "stop"));
		pool.emit({ type: "ask", tabId: "a", requestId: "r1", text: "Delete the file?" });
		pool.emit({ type: "ask", tabId: "a", requestId: "r1", text: "Delete the file?" });
		expect(failed.fired).toEqual(['Session "Refactor" in /x/y failed its turn: Rate limited']);
		expect(waiting.fired).toEqual(['Session "Refactor" in /x/y is waiting for an answer: Delete the file?']);
	});

	it("ignores a turn the person stopped, an idle with no outcome and a tab with no session", () => {
		const pool = fakePool([tab("a"), tab("b", { sessionFile: undefined })]);
		const { context, fired } = fakeContext();
		createSessionSource({ events: ["done", "failed"], sessions: pool.ports, context });
		pool.emit(idle("a", "aborted"));
		pool.emit({ type: "idle", tabId: "a", outcome: undefined });
		pool.emit(idle("b"));
		pool.emit(idle("gone"));
		expect(fired).toEqual([]);
	});

	it("never fires for the bot, a session the bot opened (by tab or by file), what those opened, or a paired host's tab", () => {
		const pool = fakePool([
			tab("bot", { sessionFile: BOT }),
			tab("kid", { openedBy: "bot" }),
			tab("grandkid", { openedBy: "kid" }),
			tab("relaunched", { openedBy: "stale-tab-id", openedBySession: BOT }),
			tab("remote", { device: "dev-1" }),
			tab("own"),
		]);
		const { context, fired } = fakeContext();
		createSessionSource({ events: ["done"], sessions: pool.ports, context });
		for (const id of ["bot", "kid", "grandkid", "relaunched", "remote"]) pool.emit(idle(id));
		expect(fired).toEqual([]);
		pool.emit(idle("own"));
		expect(fired).toHaveLength(1);
	});

	it("follows the bot's family only while the bot is on, and never the session a wake-up routine delivers into", () => {
		const off = fakePool([tab("bot", { sessionFile: BOT }), tab("kid", { openedBy: "bot" })], null);
		const a = fakeContext();
		createSessionSource({ events: ["done"], sessions: off.ports, context: a.context });
		off.emit(idle("bot"));
		off.emit(idle("kid"));
		expect(a.fired).toHaveLength(2);

		const pool = fakePool(
			[tab("wake", { sessionFile: "/s/wake.jsonl" }), tab("wakeKid", { openedBy: "wake" }), tab("other")],
			null,
		);
		const b = fakeContext();
		createSessionSource({ events: ["done"], wakeSession: "/s/wake.jsonl", sessions: pool.ports, context: b.context });
		pool.emit(idle("wake"));
		pool.emit(idle("wakeKid"));
		expect(b.fired).toEqual([]);
		pool.emit(idle("other"));
		expect(b.fired).toHaveLength(1);
	});

	it("filters by folder at path segments", () => {
		const pool = fakePool([
			tab("in", { cwd: "/work/app/api" }),
			tab("near", { cwd: "/work/application" }),
			tab("win", { cwd: "C:\\Work\\App" }),
		]);
		const { context, fired } = fakeContext();
		createSessionSource({ events: ["done"], folder: "/work/app", sessions: pool.ports, context });
		pool.emit(idle("in"));
		pool.emit(idle("near"));
		expect(fired).toEqual(['Session "Refactor" in /work/app/api finished its turn']);

		const win = fakeContext();
		createSessionSource({ events: ["done"], folder: "work/app", sessions: pool.ports, context: win.context });
		pool.emit(idle("win"));
		expect(win.fired).toHaveLength(1);
	});

	it("listens no more after stop", () => {
		const pool = fakePool([tab("a")]);
		const { context, fired } = fakeContext();
		const source = createSessionSource({ events: ["done"], sessions: pool.ports, context });
		source.stop();
		expect(pool.observers.size).toBe(0);
		pool.emit(idle("a"));
		expect(fired).toEqual([]);
	});
});
