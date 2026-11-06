/**
 * Settings › Agent behavior › Computer use: which engine an omp session OMPdesk spawns uses to see and operate this
 * computer's desktop apps (pref `computerUse`).
 *
 * - `agent-desktop` (default, the owner's call, 6 Nov 2026): vercel-labs' agent-desktop, shipped in the app and kept
 *   current by machine setup's updates in the managed tools dir (src/main/agent-desktop.ts picks the copy), mounted per
 *   session as the stdio MCP server `agent-desktop` (`resources/omp-builtin/agent-desktop/.mcp.json`); stock's eval
 *   `computer` prelude is held off.
 * - `builtin`: stock omp's eval `computer` prelude (`computer.enabled`, which OMPdesk holds on).
 *
 * A session whose agent-desktop is missing, or whose server does not start, runs on the built-in prelude and says so in
 * its transcript (resources/gui-bridge/modes/computer-use.ts). The pick applies from a session's next start.
 */

export const COMPUTER_USE_PREF = "computerUse";

export const COMPUTER_USE_ENGINES = ["agent-desktop", "builtin"] as const;
export type ComputerUseEngine = (typeof COMPUTER_USE_ENGINES)[number];

export const DEFAULT_COMPUTER_USE_ENGINE: ComputerUseEngine = "agent-desktop";

export function isComputerUseEngine(value: unknown): value is ComputerUseEngine {
	return typeof value === "string" && (COMPUTER_USE_ENGINES as readonly string[]).includes(value);
}

/** The stored pref as an engine; anything else (unset, an older value) is the default. */
export function parseComputerUseEngine(value: unknown): ComputerUseEngine {
	return isComputerUseEngine(value) ? value : DEFAULT_COMPUTER_USE_ENGINE;
}
