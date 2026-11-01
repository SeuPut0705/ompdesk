/**
 * The one path for an edit of the bot's desk (`BotDeskEdit`): the owner's window and a paired device's request
 * (`host.botDesk.edit`) both come here. Most edits are the desk's own (`BotDesk.change`); a side chat is a session
 * made or deleted first.
 */
import type { BotDeskEdit } from "../../shared/bot-desk-edit";
import { type BotDesk, type BotDeskActor, BotDeskError } from "./bot-desk";

export interface BotDeskEditDeps {
	desk: BotDesk;
	/** Makes the side chat's session (`BotHome.createSideChat`) and answers its file. */
	createSideChat(topic: string): Promise<string>;
	/** Deletes a session as the sidebar's Delete does (its tab closes first; refused while it runs a turn). */
	deleteSession(sessionPath: string): Promise<void>;
}

export async function editBotDesk(deps: BotDeskEditDeps, edit: BotDeskEdit, by: BotDeskActor): Promise<void> {
	const { desk } = deps;
	switch (edit.op) {
		case "channel_add": {
			desk.assertChannelRoom();
			const sessionPath = await deps.createSideChat(edit.title);
			desk.addChannel(edit.title, sessionPath, by);
			return;
		}
		case "channel_remove": {
			const channel = desk.state().channels.find(entry => entry.id === edit.id);
			if (!channel) throw new BotDeskError(`No side chat "${edit.id}" is kept.`);
			await deps.deleteSession(channel.sessionPath);
			desk.removeChannel(channel.id, by);
			return;
		}
		default:
			desk.change(edit, by);
	}
}
