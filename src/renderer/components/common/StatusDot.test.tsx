/**
 * StatusDot: the state is a word, beside the dot or for screen readers only, with no hover title unless the caller
 * asks; a decorative dot is hidden from assistive tech and takes the caller's attributes itself.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { StatusDot } from "./StatusDot";

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

describe("StatusDot", () => {
	it("shows the state's word beside a dot hidden from screen readers", async () => {
		await mounted(<StatusDot label="Online" tone="success" />, document => {
			const status = document.querySelector("[data-status-dot]");
			expect(status?.textContent).toBe("Online");
			expect(status?.querySelector("[aria-hidden]")?.textContent).toBe("");
			expect(status?.hasAttribute("title")).toBe(false);
		});
	});

	it("keeps a hidden word for screen readers, with no hover title unless asked", async () => {
		await mounted(
			<>
				<StatusDot label="Offline" labelHidden tone="danger" />
				<StatusDot data-device="mini" label="Online" labelHidden title="Online since 9:00" tone="success" />
			</>,
			document => {
				const [plain, titled] = [...document.querySelectorAll("[data-status-dot]")];
				expect(plain?.textContent).toBe("Offline");
				expect(plain?.hasAttribute("title")).toBe(false);
				expect(titled?.getAttribute("title")).toBe("Online since 9:00");
				expect(titled?.getAttribute("data-device")).toBe("mini");
			},
		);
	});

	it("a decorative dot is one element hidden from assistive tech, carrying the caller's attributes", async () => {
		await mounted(<StatusDot className="absolute" data-device-dot="" decorative tone="working" />, document => {
			const dot = document.querySelector("[data-status-dot]");
			expect(dot?.getAttribute("aria-hidden")).toBe("true");
			expect(dot?.hasAttribute("data-device-dot")).toBe(true);
			expect(dot?.children.length).toBe(0);
			expect(dot?.textContent).toBe("");
		});
	});
});
