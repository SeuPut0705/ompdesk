/**
 * Settings › Bot › "Generate…": the app draws the bot's avatar on the image model role itself, with no turn of the bot
 * (`BOT_AVATAR_STATUS`, `BOT_AVATAR_GENERATE`). The drawing runs in a live local omp's bridge (`bot-avatar.ts`, stock's
 * `generate_image` over that session's registry and settings): the bot's own tab when it is open, else the asking
 * window's active tab. Main cuts the picture to the desk's avatar and records it as the owner's identity change, so
 * the activity log keeps it with Undo.
 */
import { z } from "zod";
import {
	BOT_AVATAR_GENERATE,
	BOT_AVATAR_PROMPT_MAX,
	BOT_AVATAR_STATUS,
	type BotAvatarAnswer,
	type BotAvatarImage,
} from "../../../resources/gui-bridge/bot-avatar-contracts";
import type { SidecarLike } from "../sidecar-types";
import { type BotDesk, BotDeskError } from "./bot-desk";

/** One request to a live omp's bridge (`SidecarLike.bridgeRequest`). */
export type AvatarBridge = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;

/** Stock's own image request gives up after 3 minutes (`tools/image-gen`); the bridge waits a little longer. */
const GENERATE_WAIT_MS = 200_000;

/** The owner's description, as the dialog sends it. */
export const BotAvatarPromptSchema = z.string().trim().min(1).max(BOT_AVATAR_PROMPT_MAX);

export const NO_SESSION_MESSAGE = "Open any session first";

/** The part of a tab's sidecar the avatar reads: whether it is local and ready, and its bridge. */
export type AvatarSidecar = Pick<SidecarLike, "status" | "device" | "bridgeRequest">;

/** A local omp whose bridge answers now; a paired host's or a starting tab has none to ask. */
export function liveBridge(sidecar: AvatarSidecar | null): AvatarBridge | null {
	if (!sidecar || sidecar.device !== undefined || sidecar.status !== "ready" || !sidecar.bridgeRequest) return null;
	return sidecar.bridgeRequest.bind(sidecar);
}

/** The tabs the bot's session and a window's active tab are asked through (`SidecarPool`). */
export interface AvatarTabs {
	sessionOwner(sessionPath: string): { tabId: string } | null;
	sidecarOf(tabId: string): AvatarSidecar | null;
}

/** The bot's own tab when it is open and ready, else the asking window's active tab, else none. */
export function avatarBridge(
	tabs: AvatarTabs,
	botSessionPath: string | null,
	windowSidecar: AvatarSidecar | null,
): AvatarBridge | null {
	const owner = botSessionPath ? tabs.sessionOwner(botSessionPath) : null;
	return liveBridge(owner ? tabs.sidecarOf(owner.tabId) : null) ?? liveBridge(windowSidecar);
}

/** Whether the image role can draw, without drawing. A bridge that does not answer reads as unavailable. */
export async function avatarStatus(bridge: AvatarBridge | null): Promise<BotAvatarAnswer> {
	if (!bridge) return { available: false, reason: "no_session" };
	try {
		return (await bridge(BOT_AVATAR_STATUS)) as BotAvatarAnswer;
	} catch {
		return { available: false, reason: "unavailable" };
	}
}

export interface AvatarDrawDeps {
	desk: Pick<BotDesk, "change">;
	/** `bot-avatar.ts` `avatarFromBuffer`: the centre square at the desk's size, as a data URL. */
	avatarFromBuffer(bytes: Buffer): string | Promise<string>;
}

/** Draws the avatar on the image role through `bridge` and sets it as the owner's own identity change. */
export async function generateAvatar(deps: AvatarDrawDeps, bridge: AvatarBridge | null, prompt: string): Promise<void> {
	if (!bridge) throw new BotDeskError(NO_SESSION_MESSAGE);
	const image = (await bridge(BOT_AVATAR_GENERATE, { prompt }, GENERATE_WAIT_MS)) as BotAvatarImage;
	if (typeof image?.base64 !== "string" || !image.base64)
		throw new BotDeskError("The image model returned no picture.");
	const dataUrl = await deps.avatarFromBuffer(Buffer.from(image.base64, "base64"));
	deps.desk.change({ op: "identity", avatar: { kind: "image", dataUrl } }, "owner");
}
