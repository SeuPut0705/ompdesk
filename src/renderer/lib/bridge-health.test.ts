import { afterEach, describe, expect, it } from "vitest";
import { bridgeHealthToast } from "./bridge-health";
import { loadLocale, setLanguageOverride, translate } from "./i18n";

describe("bridgeHealthToast", () => {
	afterEach(() => setLanguageOverride(null));

	it.each([
		["en", "Inter-agent message delivery", "Some OMPdesk features don't work with this omp"],
		["ko", "에이전트 간 메시지 전달", "일부 OMPdesk 기능이 이 omp와 맞지 않아요"],
	] as const)("names unavailable agent delivery in the %s sticky warning", async (lang, label, title) => {
		await loadLocale(lang);
		setLanguageOverride(lang);
		const input = bridgeHealthToast(
			{ kind: "unsupported", ompVersion: "18.20.0", features: ["agentInbox"] },
			translate,
		);
		expect(input.variant).toBe("warning");
		expect(input.durationMs).toBe(Infinity);
		expect(input.title).toBe(title);
		expect(input.message).toContain(label);
		expect(input.message).toContain("18.20.0");
		expect(input.message).not.toContain("agentInbox");
	});

	it("names the unavailable features in the UI language and stays until dismissed", () => {
		const input = bridgeHealthToast(
			{ kind: "unsupported", ompVersion: "19.0.0", features: ["planMode", "mcp", "futureFeature"] },
			translate,
		);
		expect(input.variant).toBe("warning");
		expect(input.durationMs).toBe(Number.POSITIVE_INFINITY);
		expect(input.title).toBe(translate("bridgeHealth.unsupportedTitle"));
		// Unknown ids (a newer bridge than these locales) fall back to the raw id.
		expect(input.message).toBe(
			"omp 19.0.0 lacks internals OMPdesk needs for: Plan mode, MCP servers, futureFeature. OMPdesk looks for a newer omp and repairs the install itself. If this stays, report an issue.",
		);
	});

	it("explains a bridge that never connected", () => {
		const input = bridgeHealthToast(
			{ kind: "unavailable", ompVersion: "19.0.0", reason: "GUI bridge did not accept a connection within 3000ms" },
			translate,
		);
		expect(input.title).toBe("OMPdesk features unavailable");
		expect(input.message).toContain("(omp 19.0.0): GUI bridge did not accept a connection within 3000ms.");
		expect(input.message).toContain("repairs the install itself");
	});
});
