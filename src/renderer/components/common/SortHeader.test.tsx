/** SortHeader: a column header whose button sorts by it; only the sorted column says its order (`aria-sort`). */

import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { type SortDirection, SortHeader } from "./SortHeader";

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

function Table() {
	const [sort, setSort] = useState<{ key: "name" | "cost"; direction: SortDirection }>({
		key: "name",
		direction: "ascending",
	});
	const by = (key: "name" | "cost") => () =>
		setSort(current => ({
			key,
			direction: current.key === key && current.direction === "ascending" ? "descending" : "ascending",
		}));
	return (
		<table>
			<thead>
				<tr>
					<SortHeader direction={sort.key === "name" ? sort.direction : null} label="Name" onSort={by("name")} />
					<SortHeader
						align="end"
						direction={sort.key === "cost" ? sort.direction : null}
						label="Cost"
						onSort={by("cost")}
					/>
				</tr>
			</thead>
		</table>
	);
}

it("says the sorted column's order and moves it to the column whose button is pressed", async () => {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(<Table />));
	const headers = () => [...host.querySelectorAll("th")].map(th => th.getAttribute("aria-sort"));
	const press = (name: string) =>
		act(async () =>
			(
				[...host.querySelectorAll("th button")].find(
					button => button.textContent === name,
				) as unknown as HTMLElement
			).click(),
		);

	expect([...host.querySelectorAll("th")].every(th => th.getAttribute("scope") === "col")).toBe(true);
	expect(headers()).toEqual(["ascending", null]);
	await press("Name");
	expect(headers()).toEqual(["descending", null]);
	await press("Cost");
	expect(headers()).toEqual([null, "ascending"]);
});
