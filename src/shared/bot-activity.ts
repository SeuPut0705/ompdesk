/**
 * The bot's activity log (Muse's Activity log, Grok's audit log): what the bot and the owner did, newest last. Main
 * alone keeps it (`<userData>/bot-activity.json`, `src/main/agent-control/bot-activity.ts`): every tool the bot's
 * sessions (its own and its side chats) ran, each desk change by either side, the notices it sent and the permissions
 * asked of the owner. An entry whose change can be taken back carries the edit that does it (`undo`); the owner replays
 * it once (`BOT_DESK_EDIT {op:"undo"}`), and the entry is then `undone`. Windows read it on demand (`BOT_ACTIVITY_GET`,
 * `host.botDesk.activity` for a paired host's), never by push.
 */
import { z } from "zod";
import { BotDeskEditSchema } from "./bot-desk-edit";

/** Entries the file keeps; the oldest go first. */
export const BOT_ACTIVITY_KEPT = 400;
/** Entries one read returns at most. */
export const BOT_ACTIVITY_PAGE = 200;
/** What `ompdesk_bot visited` / `activity` list when the bot names no limit. */
export const BOT_ACTIVITY_DEFAULT_LIMIT = 30;
export const BOT_ACTIVITY_TEXT_MAX = 240;

/**
 * - `read`: a file or page the bot read (a read tool, a search, a fetch, a browser visit); `target` names it.
 * - `change`: a file it wrote or edited. `run`: a command it ran. `sessions`: a session it opened, told, answered,
 *   stopped or scheduled (the control tools). `approval`: a permission asked of the owner, or one the bot gave a
 *   session, or the owner's rules changing.
 * - `notify`: a notice it sent the owner, or one the owner's routing held. `desk`: a duty, memory, identity, side
 *   chat or decision change, by the bot or the owner. `routine`: a routine run that ended (`routine_run`, session B's
 *   Schedules side appends it). `tool`: any other tool.
 */
export const BOT_ACTIVITY_KINDS = [
	"read",
	"change",
	"run",
	"sessions",
	"approval",
	"notify",
	"desk",
	"routine",
	"tool",
] as const;
export type BotActivityKind = (typeof BOT_ACTIVITY_KINDS)[number];

export const BotActivityTargetSchema = z.object({
	type: z.enum(["file", "url", "session", "query"]),
	value: z.string().min(1).max(2000),
});
export type BotActivityTarget = z.infer<typeof BotActivityTargetSchema>;

/**
 * What happened, as the log's rows name it (`botActivity.action.<action>` in the locales): `tool` is a tool call whose
 * `text` is the call in short ("read src/main/index.ts"); every other action's `text` is its subject (the memory, the
 * duty, the decision's question, the notice's title, the side chat's topic).
 */
export const BOT_ACTIVITY_ACTIONS = [
	"tool",
	"duty_add",
	"duty_remove",
	"duties_set",
	"decision_post",
	"decision_answer",
	"memory_add",
	"memory_edit",
	"memory_forget",
	"memory_restore",
	"memory_import",
	"identity",
	"notify_settings",
	"voice",
	"channel_add",
	"channel_remove",
	"notice_sent",
	"notice_held",
	"rules",
	"approval_asked",
	"routine_run",
] as const;
export type BotActivityAction = (typeof BOT_ACTIVITY_ACTIONS)[number];

export const BotActivitySchema = z.object({
	id: z.string().min(1).max(64),
	at: z.string(),
	kind: z.enum(BOT_ACTIVITY_KINDS),
	action: z.enum(BOT_ACTIVITY_ACTIONS),
	/** `bot` for its own sessions' doing, `owner` for a change made from the app. */
	by: z.enum(["bot", "owner"]),
	/** One line: the tool call in short, or the action's subject. */
	text: z.string().max(BOT_ACTIVITY_TEXT_MAX),
	/** The tool's name, for a tool call. */
	tool: z.string().max(80).optional(),
	target: BotActivityTargetSchema.optional(),
	/** How a routine run ended (`routine_run`); `text` names the routine. */
	outcome: z.enum(["succeeded", "failed", "stopped", "skipped"]).optional(),
	/** What started a routine run. */
	trigger: z.enum(["schedule", "manual", "event"]).optional(),
	/** More than the one line: a routine run's result or failure reason. */
	detail: z.string().max(1000).optional(),
	/** The side chat it happened in (`BotChannel.id`), when not the bot's main conversation. */
	channel: z.string().max(64).optional(),
	/** The edit that takes it back, while it can be. */
	undo: BotDeskEditSchema.optional(),
	undone: z.boolean().optional(),
});
export type BotActivity = z.infer<typeof BotActivitySchema>;

/** What an entry is made from: the log stamps `id` and `at`, and cuts `text`. */
export type BotActivityDraft = Omit<BotActivity, "id" | "at" | "undone">;

/** `BOT_ACTIVITY_GET`'s reply and `host.botDesk.activity`'s: the newest entries, oldest first, and the log's revision. */
export const BotActivityPageSchema = z.object({
	entries: z.array(BotActivitySchema),
	/** Bumped by every change; a reader that holds this revision has nothing new to read. */
	revision: z.number().int().nonnegative(),
});
export type BotActivityPage = z.infer<typeof BotActivityPageSchema>;

/** The files and pages the bot read, newest first, each once (`ompdesk_bot {"action":"visited"}`, the log's filter). */
export function botVisited(entries: readonly BotActivity[]): BotActivity[] {
	const seen = new Set<string>();
	const visited: BotActivity[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.kind !== "read" || !entry.target) continue;
		const key = `${entry.target.type}\n${entry.target.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		visited.push(entry);
	}
	return visited;
}
