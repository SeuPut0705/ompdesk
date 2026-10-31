/**
 * The owner's edits of the bot's desk (`BOT_DESK_EDIT`, `host.botDesk.edit`) and the Memory.md files they export and
 * import. Apart from `bot-desk.ts`, which a paired phone's first screen loads: these are main's and the bot's lazy
 * screens' only.
 */
import { z } from "zod";
import {
	BOT_CHANNEL_TITLE_MAX,
	BOT_MEMORIES_MAX,
	BOT_MEMORY_TEXT_MAX,
	BOT_NOTIFY_ROUTES,
	BOT_PERSONA_MAX,
	BOT_PROGRESS_EVERY,
	BOT_TAGLINE_MAX,
	BotAvatarSchema,
	BotDeskDutiesSchema,
	type BotMemory,
	BotMemorySchema,
} from "./bot-desk";

const id = z.string().min(1).max(64);
const route = z.enum(BOT_NOTIFY_ROUTES);
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

/** A memory file the owner exports (Memory.md): one memory per bullet, oldest first. */
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
