/**
 * Prompt origins for a tab several windows show (gui-bridge prompt-origin.ts): main names the device a
 * prompt, steer or follow-up came from just before it hands the text to the omp, and the bridge journals that
 * device for the user message with that text. Not a stock command and never sent by a renderer.
 */
import { z } from "zod";
import type { RpcCommand } from "../../shared/rpc-types";
import { personsPrompt } from "../turn-resume";
import type { LocalHandler } from "./types";

const setCommand = z.object({
	origin: z.object({ deviceId: z.string().min(1).max(256), name: z.string().min(1).max(256) }),
	text: z.string(),
});

const typedCommand = z.object({ text: z.string(), steer: z.boolean() });
const TYPED_NOTE_MAX_MS = 500;

export const handlers: Record<string, LocalHandler> = {
	prompt_origin_set: async (command, ctx) => {
		const { origin, text } = setCommand.parse(command);
		return ctx.bridge.request("prompt_origin_set", { origin, text });
	},
	// A person typed the message about to go in (gui-bridge typed-prompts.ts): memory recall then runs for it even in an
	// Autopilot run's tab, and one that joins a running turn is answered first (answer-first.ts). Never sent by a renderer.
	typed_prompt: async (command, ctx) => {
		const { text, steer } = typedCommand.parse(command);
		return ctx.bridge.request("typed_prompt", { text, steer });
	},
};

/** Whether the message is meant to join the running turn: stock `steer`, or a `prompt` whose host-side join is a steer. */
export function joinsAsSteer(command: RpcCommand): boolean {
	return command.type === "steer" || (command.type === "prompt" && command.streamingBehavior === "steer");
}

/**
 * Tells the omp that the prompt, steer or follow-up a person sends was typed, and whether it was sent to join the
 * running turn. Only a person's own (`personsPrompt`: an agent's wrapped message is none; the callers keep main's own
 * prompts, Autopilot's and a relaunch's, away). Best effort: an older bridge refuses it.
 */
export async function noteTypedPrompt(
	client: { command(command: RpcCommand): Promise<unknown> },
	command: RpcCommand,
): Promise<void> {
	if (!personsPrompt(command) || !("message" in command) || typeof command.message !== "string") return;
	// Bounded: the prompt never waits on a busy bridge for more than this (recall and the answer-first companion then
	// stay off for it, nothing else).
	const { promise: bound, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, TYPED_NOTE_MAX_MS);
	const text = command.message;
	await Promise.race([
		client.command({ type: "typed_prompt", text, steer: joinsAsSteer(command) }).catch(() => undefined),
		bound,
	]);
	clearTimeout(timer);
}
