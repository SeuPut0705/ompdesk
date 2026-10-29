/**
 * Tooltip with a mouse: it shows after the hover delay or at once on keyboard focus, names itself as the trigger's
 * description only while shown (and only when asked), and goes with Escape, a press, leaving or blur (WCAG 1.4.13).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShellModeForTests, TOUCH_QUERY } from "../../hooks/use-shell-mode";
import { Tooltip, type TooltipProps } from "./Tooltip";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
/** Whether the trigger's focus came from the keyboard; linkedom knows no `:focus-visible`. */
let keyboardFocus = true;

beforeEach(() => {
	vi.useFakeTimers();
	keyboardFocus = true;
	const matches = HTMLElement.prototype.matches;
	vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
		return selector === ":focus-visible" ? keyboardFocus : matches.call(this, selector);
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function mount(props: Partial<TooltipProps> = {}) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<Tooltip content="Open in browser" {...props}>
				<button aria-label="Open" type="button">
					↗
				</button>
			</Tooltip>,
		),
	);
	return host.querySelector("button") as unknown as HTMLElement;
}

const bubble = () => document.querySelector("[role=tooltip]");

async function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, init);
	await act(async () => target.dispatchEvent(event));
}

describe("Tooltip", () => {
	it("shows after the hover delay, not before, and goes when the pointer leaves", async () => {
		const trigger = await mount();
		await fire(trigger, "pointerover", { pointerType: "mouse" });
		await act(async () => vi.advanceTimersByTime(400));
		expect(bubble()).toBeNull();
		await act(async () => vi.advanceTimersByTime(100));
		expect(bubble()?.textContent).toBe("Open in browser");
		await fire(trigger, "pointerout", { pointerType: "mouse" });
		expect(bubble()).toBeNull();
	});

	it("shows at once on keyboard focus, never on a click's focus, and goes on blur", async () => {
		const trigger = await mount();
		keyboardFocus = false;
		await fire(trigger, "focusin");
		expect(bubble()).toBeNull();
		keyboardFocus = true;
		await fire(trigger, "focusin");
		expect(bubble()).not.toBeNull();
		await fire(trigger, "focusout");
		expect(bubble()).toBeNull();
	});

	it("describes its trigger only while shown, unless told the text repeats the trigger's name", async () => {
		const trigger = await mount();
		expect(trigger.getAttribute("aria-describedby")).toBeNull();
		await fire(trigger, "focusin");
		expect(trigger.getAttribute("aria-describedby")).toBe(bubble()?.id);
		await act(async () => root?.unmount());
		const named = await mount({ describe: false });
		await fire(named, "focusin");
		expect(bubble()).not.toBeNull();
		expect(named.getAttribute("aria-describedby")).toBeNull();
	});

	it("goes with Escape or a press, without moving focus", async () => {
		const trigger = await mount();
		await fire(trigger, "focusin");
		await fire(document, "keydown", { key: "Escape" });
		expect(bubble()).toBeNull();
		await fire(trigger, "focusin");
		await fire(trigger, "pointerdown", { pointerType: "mouse" });
		expect(bubble()).toBeNull();
	});

	it("stays off while another surface already shows the same text", async () => {
		const trigger = await mount({ hidden: true });
		await fire(trigger, "focusin");
		expect(bubble()).toBeNull();
		expect(trigger.getAttribute("aria-describedby")).toBeNull();
	});
	it("does not open on a script's focus where the main pointer is a finger", async () => {
		document.documentElement.dataset.platform = "web";
		Object.assign(window, {
			matchMedia: (query: string) => ({
				matches: query === TOUCH_QUERY,
				addEventListener: () => {},
				removeEventListener: () => {},
			}),
		});
		resetShellModeForTests();
		try {
			// A sheet focuses its close button as it slides in; the chord in the bubble cannot be pressed on touch.
			const trigger = await mount({ shortcut: "⌘J" });
			await fire(trigger, "focusin");
			expect(bubble()).toBeNull();
		} finally {
			delete document.documentElement.dataset.platform;
			Reflect.deleteProperty(window, "matchMedia");
			resetShellModeForTests();
		}
	});
});
