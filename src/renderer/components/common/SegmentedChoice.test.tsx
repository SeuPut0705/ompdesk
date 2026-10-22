/**
 * SegmentedChoice: one tab stop, arrow keys over the enabled options (disabled ones skipped, wrapping at the ends),
 * picking as it moves or only focusing, and a click on the held option reporting nothing.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedChoice, type SegmentedOption } from "./SegmentedChoice";

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

type V = "a" | "b" | "c" | "d";
const OPTIONS: SegmentedOption<V>[] = [
	{ value: "a", label: "A" },
	{ value: "b", label: "B", disabled: true },
	{ value: "c", label: "C", name: "Choice C" },
	{ value: "d", label: "D" },
];

async function mount(value: V | null, onChange: (next: V) => void, selectOnArrow?: boolean) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<SegmentedChoice
				aria-label="Pick"
				onChange={onChange}
				optionAttr="data-pick"
				options={OPTIONS}
				selectOnArrow={selectOnArrow}
				value={value}
			/>,
		),
	);
	return Array.from(document.querySelectorAll("[role=radio]")) as unknown as HTMLElement[];
}

async function press(target: HTMLElement, key: string) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: key });
	await act(async () => target.dispatchEvent(event));
}

describe("SegmentedChoice", () => {
	it("is a named radio group whose held option is the one tab stop", async () => {
		const segments = await mount("c", vi.fn());
		expect(document.querySelector("[role=radiogroup]")?.getAttribute("aria-label")).toBe("Pick");
		expect(segments.map(segment => segment.getAttribute("aria-checked"))).toEqual([
			"false",
			"false",
			"true",
			"false",
		]);
		expect(segments.map(segment => segment.getAttribute("tabindex"))).toEqual(["-1", "-1", "0", "-1"]);
		expect(segments[2]?.getAttribute("aria-label")).toBe("Choice C");
		expect(segments[1]?.hasAttribute("disabled")).toBe(true);
	});

	it("makes the first enabled option the tab stop while no value is held", async () => {
		const segments = await mount(null, vi.fn());
		expect(segments.map(segment => segment.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
	});

	it("moves over the enabled options with the arrows, skipping a disabled one and wrapping", async () => {
		const onChange = vi.fn();
		const segments = await mount("a", onChange);
		await press(segments[0] as HTMLElement, "ArrowRight");
		expect(onChange).toHaveBeenLastCalledWith("c");
		await press(segments[0] as HTMLElement, "ArrowLeft");
		expect(onChange).toHaveBeenLastCalledWith("d");
		await press(segments[3] as HTMLElement, "ArrowUp");
		expect(onChange).toHaveBeenLastCalledWith("c");
	});

	it("only moves focus when it does not pick on arrows, and a click on the held option reports nothing", async () => {
		const onChange = vi.fn();
		const segments = await mount("a", onChange, false);
		await press(segments[0] as HTMLElement, "ArrowRight");
		expect(onChange).not.toHaveBeenCalled();
		await act(async () => segments[0]?.click());
		expect(onChange).not.toHaveBeenCalled();
		await act(async () => segments[3]?.click());
		expect(onChange).toHaveBeenCalledWith("d");
	});
});
