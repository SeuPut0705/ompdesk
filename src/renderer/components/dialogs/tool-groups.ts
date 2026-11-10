import type { RpcActiveTool, RpcToolSource } from "../../../shared/rpc-types";

const SOURCE_ORDER: readonly RpcToolSource[] = ["builtin", "mcp", "extension", "plugin"];

export interface ToolGroup {
	source: RpcToolSource;
	tools: RpcActiveTool[];
}

/**
 * The agent's tools that match `query` (name or description), grouped by where they come from in one fixed order, so
 * Active tools and Force tool list them the same way. Empty groups are left out.
 */
export function groupToolsBySource(tools: readonly RpcActiveTool[], query: string): ToolGroup[] {
	const q = query.trim().toLowerCase();
	return SOURCE_ORDER.map(source => ({
		source,
		tools: tools.filter(
			tool =>
				tool.source === source &&
				(!q || tool.name.toLowerCase().includes(q) || (tool.description ?? "").toLowerCase().includes(q)),
		),
	})).filter(group => group.tools.length > 0);
}
