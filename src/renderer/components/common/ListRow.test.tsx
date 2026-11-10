/**
 * ListRow: one button per row, named by its title and described by its second lines, or named by the whole row when
 * asked; the current row says so; actions at rest follow the meta.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListRow } from "./ListRow";

async function mounted(node: ReactNode, check: (document: Document) => void): Promise<void> {
	const { document, window } = parseHTML("<html><body></body></html>");
	Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
	const root = createRoot(document.body as unknown as globalThis.Element);
	try {
		await act(async () => root.render(node));
		check(document as unknown as Document);
	} finally {
		await act(async () => root.unmount());
	}
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
});
