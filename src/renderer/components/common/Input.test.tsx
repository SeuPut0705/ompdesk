/**
 * Field labeling: a field's label names the control alone, and its hint or
 * error describes it. Wrapping the control in a <label> folded the hint and a
 * trailing button ("Show API key") into the control's accessible name.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Input, TextArea } from "./Input";
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
