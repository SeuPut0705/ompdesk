/**
 * Every `omp-*` class the stylesheets style is one some source file puts on an element. A rule left behind when its
 * component changed is dead weight in the first paint's CSS, and the cleanup that removes it later is where a shared
 * selector list loses its declarations (60ffbb3b). Classes built at run time (`omp-ansi-${n}`) count by their prefix.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname;
const renderer = join(dir, "..");

function sources(folder: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(folder, { withFileTypes: true })) {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) files.push(...sources(path));
		else if (/\.(tsx?|html|js)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
	}
	return files;
}

describe("stylesheet classes", () => {
	it("style only classes the app puts on an element", () => {
		const text = [...sources(renderer), ...sources(join(renderer, "../../scripts"))]
			.map(path => readFileSync(path, "utf8"))
			.join("\n");
		const prefixes = [...text.matchAll(/(omp-[a-z0-9-]+-)\$\{/g)].map(match => match[1] ?? "");
		const styled = new Set<string>();
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(".css")) continue;
			const css = readFileSync(join(dir, entry), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
			for (const match of css.matchAll(/\.(omp-[a-z0-9-]+)/g)) styled.add(match[1] ?? "");
		}
		const unused = [...styled].filter(
			name =>
				!new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`).test(text) &&
				!prefixes.some(prefix => name.startsWith(prefix)),
		);
		expect(unused.sort()).toEqual([]);
	});
});
