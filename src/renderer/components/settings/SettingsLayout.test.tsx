import { parseHTML } from "linkedom";
import { Bell } from "lucide-react";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { INLINE_DESCRIPTION_MAX, SettingsRow, SettingsScopeProvider, SettingsSection } from "./SettingsLayout";
import { schemaGroupTitle } from "./schema-i18n";

describe("settings group presentation", () => {
	it("names stock tab ids and humanizes unknown ids", () => {
		expect(schemaGroupTitle("ko", "tasks")).toBe("작업");
		expect(schemaGroupTitle("ko", "Compaction")).toBe("압축");
		expect(schemaGroupTitle("en", "custom_group-id")).toBe("Custom Group Id");
	});
	it("shows one heading per group and no scope tags for a local tab (SettingsDeviceScope covers a host's)", async () => {
		const { document, window } = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
		const root = createRoot(document.body as unknown as globalThis.Element);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<SettingsScopeProvider value="mixed">
							<SettingsSection title="Sharing" scope="app">
								<SettingsSection title="This computer">
									<div data-setting-row>Toggle</div>
								</SettingsSection>
							</SettingsSection>
							<SettingsSection title="SSH" scope="host">
								<div data-setting-row>Hosts</div>
							</SettingsSection>
						</SettingsScopeProvider>
					</I18nProvider>,
				);
			});
			expect([...document.querySelectorAll("h3")].map(node => node.textContent)).toEqual(["Sharing", "SSH"]);
			expect(document.querySelectorAll("[data-settings-group-scope]")).toHaveLength(0);
		} finally {
			await act(async () => root.unmount());
		}
	});

	async function mounted(node: ReactNode, check: (document: Document) => void): Promise<void> {
		const { document, window } = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
		const root = createRoot(document.body as unknown as globalThis.Element);
		try {
			await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
			check(document as unknown as Document);
		} finally {
			await act(async () => root.unmount());
		}
	}

	it("keeps a short description on the row's line and puts a long one behind an info glyph", async () => {
		const short = "Short and sweet.";
		const long = "x".repeat(INLINE_DESCRIPTION_MAX + 1);
		await mounted(
			<>
				<SettingsRow description={short} icon={<Bell />} id="a" label="Alpha" />
				<SettingsRow description={long} id="b" label="Beta" />
				<SettingsRow description={<span>Costs a request.</span>} id="c" label="Gamma" />
			</>,
			document => {
				const a = document.getElementById("a");
				expect(a?.querySelector("[data-setting-info]")).toBeNull();
				expect(a?.querySelector("[data-setting-icon]")).not.toBeNull();
				expect(a?.textContent).toContain(short);
				const b = document.getElementById("b");
				expect(b?.querySelector("[data-setting-info]")?.getAttribute("aria-label")).toBe("More about this setting");
				// The full text stays in the DOM for screen readers.
				expect(b?.querySelector(".sr-only")?.textContent).toBe(long);
				// A node (a warning, a cost) is never hidden behind the glyph.
				const c = document.getElementById("c");
				expect(c?.querySelector("[data-setting-info]")).toBeNull();
				expect(c?.textContent).toContain("Costs a request.");
			},
		);
	});

	it("moves a titled group's long description behind its info glyph", async () => {
		const long = "y".repeat(INLINE_DESCRIPTION_MAX + 1);
		await mounted(
			<SettingsSection description={long} title="Group">
				<div data-setting-row>Row</div>
			</SettingsSection>,
			document => {
				expect(document.querySelector("h3 + [data-setting-info]")).not.toBeNull();
				expect(document.querySelector(".sr-only")?.textContent).toBe(long);
			},
		);
	});
});
