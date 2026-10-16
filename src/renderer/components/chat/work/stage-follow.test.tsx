import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newestHunkFocusRow } from "../../../lib/diff";
import { I18nProvider } from "../../../lib/i18n";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../../stores/tools";
import { revealLiveFocus } from "./stage-follow";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let reducedMotion = false;
Object.assign(window, {
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
	omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } },
	matchMedia: (query: string) => ({
		matches: query.includes("prefers-reduced-motion") && reducedMotion,
		addEventListener() {},
		removeEventListener() {},
	}),
});
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("../LiveStepPeek");
const { EditRenderer } = await import("../../tools/renderers/EditRenderer");
const { WriteRenderer } = await import("../../tools/renderers/WriteRenderer");
const { ReadRenderer } = await import("../../tools/renderers/ReadRenderer");

interface Geometry {
	top: number;
	height: number;
	scrollHeight?: number;
	clientHeight?: number;
}

/**
 * Injected layout: linkedom lays nothing out, so each element's box and
 * scroll extent come from `geometry`, and `scrollTo` records the stage's
 * calls while moving `scrollTop` like a browser would.
 */
const geometry = new WeakMap<object, Geometry>();
const scrolls: Array<{ element: HTMLElement; top: number; behavior: ScrollBehavior | undefined }> = [];
const prototype = HTMLElement.prototype;
Object.defineProperties(prototype, {
	scrollHeight: {
		configurable: true,
		get(this: HTMLElement) {
			return geometry.get(this)?.scrollHeight ?? 0;
		},
	},
	clientHeight: {
		configurable: true,
		get(this: HTMLElement) {
			return geometry.get(this)?.clientHeight ?? 0;
		},
	},
});
Object.assign(prototype, {
	getBoundingClientRect(this: HTMLElement) {
		const box = geometry.get(this) ?? { top: 0, height: 0 };
		return { top: box.top, bottom: box.top + box.height, left: 0, right: 0, width: 0, height: box.height };
	},
	scrollTo(this: HTMLElement, options: ScrollToOptions) {
		const top = options.top ?? 0;
		scrolls.push({ element: this, top, behavior: options.behavior });
		const box = geometry.get(this);
		const shift = top - this.scrollTop;
		this.scrollTop = top;
		// Content moves up by the scrolled distance, as it does on screen.
		if (box) {
			for (const child of this.querySelectorAll<HTMLElement>("*")) {
				const childBox = geometry.get(child);
				if (childBox) childBox.top -= shift;
			}
		}
	},
});

let root: Root;
let container: HTMLElement;
async function mount(element: ReactElement) {
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
}
beforeEach(() => {
	reducedMotion = false;
	scrolls.length = 0;
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useToolsStore.getState().reset();
});

const twoHunks = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n@@ -40,4 +40,5 @@\n forty\n-old 41\n+new 41\n+new 42\n forty two";

describe("live focus marks", () => {
	it("finds the first change of the newest hunk", () => {
		// Rows: one, -two, +TWO, gap, forty, -old 41, …
		expect(newestHunkFocusRow(twoHunks)).toBe(5);
		expect(newestHunkFocusRow("@@ -1 +1 @@\n context only")).toBeUndefined();
	});

	it("marks the newest hunk's first changed line on a live edit, and only live", async () => {
		await mount(<EditRenderer livePreview isPartial args={{ path: "a.ts", diff: twoHunks }} result={undefined} />);
		const marks = container.querySelectorAll("[data-live-focus]");
		expect(marks).toHaveLength(1);
		expect(marks[0]?.getAttribute("data-live-focus")).toBe("start");
		expect(marks[0]?.textContent).toContain("old 41");
		await mount(<EditRenderer args={{ path: "a.ts", diff: twoHunks }} result={undefined} />);
		expect(container.querySelector("[data-live-focus]")).toBeNull();
	});

	it("follows a streaming write's tail and a read's first line", async () => {
		await mount(
			<WriteRenderer livePreview isPartial args={{ path: "a.ts", content: "a\nb\nc" }} result={undefined} />,
		);
		expect(container.querySelector("[data-live-focus]")?.getAttribute("data-live-focus")).toBe("end");
		await mount(
			<ReadRenderer
				livePreview
				args={{ path: "a.ts:40-60" }}
				result={{
					content: [{ type: "text", text: "x" }],
					details: { displayContent: { text: "forty\nforty one", startLine: 40 } },
				}}
			/>,
		);
		expect(container.querySelector("[data-live-focus]")?.getAttribute("data-live-focus")).toBe("start");
	});
});

describe("revealLiveFocus", () => {
	function nest() {
		const outer = document.createElement("div") as unknown as HTMLElement;
		const inner = document.createElement("div") as unknown as HTMLElement;
		const target = document.createElement("div") as unknown as HTMLElement;
		inner.appendChild(target as never);
		outer.appendChild(inner as never);
		geometry.set(outer, { top: 100, height: 200, scrollHeight: 900, clientHeight: 200 });
		geometry.set(inner, { top: 120, height: 300, scrollHeight: 1200, clientHeight: 300 });
		geometry.set(target, { top: 820, height: 20 });
		outer.scrollTop = 0;
		inner.scrollTop = 0;
		return { outer, inner, target };
	}

	it("scrolls each scroller up to the root so the start shows with context above", () => {
		const { outer, inner, target } = nest();
		target.dataset.liveFocus = "start";
		revealLiveFocus(outer, target, "smooth");
		// Inner: 820 - 120 - 32 of context. The target then sits at 152; outer: 152 - 100 - 32.
		expect(scrolls).toEqual([
			{ element: inner, top: 668, behavior: "smooth" },
			{ element: outer, top: 20, behavior: "smooth" },
		]);
	});

	it("keeps a tail's bottom edge at the viewport bottom and never scrolls past the root", () => {
		const { outer, inner, target } = nest();
		const page = document.createElement("div") as unknown as HTMLElement;
		page.appendChild(outer as never);
		geometry.set(page, { top: 0, height: 400, scrollHeight: 5000, clientHeight: 400 });
		target.dataset.liveFocus = "end";
		revealLiveFocus(outer, target, "instant");
		// Inner: 840 - (120 + 300). The target's bottom is then 420; outer: 420 - (100 + 200).
		expect(scrolls).toEqual([
			{ element: inner, top: 420, behavior: "instant" },
			{ element: outer, top: 120, behavior: "instant" },
		]);
	});
});

describe("work stage follow", () => {
	const edit = (diff: string, startTime = 1): ToolEntry => ({
		toolName: "edit",
		args: { path: "src/app.ts", diff },
		streamingArgs: "",
		result: undefined,
		isError: false,
		status: "running",
		startTime,
		endTime: null,
	});
	/** Gives the stage a 200px viewport over 1000px of content, its focus row 600px down. */
	function layOut() {
		const stage = container.querySelector<HTMLElement>(".omp-live-step-scroll");
		const focus = stage?.querySelector<HTMLElement>("[data-live-focus]");
		if (!stage || !focus) throw new Error("stage or focus missing");
		stage.scrollTop = 0;
		geometry.set(stage, { top: 0, height: 200, scrollHeight: 1000, clientHeight: 200 });
		geometry.set(focus, { top: 600, height: 20 });
		return stage;
	}
	async function show(ids: string[], entries: Array<[string, ToolEntry]>) {
		await act(async () => useToolsStore.setState(toolEntriesState(entries)));
		await mount(<LiveStepPeek thinkingLive={false} toolCallIds={ids} />);
	}
	function reactProps(element: HTMLElement): Record<string, (event: object) => void> {
		const key = Object.keys(element).find(name => name.startsWith("__reactProps$"));
		if (!key) throw new Error("react props missing");
		return Reflect.get(element, key);
	}

	it("scrolls the stage to the newest hunk smoothly, keeps following, and yields to the reader", async () => {
		await show(["one"], [["one", edit(twoHunks)]]);
		const stage = layOut();
		await show(["one"], [["one", edit(`${twoHunks}\n+new 43`)]]);
		expect(scrolls.at(-1)).toEqual({ element: stage, top: 568, behavior: "smooth" });

		// The edit grows; the focus moved further down and the stage follows it.
		geometry.set(stage, { top: 0, height: 200, scrollHeight: 1200, clientHeight: 200 });
		const focus = stage.querySelector<HTMLElement>("[data-live-focus]");
		if (focus) geometry.set(focus, { top: 700 - stage.scrollTop, height: 20 });
		await show(["one"], [["one", edit(`${twoHunks}\n+new 43\n+new 44`)]]);
		expect(scrolls.at(-1)).toEqual({ element: stage, top: 668, behavior: "smooth" });

		// The reader scrolls the stage: the next update leaves it where they put it.
		await act(async () => reactProps(stage).onWheel?.({ deltaY: -40 }));
		const before = scrolls.length;
		await show(["one"], [["one", edit(`${twoHunks}\n+new 43\n+new 44\n+new 45`)]]);
		expect(scrolls).toHaveLength(before);

		// The next step resumes following.
		await show(
			["one", "two"],
			[
				["one", { ...edit(twoHunks), status: "done", endTime: 2 }],
				["two", edit(twoHunks, 3)],
			],
		);
		const next = layOut();
		await show(
			["one", "two"],
			[
				["one", { ...edit(twoHunks), status: "done", endTime: 2 }],
				["two", edit(`${twoHunks}\n+more`, 3)],
			],
		);
		expect(scrolls.at(-1)).toEqual({ element: next, top: 568, behavior: "smooth" });
	});

	it("jumps instantly under reduced motion", async () => {
		reducedMotion = true;
		await show(["one"], [["one", edit(twoHunks)]]);
		const stage = layOut();
		await show(["one"], [["one", edit(`${twoHunks}\n+new 43`)]]);
		expect(scrolls.at(-1)).toEqual({ element: stage, top: 568, behavior: "instant" });
	});
});
