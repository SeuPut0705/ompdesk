/**
 * Prompt origins for a tab several windows show (gui-bridge prompt-origin.ts): main names the device a
 * prompt, steer or follow-up came from just before it hands the text to the omp, and the bridge journals that
 * device for the user message with that text. Not a stock command and never sent by a renderer.
 */
import { z } from "zod";
import type { RpcCommand } from "../../shared/rpc-types";
import type { LocalHandler } from "./types";

const setCommand = z.object({
	origin: z.object({ deviceId: z.string().min(1).max(256), name: z.string().min(1).max(256) }),
	text: z.string(),
});

const typedCommand = z.object({ text: z.string() });
const TYPED_NOTE_MAX_MS = 500;

export const handlers: Record<string, LocalHandler> = {
	prompt_origin_set: async (command, ctx) => {
		const { origin, text } = setCommand.parse(command);
		return ctx.bridge.request("prompt_origin_set", { origin, text });
	},
	// A person typed the prompt about to go in (gui-bridge modes/memory-recall.ts): memory recall then runs for it even
	// in an Autopilot run's tab, whose own prompts it leaves alone. Never sent by a renderer.
	memory_recall_typed: async (command, ctx) => {
		const { text } = typedCommand.parse(command);
		return ctx.bridge.request("memory_recall_typed", { text });
	},
};

/**
 * Tells the omp that the prompt or follow-up a person sends was typed (the GUI's own and a paired device's typed
 * commands come here; an agent's, Autopilot's and the resume's never do). Best effort: an older bridge refuses it.
 */
export async function noteTypedPrompt(
	client: { command(command: RpcCommand): Promise<unknown> },
	command: RpcCommand,
): Promise<void> {
	if (command.type !== "prompt" && command.type !== "follow_up") return;
	// Bounded: the prompt never waits on a busy bridge for more than this (recall then stays off for it, nothing else).
	const { promise: bound, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, TYPED_NOTE_MAX_MS);
	await Promise.race([
		client.command({ type: "memory_recall_typed", text: command.message }).catch(() => undefined),
		bound,
	]);
	clearTimeout(timer);
}
