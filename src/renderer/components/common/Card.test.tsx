/**
 * Card: one frame around its content, drawn as the element the content needs, which keeps the caller's attributes
 * (a role, a name, a data hook); as a button it is one pressable target.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Card } from "./Card";

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

describe("Card", () => {
	it("frames its content and keeps the caller's attributes", async () => {
		await mounted(
			<Card aria-label="Preview" data-preview="" role="region" surface="2">
				<pre>diff</pre>
			</Card>,
			document => {
				const card = document.querySelector("[data-card]");
				expect(card?.getAttribute("role")).toBe("region");
				expect(card?.getAttribute("aria-label")).toBe("Preview");
				expect(card?.hasAttribute("data-preview")).toBe(true);
				expect(card?.querySelector("pre")?.textContent).toBe("diff");
			},
		);
	});

	it("is the list or the definition list itself when asked", async () => {
		await mounted(
			<>
				<Card as="ul" padding="none">
					<li>Opus</li>
				</Card>
				<Card as="dl" padding="none" radius="lg">
					<dt>Turns</dt>
					<dd>4</dd>
				</Card>
			</>,
			document => {
				expect(document.querySelector("ul[data-card] > li")?.textContent).toBe("Opus");
				expect(document.querySelector("dl[data-card] > dd")?.textContent).toBe("4");
			},
		);
	});

	it("as a button is one pressable card that does not submit a form", async () => {
		const onClick = vi.fn();
		await mounted(
			<form>
				<Card as="button" onClick={onClick} padding="row" radius="lg">
					Anthropic
				</Card>
			</form>,
			async document => {
				const card = document.querySelector("button[data-card]") as HTMLButtonElement | null;
				expect(card?.getAttribute("type")).toBe("button");
				expect(card?.textContent).toBe("Anthropic");
				await act(async () => card?.click());
				expect(onClick).toHaveBeenCalledTimes(1);
			},
		);
	});
});
