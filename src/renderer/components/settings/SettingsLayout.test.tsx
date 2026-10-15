import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { SettingsScopeProvider, SettingsSection } from "./SettingsLayout";
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
});
