import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const E2E = path.resolve(import.meta.dirname, "../e2e");

/** Attributes whose value is a file-system path (a session file, a project folder, a remote folder). */
const PATH_ATTRIBUTES = [
	"data-session-path",
	"data-device-session",
	"data-workspace-group",
	"data-sidebar-family",
	"data-remote-dir",
];

/**
 * A raw Windows path inside a quoted CSS attribute value reads `\U` as an escape, so the selector matches nothing and
 * the spec waits 30 s for a row that is there. `cssString()` (e2e/harness.ts) doubles the backslashes.
 */
describe("e2e selectors on a path-valued attribute", () => {
	test("interpolate the path through cssString, never inside bare quotes", () => {
		const raw = new RegExp(`\\[(${PATH_ATTRIBUTES.join("|")})="\\$\\{`);
		const offenders: string[] = [];
		for (const name of readdirSync(E2E)) {
			if (!name.endsWith(".ts")) continue;
			readFileSync(path.join(E2E, name), "utf8")
				.split("\n")
				.forEach((line, index) => {
					if (raw.test(line)) offenders.push(`e2e/${name}:${index + 1}: ${line.trim()}`);
				});
		}
		expect(offenders).toEqual([]);
	});
});
