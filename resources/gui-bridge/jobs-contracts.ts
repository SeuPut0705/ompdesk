/**
 * What `composer.jobs` sends main: stock's async-job tree (`AgentSession.getAsyncJobTree`) as flat rows in display
 * order, nesting already resolved. Main maps it onto the renderer's `RpcJobRow`.
 */

/** One stock `AsyncJobSnapshotItem` plus the output `inspectAsyncJob` returned for it. */
export interface BridgeJobItem {
	id: string;
	type: "bash" | "task" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	startTime: number;
	endTime?: number;
	/** Registry id of the subagent a task job runs. */
	agentId?: string;
	/** Registry id of the agent that owns the job; absent or the tree's root: the session's own job. */
	ownerId?: string;
	command?: string;
	cancellationPending?: boolean;
	resultPreview?: string;
	errorPreview?: string;
	previewTruncated?: boolean;
}

/**
 * One row of the tree. A job row's `cancellable` is stock's own rule (`cancelAsyncJob` only cancels jobs the session's
 * agent owns); an agent row heads a subagent whose task job is not listed any more.
 */
export type BridgeJobRow =
	| { kind: "job"; job: BridgeJobItem; depth: number; cancellable: boolean }
	| { kind: "agent"; agentId: string; depth: number };

/**
 * What `composer.freeze_jobs` sends main (the automatic update's last look, src/main/background-work.ts `freeze`): the
 * same rows, whether this omp now holds every new tool call (it ran no job and no call was under way), and how many tool
 * calls under way kept it from doing so.
 */
export interface BridgeJobFreeze {
	rows: BridgeJobRow[];
	frozen: boolean;
	starting: number;
}
