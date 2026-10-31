/**
 * A picture the owner picks for the bot's avatar, as the desk keeps it: the centre square drawn at 128 px, a PNG data
 * URL (a JPEG one when the PNG is past `BOT_AVATAR_URL_MAX`). Drawn here, in the window, so a paired phone's page cuts
 * it the same way before it crosses the link; the bot's own pictures are cut in main (`agent-control/bot-avatar.ts`).
 */
import { BOT_AVATAR_PX, BOT_AVATAR_URL_MAX } from "../../../shared/bot-desk";

/** A picture past this is refused before it is decoded. */
export const BOT_AVATAR_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const BOT_AVATAR_ACCEPT = "image/png,image/jpeg,image/webp";

export class AvatarImageError extends Error {
	constructor(readonly reason: "type" | "size" | "decode") {
		super(reason);
	}
}

export async function avatarDataUrl(file: Blob): Promise<string> {
	if (!BOT_AVATAR_ACCEPT.split(",").includes(file.type)) throw new AvatarImageError("type");
	if (file.size > BOT_AVATAR_SOURCE_MAX_BYTES) throw new AvatarImageError("size");
	const bitmap = await createImageBitmap(file).catch(() => {
		throw new AvatarImageError("decode");
	});
	const side = Math.min(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	canvas.width = BOT_AVATAR_PX;
	canvas.height = BOT_AVATAR_PX;
	const context = canvas.getContext("2d");
	if (!context || side === 0) throw new AvatarImageError("decode");
	context.imageSmoothingQuality = "high";
	context.drawImage(
		bitmap,
		(bitmap.width - side) / 2,
		(bitmap.height - side) / 2,
		side,
		side,
		0,
		0,
		BOT_AVATAR_PX,
		BOT_AVATAR_PX,
	);
	bitmap.close();
	const png = canvas.toDataURL("image/png");
	return png.length <= BOT_AVATAR_URL_MAX ? png : canvas.toDataURL("image/jpeg", 0.85);
}
