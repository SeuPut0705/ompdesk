/**
 * The main session's shutdown arms the drained exit (exit-drain-core.ts): stock emits `session_shutdown` from the
 * dispose that precedes its `process.exit`, on every way an RPC omp ends by itself (its stdin closed, which is how
 * OMPdesk stops an omp on Windows and, with Memory on, everywhere; an extension's shutdown request). Armed there and
 * not at load, so nothing changes for a process that is not ending. A subagent's session ends without the process
 * ending, so only the main agent's shutdown counts.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { postmortem } from "@oh-my-pi/pi-utils";
import { drainOnExit } from "./exit-drain-core";
import { guard } from "./health";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.agent.id !== pi.pi.MAIN_AGENT_ID) return;
		drainOnExit(process, postmortem);
	});
}

export const methods = guard("exitDrain", {});
