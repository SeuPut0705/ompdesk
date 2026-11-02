import { parseHTML } from "linkedom";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMotionPlay, resetMotionTokens } from "../lib/motion";
import { useListMotion } from "./use-list-motion";

const { document, window } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	MutationObserver: (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver,
	IS_REACT_ACT_ENVIRONMENT: true,
});

/** Each row's glides, in order, as the transform it starts from. */
const glides = new Map<string, string[]>();
let root: Root | null = null;
let host: HTMLElement;

beforeEach(async () => {
	await loadMotionPlay();
	resetMotionTokens();
	Object.assign(window, { innerHeight: 800, matchMedia: () => ({ matches: false }) });
	const proto = (window as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
	// A row lays out where `data-top` says; `data-drawn` is where a glide passing through draws it meanwhile.
	Object.defineProperties(proto, {
		offsetTop: {
			configurable: true,
			get(this: HTMLElement) {
				return Number(this.dataset.top ?? 0);
			},
		},
		offsetParent: { configurable: true, get: () => null },
		clientHeight: { configurable: true, get: () => 600 },
		getBoundingClientRect: {
			configurable: true,
			value(this: HTMLElement) {
				return { top: Number(this.dataset.drawn ?? this.dataset.top ?? 0) };
			},
		},
		animate: {
			configurable: true,
			value(this: HTMLElement, keyframes: Keyframe[]) {
				const key = this.dataset.flipKey ?? "";
				const from = String(keyframes[0]?.transform ?? "");
				if (from.startsWith("translateY") && keyframes[0]?.opacity === undefined)
					glides.set(key, [...(glides.get(key) ?? []), from]);
				return {} as Animation;
			},
		},
	});
	host = document.createElement("div") as unknown as HTMLElement;
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	glides.clear();
});

type Row = { key: string; top: number; focused?: boolean };

function List({ rows }: { rows: Row[] }) {
	const ref = useRef<HTMLUListElement>(null);
	useListMotion(ref);
	return (
		<ul ref={ref}>
			{rows.map(row => (
				<li
					className={row.focused ? "focused" : undefined}
					data-flip-key={row.key}
					data-top={row.top}
					key={row.key}
				/>
			))}
		</ul>
	);
}

const render = (rows: Row[]) => act(async () => root?.render(<List rows={rows} />));
const row = (key: string) => host.querySelector<HTMLElement>(`[data-flip-key="${key}"]`) as HTMLElement;
/** The task the list reads its rows on after a change that moved none of them. */
const nextTask = () =>
	act(() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		return promise;
	});

describe("useListMotion", () => {
	it("glides a row from where it rests even when it was read again in the middle of a glide", async () => {
		await render([
			{ key: "a", top: 0 },
			{ key: "b", top: 40 },
		]);
		// A row arrives on top: a and b glide down 40 px.
		await render([
			{ key: "c", top: 0 },
			{ key: "a", top: 40 },
			{ key: "b", top: 80 },
		]);
		expect(glides.get("a")).toEqual(["translateY(-40px)"]);
		// Mid-glide, a is still drawn where it was, and a focus changes its class: the list reads its rows again.
		row("a").dataset.drawn = "0";
		row("b").dataset.drawn = "40";
		await render([
			{ key: "c", top: 0 },
			{ key: "a", top: 40, focused: true },
			{ key: "b", top: 80 },
		]);
		await nextTask();
		// The glide ends; another row arrives on top and moves a by one row again, from where it rests.
		delete row("a").dataset.drawn;
		delete row("b").dataset.drawn;
		await render([
			{ key: "d", top: 0 },
			{ key: "c", top: 40 },
			{ key: "a", top: 80, focused: true },
			{ key: "b", top: 120 },
		]);
		expect(glides.get("a")).toEqual(["translateY(-40px)", "translateY(-40px)"]);
		expect(glides.get("b")).toEqual(["translateY(-40px)", "translateY(-40px)"]);
	});
});
