/**
 * The owner's edits of the bot's desk (`BOT_DESK_EDIT`, `host.botDesk.edit`). Apart from `bot-desk.ts`, which a
 * paired phone's first screen loads: these are main's and the bot's lazy screens' only.
 */
import { z } from "zod";
import {
	BOT_CHANNEL_TITLE_MAX,
	BOT_NOTIFY_ROUTES,
	BOT_PERSONA_MAX,
	BOT_PROGRESS_EVERY,
	BOT_TAGLINE_MAX,
	BOT_TASKS_DONE_MAX,
	BotAvatarSchema,
} from "./bot-desk";

const id = z.string().min(1).max(64);
const route = z.enum(BOT_NOTIFY_ROUTES);

/**
 * IPC: `BOT_DESK_EDIT`'s payload, one change the owner makes. The bot keeps its own memory and duties (`ompdesk_bot`),
 * so none is editable here. `channel_add` and `channel_remove` make or delete a session, which main does before the
 * desk records it.
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
	/** Pause the bot (no mail starts its turn, its running turn stops) or resume it. */
	z.object({ op: z.literal("paused"), paused: z.boolean() }).strict(),
	/** Mark tasks (sessions the bot opened, by session file) done, or take the mark back. */
	z
		.object({
			op: z.literal("tasks_done"),
			sessions: z.array(z.string().min(1).max(4096)).min(1).max(BOT_TASKS_DONE_MAX),
			done: z.boolean(),
		})
		.strict(),
	/** Pin a Library item to its top, or unpin it; `key` is the item's own (`components/bot/bot-library.ts`). */
	z.object({ op: z.literal("library_pin"), key: z.string().min(1).max(4096), pinned: z.boolean() }).strict(),
]);
export type BotDeskEdit = z.infer<typeof BotDeskEditSchema>;

export type BotDeskChange = Exclude<BotDeskEdit, { op: "channel_add" | "channel_remove" }>;
