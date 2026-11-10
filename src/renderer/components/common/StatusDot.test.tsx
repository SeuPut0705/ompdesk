/**
 * StatusDot: the state is always a word, beside the dot or for screen readers and the hover title, and the dot itself
 * is decoration; a working state pulses unless told not to.
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
	it("shows the state's word beside a decorative dot", async () => {
		await mounted(<StatusDot label="Online" tone="success" />, document => {
			const status = document.querySelector("[data-status-dot]");
			expect(status?.textContent).toBe("Online");
			expect(status?.querySelector("[aria-hidden]")?.textContent).toBe("");
			expect(status?.querySelector(".sr-only")).toBeNull();
			expect(status?.hasAttribute("title")).toBe(false);
		});
	});

	it("keeps a hidden word for screen readers and the hover title", async () => {
		await mounted(<StatusDot label="Offline" labelHidden tone="danger" />, document => {
			const status = document.querySelector("[data-status-dot]");
			expect(status?.querySelector(".sr-only")?.textContent).toBe("Offline");
			expect(status?.getAttribute("title")).toBe("Offline");
		});
	});

	it("pulses while working, unless told not to", async () => {
		await mounted(
			<>
				<StatusDot label="Running" tone="working" />
				<StatusDot label="Held" pulse={false} tone="working" />
				<StatusDot label="Idle" tone="neutral" />
			</>,
			document => {
				const pulsing = [...document.querySelectorAll("[data-status-dot]")].map(
					status => status.querySelector(".omp-pulse-dot") !== null,
				);
				expect(pulsing).toEqual([true, false, false]);
			},
		);
	});
});
