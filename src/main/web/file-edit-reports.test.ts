import { describe, expect, it, vi } from "vitest";
import { FileEditReports, type FileEdits, parseFileEditReport } from "./file-edit-reports";

describe("parseFileEditReport", () => {
	it("accepts exactly one {dirtyTabId} holding a tab id or null", () => {
		expect(parseFileEditReport([{ dirtyTabId: "t1" }])).toEqual({ dirtyTabId: "t1" });
		expect(parseFileEditReport([{ dirtyTabId: null }])).toEqual({ dirtyTabId: null });
	});

	it("refuses any other shape: an extra key or argument could carry a picture whose upload lands past a drop", () => {
		const picture = { type: "image", mimeType: "image/png", upload: "/up/dev1/a/image.png" };
		for (const args of [
			[{ dirtyTabId: "t1", x: 1 }],
			[{ dirtyTabId: "t1", extra: picture }],
			[{ dirtyTabId: "t1" }, picture],
			[{ dirtyTabId: 7 }],
			[{}],
			[["t1"]],
			[null],
			[],
		])
			expect(parseFileEditReport(args), JSON.stringify(args)).toBeNull();
	});
});

describe("FileEditReports", () => {
	it("knows nothing about a page until it reports, and never reads that as clean", () => {
		const reports = new FileEditReports();
		expect(reports.edits(-1, "t1")).toBe("unreported");
	});

	it("says dirty for the one tab a page reported, and clean for its others", () => {
		const reports = new FileEditReports();
		reports.report(-1, "a", "t1");
		expect(reports.edits(-1, "t1")).toBe("dirty");
		expect(reports.edits(-1, "t2")).toBe("clean");
		expect(reports.edits(-2, "t1")).toBe("unreported");
	});

	it("takes the latest report: none left means every tab clean", () => {
		const reports = new FileEditReports();
		reports.report(-1, "a", "t1");
		reports.report(-1, "a", null);
		expect(reports.edits(-1, "t1")).toBe("clean");
	});

	it("tells its listeners after each report, until they unsubscribe", () => {
		const reports = new FileEditReports();
		const heard = vi.fn();
		const off = reports.onReport(heard);
		reports.report(-1, "a", null);
		reports.report(-1, "a", "t1");
		off();
		reports.report(-1, "a", null);
		expect(heard).toHaveBeenCalledTimes(2);
	});

	it("forgets an ended connection's report without telling its listeners, and takes the next connection's", () => {
		const reports = new FileEditReports();
		const heard = vi.fn();
		reports.onReport(heard);
		reports.report(-1, "a", null);
		reports.forget("a");
		expect(reports.edits(-1, "t1")).toBe("unreported");
		expect(heard).toHaveBeenCalledTimes(1);
		reports.report(-1, "b", "t1");
		expect(reports.edits(-1, "t1")).toBe("dirty");
	});

	it("keeps one report per connection: a second page's null never erases the first page's dirty tab", () => {
		const reports = new FileEditReports();
		reports.report(-1, "a", "t1");
		reports.report(-1, "b", null);
		expect(reports.edits(-1, "t1")).toBe("dirty");
		expect(reports.edits(-1, "t2")).toBe("clean");
	});

	it("lets the remaining connection decide when one disconnects, and is unreported only with none left", () => {
		const reports = new FileEditReports();
		reports.report(-1, "a", "t1");
		reports.report(-1, "b", null);
		reports.forget("a");
		expect(reports.edits(-1, "t1")).toBe("clean");
		reports.forget("b");
		expect(reports.edits(-1, "t1")).toBe("unreported");
	});
});

/**
 * Every order of what paired pages' connections do, as the router and the pages deliver them: a connection reports
 * (on a Files editor change, or right after it connects), a connection ends (`WsRouter` `onConnectionEnded`, once;
 * an unpair ends every connection of the device before its window goes). A reconnect is a fresh connection: a
 * socket's id is a random UUID, and the router hands a frame to its handler inside `receive`, which an ended
 * connection refuses (`ws-router.test.ts` "hands a Files-edit report to main within the frame"), so an ended
 * connection never reports again. Connections `a` and `b` belong to window -1, `c` to window -2.
 */
describe("FileEditReports over every order of connect, report, drop and reconnect", () => {
	const WINDOW_OF = { a: -1, b: -1, c: -2 } as const;
	type Conn = keyof typeof WINDOW_OF;
	const CONNECTIONS = Object.keys(WINDOW_OF) as Conn[];
	const TABS = ["t1", "t2"] as const;
	type Event = { kind: "report"; conn: Conn; dirty: string | null } | { kind: "drop"; conn: Conn };
	const ALPHABET: Event[] = [
		...CONNECTIONS.flatMap(conn => [...TABS, null].map(dirty => ({ kind: "report" as const, conn, dirty }))),
		...CONNECTIONS.map(conn => ({ kind: "drop" as const, conn })),
	];

	/** What the window's live connections said, read straight off the history: the rule the store must keep. */
	function expected(history: readonly Event[], windowId: number, tab: string): FileEdits {
		const dropped = new Set(history.flatMap(event => (event.kind === "drop" ? [event.conn] : [])));
		const latest = CONNECTIONS.filter(conn => WINDOW_OF[conn] === windowId && !dropped.has(conn)).flatMap(conn => {
			const last = history.filter(event => event.kind === "report" && event.conn === conn).at(-1);
			return last?.kind === "report" ? [last.dirty] : [];
		});
		if (latest.length === 0) return "unreported";
		return latest.includes(tab) ? "dirty" : "clean";
	}

	/** Every history of up to `depth` events the pages can produce (an ended connection says nothing more). */
	function* histories(depth: number, prefix: Event[] = []): Generator<Event[]> {
		yield prefix;
		if (prefix.length === depth) return;
		const dropped = new Set(prefix.flatMap(event => (event.kind === "drop" ? [event.conn] : [])));
		for (const event of ALPHABET) if (!dropped.has(event.conn)) yield* histories(depth, [...prefix, event]);
	}

	it("says dirty exactly when a live connection's latest report names the tab, clean when others reported, else unreported", () => {
		let checked = 0;
		for (const history of histories(5)) {
			const reports = new FileEditReports();
			let heard = 0;
			reports.onReport(() => heard++);
			for (const event of history) {
				if (event.kind === "report") reports.report(WINDOW_OF[event.conn], event.conn, event.dirty);
				else reports.forget(event.conn);
			}
			for (const windowId of [-1, -2, -3])
				for (const tab of [...TABS, "t3"]) {
					const got = reports.edits(windowId, tab);
					const want = expected(history, windowId, tab);
					if (got !== want)
						expect.fail(`${JSON.stringify(history)} → ${windowId}/${tab}: ${got}, expected ${want}`);
				}
			// Listeners hear every report and nothing else (an ended connection changes no live page's word).
			const told = history.filter(event => event.kind === "report").length;
			if (heard !== told) expect.fail(`${JSON.stringify(history)}: ${heard} listener calls, expected ${told}`);
			checked++;
		}
		expect(checked).toBeGreaterThan(100_000);
	});
});
