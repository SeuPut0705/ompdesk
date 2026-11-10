/**
 * ProgressBar: a single bar is a progressbar (no value claimed while indeterminate, its value in words when given); a
 * segmented bar is one image named by its label and every share, or with a `value` a progressbar of the whole. Empty
 * shares are left out and a `total` larger than the shares leaves room at the end.
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

describe("ProgressBar", () => {
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

	it("leaves the single bar a progressbar that can say its value in words", async () => {
		await mounted(<ProgressBar ariaLabel="Quota" ariaValueText="50 of 100 requests" value={0.5} />, document => {
			const bar = document.querySelector('[role="progressbar"]');
			expect(bar?.getAttribute("aria-valuenow")).toBe("0.5");
			expect(bar?.getAttribute("aria-valuetext")).toBe("50 of 100 requests");
		});
	});

	it("with a value, a segmented bar is a progressbar of the whole, its shares drawn for the eye", async () => {
		await mounted(
			<ProgressBar
				ariaLabel="Context 42%"
				ariaValueText="42k used, 58k left"
				segments={[
					{ value: 30, label: "Messages", color: "var(--sc-accent)" },
					{ value: 12, label: "Tools", color: "var(--sc-info)" },
				]}
				total={100}
				value={0.42}
			/>,
			document => {
				expect(document.querySelector('[role="img"]')).toBeNull();
				const bar = document.querySelector('[role="progressbar"]');
				expect(bar?.getAttribute("aria-label")).toBe("Context 42%");
				expect(bar?.getAttribute("aria-valuenow")).toBe("0.42");
				expect(bar?.getAttribute("aria-valuetext")).toBe("42k used, 58k left");
				expect(bar?.children.length).toBe(3);
			},
		);
	});

	it("divides the track among any number of shares with no gap of its own, the empty ones counted", async () => {
		const plan = Array.from({ length: 30 }, (_, index) =>
			index < 12
				? { value: 1, label: `Step ${index + 1}`, tone: "success" as const }
				: { value: 1, label: `Step ${index + 1}` },
		);
		await mounted(<ProgressBar ariaLabel="Plan" segments={plan} />, document => {
			const bar = document.querySelector('[role="img"]');
			const shares = [...(bar?.children ?? [])] as HTMLElement[];
			// Every child is a share: nothing between them takes width, and each grows from a zero basis.
			expect(shares).toHaveLength(30);
			expect(shares.every(share => share.hasAttribute("data-progress-segment"))).toBe(true);
			expect(shares.every(share => share.style.flex === "1 1 0")).toBe(true);
			// The line between two shares is drawn inside the later one.
			expect(shares[0]?.style.boxShadow).toBe("");
			expect(shares.slice(1).every(share => share.style.boxShadow.startsWith("inset"))).toBe(true);
			expect(bar?.getAttribute("aria-label")).toContain("Step 30 1");
			expect(shares[29]?.style.backgroundColor).toBe("");
		});
	});

	it("claims no value while indeterminate", async () => {
		await mounted(<ProgressBar ariaLabel="Updating omp" tone="progress" />, document => {
			const bar = document.querySelector('[role="progressbar"]');
			expect(bar?.getAttribute("aria-label")).toBe("Updating omp");
			expect(bar?.hasAttribute("aria-valuenow")).toBe(false);
		});
	});
});
