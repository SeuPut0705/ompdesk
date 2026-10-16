/**
 * Prompt origins for a tab several windows show (gui-bridge prompt-origin.ts): main names the device a
 * prompt, steer or follow-up came from just before it hands the text to the omp, and the bridge journals that
 * device for the user message with that text. Not a stock command and never sent by a renderer.
 */
import { z } from "zod";
import type { LocalHandler } from "./types";

const setCommand = z.object({
	origin: z.object({ deviceId: z.string().min(1).max(256), name: z.string().min(1).max(256) }),
	text: z.string(),
});

export const handlers: Record<string, LocalHandler> = {
	prompt_origin_set: async (command, ctx) => {
		const { origin, text } = setCommand.parse(command);
		return ctx.bridge.request("prompt_origin_set", { origin, text });
	},
};
