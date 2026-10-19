/**
 * The GUI's background-jobs rows: stock's tree layout (`pi-tui/overlays/job-tree` `buildJobTree`, passed in) over the
 * running jobs then the recent ones, each job with the output stock's `inspectAsyncJob` has for it.
 */
import type { BridgeJobItem, BridgeJobRow } from "./jobs-contracts";

/** The fields of a stock `AsyncJobSnapshotItem` the rows use. */
export type StockJobItem = Omit<BridgeJobItem, "resultPreview" | "errorPreview" | "previewTruncated">;

/** `AgentSession.getAsyncJobTree()` as far as the rows read it. */
export interface StockJobTree {
	running: readonly StockJobItem[];
	recent: readonly StockJobItem[];
	rootId?: string;
	agents: readonly { id: string; parentId?: string }[];
}

/** One row of stock's `buildJobTree`. */
export type StockJobRow =
	| { kind: "job"; job: StockJobItem; depth: number }
	| { kind: "agent"; agent: { id: string }; depth: number };

export type BuildJobTree = (
	jobs: readonly StockJobItem[],
	agents: readonly { id: string; parentId?: string }[],
	rootId: string | undefined,
) => StockJobRow[];

/** What `AgentSession.inspectAsyncJob` returns that a row shows. */
export interface JobInspection {
	output?: string;
	artifactId?: string;
}

/**
 * Whether the session may cancel `job`: stock's `cancelAsyncJob` only stops jobs its own agent owns (its jobs sheet
 * offers Cancel on those alone). A subagent's job stops with the task job that runs the subagent.
 */
export function cancellable(job: Pick<StockJobItem, "ownerId">, rootId: string | undefined): boolean {
	return job.ownerId === undefined || job.ownerId === rootId;
}

export function jobRows(
	tree: StockJobTree,
	buildJobTree: BuildJobTree,
	inspect: (id: string) => JobInspection | undefined,
): BridgeJobRow[] {
	return buildJobTree([...tree.running, ...tree.recent], tree.agents, tree.rootId).map((row): BridgeJobRow => {
		if (row.kind === "agent") return { kind: "agent", agentId: row.agent.id, depth: row.depth };
		const inspection = inspect(row.job.id);
		return {
			kind: "job",
			job: {
				...row.job,
				resultPreview: inspection?.output,
				previewTruncated: inspection?.artifactId !== undefined,
			},
			depth: row.depth,
			cancellable: cancellable(row.job, tree.rootId),
		};
	});
}
