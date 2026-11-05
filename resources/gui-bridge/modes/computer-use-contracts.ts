/**
 * What the Computer use setting resolves to for one omp process (pref rules: src/shared/computer-use.ts; bridge:
 * ./computer-use.ts). Dependency-free: main, the bridge and the renderer import it.
 */

/** Env main sets at every spawn: the engine this omp starts on; see {@link ComputerUseLaunch}. */
export const COMPUTER_USE_ENV = "OMP_GUI_COMPUTER_USE";

/**
 * Env main sets beside `agent-desktop`: the executable `resources/omp-builtin/agent-desktop/.mcp.json` runs (stock
 * expands `${…}` in a plugin root's `.mcp.json`).
 */
export const AGENT_DESKTOP_ENV = "OMP_GUI_AGENT_DESKTOP";

/** The MCP server name of the mounted root; stock names its tools `mcp__agent_desktop_<tool>`. */
export const AGENT_DESKTOP_SERVER = "agent-desktop";

/** The tool-name prefix stock mints for {@link AGENT_DESKTOP_SERVER} (lower-cased, `-` → `_`). */
export const AGENT_DESKTOP_TOOL_PREFIX = "mcp__agent_desktop_";

/**
 * - `agent-desktop`: the agent-desktop root is mounted and stock's `computer` prelude is held off.
 * - `builtin`: the person picked the built-in prelude.
 * - `missing`: the person picked agent-desktop but this computer has no agent-desktop executable (yet): the session runs
 *   on the built-in prelude and its transcript says so.
 */
export type ComputerUseLaunch = "agent-desktop" | "builtin" | "missing";

/** The env value read back; missing or malformed reads as the built-in prelude (an older main sets nothing). */
export function parseComputerUseEnv(value: string | undefined): ComputerUseLaunch {
	return value === "agent-desktop" || value === "missing" ? value : "builtin";
}

/** The transcript note a session that wanted agent-desktop and fell back to the built-in prelude shows. */
export const COMPUTER_USE_NOTICE_TYPE = "ompdesk-computer-use";

/**
 * `missing`: no agent-desktop executable at the session's start. `failed`: the `agent-desktop` MCP server did not start
 * (`error`: stock's connect failure, one line).
 */
export interface ComputerUseNoticeDetails {
	v: 1;
	reason: "missing" | "failed";
	error?: string;
}

/** The notice's details read back; undefined when the entry is not one. */
export function parseComputerUseNotice(details: unknown): ComputerUseNoticeDetails | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const record = details as Record<string, unknown>;
	if (record.reason !== "missing" && record.reason !== "failed") return undefined;
	const error = typeof record.error === "string" && record.error.trim() ? record.error.trim() : undefined;
	return { v: 1, reason: record.reason, ...(error ? { error } : {}) };
}
