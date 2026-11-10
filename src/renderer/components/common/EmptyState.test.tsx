/**
 * EmptyState: the title, its sentence and the fixing action in every size; a list row's empty line keeps its
 * sentence reachable behind the info glyph and carries the caller's id and hooks.
 */

import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { EmptyState } from "./EmptyState";

function render(node: ReactNode): Document {
	return parseHTML(`<html><body>${renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>)}</body></html>`)
		.document as unknown as Document;
}

describe("EmptyState", () => {
	it("says what is missing and offers the fix", () => {
		const document = render(
			<EmptyState
				actions={<button type="button">Connect GitHub</button>}
				description="Pull requests appear here once the repository has a GitHub remote."
				size="sm"
				title="No pull requests"
			/>,
		);
		expect(document.body.textContent).toContain("No pull requests");
		expect(document.body.textContent).toContain("Pull requests appear here");
		expect(document.querySelector("[data-empty-actions] button")?.textContent).toBe("Connect GitHub");
	});

	it("as a list row keeps the sentence behind the info glyph, the action at its end and the caller's hooks", () => {
		const document = render(
			<EmptyState
				actions={<button type="button">Add a host</button>}
				data-setting-row="true"
				description="Hosts you add here can be opened from the sidebar and the command palette."
				id="settings-ssh-empty"
				size="row"
				title="No SSH hosts yet"
			/>,
		);
		const row = document.getElementById("settings-ssh-empty");
		expect(row?.getAttribute("data-setting-row")).toBe("true");
		expect(row?.textContent).toContain("No SSH hosts yet");
		expect(row?.querySelector("[data-setting-info]")).not.toBeNull();
		expect(row?.textContent).toContain("Hosts you add here can be opened");
		expect(row?.querySelector("[data-empty-actions] button")?.textContent).toBe("Add a host");
	});
});
