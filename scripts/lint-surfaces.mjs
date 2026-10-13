#!/usr/bin/env node
/**
 * Surface policy lint — keeps content colorless and typography on the
 * unified scale (see the SURFACE POLICY block in src/renderer/styles/global.css).
 *
 * Errors:
 *  - static content fill: `bg-(--omp-bg-primary|secondary|tertiary)` or the
 *    `bg-[var(--omp-bg-*)]` form WITHOUT an interaction variant prefix
 *    (hover:/focus:/group-hover:/…). Content surfaces are transparent; only
 *    the canvas, chrome tokens, floating overlays, states, and semantic
 *    fills may paint.
 *  - raw pixel font class `text-[<N>px]` below 16px — use the text-sc-*
 *    scale (global.css @theme). Display sizes ≥16px are exempt.
 *
 * A deliberate exception carries `surface-ok` on the same line (spell the
 * reason next to it). The styles/ directory (token definitions) is skipped
 * for fill/type checks.
 *
 * Motion (styles/*.css only): interaction durations must use
 * var(--sc-duration-fast) or var(--sc-duration-med) (the legacy
 * --omp-motion-fast/-med aliases still pass). Bare Nms values are errors unless
 * the line has `motion-ok` (loops like caret, token definitions).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: the latter is "/D:/…" on Windows runners.
const ROOT = fileURLToPath(new URL("../src/renderer", import.meta.url));
const STYLES = join(ROOT, "styles");
const EXTENSIONS = new Set([".ts", ".tsx"]);
const BARE_MS = /(?<!var\(--omp-motion-(?:fast|med)\))(?<![-\w])(\d+(?:\.\d+)?)ms\b/g;

const FILL_PAREN = /(?:[a-z-]+:)*bg-\(--omp-bg-(?:primary|secondary|tertiary)\)/g;
const FILL_BRACKET = /(?:[a-z-]+:)*bg-\[var\(--omp-bg-(?:primary|secondary|tertiary)\)\]/g;
const RAW_PX = /\btext-\[(\d+(?:\.\d+)?)px\]/g;

/** @returns {string[]} */
function collect(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "styles" || entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...collect(full));
		else if (EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) out.push(full);
	}
	return out;
}

const violations = [];
for (const file of collect(ROOT)) {
	const rel = relative(ROOT, file);
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, index) => {
		if (line.includes("surface-ok")) return;
		for (const pattern of [FILL_PAREN, FILL_BRACKET]) {
			pattern.lastIndex = 0;
			for (const match of line.matchAll(pattern)) {
				const token = match[0];
				// Variant-prefixed (hover:bg-…, group-hover:bg-…) = interaction state.
				if (token.includes(":")) continue;
				violations.push(`${rel}:${index + 1}  static content fill  ${token}`);
			}
		}
		RAW_PX.lastIndex = 0;
		for (const match of line.matchAll(RAW_PX)) {
			if (Number.parseFloat(match[1]) >= 16) continue;
			violations.push(`${rel}:${index + 1}  raw pixel font class  ${match[0]}  (use text-omp-*)`);
		}
	});
}

for (const name of readdirSync(STYLES)) {
	if (!name.endsWith(".css")) continue;
	const file = join(STYLES, name);
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, index) => {
		if (line.includes("motion-ok")) return;
		if (/--(sc-duration|omp-motion)-(fast|med)\b/.test(line)) return;
		BARE_MS.lastIndex = 0;
		for (const match of line.matchAll(BARE_MS)) {
			const ms = Number.parseFloat(match[1]);
			if (ms === 0 || ms === 0.01) continue;
			violations.push(
				`styles/${name}:${index + 1}  bare motion duration  ${match[0]}  (use --sc-duration-fast/-med)`,
			);
		}
	});
}

if (violations.length > 0) {
	console.error(`surface policy: ${violations.length} violation(s)`);
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}
console.log("surface policy: clean");
