/**
 * AppShell: which store transitions return from a destination page to the
 * session view.
 */

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { leavePageOnSessionSelect } from "./AppShell";

const { document, window } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;

afterEach(() => {
	useUiStore.getState().closeDestination();
	useSessionStore.getState().reset();
	useTabsStore.setState({ activeTabId: null });
});

describe("leavePageOnSessionSelect", () => {
	it("keeps a page opened during startup when the tab's first session arrives", () => {
		const stop = leavePageOnSessionSelect();
		useUiStore.getState().openAgents("definitions");
		// get_state lands after the sidecar reports ready: "" is "no session yet".
		useSessionStore.setState({ sessionId: "s1" });
		expect(useUiStore.getState().destination).toBe("agents");
		stop();
	});

	it("returns to the session when another session is selected", () => {
		useSessionStore.setState({ sessionId: "s1" });
		const stop = leavePageOnSessionSelect();
		useUiStore.getState().openAgents();
		useSessionStore.setState({ sessionId: "s2" });
		expect(useUiStore.getState().destination).toBe("session");
		stop();
	});

	it("returns to the session when another tab is activated", () => {
		const stop = leavePageOnSessionSelect();
		useUiStore.getState().openInsights();
		useTabsStore.setState({ activeTabId: "t2" });
		expect(useUiStore.getState().destination).toBe("session");
		stop();
	});
});
