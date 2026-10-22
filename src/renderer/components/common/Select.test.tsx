/**
 * Select: a native <select> named by its label (or aria-label), listing its options, reporting the chosen string
 * value, disabled when asked, and handing its element to a ref.
 */

import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Select, type SelectOption } from "./Select";

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

async function mount(node: React.ReactNode): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(node));
}

function select(): HTMLSelectElement {
	return document.querySelector("select") as HTMLSelectElement;
}

const OPTIONS: SelectOption[] = [
	{ value: "low", label: "Low" },
	{ value: "mid", label: "Medium" },
	{ value: "high", label: "High", disabled: true },
];

async function choose(value: string): Promise<void> {
	await act(async () => {
		// linkedom has no select.value setter; selecting the option is what a user's pick amounts to.
		const picked = [...select().querySelectorAll("option")].find(option => option.value === value);
		if (picked) picked.selected = true;
		select().dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("Select", () => {
	it("renders every option with its value, label and disabled state", async () => {
		await mount(<Select defaultValue="mid" label="Effort" options={OPTIONS} />);
		const rendered = [...document.querySelectorAll("option")] as HTMLOptionElement[];
		expect(rendered.map(option => [option.value, option.textContent, option.hasAttribute("disabled")])).toEqual([
			["low", "Low", false],
			["mid", "Medium", false],
			["high", "High", true],
		]);
		expect(select().value).toBe("mid");
	});

	it("accepts <option> children instead of data", async () => {
		await mount(
			<Select aria-label="Unit">
				<option value="px">px</option>
				<option value="em">em</option>
			</Select>,
		);
		expect([...document.querySelectorAll("option")].map(option => option.textContent)).toEqual(["px", "em"]);
	});

	it("names the select by its label", async () => {
		await mount(<Select label="Effort" options={OPTIONS} />);
		const label = document.querySelector(`label[for='${select().id}']`);
		expect(select().id).not.toBe("");
		expect(label?.textContent).toBe("Effort");
	});

	it("names the select by aria-label when there is no visible label", async () => {
		await mount(<Select aria-label="Effort level" options={OPTIONS} />);
		expect(select().getAttribute("aria-label")).toBe("Effort level");
	});

	it("reports the chosen option's string value to onChange", async () => {
		const seen: string[] = [];
		await mount(
			<Select aria-label="Effort" onChange={event => seen.push(event.target.value)} options={OPTIONS} value="low" />,
		);
		await choose("mid");
		expect(seen).toEqual(["mid"]);
		expect(typeof seen[0]).toBe("string");
	});

	it("keeps option values with digits as strings, as declared", async () => {
		const seen: unknown[] = [];
		await mount(
			<Select
				aria-label="Count"
				onChange={event => seen.push(event.target.value)}
				options={[
					{ value: "1", label: "One" },
					{ value: "2", label: "Two" },
				]}
				value="1"
			/>,
		);
		await choose("2");
		expect(seen).toEqual(["2"]);
	});

	it("is disabled when asked", async () => {
		await mount(<Select aria-label="Effort" disabled options={OPTIONS} />);
		expect(select().disabled).toBe(true);
	});

	it("marks an error as invalid and describes the select by it", async () => {
		await mount(<Select aria-label="Effort" error="Pick one" options={OPTIONS} />);
		expect(select().getAttribute("aria-invalid")).toBe("true");
		const describedBy = select().getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)?.textContent).toContain("Pick one");
	});

	it("is not marked invalid without an error", async () => {
		await mount(<Select aria-label="Effort" options={OPTIONS} />);
		expect(select().getAttribute("aria-invalid")).toBeNull();
	});

	it("hands its element to a ref", async () => {
		const ref = createRef<HTMLSelectElement>();
		await mount(<Select aria-label="Effort" options={OPTIONS} ref={ref} />);
		expect(ref.current).toBe(select());
	});
});
