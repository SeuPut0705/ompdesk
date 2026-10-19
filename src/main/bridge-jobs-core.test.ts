import { describe, expect, it } from "vitest";
import {
	type BuildJobTree,
	cancellable,
	jobRows,
	type StockJobItem,
	type StockJobTree,
} from "../../resources/gui-bridge/jobs-core";

const job = (id: string, extra: Partial<StockJobItem> = {}): StockJobItem => ({
	id,
	type: "bash",
	status: "running",
	label: id,
	startTime: 1,
	...extra,
});

describe("cancellable", () => {
	it("is stock's rule: jobs the root agent owns, or that name no owner", () => {
		expect(cancellable({ ownerId: undefined }, "Main")).toBe(true);
		expect(cancellable({ ownerId: "Main" }, "Main")).toBe(true);
		expect(cancellable({ ownerId: "Scout" }, "Main")).toBe(false);
		expect(cancellable({ ownerId: "Scout" }, undefined)).toBe(false);
	});
});

describe("jobRows", () => {
	const tree: StockJobTree = {
		rootId: "Main",
		running: [
			job("watch", { ownerId: "Main" }),
			job("scout-task", { type: "task", ownerId: "Main", agentId: "Scout" }),
			job("scout-shell", { ownerId: "Scout" }),
		],
		recent: [job("old", { status: "completed", endTime: 5 })],
		agents: [{ id: "Scout", parentId: "Main" }, { id: "Gone" }],
	};
	// Stock's layout is the real function's business (bridge-jobs-tree-stock.test.ts); this one only fixes an order.
	const layout: BuildJobTree = (jobs, _agents, rootId) => {
		expect(jobs.map(entry => entry.id)).toEqual(["watch", "scout-task", "scout-shell", "old"]);
		expect(rootId).toBe("Main");
		const byId = new Map(jobs.map(entry => [entry.id, entry]));
		return [
			{ kind: "job", depth: 0, job: byId.get("scout-task") as StockJobItem },
			{ kind: "job", depth: 1, job: byId.get("scout-shell") as StockJobItem },
			{ kind: "agent", depth: 1, agent: { id: "Gone" } },
			{ kind: "job", depth: 0, job: byId.get("watch") as StockJobItem },
			{ kind: "job", depth: 0, job: byId.get("old") as StockJobItem },
		];
	};
	const inspected: string[] = [];
	const rows = jobRows(tree, layout, id => {
		inspected.push(id);
		return id === "scout-shell" ? { output: "nested output", artifactId: "artifact-1" } : undefined;
	});

	it("keeps stock's order and depth, an agent header as an agent row", () => {
		expect(rows.map(row => [row.kind, row.depth, row.kind === "job" ? row.job.id : row.agentId])).toEqual([
			["job", 0, "scout-task"],
			["job", 1, "scout-shell"],
			["agent", 1, "Gone"],
			["job", 0, "watch"],
			["job", 0, "old"],
		]);
	});

	it("lets only the root agent's jobs be cancelled", () => {
		const flags = rows.flatMap(row => (row.kind === "job" ? [[row.job.id, row.cancellable]] : []));
		expect(flags).toEqual([
			["scout-task", true],
			["scout-shell", false],
			["watch", true],
			["old", true],
		]);
	});

	it("shows a nested job's output and marks a truncated one, asking stock for each listed job only", () => {
		const nested = rows.find(row => row.kind === "job" && row.job.id === "scout-shell");
		expect(nested).toMatchObject({ job: { resultPreview: "nested output", previewTruncated: true } });
		const plain = rows.find(row => row.kind === "job" && row.job.id === "watch");
		expect(plain).toMatchObject({ job: { resultPreview: undefined, previewTruncated: false } });
		expect(inspected.sort()).toEqual(["old", "scout-shell", "scout-task", "watch"]);
	});
});
