import { describe, expect, it, vi } from "vitest";
import type { RpcGetQueueResult } from "../../shared/rpc-types";
import { GuiBridgeClient } from "../bridge-client";
import { handlers, projectQueueUpdate, QueueIds } from "./queue";
import type { LocalCommandContext } from "./types";

const ids = (lane: { id: string }[]) => lane.map(chip => chip.id);

describe("QueueIds.reconcile", () => {
	it("keeps ids across snapshots and drops only the removed chip", () => {
		const queue = new QueueIds();
		const first = queue.reconcile({ steering: ["a", "b", "c"], followUp: [] });
		const [a, , c] = ids(first.steering);
		expect(new Set(ids(first.steering)).size).toBe(3);
		const second = queue.reconcile({ steering: ["a", "c", "d"], followUp: [] });
		expect(ids(second.steering).slice(0, 2)).toEqual([a, c]);
		expect(ids(second.steering)[2]).not.toBe(ids(first.steering)[1]);
	});

	it("gives duplicate texts distinct ids and keeps the survivor's id in order", () => {
		const queue = new QueueIds();
		const first = queue.reconcile({ steering: [], followUp: ["x", "x", "y"] });
		const [x1, x2, y] = ids(first.followUp);
		expect(x1).not.toBe(x2);
		// stock removes the first matching text
		const second = queue.reconcile({ steering: [], followUp: ["x", "y"] });
		expect(ids(second.followUp)).toEqual([x1, y]);
	});

	it("carries a chip's id when it moves lanes (promotion)", () => {
		const queue = new QueueIds();
		const first = queue.reconcile({ steering: ["s"], followUp: ["f", "g"] });
		const f = ids(first.followUp)[0];
		const second = queue.reconcile({ steering: ["s", "f"], followUp: ["g"] });
		expect(ids(second.steering)[1]).toBe(f);
		expect(ids(second.followUp)).toEqual([ids(first.followUp)[1]]);
	});

	it("lets an edited chip keep its id when the new text lands at the lane end", () => {
		const queue = new QueueIds();
		const first = queue.reconcile({ steering: ["old", "keep"], followUp: [] }, 1);
		const chip = queue.find(ids(first.steering)[0]);
		if (!chip) throw new Error("chip not found");
		queue.reconcile({ steering: ["keep"], followUp: [] }, 2);
		queue.expect("steering", "new", chip.chip, 2);
		const edited = queue.reconcile({ steering: ["keep", "new"], followUp: [] }, 3);
		expect(edited.steering[1]).toMatchObject({ id: chip.chip.id, text: "new", timestamp: 1 });
	});

	it("forgets an expectation that never materialised", () => {
		const queue = new QueueIds();
		const first = queue.reconcile({ steering: ["old"], followUp: [] }, 0);
		const chip = queue.find(ids(first.steering)[0]);
		if (!chip) throw new Error("chip not found");
		queue.expect("steering", "late", chip.chip, 0);
		const later = queue.reconcile({ steering: ["late"], followUp: [] }, 60_000);
		expect(ids(later.steering)[0]).not.toBe(chip.chip.id);
	});

	it("marks image-only chips as not editable", () => {
		const view = new QueueIds().reconcile({ steering: ["[Image]", "text"], followUp: [] });
		expect(view.steering.map(chip => chip.editable)).toEqual([false, true]);
	});
});

describe("projectQueueUpdate", () => {
	it("rewrites string lanes once and passes an already projected frame through", () => {
		const bridge = new GuiBridgeClient("");
		const projected = projectQueueUpdate(bridge, { type: "queue_update", steering: ["a"], followUp: [] });
		expect(projected.steering).toEqual([expect.objectContaining({ text: "a", editable: true })]);
		expect(projectQueueUpdate(bridge, projected)).toBe(projected);
	});
});

/** A tab's stock queue: `get_state` reads it, and stock's own remove/promote/follow_up commands change it. */
function stockQueue(steering: string[], followUp: string[]) {
	const lanes = { steering: [...steering], followUp: [...followUp] };
	const sent: { type: string; [key: string]: unknown }[] = [];
	const ctx: LocalCommandContext = {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.11.0", run: vi.fn() },
		send: vi.fn(async (command: { type: string; [key: string]: unknown }) => {
			sent.push(command);
			const text = String(command.message);
			if (command.type === "get_state") return { queuedMessages: lanes };
			if (command.type === "remove_queued_message") {
				const lane = lanes[command.queue as "steering" | "followUp"];
				const at = lane.indexOf(text);
				if (at >= 0) lane.splice(at, 1);
				return { removed: at >= 0 };
			}
			if (command.type === "promote_queued_message") {
				const at = lanes.followUp.indexOf(text);
				if (at >= 0) lanes.steering.push(...lanes.followUp.splice(at, 1));
				return { promoted: at >= 0 };
			}
			if (command.type === "follow_up") lanes.followUp.push(text);
			return {};
		}) as LocalCommandContext["send"],
		bridge: new GuiBridgeClient(""),
	};
	const run = (type: string, params: Record<string, unknown> = {}) => {
		const handler = handlers[type];
		if (!handler) throw new Error(`no handler for ${type}`);
		return handler({ type, ...params }, ctx);
	};
	return { lanes, sent, run };
}

describe("queue commands", () => {
	it("removes one queued message by its id and leaves the rest", async () => {
		const q = stockQueue(["steer a"], ["later b", "later c"]);
		const view = (await q.run("get_queue")) as RpcGetQueueResult;
		const b = view.followUp.find(chip => chip.text === "later b");
		await expect(q.run("queue_remove", { queueId: b?.id })).resolves.toEqual({ removed: true });
		expect(q.lanes).toEqual({ steering: ["steer a"], followUp: ["later c"] });
		await expect(q.run("queue_remove", { queueId: "nope" })).rejects.toThrow("Unknown queued message id");
	});

	it("sends a follow-up now through stock's promotion, keeping its id, to the end of the steering lane", async () => {
		const q = stockQueue(["steer a"], ["later b", "later c"]);
		const view = (await q.run("get_queue")) as RpcGetQueueResult;
		const c = view.followUp.find(chip => chip.text === "later c");
		await expect(
			q.run("queue_move", { queueId: c?.id, toLane: "steering", toIndex: Number.MAX_SAFE_INTEGER }),
		).resolves.toEqual({ lane: "steering", index: 1 });
		expect(q.sent.filter(command => command.type === "promote_queued_message")).toEqual([
			{ type: "promote_queued_message", message: "later c" },
		]);
		expect(q.lanes).toEqual({ steering: ["steer a", "later c"], followUp: ["later b"] });
		const after = (await q.run("get_queue")) as RpcGetQueueResult;
		expect(after.steering.at(-1)).toMatchObject({ id: c?.id, text: "later c" });
	});

	it("sends a steer later by re-queueing its text as a follow-up; a same-lane reorder is refused", async () => {
		const q = stockQueue(["steer a", "steer b"], []);
		const view = (await q.run("get_queue")) as RpcGetQueueResult;
		const [a, b] = view.steering;
		await expect(q.run("queue_move", { queueId: a?.id, toLane: "followUp", toIndex: 0 })).resolves.toEqual({
			lane: "followUp",
			index: 0,
		});
		expect(q.lanes).toEqual({ steering: ["steer b"], followUp: ["steer a"] });
		// Stock's queue_update reports the new lanes (here: the next read).
		await q.run("get_queue");
		await expect(q.run("queue_move", { queueId: b?.id, toLane: "steering", toIndex: 0 })).resolves.toEqual({
			lane: "steering",
			index: 0,
		});
		q.lanes.steering.push("steer c");
		await q.run("get_queue");
		await expect(q.run("queue_move", { queueId: b?.id, toLane: "steering", toIndex: 1 })).rejects.toThrow(
			"cannot reorder",
		);
	});
});
