/**
 * The saved desktop session (prefs `tabLayouts`) is rewritten from the live windows on every tab change and every
 * window close, and never once a quit is approved: the teardown closes tabs and windows one by one, and a stalled
 * quit (21 Oct 2026: an update restart whose first quit never finished) must leave what the user had.
 */
import { describe, expect, it } from "vitest";
import { layoutsToSave } from "./saved-layouts";
import type { PersistedTabLayout } from "./tab-layout";

function layout(...cwds: string[]): PersistedTabLayout {
	return { version: 1, activeIndex: 0, tabs: cwds.map(cwd => ({ cwd, kind: "agent" })) };
}

describe("layoutsToSave", () => {
	it("writes the live windows when they differ from what is stored", () => {
		const live = [layout("/a", "/b"), layout("/c")];
		expect(layoutsToSave({ quitApproved: false, live, stored: [layout("/a")] })).toEqual(live);
	});

	it("writes nothing when the stored layouts already read the same, or no window is left", () => {
		const live = [layout("/a")];
		expect(layoutsToSave({ quitApproved: false, live, stored: JSON.parse(JSON.stringify(live)) })).toBeNull();
		expect(layoutsToSave({ quitApproved: false, live: [], stored: live })).toBeNull();
	});

	it("keeps a window the user closed out of the saved session", () => {
		const stored = [layout("/a"), layout("/b")];
		expect(layoutsToSave({ quitApproved: false, live: [layout("/a")], stored })).toEqual([layout("/a")]);
	});

	it("writes nothing during an approved quit, whatever the teardown leaves of the windows", () => {
		const stored = [layout("/a", "/remote"), layout("/b")];
		// Tabs released one by one, then each window closing: every step would otherwise rewrite the session smaller.
		for (const live of [[layout("/a"), layout("/b")], [layout("/b")], [layout("/a", "/remote")], []]) {
			expect(layoutsToSave({ quitApproved: true, live, stored })).toBeNull();
		}
	});
});
