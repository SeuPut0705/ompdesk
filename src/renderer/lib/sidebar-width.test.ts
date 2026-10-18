import { afterEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } from "../../shared/boot-shell-geometry";
import { readSidebarWidth, writeSidebarWidth } from "./sidebar-width";

function storage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
	});
	return map;
}

afterEach(() => vi.unstubAllGlobals());

describe("sidebar width mirror", () => {
	it("starts at the default and clamps what was saved", () => {
		storage();
		expect(readSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
		storage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "9999" });
		expect(readSidebarWidth()).toBe(SIDEBAR_WIDTH.max);
		storage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "10" });
		expect(readSidebarWidth()).toBe(SIDEBAR_WIDTH.min);
		storage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "nope" });
		expect(readSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
	});

	it("round-trips a width and survives a missing storage", () => {
		const map = storage();
		writeSidebarWidth(301.4);
		expect(map.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("301");
		expect(readSidebarWidth()).toBe(301);
		vi.stubGlobal("localStorage", undefined);
		expect(readSidebarWidth()).toBe(SIDEBAR_WIDTH.default);
		expect(() => writeSidebarWidth(300)).not.toThrow();
	});
});
