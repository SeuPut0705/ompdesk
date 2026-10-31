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

export const BOT_DUTIES_MAX = 20;
export const BOT_DUTY_TEXT_MAX = 300;
export const BOT_DECISION_OPTIONS_MAX = 6;
/** Answered decisions kept for the home's history; open ones are never dropped. */
export const BOT_DECISIONS_ANSWERED_KEPT = 20;
export const BOT_MEMORIES_MAX = 50;
export const BOT_MEMORY_TEXT_MAX = 300;
export const BOT_TAGLINE_MAX = 80;
export const BOT_PERSONA_MAX = 1500;
/** A picture avatar as a data URL (`components/bot/avatar-image.ts` draws it at 128 px). */
export const BOT_AVATAR_URL_MAX = 120_000;
export const BOT_CHANNELS_MAX = 12;
export const BOT_CHANNEL_TITLE_MAX = 80;

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
});
export type BotDeskFile = z.infer<typeof BotDeskFileSchema>;

/** What a window reads (`BOT_DESK_GET`) and hears (`BOT_DESK_CHANGED`): the file plus the bot's own wakes. */
export interface BotDeskState extends BotDeskFile {
	wakes: BotWake[];
}

/**
 * `host.botDesk.get`'s reply and `host.botDesk.changed`'s data: a paired host's desk as the link carries it. An older
 * host sends no identity, memories, notify, voice or channels: they read as their defaults.
 */
export const BotDeskStateSchema: z.ZodType<BotDeskState, z.ZodTypeDef, unknown> = BotDeskFileSchema.extend({
	wakes: z.array(BotWakeSchema),
});

export const EMPTY_BOT_DESK_FILE: BotDeskFile = BotDeskFileSchema.parse({ duties: [], decisions: [] });
export const EMPTY_BOT_DESK: BotDeskState = { ...EMPTY_BOT_DESK_FILE, wakes: [] };

/** A stored file as main reads it: anything unreadable is an empty desk, never a crash. */
export function parseBotDeskFile(value: unknown): BotDeskFile {
	const parsed = BotDeskFileSchema.safeParse(value);
	return parsed.success ? parsed.data : EMPTY_BOT_DESK_FILE;
}

/** The open decisions, oldest first: the home's inbox and the bot row's count. */
export function openBotDecisions(desk: Pick<BotDeskFile, "decisions">): BotDecision[] {
	return desk.decisions.filter(decision => decision.state === "open");
}

/** The duties as the bot's prompt lists them, one line each; empty when there are none. */
export function botDutiesText(duties: readonly BotDuty[]): string {
	return duties.map(duty => `- ${duty.text.replace(/\s+/g, " ").trim()} (id ${duty.id})`).join("\n");
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

/** A memory file the owner exports (Memory.md): one memory per bullet, newest last. */
export function botMemoryMarkdown(memories: readonly BotMemory[], name: string): string {
	const lines = memories.map(memory => `- ${memory.text.replace(/\s+/g, " ").trim()}`);
	return `# ${name.replace(/\s+/g, " ").trim() || "Bot"}: memory\n\n${lines.join("\n")}\n`;
}

const MemoryImportJsonSchema = z.union([
	z.array(z.unknown()),
	z.object({ memories: z.array(z.unknown()) }).transform(file => file.memories),
]);
const ImportItemSchema = z.union([z.string(), z.object({ text: z.string() }).transform(item => item.text)]);

/**
 * The memories in a file the owner imports: a Memory.md this app exported, any Markdown or text with one memory per
 * bullet or line (headings and blank lines skipped), or a JSON list of strings or of `{text}`. Each cut to
 * `BOT_MEMORY_TEXT_MAX`, the same text once, at most `BOT_MEMORIES_MAX`.
 */
export function parseBotMemoryImport(content: string): string[] {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch {
		json = undefined;
	}
	const list = MemoryImportJsonSchema.safeParse(json);
	const raw = list.success
		? list.data.map(item => {
				const parsed = ImportItemSchema.safeParse(item);
				return parsed.success ? parsed.data : "";
			})
		: content
				.split(/\r?\n/)
				.filter(line => !/^\s*#/.test(line))
				.map(line => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""));
	const seen = new Set<string>();
	const texts: string[] = [];
	for (const line of raw) {
		const text = line.replace(/\s+/g, " ").trim().slice(0, BOT_MEMORY_TEXT_MAX).trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		texts.push(text);
		if (texts.length >= BOT_MEMORIES_MAX) break;
	}
	return texts;
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

const memoryText = z.string().trim().min(1).max(BOT_MEMORY_TEXT_MAX);

/**
 * IPC: `BOT_DESK_EDIT`'s payload, one change the owner makes (and the inverse an Undo replays, `bot-activity.ts`).
 * `channel_add` and `channel_remove` make or delete a session, which main does before the desk records it.
 */
export const BotDeskEditSchema = z.discriminatedUnion("op", [
	z
		.object({
			op: z.literal("identity"),
			tagline: z.string().trim().max(BOT_TAGLINE_MAX).optional(),
			persona: z.string().trim().max(BOT_PERSONA_MAX).optional(),
			avatar: BotAvatarSchema.optional(),
		})
		.strict(),
	z.object({ op: z.literal("memory_add"), text: memoryText }).strict(),
	z.object({ op: z.literal("memory_edit"), id, text: memoryText }).strict(),
	z.object({ op: z.literal("memory_forget"), id }).strict(),
	/** Puts back a forgotten memory as it was (the Undo of a forget). */
	z.object({ op: z.literal("memory_restore"), memory: BotMemorySchema }).strict(),
	z
		.object({
			op: z.literal("memory_import"),
			texts: z.array(memoryText).max(BOT_MEMORIES_MAX),
			/** Replace every memory instead of adding to them (an empty list with it forgets them all). */
			replace: z.boolean(),
		})
		.strict(),
	/** The whole duty list as it was (the Undo of a duty change). */
	BotDeskDutiesSchema.extend({ op: z.literal("duties") }).strict(),
	z
		.object({
			op: z.literal("notify"),
			progress: route.optional(),
			decisions: route.optional(),
			done: route.optional(),
			progressEvery: z.enum(BOT_PROGRESS_EVERY).optional(),
		})
		.strict(),
	z.object({ op: z.literal("voice"), speakReplies: z.boolean() }).strict(),
	z.object({ op: z.literal("channel_add"), title: z.string().trim().min(1).max(BOT_CHANNEL_TITLE_MAX) }).strict(),
	z.object({ op: z.literal("channel_remove"), id }).strict(),
	/** Replays the inverse an activity entry carries (`BotActivity.undo`). */
	z.object({ op: z.literal("undo"), activity: id }).strict(),
]);
export type BotDeskEdit = z.infer<typeof BotDeskEditSchema>;

/** The ops whose change the desk itself makes (no session to create or delete, no activity to look up). */
export type BotDeskChange = Exclude<BotDeskEdit, { op: "channel_add" | "channel_remove" | "undo" }>;
