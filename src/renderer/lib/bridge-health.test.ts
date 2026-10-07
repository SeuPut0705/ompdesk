import { describe, expect, it } from "vitest";
import { bridgeHealthToast } from "./bridge-health";
import { translate } from "./i18n";

describe("bridgeHealthToast", () => {
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
			"omp 19.0.0 is missing internals OMPdesk needs for: Plan mode, MCP servers, futureFeature. Run `omp update` or update OMPdesk. If it persists, report an issue.",
		);
	});

	it("explains a bridge that never connected", () => {
		const input = bridgeHealthToast(
			{ kind: "unavailable", ompVersion: "19.0.0", reason: "GUI bridge did not accept a connection within 3000ms" },
			translate,
		);
		expect(input.title).toBe("OMPdesk features unavailable");
		expect(input.message).toContain("(omp 19.0.0): GUI bridge did not accept a connection within 3000ms.");
		expect(input.message).toContain("omp update");
	});
});
