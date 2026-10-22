/**
 * Checkbox / Radio: native inputs. The checkbox mirrors `indeterminate` onto the DOM property (and clears it),
 * reports checked through onChange, and hands its element to object and callback refs; radios group by name.
 */

import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox, Radio } from "./Checkbox";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function render(node: React.ReactNode): Promise<void> {
	if (!root) {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
	}
	await act(async () => root?.render(node));
}

function input(selector = "input"): HTMLInputElement {
	return document.querySelector(selector) as HTMLInputElement;
}

describe("Checkbox", () => {
	it("renders a named native checkbox", async () => {
		await render(<Checkbox aria-label="Select all" />);
		expect(input().getAttribute("type")).toBe("checkbox");
		expect(input().getAttribute("aria-label")).toBe("Select all");
		expect(input().checked).toBe(false);
	});

	it("sets the indeterminate property and clears it when the prop goes away", async () => {
		await render(<Checkbox aria-label="All" indeterminate onChange={() => {}} />);
		expect(input().indeterminate).toBe(true);
		await render(<Checkbox aria-label="All" indeterminate={false} onChange={() => {}} />);
		expect(input().indeterminate).toBe(false);
		await render(<Checkbox aria-label="All" indeterminate onChange={() => {}} />);
		expect(input().indeterminate).toBe(true);
		await render(<Checkbox aria-label="All" onChange={() => {}} />);
		expect(input().indeterminate).toBe(false);
	});

	it("is not indeterminate by default", async () => {
		await render(<Checkbox aria-label="One" />);
		expect(input().indeterminate).toBe(false);
	});

	it("reports the new checked state through onChange", async () => {
		const seen: boolean[] = [];
		await render(<Checkbox aria-label="One" checked={false} onChange={event => seen.push(event.target.checked)} />);
		// linkedom's click() does not toggle a checkbox the way a browser does; flip it first, then click.
		await act(async () => {
			input().checked = true;
			input().click();
		});
		expect(seen).toEqual([true]);
	});

	it("renders disabled when asked", async () => {
		await render(<Checkbox aria-label="One" disabled />);
		expect(input().disabled).toBe(true);
	});

	it("hands its element to an object ref and clears it on unmount", async () => {
		const ref = createRef<HTMLInputElement>();
		await render(<Checkbox aria-label="One" ref={ref} />);
		expect(ref.current).toBe(input());
		await render(null);
		expect(ref.current).toBeNull();
	});

	it("hands its element to a callback ref", async () => {
		const calls: (HTMLInputElement | null)[] = [];
		await render(<Checkbox aria-label="One" ref={element => void calls.push(element)} />);
		expect(calls).toContain(input());
		await render(null);
		expect(calls.at(-1)).toBeNull();
	});

	it("keeps the caller's own class and attributes on the input", async () => {
		await render(<Checkbox aria-label="One" className="mine" data-row="7" id="cb" name="rows" value="7" />);
		expect(input().classList.contains("mine")).toBe(true);
		expect(input().getAttribute("data-row")).toBe("7");
		expect(input().id).toBe("cb");
		expect(input().name).toBe("rows");
		expect(input().value).toBe("7");
	});
});

describe("Radio", () => {
	it("renders native radios that share a name", async () => {
		await render(
			<>
				<Radio aria-label="One" name="pick" onChange={() => {}} value="1" />
				<Radio aria-label="Two" name="pick" onChange={() => {}} value="2" />
			</>,
		);
		const radios = [...document.querySelectorAll("input")] as HTMLInputElement[];
		expect(radios.map(radio => radio.getAttribute("type"))).toEqual(["radio", "radio"]);
		expect(radios.map(radio => radio.name)).toEqual(["pick", "pick"]);
		expect(radios.map(radio => radio.value)).toEqual(["1", "2"]);
	});

	it("reports the picked value through onChange", async () => {
		const picked: string[] = [];
		await render(
			<>
				<Radio aria-label="One" name="pick" onChange={event => picked.push(event.target.value)} value="1" />
				<Radio aria-label="Two" name="pick" onChange={event => picked.push(event.target.value)} value="2" />
			</>,
		);
		await act(async () => (document.querySelectorAll("input")[1] as HTMLInputElement).click());
		expect(picked).toEqual(["2"]);
	});
});
