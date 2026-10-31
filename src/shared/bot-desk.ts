/**
 * The bot's desk: what the bot carries for the owner, apart from its conversation. Main alone keeps it
 * (`<userData>/bot-desk.json`, `src/main/agent-control/bot-desk.ts`); the bot changes it with the `ompdesk_bot` tool,
 * the owner from the bot's pane (`components/bot`) and Settings › Bot through IPC, and every window hears
 * `BOT_DESK_CHANGED`.
 * - Duties: standing responsibilities ("check the nightly build every morning"). They survive a new conversation and
 *   a compaction, and reach the bot's prompt section each time they change.
 * - Decisions: what only the owner can decide. Posting one never blocks the bot; the owner's answer reaches the bot as
 *   a message that starts its turn.
 * - Identity: the bot's avatar, tagline and persona (its name is its session's title). Memories: what the bot keeps
 *   about the owner and their work, which the owner reads, edits, forgets, exports and imports. Both reach its prompt.
 * - Notify and voice: how the bot's notices reach the owner, and whether its replies are spoken.
 * - Channels: side chats on one topic each, sessions that share the bot's desk and memory.
 */
import { z } from "zod";
import { SCHEDULE_RUNS_PER_SCHEDULE } from "./schedules";
import { ScheduleFrequencySchema, ScheduleRunSchema } from "./schedules-schema";

export const BOT_DUTIES_MAX = 20;
export const BOT_DUTY_TEXT_MAX = 300;
export const BOT_DECISION_OPTIONS_MAX = 6;
/** Answered decisions kept for the home's history; open ones are never dropped. */
export const BOT_DECISIONS_ANSWERED_KEPT = 20;
export const BOT_MEMORIES_MAX = 50;
export const BOT_MEMORY_TEXT_MAX = 300;
export const BOT_TAGLINE_MAX = 80;
export const BOT_PERSONA_MAX = 1500;
/** A picture avatar as a data URL: the centre square drawn at `BOT_AVATAR_PX`. */
export const BOT_AVATAR_URL_MAX = 120_000;
export const BOT_AVATAR_PX = 128;
export const BOT_CHANNELS_MAX = 12;
export const BOT_CHANNEL_TITLE_MAX = 80;
/** Named inputs a decision may carry with its operation. */
export const BOT_DECISION_INPUTS_MAX = 12;
export const BOT_DECISION_DRAFT_MAX = 8000;
/** Tasks the owner marked done that the desk remembers. */
export const BOT_TASKS_DONE_MAX = 200;
/** Library items the owner pinned to the top. */
export const BOT_LIBRARY_PINS_MAX = 50;

/** A decision past its `expiresAt`: answering it is refused, and it no longer waits on the owner. */
export function decisionExpired(decision: { expiresAt?: string }, now: number): boolean {
	return decision.expiresAt !== undefined && Date.parse(decision.expiresAt) <= now;
}

const id = z.string().min(1).max(64);
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
	/**
	 * The exact operation the owner approves or refuses, as it would run (a command, a tool call, a release step):
	 * the card shows it verbatim, so a "yes" approves this and nothing vaguer.
	 */
	operation: z.string().trim().min(1).max(2000).optional(),
	/** That operation's inputs by name (a target branch, a version, an amount), shown beside it. */
	inputs: z
		.record(z.string().trim().min(1).max(80), z.string().max(2000))
		.refine(inputs => Object.keys(inputs).length <= BOT_DECISION_INPUTS_MAX, {
			message: `At most ${BOT_DECISION_INPUTS_MAX} inputs.`,
		})
		.optional(),
	/**
	 * Text the bot would send or write once approved (an email, a message, a release note): the owner may edit it
	 * before answering, and the answer carries the text as they left it.
	 */
	draft: z.string().max(BOT_DECISION_DRAFT_MAX).optional(),
	/** ISO time after which the answer no longer counts (a deadline, a hold that lapses); absent = never expires. */
	expiresAt: z.string().optional(),
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

/**
 * One of the bot's routines: a schedule that wakes its session (`ompdesk_schedule {"target":"self"}`), on a clock, once
 * or on an event, as its desk lists it. `name` is without the agent mark; `runs` are its newest first.
 */
export const BotRoutineSchema = z.object({
	id: z.string(),
	name: z.string(),
	prompt: z.string(),
	frequency: ScheduleFrequencySchema,
	enabled: z.boolean(),
	/** ISO time of the next start; null when it is off, paused, spent, or starts on an event. */
	next: z.string().nullable(),
	runs: z.array(ScheduleRunSchema).max(SCHEDULE_RUNS_PER_SCHEDULE),
});
export type BotRoutine = z.infer<typeof BotRoutineSchema>;

/** The marks an avatar can wear; `components/bot/BotAvatar.tsx` draws each with its icon. */
export const BOT_AVATAR_SHAPES = [
	"bot",
	"sparkles",
	"cat",
	"dog",
	"bird",
	"rabbit",
	"ghost",
	"rocket",
	"star",
	"heart",
	"leaf",
	"smile",
] as const;
/** Theme colours (each has its soft wash and on-soft text, so every theme keeps contrast). */
export const BOT_AVATAR_COLORS = ["accent", "info", "success", "warning", "danger", "neutral"] as const;

export const BotAvatarSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("mark"), shape: z.enum(BOT_AVATAR_SHAPES), color: z.enum(BOT_AVATAR_COLORS) }),
	z.object({
		kind: z.literal("image"),
		dataUrl: z
			.string()
			.max(BOT_AVATAR_URL_MAX)
			.regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
	}),
]);
export type BotAvatar = z.infer<typeof BotAvatarSchema>;

export const DEFAULT_BOT_AVATAR: BotAvatar = { kind: "mark", shape: "bot", color: "accent" };

export const BotIdentitySchema = z.object({
	/** One line under the name. */
	tagline: z.string().trim().max(BOT_TAGLINE_MAX).default(""),
	/** Personality, tone and boundaries, in the owner's words. */
	persona: z.string().trim().max(BOT_PERSONA_MAX).default(""),
	avatar: BotAvatarSchema.default(DEFAULT_BOT_AVATAR),
});
export type BotIdentity = z.infer<typeof BotIdentitySchema>;

export const BotMemorySchema = z.object({
	id,
	text: z.string().trim().min(1).max(BOT_MEMORY_TEXT_MAX),
	/** Who wrote it: the bot (`ompdesk_bot remember`) or the owner (the Memory section, an import). */
	by: z.enum(["bot", "owner"]),
	/** ISO time it was saved or last edited. */
	at: z.string(),
});
export type BotMemory = z.infer<typeof BotMemorySchema>;

/** Where a kind of notice goes: the desktop banner, the paired phones' push, both, or nowhere. */
export const BOT_NOTIFY_ROUTES = ["both", "banner", "push", "quiet"] as const;
export type BotNotifyRoute = (typeof BOT_NOTIFY_ROUTES)[number];
/** The kinds of the bot's notices: its progress reports, the decisions it waits on, and work it finished. */
export const BOT_NOTIFY_KINDS = ["progress", "decisions", "done"] as const;
export type BotNotifyKind = (typeof BOT_NOTIFY_KINDS)[number];
/** How often a progress notice may reach the owner. */
export const BOT_PROGRESS_EVERY = ["all", "hourly", "daily"] as const;

const route = z.enum(BOT_NOTIFY_ROUTES);
export const BotNotifySchema = z.object({
	progress: route.default("banner"),
	decisions: route.default("both"),
	done: route.default("both"),
	progressEvery: z.enum(BOT_PROGRESS_EVERY).default("all"),
});
export type BotNotify = z.infer<typeof BotNotifySchema>;

export const BotVoiceSchema = z.object({
	/** The window showing the bot reads each finished reply aloud (`stores/read-aloud.ts`). */
	speakReplies: z.boolean().default(false),
});
export type BotVoice = z.infer<typeof BotVoiceSchema>;

/** A side chat: a session of its own on one topic that shares the bot's desk, memory and rules. */
export const BotChannelSchema = z.object({
	id,
	title: z.string().trim().min(1).max(BOT_CHANNEL_TITLE_MAX),
	sessionPath: z.string().min(1),
	at: z.string(),
});
export type BotChannel = z.infer<typeof BotChannelSchema>;

/** What the file holds. Fields added after the first desk default, so an older file reads as it was. */
export const BotDeskFileSchema = z.object({
	duties: z.array(BotDutySchema).max(BOT_DUTIES_MAX),
	decisions: z.array(BotDecisionSchema),
	identity: BotIdentitySchema.default({}),
	memories: z.array(BotMemorySchema).max(BOT_MEMORIES_MAX).default([]),
	notify: BotNotifySchema.default({}),
	voice: BotVoiceSchema.default({}),
	channels: z.array(BotChannelSchema).max(BOT_CHANNELS_MAX).default([]),
	/** The owner paused the bot: no mail starts a turn in its session until they resume it. Absent: running. */
	paused: z.boolean().optional(),
	/**
	 * Sessions the bot opened that the owner marked done (Duet: only the owner completes a task), by session file,
	 * newest last; the bot's own report never completes one. Bounded: the oldest marks go first.
	 */
	tasksDone: z.array(z.string().min(1).max(4096)).max(BOT_TASKS_DONE_MAX).default([]),
	/** Library items the owner pinned, newest last (`library_pin`). */
	libraryPins: z.array(z.string().min(1).max(4096)).max(BOT_LIBRARY_PINS_MAX).default([]),
});
export type BotDeskFile = z.infer<typeof BotDeskFileSchema>;

/** What a window reads (`BOT_DESK_GET`) and hears (`BOT_DESK_CHANGED`): the file plus the bot's routines. */
export interface BotDeskState extends BotDeskFile {
	routines: BotRoutine[];
	/** The owner is showing the bot a workflow (`main/agent-control/bot-teach.ts`) since this ISO time; null/absent = not. */
	teaching?: { since: string } | null;
}

/**
 * `host.botDesk.get`'s reply and `host.botDesk.changed`'s data: a paired host's desk as the link carries it. An older
 * host sends no identity, memories, notify, voice or channels: they read as their defaults.
 */
export const BotDeskStateSchema: z.ZodType<BotDeskState, z.ZodTypeDef, unknown> = BotDeskFileSchema.extend({
	routines: z.array(BotRoutineSchema),
	teaching: z.object({ since: z.string() }).nullable().optional(),
});

export const EMPTY_BOT_DESK_FILE: BotDeskFile = {
	duties: [],
	decisions: [],
	identity: { tagline: "", persona: "", avatar: DEFAULT_BOT_AVATAR },
	memories: [],
	notify: { progress: "banner", decisions: "both", done: "both", progressEvery: "all" },
	voice: { speakReplies: false },
	channels: [],
	tasksDone: [],
	libraryPins: [],
};
export const EMPTY_BOT_DESK: BotDeskState = { ...EMPTY_BOT_DESK_FILE, routines: [] };

/** A stored file as main reads it: anything unreadable is an empty desk, never a crash. */
export function parseBotDeskFile(value: unknown): BotDeskFile {
	const parsed = BotDeskFileSchema.safeParse(value);
	return parsed.success ? parsed.data : EMPTY_BOT_DESK_FILE;
}

/** The decisions still waiting on the owner, oldest first: the dock's inbox and the bot row's count. An expired one
 * waits on nobody. */
export function openBotDecisions(desk: Pick<BotDeskFile, "decisions">, now = Date.now()): BotDecision[] {
	return desk.decisions.filter(decision => decision.state === "open" && !decisionExpired(decision, now));
}

/** The duties as the bot's prompt lists them, one line each; empty when there are none. */
export function botDutiesText(duties: readonly BotDuty[]): string {
	return duties.map(duty => `- ${duty.text.replace(/\s+/g, " ").trim()} (id ${duty.id})`).join("\n");
}

/** The desk as the bot's prompt carries it (`agent_control_bot`): duties, memories and identity, each as text. */
export interface BotRoleDesk {
	duties: string;
	memory: string;
	identity: string;
}

export function botRoleDesk(desk: Pick<BotDeskFile, "duties" | "memories" | "identity">): BotRoleDesk {
	return {
		duties: botDutiesText(desk.duties),
		memory: botMemoryText(desk.memories),
		identity: botIdentityText(desk.identity),
	};
}

/** The memories as the bot's prompt lists them, one line each; empty when there are none. */
export function botMemoryText(memories: readonly BotMemory[]): string {
	return memories.map(memory => `- ${memory.text.replace(/\s+/g, " ").trim()} (id ${memory.id})`).join("\n");
}

/** The owner's words about who the bot is, as its prompt carries them; empty when the owner wrote none. */
export function botIdentityText(identity: Pick<BotIdentity, "tagline" | "persona">): string {
	return [
		identity.tagline ? `Tagline: ${identity.tagline.replace(/\s+/g, " ")}` : "",
		identity.persona ? `Persona, tone and boundaries (the owner's words):\n${identity.persona}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** IPC: `BOT_DESK_ANSWER`'s payload. `answer` is one of the options or the owner's own words; `draft` is the
 * decision's draft as the owner edited it before answering. */
export const BotDeskAnswerSchema = z.object({
	id: z.string().min(1).max(64),
	answer: z.string().trim().min(1).max(2000),
	draft: z.string().max(BOT_DECISION_DRAFT_MAX).optional(),
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
