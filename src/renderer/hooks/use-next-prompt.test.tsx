import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextPromptState, NextPromptUpdate } from "../../../resources/gui-bridge/next-prompt-contracts";
import { useNextPromptStore } from "../stores/next-prompt";
import { useSessionStore } from "../stores/session";
import { type NextPromptView, useNextPrompt } from "./use-next-prompt";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let reply: unknown = { success: true, data: { requestId: "r1", text: " world" } };
const command = vi.fn(async (_command: unknown) => reply);
// No tab runtime is mounted: useTabRpc falls back to the window-level client, as InputArea does outside a pane.
Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc: { command } } });

let root: Root | undefined;
let view: NextPromptView;

function Probe() {
	view = useNextPrompt();
	return null;
}

const config = (patch: Partial<NextPromptState> = {}): NextPromptState => ({
	suggestions: true,
	inline: true,
	legacyExtension: false,
	requests: { suggest: 0, inline: 0 },
	...patch,
});
const ready = (candidates: string[]): NextPromptUpdate => ({
	type: "next_prompt_update",
	status: "ready",
	candidates,
});
const sent = () => command.mock.calls.map(call => call[0]);

async function mount(): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => root?.render(<Probe />));
}

beforeEach(() => {
	command.mockClear();
	reply = { success: true, data: { requestId: "r1", text: " world" } };
	useSessionStore.setState({ sessionFile: "/a.jsonl", sessionId: "s-1", status: "ready", isStreaming: false });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	useNextPromptStore.getState().reset();
	useSessionStore.setState({ nextPrompt: null, nextPromptUnavailable: null, sessionFile: null, sessionId: "" });
});

describe("useNextPrompt", () => {
	it("is not builtin while the bridge reports nothing or suggestions off", async () => {
		await mount();
		expect(view.builtin).toBe(false);
		expect(view.inline).toBe(false);
		await act(async () => useSessionStore.setState({ nextPrompt: config({ suggestions: false }) }));
		expect(view.builtin).toBe(false);
		expect(view.unavailable).toBeUndefined();
	});

	it("splits the session's candidates into the best and the chips", async () => {
		await mount();
		await act(async () => {
			useSessionStore.setState({ nextPrompt: config() });
			useNextPromptStore.getState().recordUpdate("/a.jsonl", ready(["one", "two", "three"]));
		});
		expect(view.builtin).toBe(true);
		expect(view.inline).toBe(true);
		expect(view.best).toBe("one");
		expect(view.chips).toEqual(["two", "three"]);
	});

	it("keeps another session's candidates out and hides them while streaming", async () => {
		await mount();
		await act(async () => {
			useSessionStore.setState({ nextPrompt: config() });
			useNextPromptStore.getState().recordUpdate("/b.jsonl", ready(["other"]));
			useNextPromptStore.getState().recordUpdate("/a.jsonl", ready(["mine"]));
		});
		expect(view.best).toBe("mine");
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		expect(view.best).toBeUndefined();
		expect(view.chips).toEqual([]);
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		expect(view.best).toBe("mine");
	});

	it("reports the last failure only while the built-in is on, and inline only under suggestions", async () => {
		await mount();
		await act(async () => useSessionStore.setState({ nextPromptUnavailable: { reason: "offline", detail: "x" } }));
		expect(view.unavailable).toBeUndefined();
		await act(async () => useSessionStore.setState({ nextPrompt: config({ inline: false }) }));
		expect(view.unavailable).toEqual({ reason: "offline", detail: "x" });
		expect(view.inline).toBe(false);
	});

	it("leaves the memory alone when a suggestion is accepted", async () => {
		await mount();
		await act(async () => {
			useSessionStore.setState({ nextPrompt: config() });
			useNextPromptStore.getState().recordUpdate("/a.jsonl", ready(["keep"]));
		});
		view.accepted();
		expect(useNextPromptStore.getState().suggestions["/a.jsonl"]?.candidates).toEqual(["keep"]);
		expect(sent()).toEqual([]);
	});

	it("asks the bridge to refresh after a bash command", async () => {
		await mount();
		view.refreshAfterBash();
		expect(sent()).toEqual([{ type: "refresh_next_prompt", reason: "bash" }]);
	});

	it("returns the inline continuation, or null when nothing fits or the call fails", async () => {
		await mount();
		const live = new AbortController();
		await expect(view.completeInline("hello", "r1", live.signal)).resolves.toBe(" world");
		expect(sent()).toEqual([{ type: "complete_inline", draft: "hello", requestId: "r1" }]);
		reply = { success: true, data: { requestId: "r2", text: null } };
		await expect(view.completeInline("hello", "r2", live.signal)).resolves.toBeNull();
		reply = { success: false, error: "unsupported_omp" };
		await expect(view.completeInline("hello", "r3", live.signal)).resolves.toBeNull();
	});

	it("cancels the bridge's inline request when the signal aborts, and drops the late answer", async () => {
		await mount();
		const controller = new AbortController();
		const pending = view.completeInline("hello", "r1", controller.signal);
		controller.abort();
		await expect(pending).resolves.toBeNull();
		expect(sent()).toEqual([
			{ type: "complete_inline", draft: "hello", requestId: "r1" },
			{ type: "cancel_next_prompt", scope: "inline" },
		]);
	});

	it("sends nothing for an already aborted signal and cancels inline on demand", async () => {
		await mount();
		const controller = new AbortController();
		controller.abort();
		await expect(view.completeInline("hello", "r1", controller.signal)).resolves.toBeNull();
		expect(sent()).toEqual([]);
		view.cancelInline();
		expect(sent()).toEqual([{ type: "cancel_next_prompt", scope: "inline" }]);
	});

	it("keeps one view object until something it shows changes", async () => {
		await mount();
		const first = view;
		await act(async () => root?.render(<Probe />));
		expect(view).toBe(first);
	});
});
