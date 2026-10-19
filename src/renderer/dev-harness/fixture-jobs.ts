/**
 * `?jobs=tree`: the Background tasks view with stock's jobs tree. A subagent (`sa-explore`) runs a shell and a
 * nested subagent (`sa-nested`) that runs one too; `sa-review` settled; `sa-evicted` lost its task job and shows as a
 * header. Only the session's own jobs offer Cancel. The roster names two of the subagents, as the sidebar would.
 */
import type { RpcAsyncJobItem, RpcJobRow, SubagentSnapshot } from "../../shared/rpc-types";

const MINUTE = 60_000;

const job = (
	id: string,
	type: RpcAsyncJobItem["type"],
	status: RpcAsyncJobItem["status"],
	startedAgo: number,
	extra: Partial<RpcAsyncJobItem> = {},
	depth = 0,
): RpcJobRow => ({
	kind: "job",
	depth,
	cancellable: depth === 0,
	job: { id, type, status, label: id, startTime: Date.now() - startedAgo, ...extra },
});

export function jobTreeRows(): RpcJobRow[] {
	const settled = (endedAgo: number) => Date.now() - endedAgo;
	return [
		job("bun run dev", "bash", "running", 94_000),
		job("sa-explore", "task", "running", MINUTE, { agentId: "sa-explore" }),
		job(
			"rg -n settings src",
			"bash",
			"running",
			33_000,
			{
				resultPreview: "src/settings.ts:12: export const settings\nsrc/lib/prefs.ts:4: settings",
			},
			1,
		),
		job("sa-nested", "task", "running", 27_000, { agentId: "sa-nested" }, 1),
		job("bun test locales", "bash", "running", 9_000, {}, 2),
		job("sa-review", "task", "completed", 2 * MINUTE, { agentId: "sa-review", endedAt: settled(70_000) }),
		job("diff stat", "eval", "completed", 110_000, { endedAt: settled(100_000) }, 1),
		{ kind: "agent", agentId: "sa-evicted", depth: 0 },
		job("biome check", "bash", "failed", 200_000, { endedAt: settled(190_000), resultPreview: "2 errors" }, 1),
	];
}

export const JOB_TREE_SUBAGENTS: SubagentSnapshot[] = [
	{
		id: "sa-explore",
		index: 0,
		agent: "explore",
		description: "Map the settings code",
		status: "running",
		live: true,
		lastUpdate: Date.now(),
	},
	{
		id: "sa-nested",
		index: 1,
		agent: "task",
		description: "Read locale files",
		status: "running",
		live: true,
		parentSubagentId: "sa-explore",
		lastUpdate: Date.now(),
	},
];
