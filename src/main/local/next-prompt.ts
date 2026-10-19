/**
 * Built-in prompt suggestions (gui-bridge modes/next-prompt.ts, contracts in
 * resources/gui-bridge/modes/next-prompt-contracts.ts). Stock RPC has no composer
 * prediction, so each command is a thin, validated call to the bridge in the
 * tab's own omp; the bridge pushes the `next_prompt_update` and
 * `next_prompt_config` frames.
 */
import { z } from "zod";
import {
	INLINE_MAX_DRAFT_CHARS,
	MAX_NEXT_PROMPT_CHILDREN,
	NEXT_PROMPT_REFRESH_REASONS,
} from "../../../resources/gui-bridge/modes/next-prompt-contracts";
import type { LocalHandler } from "./types";

const draftCommand = z.object({ empty: z.boolean() });
const refreshCommand = z.object({ reason: z.enum(NEXT_PROMPT_REFRESH_REASONS) });
const cancelCommand = z.object({ scope: z.enum(["suggest", "inline", "all"]) });
const childrenCommand = z.object({
	children: z
		.array(z.object({ title: z.string().max(200), waiting: z.boolean().optional() }))
		.max(MAX_NEXT_PROMPT_CHILDREN),
});
// The bridge trims the draft to its own cap; twice that is the most a well-behaved client sends.
const inlineCommand = z.object({
	draft: z.string().max(INLINE_MAX_DRAFT_CHARS * 2),
	requestId: z.string().min(1).max(64),
});

export const handlers: Record<string, LocalHandler> = {
	get_next_prompt: (_command, ctx) => ctx.bridge.request("next_prompt_state"),
	set_next_prompt_draft: async (command, ctx) =>
		ctx.bridge.request("next_prompt_draft", { empty: draftCommand.parse(command).empty }),
	refresh_next_prompt: async (command, ctx) =>
		ctx.bridge.request("next_prompt_refresh", { reason: refreshCommand.parse(command).reason }),
	cancel_next_prompt: async (command, ctx) =>
		ctx.bridge.request("next_prompt_cancel", { scope: cancelCommand.parse(command).scope }),
	/** Main's agent-control runtime (never the renderer): the opened sessions still running or waiting. */
	set_next_prompt_children: async (command, ctx) =>
		ctx.bridge.request("next_prompt_children", { children: childrenCommand.parse(command).children }),
	complete_inline: async (command, ctx) => {
		const { draft, requestId } = inlineCommand.parse(command);
		return ctx.bridge.request("next_prompt_inline", { draft, requestId });
	},
};
