/**
 * ContextMenu contract tests: items render, arrows navigate, Enter selects,
 * Escape closes, disabled items never fire. Same linkedom + react-dom harness
 * as LangSwitcher.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove: () => void;
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(element);
	});
	await flush();
}

/** Drive the menu's own keydown and report what the handler claimed. */
async function menuKeyDown(key: string): Promise<{ prevented: boolean; stopped: boolean }> {
	const outcome = { prevented: false, stopped: false };
	if (key === "Escape") {
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key });
		const stop = event.stopImmediatePropagation.bind(event);
		event.stopImmediatePropagation = () => {
			outcome.stopped = true;
			stop();
		};
		await act(async () => {
			document.dispatchEvent(event);
		});
		outcome.prevented = event.defaultPrevented;
		return outcome;
	}
	const menu = document.body.querySelector('[role="menu"]') as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(menu).find(name => name.startsWith("__reactProps$"));
	const props = propsKey
		? (menu[propsKey] as
				| { onKeyDown?: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => void }
				| undefined)
		: undefined;
	if (!props?.onKeyDown) throw new Error("menu onKeyDown not found");
	await act(async () =>
		props.onKeyDown?.({
			key,
			preventDefault: () => {
				outcome.prevented = true;
			},
			stopPropagation: () => {
				outcome.stopped = true;
			},
		}),
	);
	await flush();
	return outcome;
}

async function clickItem(label: string): Promise<void> {
	const button = [...document.body.querySelectorAll("button")].find(b => b.textContent?.includes(label));
	const record = button as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	const props = propsKey
		? (record[propsKey] as { onClick?: (event: { preventDefault(): void }) => void } | undefined)
		: undefined;
	if (!props?.onClick) throw new Error(`item onClick not found: ${label}`);
	await act(async () => props.onClick?.({ preventDefault: () => {} }));
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
});

describe("ContextMenu", () => {
	it("renders all items and fires onSelect on click", async () => {
		const onA = vi.fn();
		const onB = vi.fn();
		const items: ContextMenuItem[] = [
			{ id: "a", label: "Action A", onSelect: onA },
			{ id: "b", label: "Action B", onSelect: onB },
		];
		await mount(<ContextMenu items={items} x={10} y={10} onClose={() => {}} />);

		expect(document.body.textContent).toContain("Action A");
		expect(document.body.textContent).toContain("Action B");
		await clickItem("Action B");
		expect(onB).toHaveBeenCalledTimes(1);
		expect(onA).not.toHaveBeenCalled();
	});

	it("arrows navigate, Enter selects the active item", async () => {
		const onA = vi.fn();
		const onB = vi.fn();
		await mount(
			<ContextMenu
				items={[
					{ id: "a", label: "Action A", onSelect: onA },
					{ id: "b", label: "Action B", onSelect: onB },
				]}
				x={10}
				y={10}
				onClose={() => {}}
			/>,
		);

		await menuKeyDown("ArrowDown");
		await menuKeyDown("Enter");
		expect(onB).toHaveBeenCalledTimes(1);

		// Wrap-around: ArrowUp from the last item cycles back and selects A.
		await menuKeyDown("ArrowUp");
		await menuKeyDown("Enter");
		expect(onA).toHaveBeenCalledTimes(1);
	});

	it("Escape closes without selecting, and is claimed so the dialog behind stays open", async () => {
		const onClose = vi.fn();
		const onA = vi.fn();
		await mount(
			<ContextMenu items={[{ id: "a", label: "Action A", onSelect: onA }]} x={10} y={10} onClose={onClose} />,
		);

		const outcome = await menuKeyDown("Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onA).not.toHaveBeenCalled();
		// A settings window behind this menu listens for Escape on the same
		// document; without the claim one press closes both.
		expect(outcome.stopped).toBe(true);
	});

	it("stays open through clicks inside and closes on the next outside pointer press", async () => {
		const onClose = vi.fn();
		await mount(
			<ContextMenu items={[{ id: "a", label: "Action A", onSelect: () => {} }]} x={10} y={10} onClose={onClose} />,
		);

		const item = document.body.querySelector('[role="menu"] button');
		await act(async () => {
			item?.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		});
		expect(onClose).not.toHaveBeenCalled();

		await act(async () => {
			document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("disabled items are skipped by navigation and never fire", async () => {
		const onA = vi.fn();
		const onB = vi.fn();
		await mount(
			<ContextMenu
				items={[
					{ id: "a", label: "Disabled A", disabled: true, disabledReason: "nope", onSelect: onA },
					{ id: "b", label: "Action B", onSelect: onB },
				]}
				x={10}
				y={10}
				onClose={() => {}}
			/>,
		);

		// Initial active index skips the disabled first item; Enter hits B.
		await menuKeyDown("Enter");
		expect(onB).toHaveBeenCalledTimes(1);
		expect(onA).not.toHaveBeenCalled();
	});
});

describe("ContextMenu placement", () => {
	/** A 200×240 menu whose pop-in scale(0.95) still shrinks its bounding box at mount. */
	function stubLayout(): () => void {
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		const saved = ["offsetWidth", "offsetHeight", "getBoundingClientRect"].map(
			key => [key, Object.getOwnPropertyDescriptor(proto, key)] as const,
		);
		Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 200 });
		Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 240 });
		Object.defineProperty(proto, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ width: 190, height: 228, left: 0, top: 0, right: 190, bottom: 228 }),
		});
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
		Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
		return () => {
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(proto, key, descriptor);
				else Reflect.deleteProperty(proto, key);
			}
		};
	}

	function menuBox(): { left: string; top: string } {
		const menu = document.body.querySelector('[role="menu"]') as unknown as { style: { left: string; top: string } };
		return { left: menu.style.left, top: menu.style.top };
	}

	it("sizes from the layout box, so an end-aligned menu never runs past the window edge", async () => {
		const restore = stubLayout();
		try {
			await mount(
				<ContextMenu
					align="end"
					items={[{ id: "a", label: "A", onSelect() {} }]}
					onClose={() => {}}
					x={1396}
					y={40}
				/>,
			);
			expect(menuBox()).toEqual({ left: "1196px", top: "40px" });
		} finally {
			restore();
		}
	});

	it("opens above its trigger when there is no room below instead of covering it", async () => {
		const restore = stubLayout();
		try {
			await mount(
				<ContextMenu
					above={862}
					items={[{ id: "a", label: "A", onSelect() {} }]}
					onClose={() => {}}
					x={20}
					y={892}
				/>,
			);
			expect(menuBox()).toEqual({ left: "20px", top: "622px" });
		} finally {
			restore();
		}
	});
});
