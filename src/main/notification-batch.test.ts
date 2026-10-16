import { describe, expect, it } from "vitest";
import type { UiLanguage } from "../shared/ui-language";
import { formatBatchSummary, type NoticeKind, NotificationBatcher } from "./notification-batch";

interface Shown {
	title: string;
	body: string;
	tabId: string | null;
	closed: boolean;
}

function setup(language: UiLanguage = "en") {
	const shown: Shown[] = [];
	const timers = new Map<number, { fn: () => void; at: number }>();
	let nextTimer = 1;
	let now = 0;
	const batcher = new NotificationBatcher({
		language: () => language,
		show: (_windowId, notice) => {
			const entry: Shown = { ...notice, closed: false };
			shown.push(entry);
			return {
				close: () => {
					entry.closed = true;
				},
			};
		},
		setTimer: (fn, ms) => {
			const id = nextTimer++;
			timers.set(id, { fn, at: now + ms });
			return id;
		},
		clearTimer: handle => {
			timers.delete(handle as number);
		},
	});
	return {
		batcher,
		shown,
		timers,
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.fn();
				}
			}
		},
	};
}

function event(tabId: string | undefined, kind: NoticeKind | undefined, title = `Tab ${tabId}`) {
	return { title, body: `${kind} body`, tabId, kind };
}

describe("NotificationBatcher", () => {
	it("shows a single event at once and leaves it alone when the window ends", () => {
		const { batcher, shown, advance } = setup();
		batcher.notify(1, event("a", "completion"), true);
		expect(shown).toEqual([{ title: "Tab a", body: "completion body", tabId: "a", closed: false }]);
		advance(4000);
		expect(shown).toHaveLength(1);
		expect(shown[0]?.closed).toBe(false);
	});

	it("shows the first event at once, then one summary at 4 s that replaces it", () => {
		const { batcher, shown, advance } = setup();
		batcher.notify(1, event("a", "completion"), true);
		advance(1000);
		batcher.notify(1, event("b", "completion"), true);
		batcher.notify(1, event("c", "error"), true);
		batcher.notify(1, event("d", "ask"), true);
		expect(shown).toHaveLength(1);
		advance(2999);
		expect(shown).toHaveLength(1);
		advance(1);
		expect(shown).toHaveLength(2);
		expect(shown[0]?.closed).toBe(true);
		expect(shown[1]).toEqual({
			title: "2 tasks finished · 1 failed · 1 needs you",
			body: "Tab d, Tab c, Tab b +1 more",
			tabId: "d",
			closed: false,
		});
	});

	it("points the click at needs-you, then failed, then the most recent finished", () => {
		const a = setup();
		a.batcher.notify(1, event("a", "completion"), true);
		a.batcher.notify(1, event("b", "error"), true);
		a.batcher.notify(1, event("c", "completion"), true);
		a.advance(4000);
		expect(a.shown.at(-1)?.tabId).toBe("b");

		const b = setup();
		b.batcher.notify(1, event("a", "completion"), true);
		b.batcher.notify(1, event("b", "completion"), true);
		b.batcher.notify(1, event("c", "completion"), true);
		b.advance(4000);
		expect(b.shown.at(-1)?.tabId).toBe("c");

		const c = setup();
		c.batcher.notify(1, event("a", "ask"), true);
		c.batcher.notify(1, event("b", "error"), true);
		c.advance(4000);
		expect(c.shown.at(-1)?.tabId).toBe("a");
		expect(c.shown.at(-1)?.title).toBe("1 failed · 1 needs you");
	});

	it("counts a tab once, the highest-priority kind winning", () => {
		const { batcher, shown, advance } = setup();
		batcher.notify(1, event("a", "completion"), true);
		batcher.notify(1, event("a", "ask"), true);
		batcher.notify(1, event("a", "completion"), true);
		batcher.notify(1, event("b", "completion"), true);
		advance(4000);
		expect(shown.at(-1)?.title).toBe("1 task finished · 1 needs you");
		expect(shown.at(-1)?.tabId).toBe("a");
	});

	it("keeps two windows apart", () => {
		const { batcher, shown, advance } = setup();
		batcher.notify(1, event("a", "completion"), true);
		batcher.notify(2, event("b", "completion"), true);
		expect(shown).toHaveLength(2);
		advance(4000);
		expect(shown).toHaveLength(2);
		expect(shown.every(entry => !entry.closed)).toBe(true);
	});

	it("opens a new batch for an event after the window ended", () => {
		const { batcher, shown, advance } = setup();
		batcher.notify(1, event("a", "completion"), true);
		batcher.notify(1, event("b", "completion"), true);
		advance(4000);
		expect(shown).toHaveLength(2);
		batcher.notify(1, event("c", "completion"), true);
		expect(shown).toHaveLength(3);
		expect(shown[2]).toMatchObject({ title: "Tab c", closed: false });
		advance(4000);
		expect(shown).toHaveLength(3);
	});

	it("does not slide the window with followers", () => {
		const { batcher, shown, advance } = setup();
		batcher.notify(1, event("a", "completion"), true);
		advance(3000);
		batcher.notify(1, event("b", "completion"), true);
		advance(1000);
		expect(shown).toHaveLength(2);
	});

	it("bypasses batching without a kind, without a tab, or when the pref is off", () => {
		const { batcher, shown, timers } = setup();
		batcher.notify(1, event("a", undefined), true);
		batcher.notify(1, event(undefined, "completion"), true);
		batcher.notify(1, event("b", "completion"), false);
		batcher.notify(1, event("c", "completion"), false);
		expect(shown.map(entry => entry.tabId)).toEqual(["a", null, "b", "c"]);
		expect(timers.size).toBe(0);
	});

	it("cancels a window's timer when the window goes away, and every timer on dispose", () => {
		const { batcher, shown, timers, advance } = setup();
		batcher.notify(1, event("a", "completion"), true);
		batcher.notify(1, event("b", "completion"), true);
		batcher.notify(2, event("c", "completion"), true);
		expect(timers.size).toBe(2);
		batcher.dropWindow(1);
		expect(timers.size).toBe(1);
		batcher.dispose();
		expect(timers.size).toBe(0);
		advance(10_000);
		expect(shown).toHaveLength(2);
		expect(shown.every(entry => !entry.closed)).toBe(true);
	});

	describe("for a second sink (Web Push)", () => {
		function sink() {
			const infos: Array<{ title: string; info: unknown }> = [];
			const timers = new Map<number, () => void>();
			let next = 1;
			const batcher = new NotificationBatcher({
				language: () => "en",
				show: (_windowId, notice, info) => {
					infos.push({ title: notice.title, info });
					return { close: () => undefined };
				},
				setTimer: fn => {
					timers.set(next, fn);
					return next++;
				},
				clearTimer: handle => {
					timers.delete(handle as number);
				},
			});
			const end = () => {
				for (const [id, fn] of [...timers]) {
					timers.delete(id);
					fn();
				}
			};
			return { batcher, infos, end };
		}

		it("hands the sink each notice's kind: a lone event's own, a summary's strongest with its tally", () => {
			const { batcher, infos, end } = sink();
			batcher.notify(1, event("a", "completion"), true);
			batcher.notify(1, event("b", "error"), true);
			batcher.notify(1, event("c", "completion"), true);
			end();
			expect(infos.map(item => item.info)).toEqual([
				{ kind: "completion", summary: null },
				{ kind: "error", summary: { finished: 2, failed: 1, asks: 0 } },
			]);
		});

		it("hands over the kind when batching is off, and null for a notice without one", () => {
			const { batcher, infos } = sink();
			batcher.notify(1, event("a", "ask"), false);
			batcher.notify(1, event("b", undefined), true);
			expect(infos.map(item => item.info)).toEqual([{ kind: "ask", summary: null }, null]);
		});

		it("drops a retracted ask from the summary, and sends no summary when nothing is left", () => {
			const a = sink();
			a.batcher.notify(1, event("a", "completion"), true);
			a.batcher.notify(1, event("b", "ask"), true);
			a.batcher.retract(1, "b");
			a.end();
			expect(a.infos.at(-1)?.title).toBe("1 task finished");

			const b = sink();
			b.batcher.notify(1, event("a", "ask"), true);
			b.batcher.notify(1, event("b", "ask"), true);
			b.batcher.retract(1, "a");
			b.batcher.retract(1, "b");
			b.end();
			expect(b.infos).toHaveLength(1);
		});

		it("leaves a finished or failed entry alone, and an unknown window", () => {
			const { batcher, infos, end } = sink();
			batcher.retract(9, "x");
			batcher.notify(1, event("a", "completion"), true);
			batcher.notify(1, event("b", "error"), true);
			batcher.retract(1, "a");
			batcher.retract(1, "b");
			end();
			expect(infos.at(-1)?.title).toBe("1 task finished · 1 failed");
			expect(infos.at(-1)?.info).toEqual({ kind: "error", summary: { finished: 1, failed: 1, asks: 0 } });
		});
	});
});

describe("formatBatchSummary", () => {
	const titles = (...names: string[]) => names;

	it("uses singular and plural parts, in order, only the non-zero ones", () => {
		expect(formatBatchSummary({ finished: 1, failed: 0, asks: 0 }, titles("A"), "en").title).toBe("1 task finished");
		expect(formatBatchSummary({ finished: 3, failed: 0, asks: 1 }, titles("A"), "en").title).toBe(
			"3 tasks finished · 1 needs you",
		);
		expect(formatBatchSummary({ finished: 0, failed: 2, asks: 2 }, titles("A"), "en").title).toBe(
			"2 failed · 2 need you",
		);
	});

	it("caps the body at three titles", () => {
		expect(formatBatchSummary({ finished: 3, failed: 0, asks: 0 }, titles("A", "B", "C"), "en").body).toBe("A, B, C");
		expect(formatBatchSummary({ finished: 5, failed: 0, asks: 0 }, titles("A", "B", "C", "D", "E"), "en").body).toBe(
			"A, B, C +2 more",
		);
	});

	it("speaks Korean", () => {
		expect(
			formatBatchSummary({ finished: 3, failed: 1, asks: 1 }, titles("가", "나", "다", "라", "마"), "ko"),
		).toEqual({
			title: "작업 3개 완료 · 1개 실패 · 1개 확인 필요",
			body: "가, 나, 다 외 2개",
		});
	});
});
