/**
 * Teaching the bot by demonstration: the owner presses Record on the bot, works in OMPdesk as usual and presses Stop;
 * main turns what they did into one message to the bot, which writes a skill from it (`main/agent-control/bot-teach.ts`).
 * IPC `BOT_TEACH` and the paired host's `host.botDesk.teach` carry the same payload and answer.
 */
import { z } from "zod";

export const BotTeachRequestSchema = z.object({ action: z.enum(["start", "stop", "cancel"]) });
export type BotTeachRequest = z.infer<typeof BotTeachRequestSchema>;

/** `delivered` is true only when Stop handed the bot a record; an empty one is never mailed. */
export const BotTeachResultSchema = z.object({ delivered: z.boolean() });
export type BotTeachResult = z.infer<typeof BotTeachResultSchema>;
