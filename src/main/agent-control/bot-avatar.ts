/**
 * A picture the bot made for its avatar (`ompdesk_bot {"action":"identity","avatar_file":…}`), as the desk keeps it:
 * the centre square, 128 px, as a PNG data URL (a JPEG one when the PNG would not fit `BOT_AVATAR_URL_MAX`). The
 * owner's own upload is cut the same way in the window (`components/bot/avatar-image.ts`).
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { nativeImage } from "electron";
import { BOT_AVATAR_URL_MAX } from "../../shared/bot-desk";
import { BotDeskError } from "./bot-desk";

export const BOT_AVATAR_PX = 128;
/** A source picture past this is refused before it is read. */
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;

export async function avatarFromFile(path: string): Promise<string> {
	if (!isAbsolute(path)) throw new BotDeskError("avatar_file needs an absolute path.");
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) throw new BotDeskError(`No picture at ${path}.`);
	if (info.size > SOURCE_MAX_BYTES) throw new BotDeskError("The picture is larger than 25 MB.");
	const image = nativeImage.createFromBuffer(await readFile(path));
	if (image.isEmpty()) throw new BotDeskError("That file is not a PNG, JPEG or WebP picture.");
	const { width, height } = image.getSize();
	const side = Math.min(width, height);
	const square = image
		.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
		.resize({ width: BOT_AVATAR_PX, height: BOT_AVATAR_PX, quality: "best" });
	const png = `data:image/png;base64,${square.toPNG().toString("base64")}`;
	if (png.length <= BOT_AVATAR_URL_MAX) return png;
	return `data:image/jpeg;base64,${square.toJPEG(85).toString("base64")}`;
}
