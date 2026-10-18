/**
 * Mermaid diagram block: renders ```mermaid fences as real SVG diagrams.
 * The mermaid package (~500KB) is dynamically imported only when a mermaid
 * fence actually appears. Rendered SVG is cached by (theme, source hash);
 * parse failures fall back to the plain CodeBlock showing the source.
 */

import type { Mermaid, MermaidConfig } from "mermaid";
import { memo, type ReactNode, type RefObject, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { svgDataUrl } from "../../lib/svg-preview";
import type { ResolvedTheme } from "../../lib/theme";
import { Spinner } from "../common/Spinner";
import { ZoomableImage, type ZoomableImageHandle } from "../common/ZoomableImage";
import { Figure, type FigureMode } from "./Figure";

let mermaidPromise: Promise<Mermaid> | null = null;
/** Look key the shared mermaid singleton was last initialized with. */
let initializedLook: string | null = null;
/** Rendered SVG cache, keyed by `${look.key}:${fnv(source)}`. */
const svgCache = new Map<string, string>();
const CACHE_LIMIT = 50;
let renderSeq = 0;

function loadMermaid(): Promise<Mermaid> {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then(mod => mod.default);
	}
	return mermaidPromise;
}

/** FNV-1a 32-bit — cheap stable cache key (not cryptographic). */
function hashSource(source: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		h ^= source.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/**
 * Defense in depth on top of securityLevel:"strict" (mermaid already encodes
 * label text): strip executable elements, inline event handlers, and
 * javascript: links from the rendered SVG before injecting it as HTML.
 * <style> and <foreignObject> (mermaid's label layout) are kept.
 */
function sanitizeSvg(svg: string): string {
	// Parse as HTML, not image/svg+xml: label HTML inside <foreignObject> is
	// not guaranteed XML-wellformed (e.g. an unclosed <img> surviving strict
	// sanitization), and strict XML parsing would reject valid diagrams.
	// DOMParser documents are inert — nothing here executes or loads.
	const doc = new DOMParser().parseFromString(svg, "text/html");
	const root = doc.querySelector("svg");
	if (!root) {
		throw new Error("mermaid produced no SVG root");
	}
	for (const el of Array.from(root.querySelectorAll("script,iframe,object,embed,link,meta"))) {
		el.remove();
	}
	const scrub = (el: Element) => {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			const value = attr.value.trim().toLowerCase();
			if (name.startsWith("on") || ((name === "href" || name === "xlink:href") && value.startsWith("javascript:"))) {
				el.removeAttribute(attr.name);
			}
		}
	};
	scrub(root);
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
	let node = walker.nextNode();
	while (node) {
		scrub(node as Element);
		node = walker.nextNode();
	}
	// Mermaid sizes the root `width="100%"` with a CSS max-width: as an <img>
	// that leaves no intrinsic width, so a shrink-to-fit container (the zoom
	// button) collapses it to nothing. The viewBox carries the natural size.
	const [, , width, height] = (root.getAttribute("viewBox") ?? "")
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (width && height && Number.isFinite(width) && Number.isFinite(height)) {
		root.setAttribute("width", String(width));
		root.setAttribute("height", String(height));
	}
	return new XMLSerializer().serializeToString(root);
}

async function renderDiagram(source: string, look: MermaidLook): Promise<string> {
	const key = `${look.key}:${hashSource(source)}`;
	const cached = svgCache.get(key);
	if (cached !== undefined) return cached;
	const mermaid = await loadMermaid();
	if (initializedLook !== look.key) {
		const config: MermaidConfig = {
			startOnLoad: false,
			theme: "base",
			themeVariables: look.variables,
			securityLevel: "strict",
		};
		mermaid.initialize(config);
		initializedLook = look.key;
	}
	const id = `omp-mermaid-${renderSeq++}`;
	let svg: string;
	try {
		svg = (await mermaid.render(id, source)).svg;
	} catch (err) {
		// Mermaid leaves its failed-render scratch element in the DOM.
		document.getElementById(id)?.remove();
		throw err;
	}
	const clean = sanitizeSvg(svg);
	if (svgCache.size >= CACHE_LIMIT) {
		const oldest = svgCache.keys().next().value;
		if (oldest !== undefined) svgCache.delete(oldest);
	}
	svgCache.set(key, clean);
	return clean;
}

function readResolvedTheme(): ResolvedTheme {
	if (typeof window === "undefined") return "dark";
	const attr = document.documentElement.getAttribute("data-theme");
	if (attr === "light" || attr === "dark") return attr;
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** What a diagram is drawn in: the active theme's surfaces, text and lines, as mermaid's `base` theme variables. */
interface MermaidLook {
	/** Theme id plus a hash of the variables: any change to either re-renders. */
	key: string;
	variables: NonNullable<MermaidConfig["themeVariables"]>;
}

function readLook(): MermaidLook {
	if (typeof window === "undefined" || typeof getComputedStyle !== "function") return { key: "plain", variables: {} };
	const root = document.documentElement;
	const style = getComputedStyle(root);
	const read = (name: string) => style.getPropertyValue(name).trim();
	const scheme = readResolvedTheme();
	const variables = {
		darkMode: scheme === "dark",
		background: read("--sc-elevated"),
		fontFamily: read("--sc-font-sans"),
		textColor: read("--sc-text"),
		primaryColor: read("--sc-surface-3"),
		primaryTextColor: read("--sc-text"),
		primaryBorderColor: read("--sc-border"),
		secondaryColor: read("--sc-surface-2"),
		secondaryTextColor: read("--sc-text"),
		tertiaryColor: read("--sc-surface-1"),
		tertiaryTextColor: read("--sc-text"),
		lineColor: read("--sc-text-secondary"),
		mainBkg: read("--sc-surface-3"),
		nodeBorder: read("--sc-border"),
		clusterBkg: read("--sc-surface-2"),
		clusterBorder: read("--sc-border-subtle"),
		titleColor: read("--sc-text"),
		edgeLabelBackground: read("--sc-surface-1"),
		noteBkgColor: read("--sc-surface-2"),
		noteTextColor: read("--sc-text"),
		noteBorderColor: read("--sc-border"),
		errorBkgColor: read("--sc-surface-2"),
		errorTextColor: read("--sc-danger"),
	};
	// A variable the page does not define (a bare test document) keeps mermaid's own value.
	const defined = Object.fromEntries(Object.entries(variables).filter(([, value]) => value !== ""));
	const name = root.getAttribute("data-theme-name") ?? scheme;
	return { key: `${name}:${hashSource(JSON.stringify(defined))}`, variables: defined };
}

/**
 * The diagram look, tracked through `data-theme` / `data-theme-name` on <html>, so
 * a named theme (lib/themes) and an OS flip under System both re-render.
 */
function useMermaidLook(): MermaidLook {
	const [look, setLook] = useState<MermaidLook>(readLook);
	useEffect(() => {
		const observer = new MutationObserver(() =>
			setLook(current => {
				const next = readLook();
				return next.key === current.key ? current : next;
			}),
		);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "data-theme-name"],
		});
		return () => observer.disconnect();
	}, []);
	return look;
}

interface MermaidImageProps {
	svg: string;
	alt: string;
	zoom: RefObject<ZoomableImageHandle | null>;
}

/** The diagram as an image that opens full size on click (fit, then actual size). */
function MermaidImage({ svg, alt, zoom }: MermaidImageProps) {
	const [url] = useState(() => URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })));
	useEffect(() => () => URL.revokeObjectURL(url), [url]);
	return (
		<div className="flex justify-center p-3">
			<ZoomableImage alt={alt} className="block h-auto max-w-full" handleRef={zoom} src={url} />
		</div>
	);
}

export interface MermaidBlockProps {
	/** Mermaid diagram source. */
	code: string;
	/** The code view's gutter, as the surrounding transcript has it. */
	showLineNumbers?: boolean;
	maxHeightClass?: string;
	/** Replaces the code view's CodeBlock (a write's diff), inside the same box. */
	codeView?: ReactNode;
	/** Header title when the figure is a file ("flow.mmd"); the kind otherwise. */
	title?: string;
	className?: string;
	/** Controlled Preview/Code view (a file viewer that remembers it). */
	mode?: FigureMode;
	onModeChange?: (mode: FigureMode) => void;
}

interface RenderState {
	key: string;
	svg: string | null;
	failed: boolean;
}

export const MermaidBlock = memo(function MermaidBlock({
	code,
	showLineNumbers,
	maxHeightClass,
	codeView,
	title = "Mermaid",
	className,
	mode,
	onModeChange,
}: MermaidBlockProps) {
	const t = useT();
	const look = useMermaidLook();
	const cacheKey = `${look.key}:${hashSource(code)}`;
	const [state, setState] = useState<RenderState>(() => ({
		key: cacheKey,
		svg: svgCache.get(cacheKey) ?? null,
		failed: false,
	}));

	useEffect(() => {
		const cached = svgCache.get(cacheKey);
		if (cached !== undefined) {
			setState({ key: cacheKey, svg: cached, failed: false });
			return;
		}
		setState({ key: cacheKey, svg: null, failed: false });
		let cancelled = false;
		renderDiagram(code, look).then(
			clean => {
				if (!cancelled) setState({ key: cacheKey, svg: clean, failed: false });
			},
			() => {
				if (!cancelled) setState({ key: cacheKey, svg: null, failed: true });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [code, look, cacheKey]);

	// Guard against showing the previous diagram while the effect for a new
	// (code, theme) pair has not run yet.
	const current: RenderState =
		state.key === cacheKey ? state : { key: cacheKey, svg: svgCache.get(cacheKey) ?? null, failed: false };
	const svg = current.svg;
	const common = {
		kind: "mermaid",
		title,
		code,
		language: "mermaid",
		codeView,
		showLineNumbers,
		maxHeightClass,
		className,
		mode,
		onModeChange,
	};

	// SSR / non-DOM path or a diagram mermaid rejects: the source, still in the box.
	if (typeof window === "undefined" || current.failed) return <Figure {...common} preview={null} />;
	if (svg === null) {
		return (
			<Figure
				{...common}
				preview={() => (
					<div className="flex items-center justify-center px-3 py-6">
						<Spinner size="md" label={t("chat.renderingDiagram")} />
					</div>
				)}
			/>
		);
	}
	return (
		<Figure
			{...common}
			download={{
				src: svgDataUrl(svg),
				name: `${title === "Mermaid" ? "diagram" : title.replace(/\.[^.]*$/, "")}.svg`,
			}}
			preview={zoom => <MermaidImage key={cacheKey} alt={t("chat.diagram")} svg={svg} zoom={zoom} />}
			zoomable
		/>
	);
});
