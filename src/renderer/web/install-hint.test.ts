import { describe, expect, it, vi } from "vitest";
import {
	INSTALL_HINT_KEY,
	type KeyValueStorage,
	readHintRecord,
	recordVisit,
	showInstallHintIfDue,
} from "./install-hint";

class MemoryStorage implements KeyValueStorage {
	readonly items = new Map<string, string>();
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
}

describe("recordVisit", () => {
	it("counts one visit per browser session, however often the page loads", () => {
		const local = new MemoryStorage();
		const first = new MemoryStorage();
		expect(recordVisit(local, first).visits).toBe(1);
		expect(recordVisit(local, first).visits).toBe(1);
		expect(recordVisit(local, new MemoryStorage()).visits).toBe(2);
	});

	it("reads damaged memory as none, and a storage that throws as no visit", () => {
		const local = new MemoryStorage();
		local.setItem(INSTALL_HINT_KEY, "{nope");
		expect(readHintRecord(local)).toEqual({ visits: 0, shown: false });
		const broken: KeyValueStorage = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(recordVisit(broken, broken)).toEqual({ visits: 0, shown: false });
	});
});

describe("showInstallHintIfDue", () => {
	it("shows once on the second visit and never again", () => {
		const local = new MemoryStorage();
		const show = vi.fn();
		const deps = { local, guidance: () => "prompt" as const, show };
		recordVisit(local, new MemoryStorage());
		expect(showInstallHintIfDue(deps)).toBe(false);
		recordVisit(local, new MemoryStorage());
		expect(showInstallHintIfDue(deps)).toBe(true);
		expect(show).toHaveBeenCalledWith("prompt");
		recordVisit(local, new MemoryStorage());
		expect(showInstallHintIfDue(deps)).toBe(false);
		expect(show).toHaveBeenCalledTimes(1);
	});

	it("stays quiet when installed, and does not spend the hint on a page with nothing to offer", () => {
		const local = new MemoryStorage();
		local.setItem(INSTALL_HINT_KEY, JSON.stringify({ visits: 3, shown: false }));
		const show = vi.fn();
		expect(showInstallHintIfDue({ local, guidance: () => "installed", show })).toBe(false);
		expect(showInstallHintIfDue({ local, guidance: () => "none", show })).toBe(false);
		expect(show).not.toHaveBeenCalled();
		expect(showInstallHintIfDue({ local, guidance: () => "ios-share", show })).toBe(true);
	});
});
