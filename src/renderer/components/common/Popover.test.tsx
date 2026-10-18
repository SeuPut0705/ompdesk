/**
 * Popover placement: the panel is placed from its layout box, so the pop-in
 * scale never shrinks the measure and lets the grown panel overrun the window
 * edge. Same linkedom + react-dom harness as ContextMenu.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Popover } from "./Popover";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
});

it("places a panel near the window edge by its layout box, inside the window", async () => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	const saved = ["offsetWidth", "offsetHeight", "getBoundingClientRect"].map(
		key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
	);
	// A 320×400 panel whose pop-in scale(0.95) still shrinks its bounding box at mount.
	Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 320 });
	Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 400 });
	Object.defineProperty(proto, "getBoundingClientRect", {
		configurable: true,
		value: () => ({ width: 304, height: 380, left: 0, top: 0, right: 304, bottom: 380 }),
	});
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: 760 });
	try {
		// A trigger in the bottom-right quarter pane of a 2×2 split.
		const anchor = document.createElement("button");
		Object.defineProperty(anchor, "getBoundingClientRect", {
			value: () => ({ width: 28, height: 28, left: 960, top: 700, right: 988, bottom: 728 }),
		});
		document.body.appendChild(anchor);
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root?.render(
				<Popover
					anchorRef={{ current: anchor as unknown as HTMLElement }}
					ariaLabel="Run settings"
					onClose={() => {}}
					open
					placement="top-start"
				>
					settings
				</Popover>,
			);
		});
		const panel = document.body.querySelector('[role="dialog"]') as unknown as {
			style: { left: string; top: string };
		};
		expect({ left: panel.style.left, top: panel.style.top }).toEqual({ left: "672px", top: "294px" });
	} finally {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(proto, key, descriptor);
			else Reflect.deleteProperty(proto, key);
		}
	}
});

it("Tab on the last control closes the popover and moves on to the control after its anchor; Shift+Tab on the first returns to the anchor", async () => {
	let focused: unknown = null;
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	const savedFocus = Object.getOwnPropertyDescriptor(proto, "focus");
	Object.defineProperty(proto, "focus", {
		configurable: true,
		value(this: unknown) {
			focused = this;
		},
	});
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });
	try {
		const toolbar = document.createElement("div");
		const anchor = document.createElement("button");
		const next = document.createElement("button");
		toolbar.append(anchor, next);
		document.body.appendChild(toolbar);
		const container = document.createElement("div");
		document.body.appendChild(container);
		let closed = 0;
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root?.render(
				<Popover
					anchorRef={{ current: anchor as unknown as HTMLElement }}
					ariaLabel="Run settings"
					onClose={() => {
						closed += 1;
					}}
					open
				>
					<button type="button">first</button>
					<button type="button">last</button>
				</Popover>,
			);
		});
		const [first, last] = [...document.body.querySelectorAll('[role="dialog"] button')] as unknown as HTMLElement[];
		const press = async (target: HTMLElement, shiftKey: boolean) => {
			focused = target;
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: "Tab" });
			Object.defineProperty(event, "shiftKey", { value: shiftKey });
			await act(async () => target.dispatchEvent(event));
			return event;
		};

		// Between the panel's own controls the browser moves focus.
		const inside = await press(first as HTMLElement, false);
		expect(inside.defaultPrevented).toBe(false);
		expect(closed).toBe(0);

		const out = await press(last as HTMLElement, false);
		expect(out.defaultPrevented).toBe(true);
		expect(closed).toBe(1);
		expect(focused).toBe(next);

		const back = await press(first as HTMLElement, true);
		expect(back.defaultPrevented).toBe(true);
		expect(closed).toBe(2);
		expect(focused).toBe(anchor);
	} finally {
		if (savedFocus) Object.defineProperty(proto, "focus", savedFocus);
		else Reflect.deleteProperty(proto, "focus");
		Reflect.deleteProperty(document, "activeElement");
	}
});
