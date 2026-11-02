import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMotionPlay, resetMotionTokens } from "../../lib/motion";
import { Collapse } from "./Collapse";

const { document, window } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

interface FakeAnimation {
	keyframes: Keyframe[];
	onfinish: (() => void) | null;
	cancel: () => void;
}

const animations: FakeAnimation[] = [];
let reduced = false;
let root: Root | null = null;
let host: HTMLElement;

beforeEach(async () => {
	await loadMotionPlay();
	resetMotionTokens();
	reduced = false;
	Object.assign(window, { innerHeight: 800, matchMedia: () => ({ matches: reduced }) });
	const proto = (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype;
	proto.animate = (keyframes: Keyframe[]) => {
		const animation: FakeAnimation = { keyframes, onfinish: null, cancel: () => undefined };
		animations.push(animation);
		return animation;
	};
	Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 120 });
	host = document.createElement("div") as unknown as HTMLElement;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	animations.length = 0;
	vi.unstubAllGlobals();
});

const render = (open: boolean) => act(async () => root?.render(<Collapse open={open}>body</Collapse>));
const body = () => host.querySelector("[data-collapse]");

describe("Collapse", () => {
	it("shows a body open on its first render at once", async () => {
		await render(true);
		expect(body()?.textContent).toBe("body");
		expect(animations).toEqual([]);
	});

	it("grows a body in when it opens and keeps it, inert, until it has shrunk away", async () => {
		await render(false);
		expect(body()).toBeNull();
		await render(true);
		const opening = animations.at(-1);
		expect(opening?.keyframes.map(frame => frame.height)).toEqual(["0px", "120px"]);
		await act(async () => opening?.onfinish?.());
		await render(false);
		expect(body()?.hasAttribute("inert")).toBe(true);
		const closing = animations.at(-1);
		expect(closing?.keyframes.map(frame => frame.height)).toEqual(["120px", "0px"]);
		await act(async () => closing?.onfinish?.());
		expect(body()).toBeNull();
	});

	it("opens and closes at once where motion is off", async () => {
		reduced = true;
		await render(false);
		await render(true);
		expect(body()?.textContent).toBe("body");
		await render(false);
		expect(body()).toBeNull();
		expect(animations).toEqual([]);
	});
});
