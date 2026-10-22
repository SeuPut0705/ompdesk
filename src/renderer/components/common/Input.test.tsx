/**
 * Field labeling: a field's label names the control alone, and its hint or
 * error describes it. Wrapping the control in a <label> folded the hint and a
 * trailing button ("Show API key") into the control's accessible name.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { Input, SearchField, TextArea } from "./Input";
import { Select } from "./Select";

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

async function render(node: React.ReactNode): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(node);
	});
}

/** The text a screen reader names `control` by, through label[for]. */
function labelText(control: Element): string {
	const label = document.body.querySelector(`label[for="${control.getAttribute("id")}"]`);
	return label?.textContent ?? "";
}

function description(control: Element): string {
	return (control.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map(id => document.getElementById(id)?.textContent ?? "")
		.join(" ")
		.trim();
}

it("names an input by its label alone, with the hint as its description", async () => {
	await render(
		<Input
			hint="Optional — stored in models.yml."
			label="API key"
			trailing={
				<button aria-label="Show API key" type="button">
					eye
				</button>
			}
		/>,
	);
	const input = document.body.querySelector("input") as unknown as Element;
	expect(input.closest("label")).toBeNull();
	expect(labelText(input)).toBe("API key");
	expect(description(input)).toBe("Optional — stored in models.yml.");
});

it("describes a field by its error once there is one, and keeps a caller's own description", async () => {
	await render(
		<>
			<span id="extra">Also see the docs.</span>
			<TextArea aria-describedby="extra" error="Base URL is required" hint="Ignored" label="Base URL" />
			<Select
				hint="The API shape the endpoint speaks."
				id="api"
				label="Protocol"
				options={[{ value: "a", label: "A" }]}
			/>
		</>,
	);
	const textarea = document.body.querySelector("textarea") as unknown as Element;
	expect(labelText(textarea)).toBe("Base URL");
	expect(description(textarea)).toBe("Also see the docs. Base URL is required");
	const select = document.body.querySelector("select") as unknown as Element;
	expect(select.getAttribute("id")).toBe("api");
	expect(labelText(select)).toBe("Protocol");
	expect(description(select)).toBe("The API shape the endpoint speaks.");
});

it("grows an auto-grow field to its content plus its border, so an empty field has nothing to scroll", async () => {
	// A layout stand-in: 18px of padding and 2px of border around one 18px line, border-box sizing.
	const PADDING = 16;
	const BORDER = 2;
	const LINE = 18;
	const height = (element: Element) => Number.parseFloat((element as HTMLElement).style.height) || 0;
	const prototype = HTMLElement.prototype;
	Object.defineProperties(prototype, {
		scrollHeight: { configurable: true, get: () => PADDING + LINE },
		offsetHeight: {
			configurable: true,
			get(this: Element) {
				return Math.max(height(this), PADDING + BORDER);
			},
		},
		clientHeight: {
			configurable: true,
			get(this: Element) {
				return Math.max(height(this) - BORDER, PADDING);
			},
		},
	});
	try {
		await render(<TextArea autoGrow label="Message" />);
		const textarea = document.body.querySelector("textarea") as unknown as HTMLElement;
		expect(textarea.style.height).toBe(`${PADDING + LINE + BORDER}px`);
		// Box 36px + border 2px: the content (34px) fits the client box exactly.
		expect(textarea.scrollHeight).toBeLessThanOrEqual(textarea.clientHeight);
	} finally {
		for (const key of ["scrollHeight", "offsetHeight", "clientHeight"]) Reflect.deleteProperty(prototype, key);
	}
});

it("makes a search field the combobox of the list it drives, naming the list and its highlighted row", async () => {
	await render(
		<>
			<SearchField
				label="Search commands"
				listbox={{ id: "list", activeId: "list-2" }}
				onValueChange={() => {}}
				value=""
			/>
			<SearchField label="Filter" onValueChange={() => {}} value="" />
		</I18nProvider>,
	);
	const [picker, filter] = Array.from(document.body.querySelectorAll("input"));
	expect(picker?.getAttribute("role")).toBe("combobox");
	expect(picker?.getAttribute("aria-controls")).toBe("list");
	expect(picker?.getAttribute("aria-activedescendant")).toBe("list-2");
	expect(picker?.getAttribute("aria-expanded")).toBe("true");
	expect(picker?.getAttribute("aria-autocomplete")).toBe("list");
	// A plain filter stays a search box.
	expect(filter?.getAttribute("role")).toBeNull();
	expect(filter?.getAttribute("type")).toBe("search");
});
