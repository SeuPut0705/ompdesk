/**
 * queue store: queue_update frames are the authoritative update channel
 * (setFromFrame) — they cover enqueue, drain/consume, remove, move, and
 * clear with zero RPC traffic. get_queue survives only as the hydrate
 * fallback (refresh), latest-response-wins and tolerant of failures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { loadLocale, setLanguageOverride } from "../lib/i18n";
import { routeCommands } from "../test-support/route-commands";
import { useQueueStore } from "./queue";

const getQueue = vi.fn();
(globalThis as Record<string, unknown>).window = { omp: { rpc: routeCommands({ getQueue }) } };

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

describe("pictures sent into a run", () => {
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

	afterEach(() => setLanguageOverride(null));

	it("shows a steer's pictures on the chip that carries its text, by id, until the chip leaves", () => {
		const store = useQueueStore.getState();
		store.expectImages("look at this picture", [image]);
		store.setFromFrame({ steering: [queued("q1", "look at this picture")], followUp: [] });
		expect(useQueueStore.getState().steering[0].images).toEqual([image]);

		// A later snapshot with other chips around it keeps the pictures on the same id.
		useQueueStore
			.getState()
			.setFromFrame({ steering: [queued("q1", "look at this picture"), queued("q2", "other")], followUp: [] });
		expect(useQueueStore.getState().steering.map(entry => entry.images?.length ?? 0)).toEqual([1, 0]);

		useQueueStore.getState().setFromFrame({ steering: [queued("q2", "other")], followUp: [] });
		useQueueStore.getState().setFromFrame({ steering: [queued("q1", "look at this picture")], followUp: [] });
		expect(useQueueStore.getState().steering[0].images).toBeUndefined();
	});

	it("gives each of two identical messages its own pictures, in order, and none to a chip it never sent", () => {
		const store = useQueueStore.getState();
		store.expectImages("same", [image]);
		store.expectImages("same", [image, image]);
		store.setFromFrame({
			steering: [queued("a", "same"), queued("b", "same"), queued("c", "same")],
			followUp: [],
		});
		expect(useQueueStore.getState().steering.map(entry => entry.images?.length ?? 0)).toEqual([1, 2, 0]);
	});

	it("drops the pictures of a message an edit re-queued with new text, and of one forgotten on purpose", () => {
		const store = useQueueStore.getState();
		store.expectImages("first", [image]);
		store.expectImages("second", [image]);
		store.setFromFrame({ steering: [queued("a", "first"), queued("b", "second")], followUp: [] });
		store.setFromFrame({ steering: [queued("b", "second"), queued("a", "first, edited")], followUp: [] });
		expect(useQueueStore.getState().steering.map(entry => entry.images?.length ?? 0)).toEqual([1, 0]);
		useQueueStore.getState().forgetImages("b");
		expect(useQueueStore.getState().steering.map(entry => entry.images?.length ?? 0)).toEqual([0, 0]);
	});

	it("gives a picture-only chip the interface language's word instead of stock's English one", async () => {
		const store = useQueueStore.getState();
		store.expectImages("[Image]", [image, image]);
		const frame = {
			steering: [{ id: "i1", text: "[Image]", editable: false, timestamp: 1 }],
			followUp: [{ id: "i2", text: "[Image]", editable: false, timestamp: 1 }],
		};
		store.setFromFrame(frame);
		expect(useQueueStore.getState().steering[0].text).toBe("Image only · 2");
		expect(useQueueStore.getState().followUp[0].text).toBe("Image only");
		await loadLocale("ko");
		setLanguageOverride("ko");
		useQueueStore.getState().setFromFrame(frame);
		expect(useQueueStore.getState().steering[0].text).toBe("이미지만 · 2");
		expect(useQueueStore.getState().followUp[0].text).toBe("이미지만");
	});
});

describe("where an edited message landed", () => {
	afterEach(() => vi.useRealTimers());

	it("exposes its place in the lane for a few seconds", () => {
		vi.useFakeTimers();
		useQueueStore.getState().noteMoved({ id: "a", lane: "steering", position: 3, count: 3, kind: "edit" });
		expect(useQueueStore.getState().moved).toEqual({
			id: "a",
			lane: "steering",
			position: 3,
			count: 3,
			kind: "edit",
		});
		vi.advanceTimersByTime(4_001);
		expect(useQueueStore.getState().moved).toBeNull();
	});
});
