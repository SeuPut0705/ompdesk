/**
 * queue store: queue_update frames are the authoritative update channel
 * (setFromFrame) — they cover enqueue, drain/consume, remove, move, and
 * clear with zero RPC traffic. get_queue survives only as the hydrate
 * fallback (refresh), latest-response-wins and tolerant of failures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { useQueueStore } from "./queue";

const getQueue = vi.fn();
(globalThis as Record<string, unknown>).window = { omp: { rpc: { getQueue } } };

function queued(id: string, text: string) {
	return { id, text, editable: true, timestamp: 1 };
}

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "get_queue", success: true, data };
}

afterEach(() => {
	getQueue.mockReset();
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
});

describe("queue store", () => {
	it("applies queue_update snapshots with no RPC traffic, including drain-to-empty", () => {
		useQueueStore
			.getState()
			.setFromFrame({ steering: [queued("s1", "steer me")], followUp: [queued("f2", "later")] });
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["later"]);

		// The drain-consumption frame empties the store on its own — the gap
		// that previously froze the strip/panel/bubbles on consumed items.
		useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
		expect(useQueueStore.getState().steering).toEqual([]);
		expect(useQueueStore.getState().followUp).toEqual([]);
		expect(getQueue).not.toHaveBeenCalled();
	});

	it("keeps a slower old-session refresh from overwriting the latest queue", async () => {
		const oldSession = Promise.withResolvers<RpcResponse>();
		const newSession = Promise.withResolvers<RpcResponse>();
		getQueue.mockReturnValueOnce(oldSession.promise).mockReturnValueOnce(newSession.promise);

		const oldRefresh = useQueueStore.getState().refresh();
		const newRefresh = useQueueStore.getState().refresh();
		newSession.resolve(ok({ steering: [queued("new", "latest")], followUp: [] }));
		await newRefresh;
		oldSession.resolve(ok({ steering: [queued("old", "stale")], followUp: [] }));
		await oldRefresh;

		expect(getQueue).toHaveBeenCalledTimes(2);
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["new"]);
	});

	it("failed refresh keeps the last frame-driven snapshot", async () => {
		useQueueStore.getState().setFromFrame({ steering: [], followUp: [queued("f9", "keep")] });
		getQueue.mockResolvedValueOnce({
			type: "response",
			command: "get_queue",
			success: false,
			error: "unsupported",
		} satisfies RpcResponse);

		await useQueueStore.getState().refresh();
		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f9"]);

		getQueue.mockRejectedValueOnce(new Error("sidecar down"));
		await useQueueStore.getState().refresh();
		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f9"]);
	});
});
