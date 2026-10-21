/**
 * Why an MCP server is not used, as stock decides it, for the Settings MCP list and the agents' app actions.
 * Dependency-free: the bridge (extensions/mcp.ts) derives it, main and the renderer read it.
 *
 * Stock's own derivation is the extensions dashboard's `resolveState` (pi-coding-agent
 * `modes/components/extensions/state-manager.ts`): an item the user turned off, a provider turned off as a whole, a
 * foreign tool's `~/` config omp does not read until its provider is opted in (`enabledProviders`,
 * `capability/index.ts` `isUserSourceEnabled`). The bridge adds what stock's dashboard folds into one
 * "item-disabled": whether omp's own config or the other tool's config turned the server off, and the project
 * config switch (`mcp.enableProjectConfig`).
 */
export type McpOffReason =
	/** Turned off in omp's own config (`/mcp disable`, the denylist, or `enabled: false` in omp's mcp.json). */
	| { kind: "disabled" }
	/** Declared only in another tool's user config (~/.codex, ~/.claude.json, …), which omp reads only when opted in. */
	| { kind: "otherTool"; tool: string; provider: string }
	/** The other tool's own config turns it off (`enabled = false` there). */
	| { kind: "offInTool"; tool: string; provider: string }
	/** That tool's whole provider is turned off in omp (`disabledProviders`). */
	| { kind: "toolOff"; tool: string; provider: string }
	/** A project server while project MCP config is turned off (`mcp.enableProjectConfig`). */
	| { kind: "projectConfigOff" };

/** What `mcp_action` `adopt`, `mcp_add`, a sign-in and `/mcp reload` tell main so every live session follows. */
export interface McpLiveChange {
	/** The servers whose configuration or credential changed; empty with `all`. */
	names: string[];
	/** Every server (a full reload). */
	all?: boolean;
}

/** `mcp_sync`'s answer: what this session did to follow the configuration on disk. */
export interface McpSyncResult {
	connected: string[];
	disconnected: string[];
	unchanged: string[];
	failed: string[];
}
