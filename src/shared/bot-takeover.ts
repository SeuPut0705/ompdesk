/**
 * Taking over a session the bot opened (item 8 of the bot parity list; dots, Grok and Muse let the owner take control
 * of the bot's work and give it back). From a Tasks row the owner takes over: the session's turn stops, its tab opens
 * with the Terminal panel in its folder, and the owner works there. "Hand back" tells the session what the owner ran
 * in its terminals (the shared safe capture, `main/agent-control/terminal-capture.ts`: redacted, password prompts and
 * unechoed lines hidden) and starts its turn again (`main/agent-control/bot-takeover.ts`).
 * IPC `BOT_TAKEOVER` and the paired host's `host.botDesk.takeover` carry the same payload and answer; the sessions under
 * the owner's control are the desk's `takeovers`.
 */
import { z } from "zod";

export const BotTakeoverRequestSchema = z.object({
	action: z.enum(["take", "handBack"]),
	sessionPath: z.string().min(1).max(4096),
});
export type BotTakeoverRequest = z.infer<typeof BotTakeoverRequestSchema>;

/** `lines`: the terminal lines the hand-back note listed (0 when the owner ran nothing); absent for `take`. */
export const BotTakeoverResultSchema = z.object({ lines: z.number().int().nonnegative().optional() });
export type BotTakeoverResult = z.infer<typeof BotTakeoverResultSchema>;

/** A session under the owner's control, as the desk lists it. */
export const BotTakeoverSchema = z.object({ sessionPath: z.string(), since: z.string() });
export type BotTakeover = z.infer<typeof BotTakeoverSchema>;
