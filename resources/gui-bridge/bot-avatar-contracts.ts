/**
 * Settings › Bot › "Generate…": the app draws the bot's avatar on the image model role itself, without a turn of the
 * bot (`bot-avatar.ts`). Dependency-free: main imports it for the method names and the shapes.
 */

export const BOT_AVATAR_STATUS = "bot_avatar.status";
export const BOT_AVATAR_GENERATE = "bot_avatar.generate";

/** The longest description the dialog takes (the desk edit's old `avatar_generate` limit). */
export const BOT_AVATAR_PROMPT_MAX = 500;

/** `no_model`: the image role resolves to no model that generates images; `no_credentials`: it resolves, but none is signed in. */
export type BotAvatarUnavailable = "no_model" | "no_credentials";

/** What `bot_avatar.status` answers, without a request to any model. */
export interface BotAvatarStatus {
	available: boolean;
	/** `provider/id` of the first model the image role's chain can use. */
	model?: string;
	reason?: BotAvatarUnavailable;
}

/** What `BOT_AVATAR_STATUS` answers the window: the bridge's status, or main's own "not asked": no open session to ask through, or a bridge that did not answer. */
export type BotAvatarAnswer = BotAvatarStatus | { available: false; reason: "no_session" | "unavailable" };

/** The first picture the image model drew. */
export interface BotAvatarImage {
	mimeType: string;
	base64: string;
}
