/**
 * The bot's desk: what the bot carries for the owner, apart from its conversation. Main alone keeps it
 * (`<userData>/bot-desk.json`, `src/main/agent-control/bot-desk.ts`); the bot changes it with the `ompdesk_bot` tool,
 * the owner from the bot's home (`BotHome.tsx`) through IPC, and every window hears `BOT_DESK_CHANGED`.
 * - Duties: standing responsibilities ("check the nightly build every morning"). They survive a new conversation and
 *   a compaction, and reach the bot's prompt section each time they change.
 * - Decisions: what only the owner can decide. Posting one never blocks the bot; the owner's answer reaches the bot as
 *   a message that starts its turn.
 */
import { z } from "zod";

export const BOT_DUTIES_MAX = 20;
export const BOT_DUTY_TEXT_MAX = 300;
export const BOT_DECISION_OPTIONS_MAX = 6;
/** Answered decisions kept for the home's history; open ones are never dropped. */
export const BOT_DECISIONS_ANSWERED_KEPT = 20;

export const BotDutySchema = z.object({
	id: z.string().min(1).max(64),
	text: z.string().trim().min(1).max(BOT_DUTY_TEXT_MAX),
	/** ISO time it was added. */
	at: z.string(),
});
export type BotDuty = z.infer<typeof BotDutySchema>;

const DecisionBase = z.object({
	id: z.string().min(1).max(64),
	question: z.string().trim().min(1).max(2000),
	/** Choices the bot offers; empty = a free answer. */
	options: z.array(z.string().trim().min(1).max(200)).max(BOT_DECISION_OPTIONS_MAX),
	/** What the owner needs to know to decide. */
	context: z.string().max(4000).optional(),
	/** ISO time it was posted. */
	at: z.string(),
});
export const BotDecisionSchema = z.discriminatedUnion("state", [
	DecisionBase.extend({ state: z.literal("open") }),
	DecisionBase.extend({
		state: z.literal("answered"),
		answer: z.string().trim().min(1).max(2000),
		answeredAt: z.string(),
	}),
]);
export type BotDecision = z.infer<typeof BotDecisionSchema>;

/** A wake the bot scheduled for itself (`ompdesk_schedule {"target":"self"}`), as the home lists it. */
export const BotWakeSchema = z.object({
	id: z.string(),
	prompt: z.string(),
	/** ISO time of the next start; null when the schedule is paused or has none. */
	next: z.string().nullable(),
});
export type BotWake = z.infer<typeof BotWakeSchema>;

/** What the file holds. */
export const BotDeskFileSchema = z.object({
	duties: z.array(BotDutySchema).max(BOT_DUTIES_MAX),
	decisions: z.array(BotDecisionSchema),
});
export type BotDeskFile = z.infer<typeof BotDeskFileSchema>;

/** What a window reads (`BOT_DESK_GET`) and hears (`BOT_DESK_CHANGED`): the file plus the bot's own wakes. */
export interface BotDeskState extends BotDeskFile {
	wakes: BotWake[];
}

export const EMPTY_BOT_DESK: BotDeskState = { duties: [], decisions: [], wakes: [] };

/** A stored file as main reads it: anything unreadable is an empty desk, never a crash. */
export function parseBotDeskFile(value: unknown): BotDeskFile {
	const parsed = BotDeskFileSchema.safeParse(value);
	return parsed.success ? parsed.data : { duties: [], decisions: [] };
}

/** The open decisions, oldest first: the home's inbox and the bot row's count. */
export function openBotDecisions(desk: Pick<BotDeskFile, "decisions">): BotDecision[] {
	return desk.decisions.filter(decision => decision.state === "open");
}

/** The duties as the bot's prompt lists them, one line each; empty when there are none. */
export function botDutiesText(duties: readonly BotDuty[]): string {
	return duties.map(duty => `- ${duty.text.replace(/\s+/g, " ").trim()} (id ${duty.id})`).join("\n");
}

/** IPC: `BOT_DESK_ANSWER`'s payload. `answer` is one of the options or the owner's own words. */
export const BotDeskAnswerSchema = z.object({
	id: z.string().min(1).max(64),
	answer: z.string().trim().min(1).max(2000),
});
export type BotDeskAnswer = z.infer<typeof BotDeskAnswerSchema>;

/** IPC: `BOT_DESK_SET_DUTIES`'s payload, the whole list as the owner left it. */
export const BotDeskDutiesSchema = z.object({
	duties: z
		.array(
			z.object({ id: z.string().min(1).max(64).optional(), text: z.string().trim().min(1).max(BOT_DUTY_TEXT_MAX) }),
		)
		.max(BOT_DUTIES_MAX),
});
export type BotDeskDuties = z.infer<typeof BotDeskDutiesSchema>;
