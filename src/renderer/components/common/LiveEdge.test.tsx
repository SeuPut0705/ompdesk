import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cometShape, edgePath, pillDelay } from "./live-light";

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
const { LIVE_EDGE_LEAVE_MS, LiveEdge } = await import("./LiveEdge");

let container: HTMLElement;
let root: Root;

async function mount(node: ReactNode): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(node));
}

/** A Web Animation as far as LiveEdge drives it: its start on the timeline, paused or running. */
interface FakeAnimation {
	id: string;
	startTime: number | null;
	paused: boolean;
	cancelled: boolean;
	pause(): void;
	cancel(): void;
	effect: { setKeyframes(): void };
}

let timelineNow = 0;
let created: FakeAnimation[] = [];

/** Gives linkedom what LiveEdge measures and animates with: a 260 x 28 box rounded 6 px, Web Animations, a timeline. */
function installAnimationStubs(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.getBoundingClientRect = () => ({
		width: 260,
		height: 28,
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 260,
		bottom: 28,
	});
	proto.getAnimations = function (this: { __animations?: FakeAnimation[] }) {
		return (this.__animations ?? []).filter(animation => !animation.cancelled);
	};
	// linkedom has no shadow DOM: a child stands in for the edge's shadow root (the pills stay findable from the card).
	proto.attachShadow = function (this: HTMLElement) {
		const root = document.createElement("span") as unknown as HTMLElement;
		this.appendChild(root as never);
		Object.defineProperty(this, "shadowRoot", { value: root, configurable: true });
		return root;
	};
	proto.animate = function (this: { __animations?: FakeAnimation[] }) {
		const animation: FakeAnimation = {
			id: "",
			startTime: null,
			paused: false,
			cancelled: false,
			pause() {
				this.paused = true;
				this.startTime = null;
			},
			cancel() {
				this.cancelled = true;
			},
			effect: { setKeyframes() {} },
		};
		this.__animations = [...(this.__animations ?? []), animation];
		created.push(animation);
		return animation;
	};
	Object.assign(globalThis, { getComputedStyle: () => ({ borderTopLeftRadius: "6px" }) });
	Reflect.set(document, "timeline", {
		get currentTime() {
			return timelineNow;
		},
	});
}

/** Lets the lazily loaded comet runner arrive and start. */
async function settle(): Promise<void> {
	await act(async () => {
		await vi.dynamicImportSettled();
	});
}

const live = () => created.filter(animation => !animation.cancelled);
const edge = () => container.querySelector(".omp-live-edge");

beforeEach(() => {
	created = [];
	timelineNow = 0;
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	Reflect.set(document, "visibilityState", "visible");
	vi.useRealTimers();
});

describe("LiveEdge", () => {
	it("is one decorative element with the state and the contained form as attributes", async () => {
		await mount(<LiveEdge inside state="background" />);
		expect(edge()?.getAttribute("aria-hidden")).toBe("true");
		expect(edge()?.getAttribute("data-live-edge")).toBe("background");
		expect(edge()?.hasAttribute("data-live-edge-inside")).toBe(true);
		expect(edge()?.hasAttribute("data-paused")).toBe(false);
	});

	it("rests while the window is hidden", async () => {
		await mount(<LiveEdge state="turn" />);
		Reflect.set(document, "visibilityState", "hidden");
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(edge()?.hasAttribute("data-paused")).toBe(true);
	});

	it("fades out when its work ends, then goes", async () => {
		vi.useFakeTimers();
		await mount(<LiveEdge inside state="turn" />);
		await settle();
		await act(async () => root.render(<LiveEdge inside state={null} />));
		expect(edge()?.getAttribute("data-live-edge")).toBe("turn");
		expect(edge()?.hasAttribute("data-leaving")).toBe(true);
		await act(async () => vi.advanceTimersByTime(LIVE_EDGE_LEAVE_MS - 20));
		expect(edge()).not.toBeNull();
		await act(async () => vi.advanceTimersByTime(40));
		expect(edge()).toBeNull();
	});

	it("comes straight back, in place, when work starts again while it fades", async () => {
		vi.useFakeTimers();
		await mount(<LiveEdge inside state="turn" />);
		await settle();
		await act(async () => root.render(<LiveEdge inside state={null} />));
		await act(async () => root.render(<LiveEdge inside state="background" />));
		await act(async () => vi.advanceTimersByTime(LIVE_EDGE_LEAVE_MS * 2));
		expect(edge()?.getAttribute("data-live-edge")).toBe("background");
		expect(edge()?.hasAttribute("data-leaving")).toBe(false);
	});

	it("waits with a still tint: no comet", async () => {
		installAnimationStubs();
		await mount(<LiveEdge inside state="waiting" />);
		expect(edge()?.getAttribute("data-live-edge")).toBe("waiting");
		expect(container.querySelectorAll(".omp-live-pill")).toHaveLength(0);
		expect(live()).toHaveLength(0);
	});
});

describe("the comet on the shared clock", () => {
	beforeEach(installAnimationStubs);
	const comet = cometShape(edgePath(260, 28, 6).perimeter, edgePath(260, 28, 6).radius);
	const perimeter = edgePath(260, 28, 6).perimeter;

	it("lays one animation per pill, each its spacing behind the head on one timeline origin", async () => {
		timelineNow = 1700;
		await mount(<LiveEdge inside state="turn" />);
		await settle();
		expect(container.querySelectorAll(".omp-live-pill")).toHaveLength(comet.count);
		expect(live()).toHaveLength(comet.count);
		live().forEach((animation, rank) => {
			expect(animation.startTime).toBeCloseTo(pillDelay(rank, comet, perimeter), 6);
		});
	});

	it("puts a light that mounts later where the others are, and a remount where it was", async () => {
		timelineNow = 200;
		await mount(<LiveEdge inside state="turn" />);
		await settle();
		const first = live()[0]?.startTime;
		await act(async () => root.unmount());
		created = [];
		timelineNow = 5300;
		root = createRoot(container as unknown as Element);
		await act(async () => root.render(<LiveEdge inside state="turn" />));
		await settle();
		// Same start on the timeline: the same place on the loop at any moment, whenever it mounted.
		expect(live()[0]?.startTime).toBe(first);
	});

	it("changes state without touching the travel: no new animation, no new start", async () => {
		await mount(<LiveEdge inside state="turn" />);
		await settle();
		const before = live().map(animation => animation.startTime);
		const count = created.length;
		await act(async () => root.render(<LiveEdge inside state="background" />));
		expect(created.length).toBe(count);
		expect(live().map(animation => animation.startTime)).toEqual(before);
	});

	it("rests while hidden and goes on from where it rested when the window comes back", async () => {
		timelineNow = 1000;
		await mount(<LiveEdge inside state="turn" />);
		await settle();
		timelineNow = 2000;
		Reflect.set(document, "visibilityState", "hidden");
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(live().every(animation => animation.paused)).toBe(true);
		timelineNow = 2600;
		Reflect.set(document, "visibilityState", "visible");
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		await settle();
		// The 600 ms it stayed hidden moved the origin: the head is where it was at 2000.
		const head = live()[0];
		expect(head?.paused).toBe(false);
		expect(2600 - Number(head?.startTime)).toBe(2000 - 0);
	});
});

describe("the light's look (components.css)", () => {
	const css = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
	const light = css.slice(
		css.indexOf('/* "Work is going on" light'),
		css.indexOf('html[data-gpu="software"] .omp-live-edge'),
	);
	const block = (from: string) => css.slice(css.indexOf(from), css.indexOf("\n}\n", css.indexOf(from)));

	it("moves only by the pills' transforms: no CSS animation, nothing breathes, the Send ring holds still", () => {
		expect(light).not.toMatch(/\banimation:/);
		expect(light).not.toContain("@keyframes");
		expect(block(".omp-composer-send-live[data-composer-live]::after")).not.toContain("animation");
		expect(css).not.toContain("omp-composer-live-breathe");
	});

	it("keeps a card's light cheap: no mask, no clip, no opacity group on the edge", () => {
		for (const rule of [block(".omp-live-edge {"), block(".omp-live-edge[data-live-edge-inside] {")]) {
			expect(rule).not.toMatch(/mask|overflow: hidden|clip|opacity/);
		}
	});

	it("draws a still edge under reduced motion and software compositing", () => {
		const reduced = block("@media (prefers-reduced-motion: reduce) {\n\t.omp-live-edge");
		expect(reduced).toMatch(
			/\.omp-live-edge\[data-live-edge-inside\]\[data-live-edge="turn"\] \{\s*border-color: color-mix/,
		);
		expect(css).toMatch(
			/html\[data-gpu="software"\] \.omp-live-edge\[data-live-edge-inside\]\[data-live-edge="turn"\] \{\s*border-color: color-mix/,
		);
	});
});
