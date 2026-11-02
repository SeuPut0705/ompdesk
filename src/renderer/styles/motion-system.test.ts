import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The motion system's rules (docs/motion-design.md), checked over every stylesheet and renderer source:
 * - keyframes move only what the compositor moves (transform, opacity), so no animation lays out or repaints a frame;
 * - every duration and curve is a token, so one scale times the whole app and reduced motion / software compositing
 *   zero it in one place;
 * - no transition eases a layout property (it lays out the page every frame);
 * - Web Animations run only through lib/motion.ts.
 * A deliberate exception carries `motion-ok: <reason>` on its line.
 */

const STYLES = fileURLToPath(new URL(".", import.meta.url));
const RENDERER = fileURLToPath(new URL("..", import.meta.url));

const stylesheets = readdirSync(STYLES)
	.filter(name => name.endsWith(".css"))
	.map(name => ({ name, css: readFileSync(join(STYLES, name), "utf8") }));

/** Renderer sources (tests aside), comments blanked out with their line breaks kept so line numbers still hold. */
function sources(dir: string): { file: string; text: string }[] {
	return readdirSync(dir).flatMap(entry => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return entry === "dev-harness" || entry === "test-support" ? [] : sources(full);
		if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry) || entry.endsWith(".d.ts")) return [];
		const text = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, comment =>
			comment.includes("motion-ok") ? comment : comment.replace(/[^\n]/g, " "),
		);
		return [{ file: full, text }];
	});
}

const lineOf = (text: string, index: number): string => {
	const start = text.lastIndexOf("\n", index) + 1;
	const end = text.indexOf("\n", index);
	return text.slice(start, end === -1 ? undefined : end);
};

const lineNumber = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Each `@keyframes` block's name and the properties its frames set. */
function keyframes(css: string): { name: string; properties: Set<string>; at: number }[] {
	const found: { name: string; properties: Set<string>; at: number }[] = [];
	for (const match of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
		let depth = 1;
		let index = (match.index ?? 0) + match[0].length;
		const start = index;
		while (depth > 0 && index < css.length) {
			if (css[index] === "{") depth += 1;
			else if (css[index] === "}") depth -= 1;
			index += 1;
		}
		const body = css.slice(start, index - 1).replace(/\/\*[\s\S]*?\*\//g, "");
		const properties = new Set<string>();
		for (const declaration of body.matchAll(/([\w-]+)\s*:[^;{}]+/g)) properties.add(declaration[1] ?? "");
		found.push({ name: match[1] ?? "", properties, at: match.index ?? 0 });
	}
	return found;
}

const COMPOSITED = new Set(["opacity", "transform", "translate", "scale", "rotate", "animation-timing-function"]);
const MOTION_DECLARATION =
	/(?<![-\w])(transition|animation)(?:-(duration|timing-function|delay|property))?\s*:\s*([^;{}]+);/g;
const LAYOUT_PROPERTY =
	/(?<![-\w])(width|height|max-height|min-height|max-width|min-width|inset|top|left|right|bottom|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|grid-template-rows|grid-template-columns|flex-basis|all)(?![-\w])/;

describe("motion system", () => {
	it("animates only transform and opacity in every keyframe", () => {
		const offenders: string[] = [];
		for (const { name, css } of stylesheets)
			for (const frame of keyframes(css)) {
				const extra = [...frame.properties].filter(property => !COMPOSITED.has(property));
				if (extra.length > 0 && !lineOf(css, frame.at).includes("motion-ok"))
					offenders.push(`${name}:${lineNumber(css, frame.at)} @keyframes ${frame.name}: ${extra.join(", ")}`);
			}
		expect(offenders).toEqual([]);
	});

	it("times every transition and animation with the duration and curve tokens", () => {
		const offenders: string[] = [];
		for (const { name, css } of stylesheets) {
			if (name === "tokens.css") continue;
			for (const match of css.matchAll(MOTION_DECLARATION)) {
				const at = match.index ?? 0;
				const end = at + match[0].length;
				if (lineOf(css, end - 1).includes("motion-ok")) continue;
				const value = (match[3] ?? "").replace(/var\([^)]*\)/g, "");
				const raw =
					value.match(/(?<![\w.-])(?!0m?s\b)\d*\.?\d+m?s\b/) ??
					value.match(/\b(?:ease|ease-in|ease-out|ease-in-out)\b|cubic-bezier\(|linear\(/);
				if (raw) offenders.push(`${name}:${lineNumber(css, at)} ${match[1]}: ${raw[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("never eases a layout property", () => {
		const offenders: string[] = [];
		for (const { name, css } of stylesheets)
			for (const match of css.matchAll(MOTION_DECLARATION)) {
				if (match[1] !== "transition" || (match[2] && match[2] !== "property")) continue;
				const at = match.index ?? 0;
				if (lineOf(css, at + match[0].length - 1).includes("motion-ok")) continue;
				const hit = (match[3] ?? "").replace(/var\([^)]*\)/g, "").match(LAYOUT_PROPERTY);
				if (hit) offenders.push(`${name}:${lineNumber(css, at)} transition of ${hit[0]}`);
			}
		for (const { file, text } of sources(RENDERER)) {
			for (const match of text.matchAll(/\btransition-\[([^\]]+)\]|\btransition-all\b/g)) {
				const at = match.index ?? 0;
				if (lineOf(text, at).includes("motion-ok")) continue;
				if (match[0] === "transition-all" || LAYOUT_PROPERTY.test(match[1] ?? ""))
					offenders.push(`${relative(RENDERER, file)}:${lineNumber(text, at)} ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("uses no Tailwind default duration, curve, delay or loop in components", () => {
		const offenders: string[] = [];
		const RAW =
			/(?<![\w-])(?:[a-z-]+:)*(?:duration-(?:\d+|\[[^\]]*\])|ease-(?:in|out|in-out)|delay-(?:\d+|\[[^\]]*\])|animate-(?:pulse|bounce|ping))(?![\w-])/g;
		for (const { file, text } of sources(RENDERER)) {
			for (const match of text.matchAll(RAW)) {
				const at = match.index ?? 0;
				if (!lineOf(text, at).includes("motion-ok"))
					offenders.push(`${relative(RENDERER, file)}:${lineNumber(text, at)} ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("runs Web Animations only through lib/motion-play.ts", () => {
		const offenders = sources(RENDERER)
			.filter(({ file, text }) => !file.endsWith(join("lib", "motion-play.ts")) && /\.animate\(\s*\[/.test(text))
			.map(({ file }) => relative(RENDERER, file));
		expect(offenders).toEqual([]);
	});

	it("zeroes every duration token under reduced motion and software compositing", () => {
		const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
		const defined = new Set(
			[...tokens.matchAll(/(--sc-duration-[\w-]+|--sc-motion-stagger)\s*:\s*\d/g)].map(match => match[1]),
		);
		const zeroedIn = (block: RegExp) => {
			const body = tokens.match(block)?.[0] ?? "";
			return new Set([...body.matchAll(/(--sc-[\w-]+)\s*:\s*0s\b/g)].map(match => match[1]));
		};
		expect(defined.size).toBeGreaterThan(0);
		expect(zeroedIn(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{[^}]*\}/)).toEqual(defined);
		expect(zeroedIn(/html\[data-gpu="software"\]\s*\{[^}]*\}/)).toEqual(defined);
	});
});
