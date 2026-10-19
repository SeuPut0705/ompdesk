import { describe, expect, it } from "vitest";
import type { RpcAsyncJobItem, RpcJobRow } from "../../../shared/rpc-types";
import { splitJobRows } from "./jobs-tree";

const job = (
	id: string,
	depth: number,
	status: RpcAsyncJobItem["status"],
	extra: Partial<RpcAsyncJobItem> = {},
): RpcJobRow => ({
	kind: "job",
	depth,
	cancellable: depth === 0,
	job: { id, type: "bash", status, label: id, startTime: 0, ...extra },
});
const ids = (rows: RpcJobRow[]) => rows.map(row => (row.kind === "job" ? row.job.id : `agent:${row.agentId}`));

describe("splitJobRows", () => {
	it("keeps a subagent's subtree together under whichever heading its newest state earns", () => {
		const rows: RpcJobRow[] = [
			job("scout", 0, "completed", { type: "task" }),
			job("scout-shell", 1, "running"),
			job("scout-old", 1, "completed"),
			job("done", 0, "completed"),
			{ kind: "agent", agentId: "Gone", depth: 0 },
			job("gone-shell", 1, "failed"),
			job("watch", 0, "running"),
		];
		const { running, recent } = splitJobRows(rows);
		expect(ids(running)).toEqual(["scout", "scout-shell", "scout-old", "watch"]);
		expect(ids(recent)).toEqual(["done", "agent:Gone", "gone-shell"]);
	});

	it("counts a job asked to stop as still working", () => {
		const { running, recent } = splitJobRows([job("stopping", 0, "completed", { cancellationPending: true })]);
		expect(ids(running)).toEqual(["stopping"]);
		expect(recent).toEqual([]);
	});

	it("is empty for no rows", () => {
		expect(splitJobRows([])).toEqual({ running: [], recent: [] });
	});
});
