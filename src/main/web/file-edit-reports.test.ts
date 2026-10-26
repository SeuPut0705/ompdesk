import { describe, expect, it, vi } from "vitest";
import type { ClientWindow } from "./client-window";
import { FileEditReports } from "./file-edit-reports";

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
