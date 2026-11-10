/**
 * ChoiceCards: a named radio group of cards with one tab stop; arrow keys move over the enabled cards (disabled ones
 * skipped, wrapping at the ends) and pick as they move; a click on the held card reports nothing.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChoiceCard, ChoiceCards } from "./ChoiceCards";

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

type V = "a" | "b" | "c";
const OPTIONS: ChoiceCard<V>[] = [
	{ value: "a", title: "A", hint: "First" },
	{ value: "b", title: "B", disabled: true },
	{ value: "c", title: "C", hint: "Third" },
];

async function mount(value: V | null, onChange: (next: V) => void) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<ChoiceCards aria-label="Pick" onChange={onChange} optionAttr="data-pick" options={OPTIONS} value={value} />,
		),
	);
	return Array.from(document.querySelectorAll("[role=radio]")) as unknown as HTMLElement[];
}

async function press(target: HTMLElement, key: string) {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: key });
	await act(async () => target.dispatchEvent(event));
}

describe("ChoiceCards", () => {
	it("is a named radio group whose held card is the one tab stop, each card with its hint", async () => {
		const cards = await mount("c", vi.fn());
		expect(document.querySelector("[role=radiogroup]")?.getAttribute("aria-label")).toBe("Pick");
		expect(cards.map(card => card.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
		expect(cards.map(card => card.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
		expect(cards.map(card => card.getAttribute("data-pick"))).toEqual(["a", "b", "c"]);
		expect(cards[2]?.textContent).toBe("CThird");
		expect(cards[1]?.hasAttribute("disabled")).toBe(true);
	});

	it("makes the first enabled card the tab stop while no value is held", async () => {
		const cards = await mount(null, vi.fn());
		expect(cards.map(card => card.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
	});

	it("picks with the arrows, skipping a disabled card and wrapping", async () => {
		const onChange = vi.fn();
		const cards = await mount("a", onChange);
		await press(cards[0] as HTMLElement, "ArrowRight");
		expect(onChange).toHaveBeenLastCalledWith("c");
		await press(cards[0] as HTMLElement, "ArrowUp");
		expect(onChange).toHaveBeenLastCalledWith("c");
		// Back onto the held card: nothing to report.
		await press(cards[2] as HTMLElement, "ArrowDown");
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("reports a click on another card and nothing for the held one", async () => {
		const onChange = vi.fn();
		const cards = await mount("a", onChange);
		await act(async () => cards[0]?.click());
		expect(onChange).not.toHaveBeenCalled();
		await act(async () => cards[2]?.click());
		expect(onChange).toHaveBeenCalledWith("c");
	});

	it("in parts, keeps one radio group whose arrows cross from one part's grid to the next", async () => {
		const onChange = vi.fn();
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host as unknown as Element);
		await act(async () =>
			root?.render(
				<ChoiceCards
					aria-label="Theme"
					groups={[
						{ key: "system", options: [{ value: "a", title: "System", preview: <i /> }] },
						{
							key: "light",
							label: "Light",
							attrs: { "data-group": "light" },
							options: [
								{ value: "b", title: "Paper", preview: <i /> },
								{ value: "c", title: "Sand", preview: <i />, tooltip: "Warm, low glare" },
							],
						},
					]}
					onChange={onChange}
					optionAttr="data-pick"
					value="a"
				/>,
			),
		);
		expect(document.querySelectorAll("[role=radiogroup]").length).toBe(1);
		expect(document.querySelector("[data-group=light] h3")?.textContent).toBe("Light");
		const cards = Array.from(document.querySelectorAll("[role=radio]")) as unknown as HTMLElement[];
		// The picture is decoration: the card is named by its title.
		expect(cards.map(card => card.textContent)).toEqual(["System", "Paper", "Sand"]);
		expect(cards.map(card => card.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
		await press(cards[0] as HTMLElement, "ArrowRight");
		expect(onChange).toHaveBeenLastCalledWith("b");
		await press(cards[0] as HTMLElement, "ArrowLeft");
		expect(onChange).toHaveBeenLastCalledWith("c");
	});
});
