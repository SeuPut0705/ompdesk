/**
 * AppShell: which store transitions return from a destination page to the
 * session view, and where focus goes on the way in and out.
 */

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { followPageFocus, leavePageOnSessionSelect } from "./AppShell";

const { document, window, HTMLElement } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.HTMLElement = HTMLElement;

// Frames run only when the test says so: the handoff waits for React's commit.
let frames: (() => void)[] = [];
globals.requestAnimationFrame = (callback: () => void) => frames.push(callback);
globals.cancelAnimationFrame = () => {};
const runFrames = () => {
	const pending = frames;
	frames = [];
	for (const callback of pending) callback();
};

afterEach(() => {
	useUiStore.getState().closeDestination();
	useSessionStore.getState().reset();
	useTabsStore.setState({ activeTabId: null });
	frames = [];
	document.body.innerHTML = "";
	vi.restoreAllMocks();
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

describe("followPageFocus", () => {
	/**
	 * A window with a session pane (an ask card's answer field ahead of the composer), a sidebar
	 * button and a page section; focus is tracked by hand.
	 */
	function setup() {
		document.body.innerHTML = `
			<aside><button id="row">Row</button></aside>
			<div class="omp-session-pane" data-active="true">
				<textarea id="ask"></textarea><textarea id="composer" data-composer-input></textarea>
			</div>
			<section id="page" tabindex="-1"><button id="inside">Back</button></section>`;
		let active: Element = document.body;
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
		const hidden = new Set<Element>();
		// linkedom has no layout: a hidden element is one the test marks hidden.
		Object.defineProperty(HTMLElement.prototype, "getClientRects", {
			configurable: true,
			value(this: Element) {
				return hidden.has(this) ? [] : [{}];
			},
		});
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: Element) {
			active = this;
		});
		const byId = (id: string) => document.getElementById(id) as unknown as HTMLElement;
		return {
			byId,
			hidden,
			focusOn: (element: Element) => {
				active = element;
			},
			active: () => active,
			stop: followPageFocus(() => byId("page")),
		};
	}

	it("lands on the page it opens and goes back to the composer that had focus", () => {
		const view = setup();
		view.focusOn(view.byId("composer"));
		useUiStore.getState().openSettings();
		// The session view is hidden under the page: its focus drops to the body.
		view.focusOn(document.body);
		runFrames();
		expect(view.active()).toBe(view.byId("page"));
		// Switching pages keeps focus on the page.
		view.focusOn(view.byId("inside"));
		useUiStore.getState().openAgents();
		runFrames();
		expect(view.active()).toBe(view.byId("inside"));
		// Escape (or Back, which unmounts with the page) returns to the composer.
		useUiStore.getState().closeDestination();
		view.focusOn(document.body);
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});

	it("leaves focus the user moved elsewhere, and falls back to the active composer", () => {
		const view = setup();
		view.focusOn(view.byId("row"));
		useUiStore.getState().openInsights();
		runFrames();
		expect(view.active()).toBe(view.byId("page"));
		// Picking a session in the sidebar closes the page with focus on that row.
		useUiStore.getState().closeDestination();
		view.focusOn(view.byId("row"));
		runFrames();
		expect(view.active()).toBe(view.byId("row"));

		// The element focus came from is gone or hidden: the composer takes it.
		useUiStore.getState().openSettings();
		runFrames();
		view.hidden.add(view.byId("row"));
		useUiStore.getState().closeDestination();
		view.focusOn(document.body);
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});
});
