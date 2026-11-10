/**
 * ListRow: one button per row, named by its title and described by its second lines, or named by the whole row when
 * asked; the current row says so; actions at rest follow the meta; its tooltip is reachable by keyboard and by a tap.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TOUCH_QUERY } from "../../hooks/shell-queries";
import { resetShellModeForTests } from "../../hooks/use-shell-mode";
import { ListRow } from "./ListRow";

const TOUCH_MEDIA = (query: string) => ({
	matches: query === TOUCH_QUERY,
	addEventListener: () => {},
	removeEventListener: () => {},
});

async function mounted(
	node: ReactNode,
	check: (document: Document) => void | Promise<void>,
	{ touch = false }: { touch?: boolean } = {},
): Promise<void> {
	const { document, window, Event, HTMLElement } = parseHTML("<html><body></body></html>");
	Object.assign(globalThis, { document, window, Event, IS_REACT_ACT_ENVIRONMENT: true });
	if (touch) {
		document.documentElement.dataset.platform = "web";
		Object.assign(window, { matchMedia: TOUCH_MEDIA });
	}
	resetShellModeForTests();
	// linkedom knows no `:focus-visible`: every focus here comes from the keyboard.
	const matches = HTMLElement.prototype.matches;
	vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
		return selector === ":focus-visible" || matches.call(this, selector);
	});
	const root = createRoot(document.body as unknown as globalThis.Element);
	try {
		await act(async () => root.render(node));
		await check(document as unknown as Document);
	} finally {
		await act(async () => root.unmount());
		vi.restoreAllMocks();
		resetShellModeForTests();
	}
}

/** Fire `type` on the row's button and read the tooltip it leaves open. */
async function tooltipAfter(document: Document, type: string): Promise<string | null> {
	await act(async () => document.querySelector("button")?.dispatchEvent(new Event(type, { bubbles: true })));
	return document.querySelector("[role=tooltip]")?.textContent ?? null;
}

/** The texts the ids in `attribute` point at, in order. */
function referenced(document: Document, element: Element | null, attribute: string): string[] {
	return (element?.getAttribute(attribute) ?? "")
		.split(" ")
		.filter(Boolean)
		.map(id => document.getElementById(id)?.textContent ?? `missing ${id}`);
}

describe("ListRow", () => {
	it("actionsAtRest puts the actions after the meta as an ordinary control", () => {
		const row = renderToStaticMarkup(
			<ListRow
				actions={<button type="button">act</button>}
				actionsAtRest
				actionsOnHover
				meta="2m"
				onClick={() => {}}
				title="Session"
			/>,
		);
		expect(row.indexOf("2m")).toBeLessThan(row.indexOf("act"));
	});

	it("describes its button by the description and the secondary line, beside any description the caller gives", async () => {
		await mounted(
			<>
				<ListRow
					buttonProps={{ "aria-describedby": "hint" }}
					description="~/work/app"
					onClick={() => {}}
					secondary={<span>main</span>}
					title="app"
				/>
				<span id="hint">Opens the project</span>
			</>,
			document => {
				const button = document.querySelector("button");
				expect(button?.textContent).toBe("app");
				expect(button?.hasAttribute("aria-labelledby")).toBe(false);
				expect(referenced(document, button, "aria-describedby")).toEqual([
					"Opens the project",
					"~/work/app",
					"main",
				]);
			},
		);
		expect(renderToStaticMarkup(<ListRow onClick={() => {}} title="app" />)).not.toContain("aria-describedby");
	});

	it("names its button by every text of the row when asked, in order", async () => {
		await mounted(
			<ListRow
				accessibleName="row"
				meta="2h"
				onClick={() => {}}
				secondary={
					<>
						<span>#42</span>
						<span>octocat</span>
					</>
				}
				title="The project page loads"
			/>,
			document => {
				const button = document.querySelector("button");
				expect(referenced(document, button, "aria-labelledby")).toEqual([
					"The project page loads",
					"#42octocat",
					"2h",
				]);
				expect(button?.hasAttribute("aria-describedby")).toBe(false);
			},
		);
	});

	it("marks the current row, which stays current while it cannot be pressed", async () => {
		await mounted(<ListRow disabled onClick={() => {}} selected size="sm" title="main" />, document => {
			const button = document.querySelector("button");
			expect(button?.getAttribute("aria-current")).toBe("true");
			expect(button?.hasAttribute("disabled")).toBe(true);
		});
	});

	it("shows its tooltip on keyboard focus, and on a tap where the row has no action of its own", async () => {
		await mounted(<ListRow onClick={() => {}} title="app" tooltip="~/work/app" />, async document => {
			expect(await tooltipAfter(document, "focusin")).toBe("~/work/app");
		});
		await mounted(<ListRow title="notes.md" tooltip="~/work/app/notes.md" />, async document => {
			expect(document.querySelector("button")?.textContent).toBe("notes.md");
			expect(await tooltipAfter(document, "focusin")).toBe("~/work/app/notes.md");
		});
		await mounted(
			<ListRow title="notes.md" tooltip="~/work/app/notes.md" />,
			async document => {
				expect(await tooltipAfter(document, "click")).toBe("~/work/app/notes.md");
			},
			{ touch: true },
		);
		expect(renderToStaticMarkup(<ListRow title="notes.md" />)).not.toContain("<button");
	});
});
