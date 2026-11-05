/**
 * What a session's omp is started with for the Computer use setting (pref `computerUse`, src/shared/computer-use.ts;
 * bridge half: resources/gui-bridge/modes/computer-use.ts). Read at every spawn, so a pick applies from a session's
 * next start: the MCP root is mounted when omp starts and cannot be switched live.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DESKTOP_ENV, COMPUTER_USE_ENV } from "../../resources/gui-bridge/modes/computer-use-contracts";
import { parseComputerUseEngine } from "../shared/computer-use";
import type { SetupPlatform } from "../shared/setup";
import { managedAgentDesktop } from "./setup/paths";

export interface ComputerUseSpawn {
	/** `-e <root>` of the agent-desktop MCP server, only when it will run. */
	args: string[];
	/** `COMPUTER_USE_ENV` always (the bridge reads it), `AGENT_DESKTOP_ENV` beside the root. */
	env: Record<string, string>;
}

export interface ComputerUseSpawnInput {
	/** The stored pref, as read. */
	pref: unknown;
	/** `resources/omp-builtin`: the root is its `agent-desktop/` folder. */
	builtinDir: string;
	toolsDir: string;
	platform: SetupPlatform;
	exists?: (path: string) => boolean;
}

/**
 * - `builtin`: stock's eval `computer` prelude; nothing is mounted.
 * - `agent-desktop` with the managed executable present: the root and the executable's path.
 * - `agent-desktop` without it (not installed yet, or its install failed): nothing is mounted and the bridge keeps the
 *   built-in prelude on and says so in the session (`missing`).
 */
export function computerUseSpawn(input: ComputerUseSpawnInput): ComputerUseSpawn {
	const { builtinDir, toolsDir, platform, exists = existsSync } = input;
	if (parseComputerUseEngine(input.pref) === "builtin") return { args: [], env: { [COMPUTER_USE_ENV]: "builtin" } };
	const executable = managedAgentDesktop(toolsDir, platform);
	if (!exists(executable)) return { args: [], env: { [COMPUTER_USE_ENV]: "missing" } };
	return {
		args: ["-e", join(builtinDir, "agent-desktop")],
		env: { [COMPUTER_USE_ENV]: "agent-desktop", [AGENT_DESKTOP_ENV]: executable },
	};
}
