/**
 * An MCP change one session made reaches every live session on this computer. Each tab is its own omp with its own
 * MCPManager, and a credential or config file another omp wrote is read only at start: before this, a server added,
 * turned on or signed in from one tab stayed unusable in every other open tab until it was restarted (the user's
 * report, 21 Oct 2026: Higgsfield signed in, `No such tool: xd://mcp__…` in the session that asked).
 *
 * The local MCP handlers (local/extensions.ts) call `noteMcpChange` once a change succeeded; index.ts hands it to
 * the pool and to the tabs this computer hosts for paired devices as an extension apply plan (extension-reload.ts
 * `mcp`), which sends each ready tab the bridge's `mcp_sync` at once and a tab in a turn when its turn ends. A
 * paired host's tab runs its handlers on the host, so the host's sessions follow there.
 */
import type { McpLiveChange } from "../../resources/gui-bridge/extensions/mcp-contracts";

type Listener = (change: McpLiveChange) => void;

let listener: Listener | undefined;

export function onMcpChange(next: Listener | undefined): void {
	listener = next;
}

export function noteMcpChange(change: McpLiveChange): void {
	if (!change.all && change.names.length === 0) return;
	listener?.(change);
}
