import { describe, expect, it, vi } from "vitest";
import type { ClientWindow } from "./client-window";
import { type FileEdits, FileEditReports } from "./file-edit-reports";

function page(id: number): ClientWindow & { close(): void } {
	const closed: (() => void)[] = [];
	return {
		webContents: { id, send: () => undefined },
		isDestroyed: () => false,
		once: (_event, listener) => void closed.push(listener),
		removeListener: () => undefined,
		close: () => {
			for (const listener of closed.splice(0)) listener();
		},
	};
}

describe("FileEditReports", () => {
	it("knows nothing about a page until it reports, and never reads that as clean", () => {
		const reports = new FileEditReports();
		expect(reports.edits(-1, "t1")).toBe("unreported");
	});

	it("says dirty for the one tab a page reported, and clean for its others", () => {
		const reports = new FileEditReports();
		reports.report(page(-1), "t1");
		expect(reports.edits(-1, "t1")).toBe("dirty");
		expect(reports.edits(-1, "t2")).toBe("clean");
		expect(reports.edits(-2, "t1")).toBe("unreported");
	});

	it("takes the latest report: none left means every tab clean", () => {
		const reports = new FileEditReports();
		const phone = page(-1);
		reports.report(phone, "t1");
		reports.report(phone, null);
		expect(reports.edits(-1, "t1")).toBe("clean");
	});

	it("tells its listeners after each report, until they unsubscribe", () => {
		const reports = new FileEditReports();
		const heard = vi.fn();
		const off = reports.onReport(heard);
		reports.report(page(-1), null);
		reports.report(page(-1), "t1");
		off();
		reports.report(page(-1), null);
		expect(heard).toHaveBeenCalledTimes(2);
	});

	it("forgets a page's report on demand without telling its listeners, and takes the next one", () => {
		const reports = new FileEditReports();
		const phone = page(-1);
		const heard = vi.fn();
		reports.onReport(heard);
		reports.report(phone, null, "a");
		reports.forget(-1, "a");
		expect(reports.edits(-1, "t1")).toBe("unreported");
		expect(heard).toHaveBeenCalledTimes(1);
		reports.report(phone, "t1", "a");
		expect(reports.edits(-1, "t1")).toBe("dirty");
		phone.close();
		expect(reports.edits(-1, "t1")).toBe("unreported");
	});

	it("keeps one report per connection: a second page's null never erases the first page's dirty tab", () => {
		const reports = new FileEditReports();
		const phone = page(-1);
		reports.report(phone, "t1", "a");
		reports.report(phone, null, "b");
		expect(reports.edits(-1, "t1")).toBe("dirty");
		expect(reports.edits(-1, "t2")).toBe("clean");
	});

	it("lets the remaining connection decide when one disconnects, and is unreported only with none left", () => {
		const reports = new FileEditReports();
		const phone = page(-1);
		reports.report(phone, "t1", "a");
		reports.report(phone, null, "b");
		reports.forget(-1, "a");
		expect(reports.edits(-1, "t1")).toBe("clean");
		reports.forget(-1, "b");
		expect(reports.edits(-1, "t1")).toBe("unreported");
	});

	it("forgets a window that closed", () => {
		const reports = new FileEditReports();
		const phone = page(-1);
		reports.report(phone, null);
		phone.close();
		expect(reports.edits(-1, "t1")).toBe("unreported");
	});
});

/**
 * Every order of what a paired page's connections do, as the router and the page deliver them: a connection reports
 * (on a Files editor change, or right after it connects), a connection drops (`WsRouter` `onConnectionEnded`, once),
 * the window closes (unpaired). A reconnect is a fresh connection: a socket's id is a random UUID, and the router
 * hands a frame to its handler inside `receive`, which an ended connection refuses (`ws-router.test.ts` "hands a
 * Files-edit report to main within the frame"), so a dropped connection never reports again.
 */
describe("FileEditReports over every order of connect, report, drop, reconnect and close", () => {
	const CONNECTIONS = ["a", "b", "c"] as const;
	const TABS = ["t1", "t2"] as const;
	type Event =
		| { kind: "report"; conn: string; dirty: string | null }
		| { kind: "drop"; conn: string }
		| { kind: "close" };
	const ALPHABET: Event[] = [
		...CONNECTIONS.flatMap(conn => [...TABS, null].map(dirty => ({ kind: "report" as const, conn, dirty }))),
		...CONNECTIONS.map(conn => ({ kind: "drop" as const, conn })),
	];

	/** What the page's connections said, read straight off the history: the rule the store must keep. */
	function expected(history: readonly Event[], tab: string): FileEdits {
		if (history.some(event => event.kind === "close")) return "unreported";
		const dropped = new Set(history.flatMap(event => (event.kind === "drop" ? [event.conn] : [])));
		const live = CONNECTIONS.filter(conn => !dropped.has(conn));
		const last = live.flatMap(conn => {
			const reports = history.filter(event => event.kind === "report" && event.conn === conn);
			const latest = reports.at(-1);
			return latest?.kind === "report" ? [latest.dirty] : [];
		});
		if (last.length === 0) return "unreported";
		return last.includes(tab) ? "dirty" : "clean";
	}

	/** Every history of up to `depth` events a page can produce, optionally ending with its window closing. */
	function* histories(depth: number, prefix: Event[] = []): Generator<Event[]> {
		yield prefix;
		yield [...prefix, { kind: "close" }];
		if (prefix.length === depth) return;
		const dropped = new Set(prefix.flatMap(event => (event.kind === "drop" ? [event.conn] : [])));
		for (const event of ALPHABET) {
			if (event.kind !== "close" && dropped.has(event.conn)) continue;
			yield* histories(depth, [...prefix, event]);
		}
	}

	it("says dirty exactly when a live connection's latest report names the tab, clean when others reported, else unreported", () => {
		let checked = 0;
		for (const history of histories(5)) {
			const reports = new FileEditReports();
			const phone = page(-1);
			let heard = 0;
			reports.onReport(() => heard++);
			for (const event of history) {
				if (event.kind === "report") reports.report(phone, event.dirty, event.conn);
				else if (event.kind === "drop") reports.forget(-1, event.conn);
				else phone.close();
			}
			for (const tab of [...TABS, "t3"]) {
				const got = reports.edits(-1, tab);
				const want = expected(history, tab);
				if (got !== want) expect.fail(`${JSON.stringify(history)} → ${tab}: ${got}, expected ${want}`);
				// Another window's tabs hear nothing of this page.
				if (reports.edits(-2, tab) !== "unreported") expect.fail(`${JSON.stringify(history)} leaked to window -2`);
			}
			// Listeners hear every report and nothing else (a drop or a close changes no live page's word).
			const told = history.filter(event => event.kind === "report").length;
			if (heard !== told) expect.fail(`${JSON.stringify(history)}: ${heard} listener calls, expected ${told}`);
			checked++;
		}
		expect(checked).toBeGreaterThan(200_000);
	});
});
