/**
 * Automatic session titles (gui-bridge modes/auto-title.ts, contracts in
 * resources/gui-bridge/auto-title-contracts.ts). Stock RPC has no command for `/rename` without a title,
 * so the editor's auto button is a thin call to the bridge in the tab's own omp, which runs stock's
 * `AgentSession.renameTitle` on the live session and saves the result. A tab a host runs for a paired
 * device answers it on the host, so the model call is the host's.
 */
import type { LocalHandler } from "./types";

export const handlers: Record<string, LocalHandler> = {
	regenerate_session_title: (_command, ctx) => ctx.bridge.request("regenerate_title"),
};
