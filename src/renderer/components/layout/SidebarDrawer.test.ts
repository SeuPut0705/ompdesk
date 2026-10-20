import { describe, expect, it } from "vitest";
import type { SessionTab } from "../../stores/tabs";
import { leftActiveSession } from "./SidebarDrawer";

const tab = (id: string, patch: Partial<SessionTab> = {}): SessionTab => ({
	id,
	cwd: "/w",
	status: "ready",
	kind: "agent",
	unreadDone: false,
	...patch,
});

describe("the phone drawer closes only when the person leaves the session", () => {
	it("stays open while the first tab list names the active tab (☰ tapped right after the page loaded)", () => {
		// Seen under load: ☰ opened the drawer at 196 ms, the first list set the active tab at 223 ms, the drawer closed.
		expect(leftActiveSession({ activeTabId: null, tabs: [] }, { activeTabId: "real" })).toBe(false);
	});

	it("stays open while a real tab takes over its ghost from the last launch", () => {
		expect(
			leftActiveSession({ activeTabId: "g1", tabs: [tab("g1", { ghost: true })] }, { activeTabId: "real" }),
		).toBe(false);
	});

	it("closes when another session is picked, and not on an unrelated change", () => {
		const shown = { activeTabId: "a", tabs: [tab("a"), tab("b")] };
		expect(leftActiveSession(shown, { activeTabId: "b" })).toBe(true);
		expect(leftActiveSession(shown, { activeTabId: "a" })).toBe(false);
	});
});
