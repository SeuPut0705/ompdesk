/**
 * ProgressBar's segmented form: one image of how a whole divides, named by its label and every share, each share
 * titled; empty shares are left out and a `total` larger than the shares leaves room at the end.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar";

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

describe("ProgressBar segments", () => {
	it("is one image named by its label and its shares, leaving empty shares out", async () => {
		await mounted(
			<ProgressBar
				label="Steps"
				segments={[
					{ value: 3, label: "Done", tone: "success" },
					{ value: 0, label: "Blocked", tone: "warning" },
					{ value: 2, label: "Pending", tone: "neutral" },
				]}
			/>,
			document => {
				expect(document.querySelector('[role="progressbar"]')).toBeNull();
				const bar = document.querySelector('[role="img"]');
				expect(bar?.getAttribute("aria-label")).toBe("Steps: Done 3, Pending 2");
				expect([...(bar?.children ?? [])].map(share => share.getAttribute("title"))).toEqual(["Done", "Pending"]);
			},
		);
	});

	it("leaves room at the end when the total is more than the shares", async () => {
		await mounted(
			<ProgressBar
				ariaLabel="Context"
				segments={[{ value: 40, label: "Messages", color: "var(--sc-accent)" }]}
				total={100}
			/>,
			document => {
				const shares = [...(document.querySelector('[role="img"]')?.children ?? [])] as HTMLElement[];
				expect(shares.map(share => share.style.flex)).toEqual(["40 1 0", "60 1 0"]);
				expect(shares[1]?.getAttribute("aria-hidden")).toBe("true");
			},
		);
	});

	it("leaves the single bar a progressbar", async () => {
		await mounted(<ProgressBar ariaLabel="Quota" value={0.5} />, document => {
			expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0.5");
		});
	});
});
