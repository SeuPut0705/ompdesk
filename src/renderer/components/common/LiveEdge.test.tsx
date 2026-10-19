import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Imported after the DOM globals above exist (react-dom reads them when it loads).
const { createRoot } = await import("react-dom/client");
const { LiveEdge } = await import("./LiveEdge");

let container: HTMLElement;
let root: Root;

async function mount(node: ReactNode): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(node));
}

afterEach(async () => {
	await act(async () => root.unmount());
	Reflect.set(document, "visibilityState", "visible");
});

describe("LiveEdge", () => {
	it("is one decorative element with the state and the contained form as attributes", async () => {
		await mount(<LiveEdge inside state="background" />);
		const edge = container.querySelector(".omp-live-edge");
		expect(edge?.getAttribute("aria-hidden")).toBe("true");
		expect(edge?.getAttribute("data-live-edge")).toBe("background");
		expect(edge?.hasAttribute("data-live-edge-inside")).toBe(true);
		expect(edge?.hasAttribute("data-paused")).toBe(false);
	});

	it("rests while the window is hidden", async () => {
		await mount(<LiveEdge />);
		Reflect.set(document, "visibilityState", "hidden");
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(container.querySelector(".omp-live-edge")?.hasAttribute("data-paused")).toBe(true);
	});
});

describe("the light's look (components.css)", () => {
	const css = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
	const sidebarCss = readFileSync(new URL("../../styles/sidebar.css", import.meta.url), "utf8");
	const block = (from: string) => css.slice(css.indexOf(from), css.indexOf("\n}\n", css.indexOf(from)));

	it("animates one transform and nothing else: no opacity breathing on the light", () => {
		const keyframes = block("@keyframes omp-live-edge-turn");
		expect(keyframes).toContain("transform: rotate(360deg)");
		expect(keyframes).not.toContain("opacity");
		expect(block(".omp-live-edge::before")).toContain("animation: omp-live-edge-turn 8s linear infinite");
		expect(block(".omp-live-edge::before")).toContain("will-change: transform");
	});

	it("rests while the window is hidden", () => {
		expect(block(".omp-live-edge[data-paused]::before")).toContain("animation-play-state: paused");
	});

	it("draws a contained card's still form as a 1px edge all round, no bars, under reduced motion and software compositing", () => {
		const reduced = block("@media (prefers-reduced-motion: reduce) {\n\t.omp-live-edge {");
		expect(reduced).toMatch(/\.omp-live-edge\[data-live-edge-inside\] \{\s*border-color: color-mix/);
		expect(reduced).toMatch(/\.omp-live-edge\[data-live-edge-inside\]::after \{\s*display: none;/);
		expect(reduced).toContain("animation: none");
		const software = block('html[data-gpu="software"] .omp-live-edge::before');
		expect(software).toContain("animation: none");
		expect(css).toMatch(
			/html\[data-gpu="software"\] \.omp-live-edge\[data-live-edge-inside\] \{\s*opacity: 1;\s*border-color: color-mix/,
		);
		expect(css).toMatch(
			/html\[data-gpu="software"\] \.omp-live-edge\[data-live-edge-inside\]::after \{\s*display: none;/,
		);
	});

	it("keeps a card's light cheap: two transform-only bars, no mask, no clip, no opacity group", () => {
		const card = block(".omp-live-edge[data-live-edge-inside] {");
		expect(card).toContain("-webkit-mask: none");
		expect(card).toContain("overflow: visible");
		expect(card).toContain("opacity: 1");
		const bars = block(".omp-live-edge[data-live-edge-inside]::before,");
		expect(bars).toContain("animation: omp-live-edge-run 8s linear infinite");
		expect(bars).toContain("will-change: transform");
		const keyframes = block("@keyframes omp-live-edge-run");
		expect(keyframes).toContain("transform: translateX(");
		expect(keyframes).not.toContain("opacity");
		expect(block(".omp-live-edge[data-paused]::before,")).toContain("animation-play-state: paused");
	});

	it("leaves no old running bar or sidebar light behind", () => {
		expect(sidebarCss).not.toContain('data-signal="running"');
		expect(sidebarCss).not.toContain("omp-sidebar-edge-light");
	});
});
