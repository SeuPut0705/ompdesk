/**
 * Focus follows a session activation: the composer takes it from <body> or a sidebar button, and from nothing else.
 */

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { followActivationFocus } from "./tab-focus";

const { document, window, HTMLElement } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.HTMLElement = HTMLElement;

let frames: ((time: number) => void)[] = [];
let clock = 0;
globals.requestAnimationFrame = (callback: (time: number) => void) => frames.push(callback);
globals.cancelAnimationFrame = () => {};
const runFrames = (frameMs = 16) => {
	const pending = frames;
	frames = [];
	clock += frameMs;
	for (const callback of pending) callback(clock);
};

afterEach(() => {
	useUiStore.getState().closeDestination();
	useSessionStore.getState().reset();
	useTabsStore.setState({ activeTabId: null });
	frames = [];
	document.body.innerHTML = "";
	delete globals.matchMedia;
	vi.restoreAllMocks();
});

function setup() {
	document.body.innerHTML = `
		<aside class="omp-session-sidebar"><button id="row">Row</button><input id="rename" /></aside>
		<div class="omp-session-pane" data-active="true"><textarea id="composer" data-composer-input></textarea></div>
		<div id="terminal"><textarea id="xterm"></textarea></div>`;
	let active: Element = document.body;
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: Element) {
		active = this;
	});
	const byId = (id: string) => document.getElementById(id) as unknown as HTMLElement;
	return {
		byId,
		focusOn: (element: Element) => {
			active = element;
		},
		active: () => active,
		stop: followActivationFocus(),
	};
}

describe("followActivationFocus", () => {
	it("hands focus to the composer when a tab is activated with focus on the body or a sidebar button", () => {
		const view = setup();
		useTabsStore.setState({ activeTabId: "t1" });
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));

		view.focusOn(view.byId("row"));
		useTabsStore.setState({ activeTabId: "t2" });
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});

	it("follows a session change in the same tab, but not a tab's first session arriving", () => {
		const view = setup();
		useSessionStore.setState({ sessionId: "s1" });
		runFrames();
		expect(view.active()).toBe(document.body);

		view.focusOn(view.byId("row"));
		useSessionStore.setState({ sessionId: "s2" });
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});

	it("never takes focus from a text field in the sidebar, a dialog, the terminal or another field", () => {
		const view = setup();
		document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><button id="in-dialog">Ok</button></div>');
		for (const id of ["rename", "in-dialog", "xterm"]) {
			view.focusOn(view.byId(id));
			useTabsStore.setState({ activeTabId: `t-${id}` });
			runFrames();
			expect(view.active(), id).toBe(view.byId(id));
		}
		view.stop();
	});

	it("leaves the body alone while a dialog is open, and while a page hides the composer", () => {
		const view = setup();
		// A dialog is open: the body focus under it is not ours to take.
		document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
		useTabsStore.setState({ activeTabId: "t2" });
		runFrames();
		expect(view.active()).toBe(document.body);

		document.querySelector('[role="dialog"]')?.remove();
		useUiStore.getState().openSettings();
		useTabsStore.setState({ activeTabId: "t3" });
		runFrames();
		expect(view.active()).toBe(document.body);
		view.stop();
	});

	it("waits out a dialog that is still closing (the ⌃Tab switcher), then takes focus from where it left it", () => {
		const view = setup();
		document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
		useTabsStore.setState({ activeTabId: "t1" });
		runFrames();
		runFrames();
		expect(view.active()).toBe(document.body);
		document.querySelector('[role="dialog"]')?.remove();
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});

	it("waits out a closing dialog by time, not by frames: a 240 Hz display draws 30 frames inside the 150 ms exit", () => {
		const view = setup();
		document.body.insertAdjacentHTML("beforeend", '<div class="omp-dialog-overlay" role="presentation"></div>');
		useTabsStore.setState({ activeTabId: "t1" });
		for (let frame = 0; frame < 40; frame++) runFrames(4);
		expect(view.active()).toBe(document.body);
		document.querySelector(".omp-dialog-overlay")?.remove();
		runFrames(4);
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});

	it("gives up on a dialog that never leaves", () => {
		const view = setup();
		document.body.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
		useTabsStore.setState({ activeTabId: "t1" });
		for (let frame = 0; frame < 60; frame++) runFrames(16);
		expect(frames).toHaveLength(0);
		view.stop();
	});

	it("waits for a closing dialog's overlay too, which keeps focus until its exit animation ends", () => {
		const view = setup();
		document.body.insertAdjacentHTML(
			"beforeend",
			'<div class="omp-dialog-overlay" role="presentation"><button id="pick">Pick</button></div>',
		);
		view.focusOn(view.byId("pick"));
		useTabsStore.setState({ activeTabId: "t1" });
		runFrames();
		expect(view.active()).toBe(view.byId("pick"));
		document.querySelector(".omp-dialog-overlay")?.remove();
		view.focusOn(document.body);
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});

	it("keeps trying while the new pane's field is not there yet", () => {
		const view = setup();
		view.byId("composer").setAttribute("hidden", "");
		const field = view.byId("composer");
		const pane = field.closest(".omp-session-pane") as unknown as HTMLElement;
		pane.setAttribute("data-active", "false");
		useTabsStore.setState({ activeTabId: "t1" });
		runFrames();
		runFrames();
		expect(view.active()).toBe(document.body);
		pane.setAttribute("data-active", "true");
		runFrames();
		expect(view.active()).toBe(field);
		view.stop();
	});

	it("takes focus from a field of the pane that was just left, which no longer shows", () => {
		const view = setup();
		document.body.insertAdjacentHTML(
			"beforeend",
			'<div class="omp-session-pane" data-active="false"><textarea id="old" data-composer-input></textarea></div>',
		);
		view.focusOn(view.byId("old"));
		useTabsStore.setState({ activeTabId: "t1" });
		runFrames();
		expect(view.active()).toBe(view.byId("composer"));
		view.stop();
	});

	it("hands focus over at the first typed key when that comes before the frame, and leaves modified keys alone", () => {
		const view = setup();
		document.body.insertAdjacentHTML(
			"beforeend",
			'<div class="omp-session-pane" data-active="false"><textarea id="old" data-composer-input></textarea></div>',
		);
		view.focusOn(view.byId("old"));
		useTabsStore.setState({ activeTabId: "t1" });
		const key = (init: { key: string; metaKey?: boolean }) => {
			const event = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { ctrlKey: false, altKey: false, metaKey: false, ...init });
			view.byId("old").dispatchEvent(event);
		};
		key({ key: "1", metaKey: true });
		expect(view.active()).toBe(view.byId("old"));
		key({ key: "s" });
		expect(view.active()).toBe(view.byId("composer"));
		// The frame that follows finds nothing left to do.
		view.focusOn(view.byId("row"));
		runFrames();
		expect(view.active()).toBe(view.byId("row"));
		view.stop();
	});

	it("keeps the keyboard down on a touch device", () => {
		globals.matchMedia = () => ({ matches: true });
		const view = setup();
		useTabsStore.setState({ activeTabId: "t1" });
		runFrames();
		expect(view.active()).toBe(document.body);
		view.stop();
	});

	it("stops following once unsubscribed", () => {
		const view = setup();
		view.stop();
		useTabsStore.setState({ activeTabId: "t1" });
		runFrames();
		expect(view.active()).toBe(document.body);
	});
});
