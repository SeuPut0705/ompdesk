import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JUDGE_ASSIST_NEEDS_USER } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import type { IpcNotifyPayload } from "../shared/ipc-types";
import {
	type BridgeAsk,
	createNotifyHandler,
	NEEDS_USER_WAIT_MS,
	NOTIFY_DEDUPE_MS,
	type NotifyCaller,
} from "./notify-triage";
import type { ClientWindow } from "./web/client-window";

function windowWithId(id: number): ClientWindow {
	return { webContents: { id, send: () => {} }, isDestroyed: () => false, once: () => {}, removeListener: () => {} };
}

const WIN_1 = windowWithId(1);
const WIN_2 = windowWithId(2);

const caller = (win: ClientWindow, focused = false): NotifyCaller => ({
	win,
	browserWindow: { isFocused: () => focused },
});

const completion = (tabId = "t1"): IpcNotifyPayload => ({
	title: "Back task",
	body: "Two ways to go. Which one?",
	tabId,
	kind: "completion",
});

interface World {
	delivered: Array<{ winId: number; notice: IpcNotifyPayload }>;
	ask: ReturnType<typeof vi.fn<BridgeAsk>>;
	bridgeFor: ReturnType<typeof vi.fn<(win: ClientWindow, tabId: string) => BridgeAsk | undefined>>;
	enabled: { current: boolean };
	shared: Set<string>;
	clock: { now: number };
	notify: (callerArg: NotifyCaller, payload: IpcNotifyPayload) => Promise<void>;
}

function build(answer: BridgeAsk = async () => ({ needsUser: true })): World {
	const delivered: World["delivered"] = [];
	const ask = vi.fn<BridgeAsk>(answer);
	const bridgeFor = vi.fn((_win: ClientWindow, _tabId: string): BridgeAsk | undefined => ask);
	const enabled = { current: true };
	const shared = new Set<string>();
	const clock = { now: 1_000 };
	const notify = createNotifyHandler({
		now: () => clock.now,
		isShared: tabId => shared.has(tabId),
		judgeEnabled: () => enabled.current,
		bridgeFor,
		needsYouTitle: title => `Needs input · ${title}`,
		deliver: (_win, winId, notice) => void delivered.push({ winId, notice }),
	});
	return { delivered, ask, bridgeFor, enabled, shared, clock, notify };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a completion the judge says waits for the person", () => {
	it("is handed on as an ask titled with the tab, with the same body and tab", async () => {
		const world = build();
		await world.notify(caller(WIN_1), completion());
		expect(world.ask).toHaveBeenCalledExactlyOnceWith(JUDGE_ASSIST_NEEDS_USER, {});
		expect(world.delivered).toEqual([
			{
				winId: 1,
				notice: {
					title: "Needs input · Back task",
					body: "Two ways to go. Which one?",
					tabId: "t1",
					kind: "ask",
				},
			},
		]);
	});
});

describe("anything else is today's notification, untouched", () => {
	it.each([
		["no decision", async () => ({ needsUser: null })],
		["a no", async () => ({ needsUser: false })],
		["an unreadable answer", async () => ({})],
		["a rejected request", async (): Promise<unknown> => Promise.reject(new Error("bridge down"))],
	])("%s", async (_label, answer) => {
		const world = build(answer);
		await world.notify(caller(WIN_1), completion());
		expect(world.ask).toHaveBeenCalledTimes(1);
		expect(world.delivered).toEqual([{ winId: 1, notice: completion() }]);
	});

	it("a bridge that never answers costs one limit, then the completion shows", async () => {
		const world = build(() => Promise.withResolvers<never>().promise);
		let settled = false;
		const pending = world.notify(caller(WIN_1), completion()).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(NEEDS_USER_WAIT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(world.delivered).toEqual([{ winId: 1, notice: completion() }]);
	});

	it("with the pref off, the bridge is never reached", async () => {
		const world = build();
		world.enabled.current = false;
		await world.notify(caller(WIN_1), completion());
		expect(world.bridgeFor).not.toHaveBeenCalled();
		expect(world.ask).not.toHaveBeenCalled();
		expect(world.delivered).toEqual([{ winId: 1, notice: completion() }]);
	});

	it("a tab that is not a local tab of this machine (a paired host's, a hosted view) is never asked", async () => {
		const world = build();
		world.bridgeFor.mockReturnValue(undefined);
		await world.notify(caller(WIN_1), completion("remote"));
		expect(world.bridgeFor).toHaveBeenCalledWith(WIN_1, "remote");
		expect(world.ask).not.toHaveBeenCalled();
		expect(world.delivered).toEqual([{ winId: 1, notice: completion("remote") }]);
	});

	it.each(["error", "ask"] as const)("a %s notification is never asked", async kind => {
		const world = build();
		await world.notify(caller(WIN_1), { ...completion(), kind });
		expect(world.bridgeFor).not.toHaveBeenCalled();
		expect(world.delivered).toEqual([{ winId: 1, notice: { ...completion(), kind } }]);
	});

	it("a notice without a kind or a tab is never asked", async () => {
		const world = build();
		await world.notify(caller(WIN_1), { title: "Plain" });
		await world.notify(caller(WIN_1), { title: "No tab", kind: "completion" });
		expect(world.bridgeFor).not.toHaveBeenCalled();
		expect(world.delivered.map(entry => entry.notice.title)).toEqual(["Plain", "No tab"]);
	});

	it("the person came back while the judge answered: the notification shows as it was sent", async () => {
		const world = build();
		const comingBack = { focused: false };
		const live: NotifyCaller = { win: WIN_1, browserWindow: { isFocused: () => comingBack.focused } };
		world.ask.mockImplementation(async () => {
			comingBack.focused = true;
			return { needsUser: true };
		});
		await world.notify(live, completion());
		expect(world.delivered).toEqual([{ winId: 1, notice: completion() }]);
	});

	it("a web caller has no native window to re-check: the answer applies", async () => {
		const world = build();
		await world.notify({ win: WIN_1, browserWindow: null }, completion());
		expect(world.delivered[0]?.notice.kind).toBe("ask");
	});
});

describe("one classification per tab end", () => {
	it("two windows reporting a shared tab's end are one event: one question, one notice", async () => {
		const world = build();
		world.shared.add("t1");
		await Promise.all([world.notify(caller(WIN_1), completion()), world.notify(caller(WIN_2), completion())]);
		expect(world.ask).toHaveBeenCalledTimes(1);
		expect(world.delivered).toHaveLength(1);
		expect(world.delivered[0]?.notice.kind).toBe("ask");
	});

	it("the same window repeating a notice within the window is dropped, and shows again after it", async () => {
		const world = build();
		await world.notify(caller(WIN_1), completion());
		await world.notify(caller(WIN_1), completion());
		expect(world.delivered).toHaveLength(1);
		world.clock.now += NOTIFY_DEDUPE_MS;
		await world.notify(caller(WIN_1), completion());
		expect(world.delivered).toHaveLength(2);
		expect(world.ask).toHaveBeenCalledTimes(2);
	});

	it("tabs that are not shared finishing in two windows are two events", async () => {
		const world = build();
		await world.notify(caller(WIN_1), completion("t1"));
		await world.notify(caller(WIN_2), completion("t2"));
		expect(world.ask).toHaveBeenCalledTimes(2);
		expect(world.delivered.map(entry => entry.winId)).toEqual([1, 2]);
	});
});

describe("a payload without a title", () => {
	it("is ignored", async () => {
		const world = build();
		await world.notify(caller(WIN_1), {} as IpcNotifyPayload);
		expect(world.delivered).toEqual([]);
	});
});
