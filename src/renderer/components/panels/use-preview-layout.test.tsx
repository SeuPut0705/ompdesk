/**
 * A phone's streamed page is sized by the layout the panel reports. A navigation used to send a zero-size layout
 * (the effect's cleanup) and only a frame later the real one, so the host's offscreen page shrank to 1x1 on every
 * address change and an agent's click right after `goto` landed in a viewport of 0x0 (issue #21).
 */
import { parseHTML } from "linkedom";
import { act, createElement, useRef } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewRequest } from "../../../shared/preview";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const frames = new Map<number, () => void>();
let nextFrame = 1;
class FakeObserver {
	observe(): void {}
	disconnect(): void {}
}
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	ResizeObserver: FakeObserver,
	MutationObserver: FakeObserver,
	requestAnimationFrame: (callback: () => void) => {
		frames.set(nextFrame, callback);
		return nextFrame++;
	},
	cancelAnimationFrame: (handle: number) => frames.delete(handle),
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { usePreviewLayout } = await import("./use-preview-layout");

interface Props {
	shown: boolean;
	pageUrl: string;
}

let sent: PreviewRequest[] = [];
const command = (request: PreviewRequest) => {
	sent.push(request);
};

function Panel({ shown, pageUrl }: Props) {
	const surface = useRef<HTMLDivElement>(null);
	// The surface's box exists from the first frame on.
	if (surface.current)
		surface.current.getBoundingClientRect = () => ({ x: 0, y: 0, width: 412, height: 617 }) as DOMRect;
	usePreviewLayout(surface, true, shown, command);
	// The address is the panel's own business: the layout hook must not hear of it.
	return createElement("div", { ref: surface, "data-url": pageUrl });
}

let root: Root | undefined;

async function mount(props: Props) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(createElement(Panel, props)));
	const surface = container.firstElementChild as unknown as HTMLElement;
	surface.getBoundingClientRect = () => ({ x: 0, y: 0, width: 412, height: 617 }) as DOMRect;
	return surface;
}

/** One animation frame: what the browser runs after a render. */
function paint() {
	const due = [...frames.values()];
	frames.clear();
	for (const callback of due) callback();
}

const layouts = () =>
	sent.filter((request): request is Extract<PreviewRequest, { action: "layout" }> => request.action === "layout");
const collapsed = () => layouts().filter(request => request.bounds.width === 0 || request.bounds.height === 0);

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	frames.clear();
	sent = [];
	document.body.replaceChildren();
});

describe("usePreviewLayout on a phone", () => {
	it("keeps the page at its size while the address changes", async () => {
		await mount({ shown: true, pageUrl: "http://site/next" });
		paint();
		await act(async () => root?.render(createElement(Panel, { shown: true, pageUrl: "http://site/" })));
		paint();
		expect(layouts().length).toBeGreaterThan(0);
		expect(collapsed()).toEqual([]);
		expect(layouts().at(-1)).toMatchObject({ bounds: { width: 412, height: 617 }, visible: true });
	});

	it("keeps the surface's size while the page is hidden and shown again", async () => {
		await mount({ shown: true, pageUrl: "http://site/" });
		paint();
		await act(async () => root?.render(createElement(Panel, { shown: false, pageUrl: "http://site/" })));
		paint();
		expect(layouts().at(-1)).toMatchObject({ bounds: { width: 412, height: 617 }, visible: false });
		await act(async () => root?.render(createElement(Panel, { shown: true, pageUrl: "http://site/" })));
		paint();
		expect(collapsed()).toEqual([]);
		expect(layouts().at(-1)).toMatchObject({ bounds: { width: 412, height: 617 }, visible: true });
	});

	it("hides the page when the panel goes away", async () => {
		await mount({ shown: true, pageUrl: "http://site/" });
		paint();
		await act(async () => root?.unmount());
		root = undefined;
		expect(layouts().at(-1)).toMatchObject({ bounds: { width: 0, height: 0 }, visible: false });
	});
});
