import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { useFrameSelector } from "./use-frame-selector";

it("ignores unrelated primitives, batches updates into a frame and cancels on unmount", async () => {
	const { document, window, HTMLElement, Node } = parseHTML("<!doctype html><html><body></body></html>");
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	Object.assign(window, {
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			const id = ++frameId;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
	});
	Object.assign(globalThis as Record<string, unknown>, {
		document,
		window,
		HTMLElement,
		Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const store = createStore(() => ({ output: "one", unrelated: 0 }));
	let renders = 0;
	function Preview() {
		const output = useFrameSelector(store, state => state.output);
		renders++;
		return <pre>{output}</pre>;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<Preview />);
	});
	const initial = renders;
	await act(async () => {
		store.setState({ unrelated: 1 });
	});
	expect(frames.size).toBe(0);
	expect(renders).toBe(initial);
	await act(async () => {
		store.setState({ output: "one\ntwo" });
		store.setState({ output: "one\ntwo\nthree" });
	});
	expect(frames.size).toBe(1);
	const pending = [...frames.values()];
	frames.clear();
	await act(async () => {
		for (const callback of pending) callback(0);
	});
	expect(container.textContent).toBe("one\ntwo\nthree");
	expect(renders).toBe(initial + 1);
	await act(async () => {
		store.setState({ output: "final" });
	});
	expect(frames.size).toBe(1);
	await act(async () => {
		root.unmount();
	});
	expect(frames.size).toBe(0);
	container.remove();
});
