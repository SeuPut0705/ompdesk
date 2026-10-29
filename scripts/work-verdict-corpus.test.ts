import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactDiagnosticsText } from "../resources/gui-bridge/redactor";
import { CORPUS_PATH } from "./work-verdict-corpus";

// The corpus is real journals in a public repository: every string in it must already be what the diagnostics redactor
// leaves (no secret, e-mail, tailnet or LAN address, home folder).
describe("work verdict corpus", () => {
	it("holds nothing the redactor would still take out", () => {
		const leaks: string[] = [];
		const walk = (value: unknown): void => {
			if (typeof value === "string") {
				if (redactDiagnosticsText(value) !== value) leaks.push(value.slice(0, 120));
			} else if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value === "object") Object.values(value).forEach(walk);
		};
		walk(JSON.parse(readFileSync(CORPUS_PATH, "utf8")));
		expect(leaks).toEqual([]);
	});
});
