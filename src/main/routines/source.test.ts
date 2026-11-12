import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clip } from "./source";

/** The rows the core's copy of `clip` is held to (`crates/core/src/routines/text.rs`), captured from this one. */
const rows = (
	JSON.parse(
		readFileSync(join(__dirname, "../../../native/ompdesk/crates/core/src/routines/captured.json"), "utf8"),
	) as { clip: [string, number, string][] }
).clip;

describe("clip", () => {
	it("cuts every captured row as the core's copy does", () => {
		expect(rows).toHaveLength(150);
		for (const [text, max, line] of rows) expect([text, max, clip(text, max)]).toEqual([text, max, line]);
	});
});
