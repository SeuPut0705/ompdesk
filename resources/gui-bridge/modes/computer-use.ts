/**
 * Computer use engine (rules: computer-use-core.ts; contracts: computer-use-contracts.ts; the setting and its rules:
 * src/shared/computer-use.ts, builtin-packs.md › Computer use engine). Main starts an omp on one of three launches
 * (`OMP_GUI_COMPUTER_USE`): `builtin` and `missing` change nothing here but the `missing` notice; `agent-desktop` has
 * mounted the `agent-desktop` MCP server and holds stock's `computer.enabled` off (thinking-default-core.ts). For that
 * launch this module:
 *
 * - waits for stock's MCP startup to settle the server once, bounded; a server that failed or is still not up at the
 *   bound makes this omp fall back to the built-in prelude: `computer.enabled` is held on again, which stock's own
 *   listener reconciles live (an empty transcript rebuilds the prompt, a running one gets stock's hidden prelude
 *   notice), and the section below goes;
 * - awaits that same check in the first turn's `before_agent_start`, so the turn's prompt is decided by it.
 *
 * A fallback (this one or `missing`) is shown, never silent: the first turn after it carries a displayed
 * `ompdesk-computer-use` message (the transcript's note; the model reads its one line) and one warning toast.
 *
 * The section is the engine's usage and safety text, for every agent of the omp (subagents share its MCP manager).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import { holdBuiltinComputerPrelude } from "../thinking-default";
import { COMPUTER_USE_ENV, parseComputerUseEnv } from "./computer-use-contracts";
import {
	COMPUTER_USE_SECTION_ID,
	ComputerUseState,
	checkServer,
	computerUseSection,
	type NoticeJournalEntry,
	noticeForTurn,
} from "./computer-use-core";

/** One per omp process: the main agent's and every subagent's extension instance share it. */
let state: ComputerUseState | undefined;
/** The startup check, started once by the first instance; it always settles (a failure is `state.fail`). */
let startup: Promise<void> | undefined;

function stateOf(): ComputerUseState {
	state ??= new ComputerUseState(parseComputerUseEnv(process.env[COMPUTER_USE_ENV]));
	return state;
}

function startCheck(pi: ExtensionAPI, current: ComputerUseState): Promise<void> {
	startup ??= checkServer(() => MCPManager.instance())
		.then(verdict => (verdict.ok ? undefined : verdict.error))
		.catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
		.then(failure => {
			if (failure === undefined || !current.fail(failure)) return;
			pi.logger.warn(
				"gui-bridge: agent-desktop did not start; this omp falls back to the built-in computer prelude",
				{
					error: failure,
				},
			);
			holdBuiltinComputerPrelude(pi.pi.Settings.instance);
		})
		.catch((error: unknown) => {
			pi.logger.warn("gui-bridge: computer use fallback failed", { error: String(error) });
		});
	return startup;
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	const current = stateOf();
	const check = current.launch === "agent-desktop" ? startCheck(pi, current) : undefined;
	// First, so it runs before this instance's sections hook (registerPromptSection adds that hook on its first
	// call): index.ts installs this module ahead of every other, so the first turn's prompt is decided by the check.
	pi.on("before_agent_start", async (_event, ctx) => {
		await check;
		if (ctx.agent.kind !== "main") return undefined;
		const builtinOn = lookup("computer.enabled")?.get(pi.pi.Settings.instance) === true;
		const turn = noticeForTurn(
			current,
			ctx.sessionManager.getBranch() as readonly NoticeJournalEntry[],
			ctx.sessionManager.getSessionId(),
			builtinOn,
		);
		if (!turn) return undefined;
		if (turn.toast) ctx.ui.notify(turn.toast, "warning");
		return { message: turn.message };
	});
	registerPromptSection(pi, COMPUTER_USE_SECTION_ID, () => computerUseSection(current));
}

/** Hooks only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("computerUse", {});
