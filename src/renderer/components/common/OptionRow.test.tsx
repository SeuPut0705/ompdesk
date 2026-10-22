/** OptionRow: a listbox option whose aria-selected follows the highlight unless the picker names the current item. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptionRow } from "./OptionRow";

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
	root = undefined;
	document.body.innerHTML = "";
});

async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(<div role="listbox">{node}</div>));
	return Array.from(document.querySelectorAll("[role=option]")) as unknown as HTMLElement[];
}

describe("OptionRow", () => {
	it("is a non-submitting option selected with the highlight unless told which item is current", async () => {
		const rows = await mount(
			<>
				<OptionRow active id="o-1">
					One
				</OptionRow>
				<OptionRow active={false} id="o-2">
					Two
				</OptionRow>
				<OptionRow active selected={false} id="o-3">
					Three
				</OptionRow>
			</>,
		);
		expect(rows.map(row => row.getAttribute("type"))).toEqual(["button", "button", "button"]);
		expect(rows.map(row => row.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
		expect(rows[0]?.id).toBe("o-1");
		// The field keeps focus and names the highlight; Tab never walks the results.
		expect(rows.map(row => row.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1"]);
	});

	it("runs its click and leaves a disabled row unpickable", async () => {
		const onPick = vi.fn();
		const rows = await mount(
			<>
				<OptionRow active={false} onClick={onPick}>
					Live
				</OptionRow>
				<OptionRow active={false} disabled onClick={onPick}>
					Off
				</OptionRow>
			</>,
		);
		await act(async () => rows[0]?.click());
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(rows[1]?.hasAttribute("disabled")).toBe(true);
	});
});
