import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motionAllowed, motionEase, motionMs, resetMotionTokens } from "./motion";
import { animateHeight, playListMotion } from "./motion-play";

type Animate = (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;

function setup(options: { reduced?: boolean; gpu?: string; hidden?: boolean; tokens?: Record<string, string> } = {}) {
	const { document, window } = parseHTML("<html><body></body></html>");
	if (options.gpu) document.documentElement.dataset.gpu = options.gpu;
	Object.defineProperty(document, "hidden", { value: options.hidden ?? false, configurable: true });
	vi.stubGlobal("document", document);
	vi.stubGlobal(
		"window",
		Object.assign(window, { innerHeight: 800, matchMedia: () => ({ matches: !!options.reduced }) }),
	);
	vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => options.tokens?.[name] ?? "" }));
	return document;
}

beforeEach(() => resetMotionTokens());
afterEach(() => vi.unstubAllGlobals());

describe("motion tokens", () => {
	it("reads durations and curves from the stylesheet's tokens", () => {
		setup({
			tokens: {
				"--sc-duration-instant": "80ms",
				"--sc-duration-fast": "0.12s",
				"--sc-duration-med": "200ms",
				"--sc-duration-slow": "300ms",
				"--sc-ease-standard": "ease",
				"--sc-ease-enter": "cubic-bezier(0, 0, 0.2, 1)",
				"--sc-ease-exit": "ease-in",
				"--sc-ease-emphasized": "ease-out",
				"--sc-ease-spring": "linear(0, 1)",
			},
		});
		expect(motionMs("fast")).toBe(120);
		expect(motionMs("med")).toBe(200);
		expect(motionEase("enter")).toBe("cubic-bezier(0, 0, 0.2, 1)");
	});

	it("is instant under reduced motion, software compositing and in a hidden document", () => {
		for (const options of [{ reduced: true }, { gpu: "software" }, { hidden: true }]) {
			setup(options);
			expect(motionAllowed()).toBe(false);
			expect(motionMs("med")).toBe(0);
		}
		setup();
		expect(motionAllowed()).toBe(true);
		expect(motionMs("med")).toBeGreaterThan(0);
	});
});

describe("animateHeight", () => {
	it("opens a height on the enter curve and closes it shorter on the exit curve", () => {
		const document = setup();
		const element = document.createElement("div") as unknown as HTMLElement;
		const calls: [Keyframe[], KeyframeAnimationOptions][] = [];
		(element as unknown as { animate: Animate }).animate = (keyframes, options) => {
			calls.push([keyframes, options]);
			return {} as Animation;
		};
		expect(animateHeight(element, 0, 120)).not.toBeNull();
		expect(animateHeight(element, 120, 0)).not.toBeNull();
		const [open, close] = calls;
		expect(open?.[0].map(frame => frame.height)).toEqual(["0px", "120px"]);
		expect(close?.[0].map(frame => frame.height)).toEqual(["120px", "0px"]);
		expect(Number(close?.[1].duration)).toBeLessThan(Number(open?.[1].duration));
	});

	it("does not animate where motion is off or a height taller than the window", () => {
		for (const [options, height] of [
			[{ reduced: true }, 100],
			[{}, 2000],
		] as const) {
			const document = setup(options);
			const element = document.createElement("div") as unknown as HTMLElement;
			const animate = vi.fn();
			(element as unknown as { animate: typeof animate }).animate = animate;
			expect(animateHeight(element, 0, height)).toBeNull();
			expect(animate).not.toHaveBeenCalled();
		}
	});
});

describe("playListMotion", () => {
	function list(document: Document, rows: Record<string, number>) {
		const container = document.createElement("ul") as unknown as HTMLElement;
		const animations: { key: string; keyframes: Keyframe[] }[] = [];
		const box = (top: number) => () => ({ top }) as DOMRect;
		container.getBoundingClientRect = box(100);
		Object.defineProperty(container, "clientHeight", { value: 600 });
		(container as unknown as { animate: Animate }).animate = () => ({}) as Animation;
		for (const [key, top] of Object.entries(rows)) {
			const row = document.createElement("li") as unknown as HTMLElement;
			row.dataset.flipKey = key;
			row.getBoundingClientRect = box(100 + top);
			(row as unknown as { animate: Animate }).animate = keyframes => {
				animations.push({ key, keyframes });
				return {} as Animation;
			};
			container.appendChild(row);
		}
		return { container, animations };
	}

	it("glides a row that moved from where it was, and rises in a new one only when asked", () => {
		const document = setup();
		const before = new Map([
			["a", 0],
			["b", 40],
		]);
		const { container, animations } = list(document as unknown as Document, { b: 0, a: 40, c: 80 });
		const after = playListMotion(container, "[data-flip-key]", before, { enter: true });
		expect(after.get("a")).toBe(40);
		const moves = Object.fromEntries(animations.map(({ key, keyframes }) => [key, keyframes[0]]));
		expect(moves.a?.transform).toBe("translateY(-40px)");
		expect(moves.b?.transform).toBe("translateY(40px)");
		expect(moves.c?.opacity).toBe(0);
		animations.length = 0;
		playListMotion(container, "[data-flip-key]", before);
		expect(animations.map(({ key }) => key).sort()).toEqual(["a", "b"]);
	});

	it("moves nothing where motion is off", () => {
		const document = setup({ gpu: "software" });
		const { container, animations } = list(document as unknown as Document, { b: 0, a: 40 });
		playListMotion(
			container,
			"[data-flip-key]",
			new Map([
				["a", 0],
				["b", 40],
			]),
		);
		expect(animations).toEqual([]);
	});
});
