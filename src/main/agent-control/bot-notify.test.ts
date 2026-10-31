import { describe, expect, it } from "vitest";
import type { BotActivityDraft } from "../../shared/bot-activity";
import { type BotNotify, BotNotifySchema } from "../../shared/bot-desk";
import { BotNoticeRouter } from "./bot-notify";

function rig(settings: Partial<BotNotify>) {
	let now = 0;
	const log: BotActivityDraft[] = [];
	const router = new BotNoticeRouter({
		notify: () => BotNotifySchema.parse(settings),
		log: draft => void log.push(draft),
		now: () => now,
	});
	return {
		router,
		log,
		at: (ms: number) => {
			now = ms;
		},
	};
}

describe("BotNoticeRouter", () => {
	it("sends each kind where the owner routed it, and holds a quiet one in the log", () => {
		const { router, log } = rig({ progress: "banner", decisions: "push", done: "quiet" });
		expect(router.route("progress", "Tests pass")).toEqual({ banner: true, push: false });
		expect(router.route("decisions", "Ship?")).toEqual({ banner: false, push: true });
		expect(router.route("done", "Release out")).toEqual({ banner: false, push: false });
		expect(log.map(entry => [entry.action, entry.text])).toEqual([
			["notice_sent", "progress: Tests pass"],
			["notice_sent", "decisions: Ship?"],
			["notice_held", "done: Release out"],
		]);
	});

	it("lets a progress notice through at most once an hour when asked, and never counts a held one", () => {
		const { router, at } = rig({ progress: "both", progressEvery: "hourly" });
		expect(router.route("progress", "one").banner).toBe(true);
		at(30 * 60_000);
		expect(router.route("progress", "two")).toEqual({ banner: false, push: false });
		// Decisions and finished work are never held back by the progress cadence.
		expect(router.route("decisions", "Ship?").push).toBe(true);
		at(60 * 60_000);
		expect(router.route("progress", "three").banner).toBe(true);
	});

	it("logs a turn's banner once and leaves its separate push out of the log", () => {
		const { router, log } = rig({ done: "both" });
		expect(router.route("done", "Finished", "banner").banner).toBe(true);
		expect(router.route("done", "Finished", "push").push).toBe(true);
		expect(log).toHaveLength(1);
	});
});
