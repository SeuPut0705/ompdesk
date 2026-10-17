/**
 * SwitchField is one dense row: label, a short description inline or a longer one behind the (i) glyph (text kept
 * in the DOM for screen readers), the switch at the right named by the label alone, the whole row clickable.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { INLINE_DESCRIPTION_MAX } from "./SettingInfo";
import { SwitchField } from "./Switch";

async function mounted(node: ReactNode, check: (document: Document) => void | Promise<void>): Promise<void> {
	const { document, window } = parseHTML("<html><body></body></html>");
	Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
	const root = createRoot(document.body as unknown as globalThis.Element);
	try {
		await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
		await check(document as unknown as Document);
	} finally {
		await act(async () => root.unmount());
	}
}

describe("SwitchField", () => {
	it("keeps a short description on the row's line, with no info glyph", async () => {
		await mounted(
			<SwitchField checked description="Short and sweet." label="Alpha" onCheckedChange={() => {}} />,
			document => {
				const row = document.querySelector("[data-switch-field]");
				expect(row?.querySelector("[data-setting-info]")).toBeNull();
				expect(row?.querySelector("[data-setting-desc]")?.textContent).toBe("Short and sweet.");
				expect(row?.querySelector("p")).toBeNull();
			},
		);
	});

	it("puts a long description behind an info glyph and keeps the switch named by the label only", async () => {
		const long = "x".repeat(INLINE_DESCRIPTION_MAX + 1);
		await mounted(
			<SwitchField checked={false} description={long} label="Beta" onCheckedChange={() => {}} />,
			document => {
				const row = document.querySelector("[data-switch-field]");
				expect(row?.querySelector("[data-setting-info]")?.getAttribute("aria-label")).toBe(
					"More about this setting",
				);
				// The text stays in the DOM for screen readers, outside the label that names the switch.
				expect(row?.querySelector(".sr-only")?.textContent).toBe(long);
				expect(row?.querySelector("label .sr-only")).toBeNull();
				expect(row?.querySelector("label")?.textContent).toBe("Beta");
				expect(row?.querySelector("[data-setting-desc]")).toBeNull();
			},
		);
	});

	it("never hides a node description (a warning, a cost) behind the glyph", async () => {
		await mounted(
			<SwitchField checked description={<span>Costs a request.</span>} label="Gamma" onCheckedChange={() => {}} />,
			document => {
				const row = document.querySelector("[data-switch-field]");
				expect(row?.querySelector("[data-setting-info]")).toBeNull();
				expect(row?.textContent).toContain("Costs a request.");
			},
		);
	});

	it("toggles from the switch and reports the next value", async () => {
		const change = vi.fn();
		await mounted(<SwitchField checked={false} label="Delta" onCheckedChange={change} />, async document => {
			const toggle = document.querySelector('[role="switch"]') as HTMLElement;
			expect(toggle.getAttribute("aria-checked")).toBe("false");
			await act(async () => toggle.click());
			expect(change).toHaveBeenCalledWith(true);
		});
	});
});
