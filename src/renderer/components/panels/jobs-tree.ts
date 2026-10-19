import type { RpcJobRow } from "../../../shared/rpc-types";

/**
 * The tree's rows split into the top-level subtrees that still work (a job running, or asked to stop and not yet
 * stopped) and those that settled, each in stock's order. A subtree is one top-level row and the rows nested under
 * it, so a finished job never leaves its subagent's group while a sibling in that group still runs.
 */
export function splitJobRows(rows: readonly RpcJobRow[]): { running: RpcJobRow[]; recent: RpcJobRow[] } {
	const groups: RpcJobRow[][] = [];
	for (const row of rows) {
		const group = groups.at(-1);
		if (row.depth === 0 || !group) groups.push([row]);
		else group.push(row);
	}
	const works = (group: RpcJobRow[]) =>
		group.some(row => row.kind === "job" && (row.job.status === "running" || row.job.cancellationPending === true));
	return {
		running: groups.filter(works).flat(),
		recent: groups.filter(group => !works(group)).flat(),
	};
}
