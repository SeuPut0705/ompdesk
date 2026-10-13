/**
 * The debug console over the live session: stock `DebugTool`. Ported from the
 * fork's rpc-mode.ts debug case. Wire shapes match `src/shared/rpc-types.ts`.
 */
import { type DebugParams, DebugTool } from "@oh-my-pi/pi-coding-agent/tools/debug";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { guard } from "./health";
import { asRecord } from "./params";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = guard("debug", {
	debug: async (params, env) => {
		const session = env.session();
		const toolSession = {
			cwd: session.sessionManager.getCwd(),
			hasUI: true,
			settings: session.settings,
		} as ToolSession;
		const result = await new DebugTool(toolSession).execute(
			`gui-debug-${Date.now()}`,
			asRecord(asRecord(params).params) as DebugParams,
		);
		return { content: result.content, details: result.details };
	},
});
