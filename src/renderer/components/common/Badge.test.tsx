/**
 * Badge: its text says the state (a dot beside it is decoration), and the caller's DOM attributes reach the badge, so
 * a test hook, a title or `aria-hidden` for a mark whose row already says it in words lands on the badge itself.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

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

describe("Badge", () => {
	it("says the state in its text, the dot hidden from screen readers", async () => {
		await mounted(
			<Badge dot data-run-state="" pulse variant="success">
				Running
			</Badge>,
			document => {
				const badge = document.querySelector("[data-run-state]");
				expect(badge?.textContent).toBe("Running");
				expect(badge?.querySelector("[aria-hidden]")?.textContent).toBe("");
			},
		);
	});

	it("passes the caller's attributes to the badge and keeps a cut text whole in the DOM", async () => {
		await mounted(
			<Badge aria-hidden data-moved-note="" size="xs" title="Moved to the end of Steer" truncate variant="accent">
				Moved to the end of Steer
			</Badge>,
			document => {
				const badge = document.querySelector("[data-moved-note]");
				expect(badge?.getAttribute("aria-hidden")).toBe("true");
				expect(badge?.getAttribute("title")).toBe("Moved to the end of Steer");
				expect(badge?.textContent).toBe("Moved to the end of Steer");
			},
		);
	});
});
