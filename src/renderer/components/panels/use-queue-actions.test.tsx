/**
 * The queue's mutations (the composer's queue popover and its edit-in-field run them): edit (omp re-queues the text
 * at the end of its lane), remove, the lane switch (a follow-up is sent now as a steer, a steer can wait for the turn
 * to end) and clearing a lane, all applied optimistically and rolled back when the transport rejects.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { type QueueActions, useQueueActions } from "./use-queue-actions";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let root: Root;
let actions: QueueActions;
let queueMove: Mock;
let queueEdit: Mock;
let queueRemove: Mock;
let queueClear: Mock;

function Probe() {
	actions = useQueueActions();
	return null;
}

function queued(id: string, text: string): RpcQueuedMessage {
	return { id, text, editable: true, timestamp: 1 };
}

async function mount(steering: RpcQueuedMessage[], followUp: RpcQueuedMessage[] = []): Promise<void> {
	queueMove = vi.fn(async () => ok({ lane: "steering", index: 0 }));
	queueEdit = vi.fn(async () => ok({ updated: true }));
	queueRemove = vi.fn(async () => ok({ removed: true }));
	queueClear = vi.fn(async () => ok({ removed: 0 }));
	(window as unknown as Record<string, unknown>).omp = {
		rpc: { getQueue: vi.fn(async () => ok({ steering, followUp })), queueEdit, queueMove, queueRemove, queueClear },
	};
	useSessionStore.setState({ status: "ready" });
	useQueueStore.getState().setFromFrame({ steering, followUp });
	root = createRoot(document.createElement("div") as unknown as Element);
	await act(async () =>
		root.render(
			<I18nProvider>
				<Probe />
			</I18nProvider>,
		),
	);
}

async function flush(): Promise<void> {
	for (let index = 0; index < 3; index++)
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
}

const lanes = () => ({
	steering: useQueueStore.getState().steering.map(entry => entry.id),
	followUp: useQueueStore.getState().followUp.map(entry => entry.id),
});

afterEach(async () => {
	await act(async () => root.unmount());
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("useQueueActions", () => {
	it("edits a queued message, moving it to the end of its lane", async () => {
		await mount([queued("s1", "before"), queued("s2", "untouched")]);
		await act(async () => actions.edit("steering", "s1", "after"));
		await flush();
		expect(queueEdit).toHaveBeenCalledWith("s1", "after");
		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["untouched", "after"]);
	});

	it("rolls back an optimistic edit when the transport rejects", async () => {
		await mount([queued("s1", "before")]);
		queueEdit.mockRejectedValueOnce(new Error("sidecar unavailable"));
		await act(async () => actions.edit("steering", "s1", "after"));
		await flush();
		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["before"]);
	});

	it("removes only the named item, by its stable queue id", async () => {
		await mount([queued("s1", "same text"), queued("s2", "same text")], [queued("f1", "later")]);
		await act(async () => actions.remove("steering", "s2"));
		await flush();
		expect(queueRemove).toHaveBeenCalledTimes(1);
		expect(queueRemove).toHaveBeenCalledWith("s2");
		expect(lanes()).toEqual({ steering: ["s1"], followUp: ["f1"] });
	});

	it("promotes a follow-up through queue_move to the steering lane", async () => {
		await mount([queued("s1", "steer")], [queued("f1", "later one"), queued("f2", "later two")]);
		await act(async () => actions.moveToLane("followUp", "f2"));
		await flush();
		expect(queueMove).toHaveBeenCalledWith("f2", Number.MAX_SAFE_INTEGER, "steering");
		expect(lanes()).toEqual({ steering: ["s1", "f2"], followUp: ["f1"] });
	});

	it("moves a steer to the end of the follow-up lane", async () => {
		await mount([queued("s1", "one"), queued("s2", "two")], [queued("f1", "queued one")]);
		await act(async () => actions.moveToLane("steering", "s1"));
		await flush();
		expect(queueMove).toHaveBeenCalledWith("s1", Number.MAX_SAFE_INTEGER, "followUp");
		expect(lanes()).toEqual({ steering: ["s2"], followUp: ["f1", "s1"] });
	});

	it("rolls back an optimistic cross-lane move when the transport rejects", async () => {
		await mount([queued("s1", "one"), queued("s2", "two")]);
		queueMove.mockRejectedValueOnce(new Error("sidecar unavailable"));
		await act(async () => actions.moveToLane("steering", "s1"));
		await flush();
		expect(lanes()).toEqual({ steering: ["s1", "s2"], followUp: [] });
	});
});
