import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IpcTabRunOutcome } from "../../shared/ipc-types";
import type { UiLanguage } from "../../shared/ui-language";
import {
	WEB_PUSH_CATEGORIES,
	type WebPushCategory,
	type WebPushPayload,
	type WebPushSubscriptionJson,
} from "../../shared/web-push";
import type { TabFacts } from "../sidecar-pool";
import { WebDevices } from "./devices-store";
import type { PushOptions, PushResult } from "./push";
import { COMPLETION_DEBOUNCE_MS, WebPushNotifier } from "./web-push-notifier";

interface Sent {
	deviceId: string;
	payload: WebPushPayload;
	options: PushOptions;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "push-notifier-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const subscriptionOf = (deviceId: string): WebPushSubscriptionJson => ({
	endpoint: `https://push.example.com/${deviceId}`,
	keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
});

function rig(options: { language?: UiLanguage } = {}) {
	const devices = new WebDevices(dir);
	const sent: Sent[] = [];
	const visible = new Set<string>();
	const tabs = new Map<string, TabFacts>();
	const timers = new Map<number, { at: number; fn: () => void }>();
	let now = 0;
	let nextTimer = 1;
	let result: PushResult = "sent";
	const notifier = new WebPushNotifier({
		devices,
		sender: {
			send: async (subscription, payload, pushOptions) => {
				const deviceId = subscription.endpoint.split("/").at(-1) ?? "";
				sent.push({ deviceId, payload, options: pushOptions });
				return result;
			},
		},
		visible: deviceId => visible.has(deviceId),
		tabFacts: tabId => tabs.get(tabId) ?? null,
		language: () => options.language ?? "en",
		setTimer: (fn, ms) => {
			const handle = nextTimer++;
			timers.set(handle, { at: now + ms, fn });
			return handle;
		},
		clearTimer: handle => {
			timers.delete(handle as number);
		},
	});
	return {
		devices,
		notifier,
		sent,
		visible,
		tab(tabId: string, facts: Partial<TabFacts> = {}) {
			tabs.set(tabId, { title: `Tab ${tabId}`, busy: false, awaitingConnection: false, retrying: false, ...facts });
		},
		dropTab: (tabId: string) => tabs.delete(tabId),
		/** A paired phone that subscribed, with what it wants. */
		phone(
			name: string,
			push: { categories?: readonly WebPushCategory[]; hideContent?: boolean; subscribed?: boolean } = {},
		) {
			const { device } = devices.create({ name, userAgent: "", tailscaleLogin: null, publicKeyJwk: null });
			devices.setPush(device.deviceId, {
				subscription: push.subscribed === false ? null : subscriptionOf(device.deviceId),
				hideContent: push.hideContent ?? false,
				categories: push.categories ?? WEB_PUSH_CATEGORIES,
			});
			return device.deviceId;
		},
		advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const due = [...timers].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].fn();
			}
			now = target;
		},
		settle: () => new Promise<void>(resolve => setImmediate(resolve)),
		setResult(next: PushResult) {
			result = next;
		},
	};
}

const done = (reply = "Fixed the parser and added two tests."): IpcTabRunOutcome => ({ stopReason: "stop", reply });

describe("autopilot notices", () => {
	it("pushes a run's stop at once to a hidden phone that wants errors, never to one looking at its page", () => {
		const r = rig();
		const hidden = r.phone("iPhone");
		const looking = r.phone("iPad");
		const noErrors = r.phone("Pixel", { categories: ["completion"] });
		r.visible.add(looking);
		r.notifier.notice("t9", { kind: "error", title: "Autopilot paused", body: "The repository folder is gone." });
		expect(r.sent.map(entry => entry.deviceId)).toEqual([hidden]);
		expect(r.sent[0]?.payload).toMatchObject({
			kind: "error",
			title: "Autopilot paused",
			body: "The repository folder is gone.",
			tabId: "t9",
		});
		expect(noErrors).not.toBe(hidden);
	});
});

describe("completion", () => {
	it("pushes a finished turn once, a debounce after it settled, with the tab's title and the reply's opening", () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("t1", { title: "Refactor parser" });
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: done("## Summary\n- **Fixed** the `parser`.") });
		expect(r.sent).toEqual([]);
		r.advance(COMPLETION_DEBOUNCE_MS - 1);
		expect(r.sent).toEqual([]);
		r.advance(1);
		expect(r.sent).toEqual([
			{
				deviceId: id,
				payload: {
					v: 1,
					kind: "completion",
					title: "Refactor parser",
					body: "Summary Fixed the parser.",
					tabId: "t1",
					tag: "tab:t1",
				},
				options: { ttl: 3600, urgency: "normal" },
			},
		]);
	});

	it("says `Complete` when the reply has no prose, and OMPdesk when the tab has no title", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1", { title: "" });
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent[0]?.payload).toMatchObject({ title: "OMPdesk", body: "Complete" });
	});

	it("stays quiet when the tab runs again within the debounce (a retry or a follow-up)", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: done() });
		r.advance(1000);
		r.notifier.handle({ type: "busy", tabId: "t1" });
		r.advance(5000);
		expect(r.sent).toEqual([]);
		// The run that follows ends on its own and is announced on its own.
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: done("Second.") });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent.map(item => item.payload.body)).toEqual(["Second."]);
	});

	it("checks the tab again when the debounce ends: busy, waiting for the connection, retrying or gone say nothing", () => {
		for (const facts of [{ busy: true }, { awaitingConnection: true }, { retrying: true }] as const) {
			const r = rig();
			r.phone("iPhone");
			r.tab("t1", facts);
			r.notifier.handle({ type: "idle", tabId: "t1", outcome: done() });
			r.advance(COMPLETION_DEBOUNCE_MS);
			expect(r.sent, JSON.stringify(facts)).toEqual([]);
		}
		const gone = rig();
		gone.phone("iPhone");
		gone.notifier.handle({ type: "idle", tabId: "t1", outcome: done() });
		gone.advance(COMPLETION_DEBOUNCE_MS);
		expect(gone.sent).toEqual([]);
	});

	it("says nothing for Stop, for no outcome (a compaction ended) and for a run it already announced", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: { stopReason: "aborted" } });
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: undefined });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent).toEqual([]);
		const outcome = done();
		r.notifier.handle({ type: "idle", tabId: "t1", outcome });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.notifier.handle({ type: "busy", tabId: "t1" });
		r.notifier.handle({ type: "idle", tabId: "t1", outcome });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent).toHaveLength(1);
	});

	it("pushes a failed turn as an error with the message", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({
			type: "idle",
			tabId: "t1",
			outcome: { stopReason: "error", errorMessage: "429\n  rate   limited" },
		});
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent[0]?.payload).toMatchObject({
			kind: "error",
			body: "Stopped with error: 429 rate limited",
			tag: "tab:t1",
		});
		expect(r.sent[0]?.options).toEqual({ ttl: 3600, urgency: "normal" });
	});

	it("reads in the host's UI language", () => {
		const r = rig({ language: "ko" });
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: { stopReason: "stop" } });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent[0]?.payload.body).toBe("완료");
	});
});

describe("asks", () => {
	it("pushes an ask at once, high urgency, kept long, with the question", () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("t1", { title: "Deploy" });
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Run  the migration?" });
		expect(r.sent).toEqual([
			{
				deviceId: id,
				payload: { v: 1, kind: "ask", title: "Deploy", body: "Run the migration?", tabId: "t1", tag: "tab:t1" },
				options: { ttl: 6 * 60 * 60, urgency: "high" },
			},
		]);
	});

	it("falls back to the stock wording when the request carries no title", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "" });
		expect(r.sent[0]?.payload.body).toBe("Waiting for your input");
		expect(r.sent[0]?.payload.title).toBe("Tab t1");
	});

	it("retracts the notification with a silent clear when the ask is answered, withdrawn or its tab ends", () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("t1");
		r.tab("t2");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		r.advance(10_000);
		r.notifier.handle({ type: "askClosed", tabId: "t1", requestId: "q1" });
		expect(r.sent.at(-1)).toEqual({
			deviceId: id,
			payload: { v: 1, kind: "clear", title: "", body: "", tabId: "t1", tag: "tab:t1", silent: true },
			options: { ttl: 120, urgency: "normal" },
		});
		// Closed once: a second close says nothing.
		r.notifier.handle({ type: "askClosed", tabId: "t1", requestId: "q1" });
		expect(r.sent).toHaveLength(2);
		// A tab that ends with an ask open retracts it too.
		r.notifier.handle({ type: "ask", tabId: "t2", requestId: "q2", text: "Go?" });
		r.advance(10_000);
		r.notifier.handle({ type: "released", tabId: "t2" });
		expect(r.sent.at(-1)?.payload).toMatchObject({ kind: "clear", tag: "tab:t2" });
	});

	it("retracts nothing that was never pushed: category off, visible page", () => {
		const r = rig();
		const off = r.phone("off", { categories: ["completion"] });
		const seen = r.phone("seen");
		r.visible.add(seen);
		r.tab("t1");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		r.notifier.handle({ type: "askClosed", tabId: "t1", requestId: "q1" });
		expect(r.sent.filter(item => item.deviceId === off || item.deviceId === seen)).toEqual([]);
	});

	it("does not send the clear to a device whose page is in the foreground: the page closes its own notice", () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		r.visible.add(id);
		r.notifier.handle({ type: "askClosed", tabId: "t1", requestId: "q1" });
		expect(r.sent).toHaveLength(1);
	});

	it("keeps the banner while another ask of the tab is open", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "One?" });
		r.advance(10_000);
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q2", text: "Two?" });
		r.notifier.handle({ type: "askClosed", tabId: "t1", requestId: "q1" });
		expect(r.sent.some(item => item.payload.kind === "clear")).toBe(false);
		r.notifier.handle({ type: "askClosed", tabId: "t1", requestId: "q2" });
		expect(r.sent.filter(item => item.payload.kind === "clear")).toHaveLength(1);
	});

	it("does not announce the same request twice", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		expect(r.sent).toHaveLength(1);
	});
});

describe("who is told", () => {
	it("pushes only to devices with a subscription whose category is on", () => {
		const r = rig();
		const all = r.phone("all");
		const askOnly = r.phone("ask only", { categories: ["ask"] });
		const none = r.phone("none", { categories: [] });
		const unsubscribed = r.phone("unsubscribed", { subscribed: false });
		r.tab("t1");
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: done() });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent.map(item => item.deviceId)).toEqual([all]);
		r.sent.length = 0;
		r.advance(4000);
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		expect(r.sent.map(item => item.deviceId).sort()).toEqual([all, askOnly].sort());
		expect([none, unsubscribed].some(deviceId => r.sent.some(item => item.deviceId === deviceId))).toBe(false);
	});

	it("never pushes to a device whose page is in the foreground; the others still hear", () => {
		const r = rig();
		const looking = r.phone("looking");
		const away = r.phone("away");
		r.visible.add(looking);
		r.tab("t1");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		expect(r.sent.map(item => item.deviceId)).toEqual([away]);
		// Once its page goes to the background it is told again.
		r.visible.delete(looking);
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q2", text: "Again?" });
		expect(r.sent.some(item => item.deviceId === looking)).toBe(true);
	});

	it("drops a summary whose device came to the foreground while the window ran", () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("a");
		r.tab("b");
		r.notifier.handle({ type: "ask", tabId: "a", requestId: "q1", text: "A?" });
		r.notifier.handle({ type: "ask", tabId: "b", requestId: "q2", text: "B?" });
		expect(r.sent).toHaveLength(1);
		r.visible.add(id);
		r.advance(4000);
		expect(r.sent).toHaveLength(1);
	});

	it("hides names and text for a device that asked for it, keeping the click target", () => {
		const r = rig();
		const id = r.phone("private", { hideContent: true });
		const open = r.phone("open");
		r.tab("t1", { title: "Secret migration" });
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: done("Dropped the production table.") });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.advance(4000);
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Drop users?" });
		const forPrivate = r.sent.filter(item => item.deviceId === id).map(item => item.payload);
		expect(forPrivate).toEqual([
			{ v: 1, kind: "completion", title: "A task finished", body: "", tabId: "t1", tag: "tab:t1" },
			{ v: 1, kind: "ask", title: "A task needs you", body: "", tabId: "t1", tag: "tab:t1" },
		]);
		expect(JSON.stringify(forPrivate)).not.toMatch(/Secret|production|users/);
		expect(r.sent.find(item => item.deviceId === open)?.payload.title).toBe("Secret migration");
	});

	it("hides content in the host's language", () => {
		const r = rig({ language: "ko" });
		r.phone("private", { hideContent: true });
		r.tab("t1");
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: { stopReason: "error", errorMessage: "boom" } });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent[0]?.payload).toMatchObject({ title: "작업이 오류로 중단됐어요", body: "" });
	});
});

describe("batching (notification-batch.ts)", () => {
	it("pushes the first event at once and one summary at the end of the 4 s window, replacing it", () => {
		const r = rig();
		r.phone("iPhone");
		for (const tab of ["a", "b", "c"]) r.tab(tab);
		r.notifier.handle({ type: "idle", tabId: "a", outcome: done("A done.") });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent).toHaveLength(1);
		r.notifier.handle({ type: "idle", tabId: "b", outcome: done("B done.") });
		r.notifier.handle({ type: "idle", tabId: "c", outcome: { stopReason: "error", errorMessage: "boom" } });
		r.advance(COMPLETION_DEBOUNCE_MS);
		expect(r.sent).toHaveLength(1);
		r.advance(4000 - COMPLETION_DEBOUNCE_MS);
		expect(r.sent).toHaveLength(2);
		expect(r.sent[1]).toEqual({
			deviceId: r.sent[0]?.deviceId,
			payload: {
				v: 1,
				kind: "batch",
				title: "2 tasks finished · 1 failed",
				body: "Tab c, Tab b, Tab a",
				tag: "tab:a",
				silent: true,
			},
			options: { ttl: 3600, urgency: "normal" },
		});
	});

	it("ranks ask > error > completion: the summary is as urgent as its strongest member", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("a");
		r.tab("b");
		r.notifier.handle({ type: "idle", tabId: "a", outcome: done() });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.notifier.handle({ type: "ask", tabId: "b", requestId: "q1", text: "Go?" });
		r.advance(4000);
		const summary = r.sent.at(-1);
		expect(summary?.payload).toMatchObject({ kind: "batch", title: "1 task finished · 1 needs you" });
		expect(summary?.options).toEqual({ ttl: 6 * 60 * 60, urgency: "high" });
		// Two tabs: the click opens the app, not one tab.
		expect(summary?.payload.tabId).toBeUndefined();
	});

	it("counts a tab once, the strongest kind winning", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("a");
		r.tab("b");
		r.notifier.handle({ type: "ask", tabId: "a", requestId: "q1", text: "Go?" });
		r.notifier.handle({ type: "idle", tabId: "b", outcome: done() });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.notifier.handle({ type: "idle", tabId: "a", outcome: done() });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.advance(4000);
		expect(r.sent.at(-1)?.payload.title).toBe("1 task finished · 1 needs you");
	});

	it("keeps each device's window to itself and feeds it only the categories it wants", () => {
		const r = rig();
		const everything = r.phone("everything");
		const askOnly = r.phone("ask only", { categories: ["ask"] });
		r.tab("a");
		r.tab("b");
		r.notifier.handle({ type: "idle", tabId: "a", outcome: done() });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.notifier.handle({ type: "idle", tabId: "b", outcome: done() });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.advance(4000);
		expect(r.sent.filter(item => item.deviceId === askOnly)).toEqual([]);
		expect(r.sent.filter(item => item.deviceId === everything).map(item => item.payload.kind)).toEqual([
			"completion",
			"batch",
		]);
	});

	it("takes a retracted ask out of the pending summary", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("a");
		r.tab("b");
		r.notifier.handle({ type: "idle", tabId: "a", outcome: done() });
		r.advance(COMPLETION_DEBOUNCE_MS);
		r.notifier.handle({ type: "ask", tabId: "b", requestId: "q1", text: "Go?" });
		r.notifier.handle({ type: "askClosed", tabId: "b", requestId: "q1" });
		r.advance(4000);
		expect(r.sent.at(-1)?.payload).toMatchObject({ kind: "batch", title: "1 task finished", tabId: "a" });
	});

	it("sends no summary when every ask of the window was retracted", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("a");
		r.tab("b");
		r.notifier.handle({ type: "ask", tabId: "a", requestId: "q1", text: "A?" });
		r.notifier.handle({ type: "ask", tabId: "b", requestId: "q2", text: "B?" });
		r.notifier.handle({ type: "askClosed", tabId: "a", requestId: "q1" });
		r.notifier.handle({ type: "askClosed", tabId: "b", requestId: "q2" });
		r.advance(4000);
		expect(r.sent.filter(item => item.payload.kind === "batch")).toEqual([]);
	});

	it("hides the tab names in a summary for a device that hides content", () => {
		const r = rig();
		r.phone("private", { hideContent: true });
		r.tab("a", { title: "Secret A" });
		r.tab("b", { title: "Secret B" });
		r.notifier.handle({ type: "ask", tabId: "a", requestId: "q1", text: "Go?" });
		r.notifier.handle({ type: "ask", tabId: "b", requestId: "q2", text: "Go?" });
		r.advance(4000);
		expect(r.sent.at(-1)?.payload).toMatchObject({ kind: "batch", title: "2 need you", body: "" });
		expect(JSON.stringify(r.sent)).not.toMatch(/Secret/);
	});
});

describe("subscription lifecycle", () => {
	it("forgets a subscription the push service says is gone (404/410), and stops pushing to it", async () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("t1");
		r.setResult("gone");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		await r.settle();
		expect(r.devices.get(id)?.push).toMatchObject({ subscription: null, hideContent: false });
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q2", text: "Again?" });
		expect(r.sent).toHaveLength(1);
	});

	it("keeps a subscription after a failure that is not `gone`", async () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("t1");
		r.setResult("failed");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		await r.settle();
		expect(r.devices.get(id)?.push?.subscription).not.toBeNull();
	});

	it("does not forget a newer subscription because the old one's push came back gone", async () => {
		const r = rig();
		const id = r.phone("iPhone");
		r.tab("t1");
		r.setResult("gone");
		r.notifier.handle({ type: "ask", tabId: "t1", requestId: "q1", text: "Go?" });
		const fresh = { ...subscriptionOf(id), endpoint: `https://push.example.com/new/${id}` };
		r.devices.setPush(id, { subscription: fresh, hideContent: false, categories: WEB_PUSH_CATEGORIES });
		await r.settle();
		expect(r.devices.get(id)?.push?.subscription).toEqual(fresh);
	});

	it("takes a revoked device out: its pending summary goes with it", () => {
		const r = rig();
		const id = r.phone("iPhone");
		const other = r.phone("other");
		r.tab("a");
		r.tab("b");
		r.notifier.handle({ type: "ask", tabId: "a", requestId: "q1", text: "A?" });
		r.notifier.handle({ type: "ask", tabId: "b", requestId: "q2", text: "B?" });
		r.devices.onRevoked(deviceId => r.notifier.dropDevice(deviceId));
		r.devices.revoke(id);
		r.sent.length = 0;
		r.advance(4000);
		expect(r.sent.map(item => item.deviceId)).toEqual([other]);
		r.notifier.handle({ type: "ask", tabId: "a", requestId: "q3", text: "Again?" });
		expect(r.sent.some(item => item.deviceId === id)).toBe(false);
	});

	it("drops the debounce of a released tab", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("t1");
		r.notifier.handle({ type: "idle", tabId: "t1", outcome: done() });
		r.notifier.handle({ type: "released", tabId: "t1" });
		r.dropTab("t1");
		r.advance(COMPLETION_DEBOUNCE_MS * 2);
		expect(r.sent).toEqual([]);
	});

	it("dispose cancels everything pending", () => {
		const r = rig();
		r.phone("iPhone");
		r.tab("a");
		r.notifier.handle({ type: "idle", tabId: "a", outcome: done() });
		r.notifier.dispose();
		r.advance(10_000);
		expect(r.sent).toEqual([]);
	});
});
