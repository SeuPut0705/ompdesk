/**
 * SectionLabel: a heading at the level asked, its count read with its name, and a group action that is a control of
 * its own beside the heading, not part of the heading's name.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SectionLabel } from "./SectionLabel";

async function mounted(node: ReactNode, check: (document: Document) => void | Promise<void>): Promise<void> {
	const { document, window } = parseHTML("<html><body></body></html>");
	Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
	const root = createRoot(document.body as unknown as globalThis.Element);
	try {
		await act(async () => root.render(node));
		await check(document as unknown as Document);
	} finally {
		await act(async () => root.unmount());
	}
}

describe("SectionLabel", () => {
	it("is an h3 by default and an h4 when asked, its count read with its name", async () => {
		await mounted(
			<>
				<SectionLabel count={4}>Projects</SectionLabel>
				<SectionLabel as="h4">Roles</SectionLabel>
			</>,
			document => {
				expect(document.querySelector("h3")?.textContent).toBe("Projects4");
				expect(document.querySelector("h4")?.textContent).toBe("Roles");
			},
		);
	});

	it("draws a section title as the same kind of heading, or the label as no heading where none belongs", async () => {
		await mounted(
			<>
				<SectionLabel count={12} size="title">
					Models
				</SectionLabel>
				<SectionLabel as="div">Shortcut</SectionLabel>
			</>,
			document => {
				expect(document.querySelector("h3")?.textContent).toBe("Models12");
				expect(document.querySelectorAll("h3, h4").length).toBe(1);
				expect(document.querySelector("div[data-section-label]")?.textContent).toBe("Shortcut");
			},
		);
	});

	it("keeps the group action outside the heading and reachable", async () => {
		const clear = vi.fn();
		await mounted(
			<SectionLabel
				action={
					<button onClick={clear} type="button">
						Clear
					</button>
				}
				id="projects-label"
			>
				Projects
			</SectionLabel>,
			async document => {
				const heading = document.getElementById("projects-label");
				expect(heading?.tagName).toBe("H3");
				expect(heading?.textContent).toBe("Projects");
				const action = document.querySelector("button") as HTMLElement;
				expect(heading?.contains(action)).toBe(false);
				await act(async () => action.click());
				expect(clear).toHaveBeenCalledTimes(1);
			},
		);
	});
});
