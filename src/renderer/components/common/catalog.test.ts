/**
 * The catalog agents read before writing UI (README.md) names every component the barrel exports, so a new one is
 * never invisible to them. Constants and hooks that only serve a listed component are exempt.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = import.meta.dirname;
const NOT_COMPONENTS = new Set(["INLINE_DESCRIPTION_MAX", "LIVE_PERIOD_MS", "useWindowVisible"]);

function exportedNames(): string[] {
	const barrel = readFileSync(join(HERE, "index.ts"), "utf8");
	return [...barrel.matchAll(/export \{([^}]*)\}/g)]
		.flatMap(match => (match[1] ?? "").split(","))
		.map(name => name.trim())
		.filter(name => name !== "" && !name.startsWith("type ") && !NOT_COMPONENTS.has(name));
}

describe("the shared component catalog", () => {
	it("names every component the barrel exports", () => {
		const catalog = readFileSync(join(HERE, "README.md"), "utf8");
		expect(exportedNames().filter(name => !catalog.includes(`\`${name}\``))).toEqual([]);
	});
});
