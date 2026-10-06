import { describe, expect, it } from "vitest";
import { GuiBridgeClient } from "../bridge-client";
import { projectQueueUpdate, QueueIds } from "./queue";

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
