/**
 * QueuePanel mutations: edit (omp re-queues the text at the end of its lane),
 * remove, and the lane switch (a follow-up is sent now as a steer, a steer
 * can wait for the turn to end), all applied optimistically and rolled back
 * when the transport rejects. omp cannot reorder within a lane, so there are
 * no same-lane move controls.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { QueuePanel } from "./QueuePanel";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	disabled?: boolean;
	value?: string;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let getQueue: Mock;
let queueMove: Mock;
let queueEdit: Mock;
let queueRemove: Mock;
let queueClear: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function click(element: TestElement): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		element.dispatchEvent(event);
	});
	await flush();
}

function buttonsByLabel(label: string): TestElement[] {
	return Array.from(document.querySelectorAll(`button[aria-label="${label}"]`)) as unknown as TestElement[];
}

function queued(id: string, text: string, editable = true): RpcQueuedMessage {
	return { id, text, editable, timestamp: 1 };
}

async function mount(steering: RpcQueuedMessage[], followUp: RpcQueuedMessage[] = []): Promise<void> {
	getQueue = vi.fn(async () => ok({ steering, followUp }));
	queueMove = vi.fn(async () => ok({ lane: "steering", index: 0 }));
	queueEdit = vi.fn(async () => ok({ updated: true }));
	queueRemove = vi.fn(async () => ok({ removed: true }));
	queueClear = vi.fn(async () => ok({ removed: 0 }));
	(window as unknown as Record<string, unknown>).omp = {
		rpc: {
			// The mount-time hydrate pull replaces the store, so it must serve
			// the same rows the test seeded.
			getQueue,
			queueEdit,
			queueMove,
			queueRemove,
			queueClear,
		},
	};
	useSessionStore.setState({ status: "ready" });
	useQueueStore.getState().setFromFrame({ steering, followUp });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<QueuePanel />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("QueuePanel editing", () => {
	it("edits a plain queued message, moving it to the end of its lane", async () => {
		await mount([queued("s1", "before"), queued("s2", "untouched")]);
		await click(buttonsByLabel("Edit")[0]!);
		const editor = document.querySelector('textarea[aria-label="Queued message text"]') as unknown as TestElement;
		editor.value = "after";
		await act(async () => {
			editor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
		});
		await click(buttonsByLabel("Save")[0]!);

		expect(queueEdit).toHaveBeenCalledWith("s1", "after");
		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["untouched", "after"]);
	});

	it("rolls back an optimistic edit when the transport rejects", async () => {
		await mount([queued("s1", "before")]);
		queueEdit.mockRejectedValueOnce(new Error("sidecar unavailable"));
		await click(buttonsByLabel("Edit")[0]!);
		const editor = document.querySelector('textarea[aria-label="Queued message text"]') as unknown as TestElement;
		editor.value = "after";
		await act(async () => {
			editor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
		});
		await click(buttonsByLabel("Save")[0]!);

		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["before"]);
	});

	it("does not offer text editing for structured queued commands", async () => {
		await mount([queued("s1", "/skill run", false)]);
		expect(buttonsByLabel("Edit")).toHaveLength(0);
	});
});
describe("QueuePanel remove", () => {
	it("removes only the clicked item, by its stable queue id", async () => {
		await mount([queued("s1", "same text"), queued("s2", "same text")], [queued("f1", "later")]);
		await click(buttonsByLabel("Remove")[1]!);

		expect(queueRemove).toHaveBeenCalledTimes(1);
		expect(queueRemove).toHaveBeenCalledWith("s2");
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f1"]);
	});
});

describe("QueuePanel lane switch", () => {
	it("offers Send now only on follow-ups and promotes through queue_move to steering", async () => {
		await mount([queued("s1", "steer")], [queued("f1", "later one"), queued("f2", "later two")]);
		const sendNow = buttonsByLabel(translate("composerQueue.sendNow"));
		expect(sendNow).toHaveLength(2);
		expect(buttonsByLabel(translate("composerQueue.sendLater"))).toHaveLength(1);

		await click(sendNow[1]!);

		expect(queueMove).toHaveBeenCalledWith("f2", Number.MAX_SAFE_INTEGER, "steering");
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1", "f2"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f1"]);
	});

	it("moves a steer to the end of the follow-up lane via queue_move with toLane", async () => {
		await mount([queued("s1", "one"), queued("s2", "two")], [queued("f1", "queued one")]);

		const sendLater = buttonsByLabel(translate("composerQueue.sendLater"));
		expect(sendLater).toHaveLength(2);
		expect(buttonsByLabel(translate("composerQueue.sendNow"))).toHaveLength(1);
		await click(sendLater[0]!);

		expect(queueMove).toHaveBeenCalledWith("s1", Number.MAX_SAFE_INTEGER, "followUp");
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s2"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f1", "s1"]);
	});

	it("rolls back an optimistic cross-lane move when the transport rejects", async () => {
		await mount([queued("s1", "one"), queued("s2", "two")]);
		queueMove.mockRejectedValueOnce(new Error("sidecar unavailable"));

		await click(buttonsByLabel(translate("composerQueue.sendLater"))[0]!);

		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1", "s2"]);
		expect(useQueueStore.getState().followUp).toEqual([]);
	});
});
