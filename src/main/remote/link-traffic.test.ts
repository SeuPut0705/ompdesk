import { describe, expect, it } from "vitest";
import { LinkTraffic } from "./link-traffic";

function tabEvent(name: string, arg: unknown) {
	return { t: "evt", event: "tab.event", data: { rtab: "t1", name, arg } };
}

describe("LinkTraffic", () => {
	it("sizes an answer under the method of its request, and a tab event under its name", () => {
		const traffic = new LinkTraffic();
		traffic.record("rx", { t: "req", id: 7, method: "sessions.list", params: {} }, 90);
		traffic.record("tx", { t: "res", id: 7, ok: true, result: [] }, 8_000);
		traffic.record("tx", tabEvent("status", { status: "ready" }), 300);
		traffic.record("tx", { t: "ping" }, 44);

		const window = traffic.take();
		expect(window.rows).toEqual([
			{ kind: "tx res sessions.list", frames: 1, bytes: 8_000 },
			{ kind: "tx evt tab.event status", frames: 1, bytes: 300 },
			{ kind: "rx req sessions.list", frames: 1, bytes: 90 },
			{ kind: "tx ping", frames: 1, bytes: 44 },
		]);
		expect([window.tx, window.rx]).toEqual([8_344, 90]);
	});

	it("names a tab command and its answer by the RPC command's type", () => {
		const traffic = new LinkTraffic();
		traffic.record(
			"rx",
			{ t: "req", id: 3, method: "tab.command", params: { rtab: "t1", command: { type: "get_jobs" } } },
			150,
		);
		traffic.record("tx", { t: "res", id: 3, ok: true, result: { type: "response" } }, 80_000);
		traffic.record("rx", { t: "req", id: 4, method: "tab.command", params: { rtab: "t1" } }, 60);
		traffic.record("tx", { t: "res", id: 4, ok: true, result: {} }, 40);
		expect(traffic.take().rows).toEqual([
			{ kind: "tx res tab.command/get_jobs", frames: 1, bytes: 80_000 },
			{ kind: "rx req tab.command/get_jobs", frames: 1, bytes: 150 },
			{ kind: "rx req tab.command", frames: 1, bytes: 60 },
			{ kind: "tx res tab.command", frames: 1, bytes: 40 },
		]);
	});

	it("names the frame type of a subagent frame and counts the omp events of a batch by type", () => {
		const traffic = new LinkTraffic();
		traffic.record("tx", tabEvent("subagentFrame", { type: "subagent_progress", payload: {} }), 3_000);
		traffic.record(
			"tx",
			tabEvent("events", [{ type: "message_update" }, { type: "message_update" }, { type: "message_end" }]),
			40_000,
		);

		const window = traffic.take();
		expect(window.rows.map(row => row.kind)).toEqual([
			"tx evt tab.event events",
			"tx evt tab.event subagentFrame/subagent_progress",
		]);
		expect(window.batched).toEqual({ message_update: 2, message_end: 1 });
	});

	it("weighs each event type of a batch by its own JSON, so one big message_end is told from many small updates", () => {
		const traffic = new LinkTraffic();
		const update = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } };
		const end = {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "가".repeat(1_000) }] },
		};
		traffic.record("tx", tabEvent("events", [update, update, update, end]), 4_000);

		const { batched, batchedBytes } = traffic.take();
		expect(batched).toEqual({ message_update: 3, message_end: 1 });
		expect(batchedBytes).toEqual({
			message_update: 3 * Buffer.byteLength(JSON.stringify(update)),
			message_end: Buffer.byteLength(JSON.stringify(end)),
		});
		// UTF-8 bytes, not characters: a Korean syllable is three.
		expect(batchedBytes.message_end).toBeGreaterThan(3_000);
	});

	it("names a tab event that batches subagent frames one kind and counts its frames by type", () => {
		const traffic = new LinkTraffic();
		const batch = [{ type: "subagent_progress" }, { type: "subagent_event" }, { type: "subagent_event" }];
		traffic.record("tx", tabEvent("subagentFrame", batch), 900);

		const window = traffic.take();
		expect(window.rows).toEqual([{ kind: "tx evt tab.event subagentFrame/batch", frames: 1, bytes: 900 }]);
		expect(window.batched).toEqual({ subagent_progress: 1, subagent_event: 2 });
	});

	it("starts an empty window after take, and keeps no more kinds than a peer can inflate", () => {
		const traffic = new LinkTraffic();
		for (let method = 0; method < 1_000; method++)
			traffic.record("rx", { t: "req", id: method, method: `m${method}` }, 10);
		expect(traffic.take().rows.length).toBeLessThanOrEqual(128);
		expect(traffic.take()).toEqual({ tx: 0, rx: 0, rows: [], batched: {}, batchedBytes: {} });
	});
});
