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
