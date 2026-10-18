/**
 * ComposerRestoredQueue: what a Stop withdrew from the queue, held apart from the draft. Mounting it is what makes
 * Stop keep the messages here; Resume sends them in order, a chip's text puts one in the field, and nothing runs by itself.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useComposerStore } from "../../../stores/composer";
import { useSessionStore } from "../../../stores/session";
import { ComposerRestoredQueue } from "./ComposerRestoredQueue";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	textContent: string | null;
	querySelectorAll(selector: string): ArrayLike<unknown>;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

const ok = () => ({ type: "response" as const, command: "x", success: true as const });
const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };

let container: TestElement;
let root: Root;
let settled: Mock<() => void>;
let prompt: Mock;
let followUp: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

function button(label: string, within: ParentNode = document): TestElement {
	const found = Array.from(within.querySelectorAll("button")).find(
		node => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
	);
	if (!found) throw new Error(`missing button ${label}`);
	return found as unknown as TestElement;
}

async function mount(): Promise<void> {
	settled = vi.fn();
	prompt = vi.fn(async () => ok());
	followUp = vi.fn(async () => ok());
	(window as unknown as Record<string, unknown>).omp = { rpc: { prompt, followUp } };
	useSessionStore.setState({ status: "ready" });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComposerRestoredQueue onSettled={settled} />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("ComposerRestoredQueue", () => {
	it("registers while mounted, so Stop keeps the queue here, and unregisters with it", async () => {
		await mount();
		expect(useComposerStore.getState().restoredTrayMounted).toBe(1);
		await act(async () => root.unmount());
		expect(useComposerStore.getState().restoredTrayMounted).toBe(0);
		root = createRoot(container as unknown as Element);
	});

	it("renders nothing until a Stop held something, then names the pause and each message", async () => {
		await mount();
		expect(container.textContent).toBe("");
		await act(async () => {
			useComposerStore.getState().holdRestored([
				{ lane: "steering", text: "queued one", images: [] },
				{ lane: "followUp", text: "", images: [{ content: image, preview: "data:" }] },
			]);
		});
		const section = document.querySelector("section[data-restored-queue]") as unknown as TestElement;
		expect(section.textContent).toContain("Queue paused because you stopped");
		// One row: the sentence, the chips and Resume / Discard share it.
		expect(section.querySelectorAll("[data-restored-resume]")).toHaveLength(1);
		const rows = Array.from(document.querySelectorAll("[data-restored-item]")) as unknown as TestElement[];
		expect(rows.map(row => row.textContent)).toEqual([
			expect.stringContaining("queued one"),
			expect.stringContaining("Image only"),
		]);
	});

	it("resumes every held message in order and clears the tray, handing focus back", async () => {
		await mount();
		await act(async () => {
			useComposerStore.getState().holdRestored([
				{ lane: "steering", text: "one", images: [] },
				{ lane: "followUp", text: "two", images: [] },
			]);
		});
		await click(button("Resume"));
		await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
		expect(prompt).toHaveBeenCalledWith("one", undefined, "followUp");
		expect(followUp).toHaveBeenCalledWith("two", undefined);
		expect(useComposerStore.getState().restoredQueue).toEqual([]);
	});

	it("puts one message in the field on demand, apart from the others and ahead of the draft", async () => {
		await mount();
		await act(async () => {
			useComposerStore.getState().setDraft("my draft");
			useComposerStore.getState().holdRestored([
				{ lane: "steering", text: "one", images: [] },
				{ lane: "followUp", text: "two", images: [] },
			]);
		});
		await click(button("Put in the field: two"));
		expect(useComposerStore.getState().draft).toBe("two\n\nmy draft");
		expect(useComposerStore.getState().restoredQueue.map(item => item.text)).toEqual(["one"]);
		expect(prompt).not.toHaveBeenCalled();
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it("removes one message or discards them all, sending nothing", async () => {
		await mount();
		await act(async () => {
			useComposerStore.getState().holdRestored([
				{ lane: "steering", text: "one", images: [] },
				{ lane: "followUp", text: "two", images: [] },
			]);
		});
		await click(button("Remove restored message: one"));
		expect(useComposerStore.getState().restoredQueue.map(item => item.text)).toEqual(["two"]);
		await click(button("Discard all restored messages"));
		expect(useComposerStore.getState().restoredQueue).toEqual([]);
		expect(container.textContent).toBe("");
		expect(prompt).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});
});
