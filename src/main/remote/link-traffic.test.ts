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

	it("starts an empty window after take, and keeps no more kinds than a peer can inflate", () => {
		const traffic = new LinkTraffic();
		for (let method = 0; method < 1_000; method++)
			traffic.record("rx", { t: "req", id: method, method: `m${method}` }, 10);
		expect(traffic.take().rows.length).toBeLessThanOrEqual(128);
		expect(traffic.take()).toEqual({ tx: 0, rx: 0, rows: [], batched: {} });
	});
});
