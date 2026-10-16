/**
 * SVG previews of model output (```svg fences, written .svg files).
 *
 * The preview is an `<img>` with a `data:` URL, never inline DOM: an SVG
 * loaded as an image runs no script and fetches nothing. On top of that the
 * source is rebuilt from a whitelist — elements outside the drawing subset
 * (script, foreignObject, …) are dropped with their content, event handlers
 * and every reference that leaves the document (`href` other than `#id` or an
 * inline raster, `url(…)` other than `url(#id)`, `@import`) are removed.
 *
 * The rebuild doubles as the completeness check: a fence still streaming (an
 * unclosed tag, a tag cut mid-attribute) is not well-formed and yields null,
 * so the caller keeps showing code until the document parses.
 *
 * Theme: stock omp teaches models to color figures with `var(--fg)`,
 * `var(--accent)`, … and `currentColor`. An image cannot see the page's CSS,
 * so those references resolve against the app theme here (`SvgPalette`), and
 * the root gets `color` and a sans-serif `font-family` like stock's TUI.
 */

/** Theme color per figure token (`var(--fg)` → `palette.fg`). */
export type SvgPalette = Readonly<Record<string, string>>;

/**
 * Figure token → app `--sc-*` palette primitive, after stock's PALETTE (pi-tui
 * chat/svg-figure.ts). Named themes mirror their colors onto `--sc-*`
 * (lib/themes.ts SC_TOKEN_SOURCES), so these follow every theme. `surface`
 * is a card on the figure's chip (`--sc-surface-1`); `border` must still read
 * on it. Stock derives `c1`…`c6` from the accent; the app's series are its
 * accent and status hues plus a neutral.
 */
export const SVG_PALETTE_VARIABLES: Readonly<Record<string, string>> = {
	fg: "--sc-text",
	muted: "--sc-text-muted",
	border: "--sc-border-subtle",
	accent: "--sc-accent",
	success: "--sc-success",
	warning: "--sc-warning",
	error: "--sc-danger",
	surface: "--sc-surface-3",
	c1: "--sc-accent",
	c2: "--sc-info",
	c3: "--sc-success",
	c4: "--sc-warning",
	c5: "--sc-danger",
	c6: "--sc-text-secondary",
};

/** Sources above this size stay code: rebuilding and data-URL encoding them would stall the transcript. */
export const SVG_PREVIEW_MAX_CHARS = 512_000;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Elements kept as written (attributes still filtered). Everything else is dropped with its subtree. */
const KEPT_ELEMENTS = new Set([
	"svg",
	"g",
	"defs",
	"symbol",
	"use",
	"switch",
	"view",
	"title",
	"desc",
	"style",
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"text",
	"tspan",
	"textPath",
	"image",
	"linearGradient",
	"radialGradient",
	"stop",
	"pattern",
	"clipPath",
	"mask",
	"marker",
	"filter",
	"feBlend",
	"feColorMatrix",
	"feComponentTransfer",
	"feComposite",
	"feConvolveMatrix",
	"feDiffuseLighting",
	"feDisplacementMap",
	"feDistantLight",
	"feDropShadow",
	"feFlood",
	"feFuncA",
	"feFuncB",
	"feFuncG",
	"feFuncR",
	"feGaussianBlur",
	"feMerge",
	"feMergeNode",
	"feMorphology",
	"feOffset",
	"fePointLight",
	"feSpecularLighting",
	"feSpotLight",
	"feTile",
	"feTurbulence",
	"animate",
	"animateMotion",
	"animateTransform",
	"mpath",
	"set",
]);

const NAME = /^[A-Za-z_][\w.-]*(?::[\w.-]+)?$/;
const ATTRIBUTE = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/y;
const VAR_REFERENCE = /var\(\s*--([\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;
/** A `url(` whose target is not a same-document `#id`. */
const EXTERNAL_URL = /url\(\s*(?!['"]?\s*#)/i;
const EXTERNAL_URL_CALL = /url\(\s*(?!['"]?\s*#)(?:"[^"]*"|'[^']*'|[^)]*)\)/gi;
const INLINE_RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

type Frame = { name: string; mode: "keep" | "unwrap" | "drop" };

interface Tag {
	name: string;
	attributes: [string, string][];
	selfClosing: boolean;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML entity decoding (the five predefined names and numeric references); anything else stays literal. */
function decodeEntities(text: string): string {
	return text.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (match, dec, hex, named) => {
		if (named) return NAMED_ENTITIES[named] ?? match;
		const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
	});
}

function escapeText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function resolveVars(value: string, palette: SvgPalette | undefined): string {
	if (!value.includes("var(")) return value;
	const fg = palette?.fg ?? "currentColor";
	return value.replace(
		VAR_REFERENCE,
		(_match, name: string, fallback: string | undefined) => palette?.[name] ?? (fallback?.trim() || fg),
	);
}

/** CSS text with every import and outside reference removed. */
function sanitizeCss(css: string, palette: SvgPalette | undefined): string {
	return resolveVars(css, palette)
		.replace(/@import[^;]*;?/gi, "")
		.replace(EXTERNAL_URL_CALL, "none")
		.replace(/expression\s*\(/gi, "");
}

/** Index just past the construct opening at `<`, or -1 while it is incomplete. */
function constructEnd(source: string, lt: number): number {
	const after = (terminator: string): number => {
		const at = source.indexOf(terminator, lt + 2);
		return at < 0 ? -1 : at + terminator.length;
	};
	if (source.startsWith("<!--", lt)) return after("-->");
	if (source.startsWith("<![CDATA[", lt)) return after("]]>");
	if (source.startsWith("<?", lt)) return after("?>");
	let quote: string | undefined;
	let subset = false;
	for (let at = lt + 1; at < source.length; at++) {
		const char = source[at];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "[" && source[lt + 1] === "!") {
			subset = true;
		} else if (char === "]") {
			subset = false;
		} else if (char === ">" && !subset) {
			return at + 1;
		}
	}
	return -1;
}

/** Parses `<name attr="v" …>` / `<name …/>`; null when the tag is malformed. */
function parseStartTag(raw: string): Tag | null {
	const selfClosing = raw.endsWith("/>");
	const body = raw.slice(1, selfClosing ? -2 : -1);
	const name = /^[^\s/>]+/.exec(body)?.[0];
	if (!name || !NAME.test(name)) return null;
	const attributes: [string, string][] = [];
	let index = name.length;
	for (;;) {
		if (body.slice(index).trim() === "") break;
		ATTRIBUTE.lastIndex = index;
		const match = ATTRIBUTE.exec(body);
		if (!match) return null;
		const [, attrName, double, single] = match;
		// XML requires a value; a bare attribute means the tag does not parse.
		if (double === undefined && single === undefined) return null;
		if (!NAME.test(attrName)) return null;
		attributes.push([attrName, decodeEntities(double ?? single ?? "")]);
		index = ATTRIBUTE.lastIndex;
	}
	return { name, attributes, selfClosing };
}

function isLocalOrRasterHref(value: string, element: string): boolean {
	const trimmed = value.trim();
	if (trimmed.startsWith("#")) return true;
	return element === "image" && INLINE_RASTER.test(trimmed);
}

/** The attributes that survive, values theme-resolved; null drops the whole element. */
function filterAttributes(tag: Tag, palette: SvgPalette | undefined): [string, string][] | null {
	const kept: [string, string][] = [];
	for (const [name, rawValue] of tag.attributes) {
		const lower = name.toLowerCase();
		if (lower.startsWith("on")) continue;
		// Animations that would retarget a link drop the whole element.
		if ((tag.name === "animate" || tag.name === "set") && lower === "attributename" && /href/i.test(rawValue)) {
			return null;
		}
		if (lower === "xmlns" || lower.startsWith("xmlns:")) continue; // re-added on the root
		if (name.includes(":") && name !== "xlink:href" && name !== "xml:space" && name !== "xml:lang") continue;
		if (lower === "href" || lower === "xlink:href") {
			if (isLocalOrRasterHref(rawValue, tag.name)) kept.push([name, rawValue.trim()]);
			continue;
		}
		if (lower === "style") {
			kept.push([name, sanitizeCss(rawValue, palette)]);
			continue;
		}
		const value = resolveVars(rawValue, palette);
		if (EXTERNAL_URL.test(value) || /javascript:/i.test(value)) continue;
		kept.push([name, value]);
	}
	return kept;
}

function serializeStartTag(name: string, attributes: [string, string][], selfClosing: boolean): string {
	let out = `<${name}`;
	for (const [attrName, value] of attributes) out += ` ${attrName}="${escapeText(value).replaceAll('"', "&quot;")}"`;
	return `${out}${selfClosing ? "/>" : ">"}`;
}

/** Root attributes: namespaces, plus the theme's text color and a sans-serif face unless the source sets them. */
function rootAttributes(
	attributes: [string, string][],
	palette: SvgPalette | undefined,
	usesXlink: boolean,
): [string, string][] {
	const has = (name: string) => attributes.some(([attrName]) => attrName === name);
	const extra: [string, string][] = [["xmlns", SVG_NS]];
	if (usesXlink) extra.push(["xmlns:xlink", XLINK_NS]);
	if (palette?.fg && !has("color")) extra.push(["color", palette.fg]);
	if (!has("font-family")) extra.push(["font-family", "sans-serif"]);
	return [...extra, ...attributes];
}

/**
 * Rebuilds `source` as a self-contained, script-free SVG document themed with
 * `palette`, or returns null when it is not (yet) a well-formed `<svg>` document.
 */
export function sanitizeSvg(source: string, palette?: SvgPalette): string | null {
	if (source.length > SVG_PREVIEW_MAX_CHARS || !source.includes("<svg")) return null;
	const stack: Frame[] = [];
	// parts[0] is the root's start tag, written once its xlink use is known.
	const parts: string[] = [];
	let root: Tag | null = null;
	let rootAttrs: [string, string][] = [];
	let rootDone = false;
	let usesXlink = false;
	let index = 0;
	const dropping = () => stack.some(frame => frame.mode === "drop");
	const emitText = (text: string) => {
		// Outside the root only whitespace is well-formed.
		if (stack.length === 0) return text.trim() === "";
		if (dropping() || text === "") return true;
		if (stack.at(-1)?.name === "style") {
			parts.push(`<![CDATA[${sanitizeCss(text, palette).replaceAll("]]>", "")}]]>`);
		} else {
			parts.push(escapeText(text));
		}
		return true;
	};
	while (index < source.length) {
		const lt = source.indexOf("<", index);
		if (!emitText(decodeEntities(source.slice(index, lt < 0 ? source.length : lt)))) return null;
		if (lt < 0) break;
		const end = constructEnd(source, lt);
		if (end < 0) return null;
		const raw = source.slice(lt, end);
		index = end;
		if (raw.startsWith("<!--") || raw.startsWith("<?")) continue;
		if (raw.startsWith("<![CDATA[")) {
			if (stack.length === 0) return null;
			if (!emitText(raw.slice(9, -3))) return null;
			continue;
		}
		if (raw.startsWith("<!")) {
			// DOCTYPE before the root only; its entity declarations are never honored.
			if (root || !/^<!DOCTYPE\s/i.test(raw)) return null;
			continue;
		}
		if (raw.startsWith("</")) {
			const name = raw.slice(2, -1).trim();
			const frame = stack.pop();
			if (!frame || frame.name !== name) return null;
			if (frame.mode === "keep" && !dropping()) parts.push(`</${name}>`);
			if (stack.length === 0) rootDone = true;
			continue;
		}
		const tag = parseStartTag(raw);
		if (!tag) return null;
		if (stack.length === 0 && (rootDone || tag.name !== "svg")) return null;
		// Link wrappers lose the tag and keep their drawing; unknown elements go with their subtree.
		let mode: Frame["mode"] = KEPT_ELEMENTS.has(tag.name) ? "keep" : tag.name === "a" ? "unwrap" : "drop";
		let attributes: [string, string][] = [];
		if (mode === "keep" && !dropping()) {
			const filtered = filterAttributes(tag, palette);
			if (filtered === null) mode = "drop";
			else attributes = filtered;
		}
		if (mode === "keep" && !dropping()) {
			if (attributes.some(([name]) => name.startsWith("xlink:"))) usesXlink = true;
			if (stack.length === 0) {
				root = tag;
				rootAttrs = attributes;
				parts.push("");
			} else {
				parts.push(serializeStartTag(tag.name, attributes, tag.selfClosing));
			}
		}
		if (tag.selfClosing) {
			if (stack.length === 0) rootDone = true;
		} else {
			stack.push({ name: tag.name, mode });
		}
	}
	if (!root || !rootDone || stack.length > 0) return null;
	parts[0] = serializeStartTag("svg", rootAttributes(rootAttrs, palette, usesXlink), root.selfClosing);
	return parts.join("");
}

/** `data:` URL for a sanitized SVG document. */
export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Whether a sanitized document leaves its width open (no `width`, or `auto`
 * or a percentage). Inline, such an SVG fills the width it is shown in; as an
 * `<img>` it has no natural width, so its box must be given one.
 */
export function svgFillsWidth(svg: string): boolean {
	const rootTag = svg.slice(0, svg.indexOf(">") + 1);
	const width = / width="([^"]*)"/.exec(rootTag)?.[1]?.trim();
	return width === undefined || width === "" || width === "auto" || width.endsWith("%");
}
