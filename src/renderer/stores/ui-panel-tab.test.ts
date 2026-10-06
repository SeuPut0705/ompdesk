/**
 * setPanelTab chat clamp: a tool-free chat tab only carries files + logs in
 * the workspace drawer (todo/plan/agents/queue moved to the center dock), so
 * force-opening the diff tab there is a no-op. The clamp lives in the ui
 * store — not just the PanelContainer tab list — because several call sites
 * force the panel open.
 */
import { afterEach, describe, expect, it } from "vitest";
import { useTabsStore } from "./tabs";
import { useUiStore } from "./ui";

function seedActiveTab(kind: "agent" | "chat"): void {
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work", status: "ready", kind, unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

afterEach(() => {
	useTabsStore.getState().reset();
	useUiStore.setState({ panelTab: "files", panelVisible: false });
});

describe("setPanelTab chat clamp", () => {
	it("refuses the diff tab in a chat tab but allows files and logs", () => {
		seedActiveTab("chat");
		// Baseline: a chat-visible tab, so a clamped no-op leaves a provable state.
		useUiStore.setState({ panelTab: "files", panelVisible: false });
		useUiStore.getState().setPanelTab("diff");
		expect(useUiStore.getState().panelTab).toBe("files");
		expect(useUiStore.getState().panelVisible).toBe(false);

		useUiStore.getState().setPanelTab("files");
		expect(useUiStore.getState().panelTab).toBe("files");
		expect(useUiStore.getState().panelVisible).toBe(true);

		useUiStore.getState().setPanelTab("logs");
		expect(useUiStore.getState().panelTab).toBe("logs");
	});

	it("opens every tab in an agent tab", () => {
		seedActiveTab("agent");
		for (const tab of ["diff", "files", "logs"] as const) {
			useUiStore.getState().setPanelTab(tab);
			expect(useUiStore.getState().panelTab).toBe(tab);
		}
	});
});
