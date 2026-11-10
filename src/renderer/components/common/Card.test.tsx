/**
 * Card: one frame around its content, which keeps the caller's attributes (a role, a name, a data hook) and layout
 * classes.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { Card } from "./Card";

describe("Card", () => {
	it("frames its content and keeps the caller's attributes", async () => {
		const { document, window } = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
		const root = createRoot(document.body as unknown as globalThis.Element);
		try {
			await act(async () =>
				root.render(
					<Card aria-label="Preview" className="max-h-40 overflow-auto" data-preview="" role="region" surface="2">
						<pre>diff</pre>
					</Card>,
				),
			);
			const card = document.querySelector("[data-card]");
			expect(card?.getAttribute("role")).toBe("region");
			expect(card?.getAttribute("aria-label")).toBe("Preview");
			expect(card?.hasAttribute("data-preview")).toBe(true);
			expect(card?.className).toContain("max-h-40");
			expect(card?.querySelector("pre")?.textContent).toBe("diff");
		} finally {
			await act(async () => root.unmount());
		}
	});
});
