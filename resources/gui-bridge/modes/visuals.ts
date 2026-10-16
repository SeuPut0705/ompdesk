/**
 * Diagram instructions. Stock's system prompt invites ```mermaid and ```svg
 * blocks only in the top-level TUI transcript (sdk.ts `renderMermaid:
 * tuiTranscript && cfgTuiRenderMermaid.get(settings)`, where main.ts sets
 * `tuiTranscript` from `isInteractive`), so an `--mode rpc-ui` session never
 * gets them and Settings' `tui.renderMermaid` / `tui.renderSvg` switches did
 * nothing in OMPdesk, which draws both. The public `before_agent_start` hook
 * renders stock's own Visuals section of `system/system-prompt.md` with the
 * current settings (visuals-core.ts) and appends it, every prompt.
 *
 * - Subagents never get it, as in stock (`tuiTranscript && !isSubagentSession`).
 * - Both settings off, or a prompt that already carries the section (an omp
 *   whose rpc-ui sets `tuiTranscript`): nothing is appended, so the prompt
 *   stays byte-identical to stock.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { cfgTuiRenderMermaid, cfgTuiRenderSvg } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { prompt } from "@oh-my-pi/pi-utils";
import { guard } from "../health";
import { registerPromptSection } from "../prompt-sections";
import { errorMessage, ompPrompt } from "./shared";
import { visualsInstruction, visualsTemplate } from "./visuals-core";

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	let warned = false;
	registerPromptSection(pi, "visuals", ctx => {
		if (ctx.agent.kind === "sub") return undefined;
		try {
			const settings = pi.pi.Settings.instance;
			return visualsInstruction(prompt.render, visualsTemplate(ompPrompt("system/system-prompt.md")), {
				renderMermaid: cfgTuiRenderMermaid.get(settings),
				renderSvg: cfgTuiRenderSvg.get(settings),
			});
		} catch (err) {
			// The prompt goes out as stock built it; one warning per process is enough.
			if (!warned) pi.logger.warn("gui-bridge: diagram instructions skipped", { error: errorMessage(err) });
			warned = true;
			return undefined;
		}
	});
}

/** Hook only; `capabilities` reports the feature when an internal it needs is gone. */
export const methods = guard("visuals", {});
