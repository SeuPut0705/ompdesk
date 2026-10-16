import { parseHTML } from "linkedom";
import { act, type RefObject, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InlineCompletion, useInlineCompletion } from "./use-inline-completion";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface Probe {
	inline: InlineCompletion;
	setText(value: string): void;
}

let root: Root;
let container: { remove(): void };

function Harness({ probe, complete }: { probe: RefObject<Probe | null>; complete: (draft: string) => string | null }) {
	const [text, setText] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);
	const inline = useInlineCompletion({
		enabled: true,
		text,
		menuOpen: false,
		textareaRef: ref,
		complete: async draft => complete(draft),
	});
	probe.current = { inline, setText };
	return <textarea ref={ref} value={text} onChange={() => {}} />;
}

async function mount(complete: (draft: string) => string | null): Promise<RefObject<Probe | null>> {
	const probe: RefObject<Probe | null> = { current: null };
	container = document.createElement("div") as unknown as { remove(): void };
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<Harness complete={complete} probe={probe} />));
	await act(async () => probe.current?.inline.onFocus());
	return probe;
}

afterEach(async () => {
	vi.useRealTimers();
	await act(async () => root.unmount());
	container.remove();
});

describe("useInlineCompletion request rate", () => {
	it("starts at most one request per typing pause over a minute of typing", async () => {
		vi.useFakeTimers();
		const asked: string[] = [];
		const probe = await mount(draft => {
			asked.push(draft);
			return " and more";
		});

		// Arithmetic: a 10 s cycle = a burst of 6 keystrokes 200 ms apart (1.2 s) + an 8.8 s pause.
		// 60 s of fake time = 6 cycles = 6 pauses, and each pause is longer than the 600 ms quiet
		// time and the 2 s floor between starts, so at most 6 requests may start in the minute.
		// Asking on every keystroke would be 36.
		const KEYSTROKE_MS = 200;
		const BURST_KEYS = 6;
		const CYCLE_MS = 10_000;
		const WINDOW_MS = 60_000;
		const pauses = WINDOW_MS / CYCLE_MS;
		let typed = "write a thorough";
		for (let cycle = 0; cycle < pauses; cycle++) {
			for (let key = 0; key < BURST_KEYS; key++) {
				typed += String.fromCharCode(97 + ((cycle * BURST_KEYS + key) % 26));
				await act(async () => probe.current?.setText(typed));
				await act(async () => {
					await vi.advanceTimersByTimeAsync(KEYSTROKE_MS);
				});
			}
			await act(async () => {
				await vi.advanceTimersByTimeAsync(CYCLE_MS - BURST_KEYS * KEYSTROKE_MS);
			});
		}

		const started = probe.current?.inline.started() ?? -1;
		expect(started).toBeGreaterThan(0);
		expect(started).toBeLessThanOrEqual(pauses);
		expect(asked).toHaveLength(started);
		// Only drafts the user paused on were asked, never one from the middle of a burst.
		for (const draft of asked) expect(draft.length % BURST_KEYS).toBe("write a thorough".length % BURST_KEYS);
	});

	it("a held key (no pause) starts nothing", async () => {
		vi.useFakeTimers();
		const probe = await mount(() => " more");
		let typed = "write a thorough";
		for (let key = 0; key < 100; key++) {
			typed += "x";
			await act(async () => probe.current?.setText(typed));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});
		}
		expect(probe.current?.inline.started()).toBe(0);
	});
});
