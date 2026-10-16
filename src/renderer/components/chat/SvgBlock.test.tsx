/**
 * The ```svg fence figure: a viewBox-only document (no width/height, as
 * models write them) fills the chip's width instead of collapsing to 0×0,
 * one that sets its size keeps it, figure tokens take the app's `--sc-*`
 * theme colors in both themes, and nothing executable or external survives.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node, MutationObserver } =
	parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	MutationObserver,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after linkedom's globals are installed: react-dom reads `document`/`window` at import.
const { createRoot } = await import("react-dom/client");
const { SvgBlock } = await import("./SvgBlock");

/** The `--sc-*` palette primitives of theme-dark.css / theme-light.css. */
const THEMES = {
	dark: {
		"--sc-surface-3": "#28282d",
		"--sc-text": "#ededf0",
		"--sc-text-secondary": "#c4c4cb",
		"--sc-text-muted": "#a1a1aa",
		"--sc-border-subtle": "#3a3a41",
		"--sc-accent": "#8b8df8",
		"--sc-success": "#5bc98c",
		"--sc-warning": "#e2b552",
		"--sc-danger": "#f27a7d",
		"--sc-info": "#79a6f6",
	},
	light: {
		"--sc-surface-3": "#ececef",
		"--sc-text": "#1b1b1f",
		"--sc-text-secondary": "#46464f",
		"--sc-text-muted": "#5f5f68",
		"--sc-border-subtle": "#dcdce2",
		"--sc-accent": "#5b5bd6",
		"--sc-success": "#18794e",
		"--sc-warning": "#935f00",
		"--sc-danger": "#bf3a3e",
		"--sc-info": "#2f62c4",
	},
} as const;

/** Figure token → the `--sc-*` primitive it must take. */
const TOKENS: Record<string, keyof (typeof THEMES)["dark"]> = {
	surface: "--sc-surface-3",
	fg: "--sc-text",
	muted: "--sc-text-muted",
	border: "--sc-border-subtle",
	accent: "--sc-accent",
	success: "--sc-success",
	warning: "--sc-warning",
	error: "--sc-danger",
	c1: "--sc-accent",
	c2: "--sc-info",
	c3: "--sc-success",
	c4: "--sc-warning",
	c5: "--sc-danger",
	c6: "--sc-text-secondary",
};

/** The kind of figure the report showed: viewBox only, every theme token, Korean labels. */
const FIGURE = [
	'<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
	"  <script>alert(2)</script>",
	'  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
	'  <image href="https://evil.example/p.png" width="10" height="10"/>',
	...Object.keys(TOKENS).map(
		(token, at) => `  <rect id="${token}" x="${at * 50}" y="10" width="40" height="40" fill="var(--${token})"/>`,
	),
	'  <text x="20" y="440" fill="var(--fg)" font-size="16">요청 흐름</text>',
	"</svg>",
].join("\n");

let container: HTMLElement;
let root: Root | undefined;
const realComputedStyle = window.getComputedStyle;

function useTheme(name: keyof typeof THEMES): void {
	const values: Record<string, string> = THEMES[name];
	document.documentElement.setAttribute("data-theme", name);
	Object.assign(window, {
		getComputedStyle: () => ({ getPropertyValue: (property: string) => values[property] ?? "" }),
	});
}

async function mount(code: string): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SvgBlock code={code} />
			</I18nProvider>,
		);
	});
}

function shownSvg(): string {
	const src = container.querySelector("[data-svg-preview] img")?.getAttribute("src") ?? "";
	expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
	return decodeURIComponent(src.slice(src.indexOf(",") + 1));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	Object.assign(window, { getComputedStyle: realComputedStyle });
});

describe("SvgBlock", () => {
	it("fills the chip's width with a viewBox-only figure instead of collapsing it", async () => {
		useTheme("dark");
		await mount(FIGURE);
		const thumb = container.querySelector("[data-svg-preview] [data-zoomable-image]");
		const img = thumb?.querySelector("img");
		// An image without a natural width inside a shrink-to-fit button lays out at 0×0.
		expect(thumb?.className.split(" ")).toContain("w-full");
		expect(img?.className.split(" ")).toContain("w-full");
		expect(img?.className.split(" ")).toContain("h-auto");
		expect(shownSvg()).toContain('viewBox="0 0 760 470"');
	});

	it("keeps the size a figure sets for itself", async () => {
		useTheme("dark");
		await mount('<svg viewBox="0 0 120 60" width="240" height="120"><rect width="120" height="60"/></svg>');
		const thumb = container.querySelector("[data-svg-preview] [data-zoomable-image]");
		expect(thumb?.className.split(" ")).not.toContain("w-full");
		expect(thumb?.querySelector("img")?.className.split(" ")).not.toContain("w-full");
	});

	for (const theme of ["dark", "light"] as const) {
		it(`resolves every figure token to the ${theme} theme's --sc-* colors`, async () => {
			useTheme(theme);
			await mount(FIGURE);
			const svg = shownSvg();
			for (const [token, variable] of Object.entries(TOKENS)) {
				expect(svg, token).toContain(`<rect id="${token}" x=`);
				expect(svg, token).toMatch(new RegExp(`id="${token}"[^>]*fill="${THEMES[theme][variable]}"`));
			}
			expect(svg).toContain(`color="${THEMES[theme]["--sc-text"]}"`);
			expect(svg).toContain(
				`<text x="20" y="440" fill="${THEMES[theme]["--sc-text"]}" font-size="16">요청 흐름</text>`,
			);
			expect(svg).not.toContain("var(");
		});
	}

	it("drops scripts, foreign content and outside references", async () => {
		useTheme("light");
		await mount(FIGURE);
		const svg = shownSvg();
		expect(svg).not.toMatch(/script|onload|alert|foreignObject|evil|href/i);
		// No inline SVG from the reply reaches the DOM.
		expect(container.querySelector("svg")).toBeNull();
	});
});
