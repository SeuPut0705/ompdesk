/**
 * The one path for an edit of the bot's desk (`BotDeskEdit`): the owner's window, a paired device's request
 * (`host.botDesk.edit`) and an Undo all come here. Most edits are the desk's own (`BotDesk.change`); a side chat is a
 * session made or deleted first, and an Undo replays the inverse an activity entry carries, once.
 */
import type { BotDeskEdit } from "../../shared/bot-desk-edit";
import type { BotActivityLog } from "./bot-activity";
import { type BotDesk, type BotDeskActor, BotDeskError, isDeskChange } from "./bot-desk";

export interface BotDeskEditDeps {
	desk: BotDesk;
	activity: BotActivityLog;
	/** Makes the side chat's session (`BotHome.createSideChat`) and answers its file. */
	createSideChat(topic: string): Promise<string>;
	/** Deletes a session as the sidebar's Delete does (its tab closes first; refused while it runs a turn). */
	deleteSession(sessionPath: string): Promise<void>;
	/** Hands the bot a request from the owner as a message that starts its turn (`AgentControlRuntime.botAsked`). */
	askBot(text: string): Promise<void>;
}

export async function editBotDesk(deps: BotDeskEditDeps, edit: BotDeskEdit, by: BotDeskActor): Promise<void> {
	const { desk, activity } = deps;
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
		case "avatar_generate":
			await deps.askBot(
				`Make yourself a new avatar: ${edit.description}\nDraw one square picture with generate_image, then set it with ompdesk_bot {"action":"identity","avatar_file":"<the picture's absolute path>"}.`,
			);
			return;
		case "undo": {
			const entry = activity.get(edit.activity);
			if (!entry) throw new BotDeskError("That activity is no longer in the log.");
			if (entry.undone) throw new BotDeskError("That change was already undone.");
			if (!entry.undo || !isDeskChange(entry.undo)) throw new BotDeskError("That change cannot be undone.");
			desk.change(entry.undo, "owner");
			activity.markUndone(entry.id);
			return;
		}
		default:
			desk.change(edit, by);
	}
}
