import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { revealAndFocus } from "./reveal-focus";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// linkedom has no focus model: record what `focus()` reached.
let focused: HTMLElement | null = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: HTMLElement) {
		focused = this;
	},
});

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	focused = null;
});

function Notes() {
	const [all, setAll] = useState(false);
	const notes = all ? ["one", "two", "three"] : ["one"];
	return (
		<div>
			{notes.map(note => (
				<div data-note={note} key={note}>
					{note}
				</div>
			))}
			{!all && (
				<button onClick={event => revealAndFocus(event.currentTarget, () => setAll(true))} type="button">
					more
				</button>
			)}
		</div>
	);
}

describe("revealAndFocus", () => {
	it("focuses a revealed row with nothing focusable in it, made focusable from script only", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () => root?.render(<Notes />));
		const more = document.querySelector("button") as HTMLElement;
		await act(async () => more.click());
		const row = focused as HTMLElement | null;
		expect(row?.getAttribute("data-note")).toBe("two");
		expect(row?.getAttribute("tabindex")).toBe("-1");
	});

	it("stays in the card's own list when the card sits in an outer list item", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<ul>
					<li>
						<button type="button">open note</button>
						<Notes />
					</li>
				</ul>,
			),
		);
		const more = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "more") as HTMLElement;
		await act(async () => more.click());
		expect(focused?.getAttribute("data-note")).toBe("two");
	});

	it("focuses the row a list names when its revealed rows land elsewhere", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		function Grouped() {
			const [all, setAll] = useState(false);
			return (
				<div>
					<div>
						<div data-row="0">a</div>
						{all && <div data-row="2">c</div>}
					</div>
					<div>
						<div data-row="1">b</div>
					</div>
					{!all && (
						<button
							onClick={event =>
								revealAndFocus(
									event.currentTarget,
									() => setAll(true),
									() => document.querySelector('[data-row="2"]'),
								)
							}
							type="button"
						>
							more
						</button>
					)}
				</div>
			);
		}
		await act(async () => root?.render(<Grouped />));
		await act(async () => (document.querySelector("button") as HTMLElement).click());
		expect(focused?.getAttribute("data-row")).toBe("2");
	});
});
