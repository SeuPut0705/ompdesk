/**
 * The bot's avatar on a sidebar row (this computer's bot row, a paired host's in its device section). The animated
 * avatar (`BotAvatar.tsx`, its faces and motion) rides the bot's lazy module (`preloadBotDesk`), so a paired phone's
 * first screen does not carry it (scripts/check-main-bundle.ts); the row asks for that module itself. Until it lands
 * the row holds the avatar's box, the same size and still (rule://no-loading-screens), so nothing moves when it comes.
 */
import type { ComponentProps } from "react";
import type { LiveBotAvatar } from "./BotAvatar";
import { useBotDeskModule } from "./bot-tab";

export function RowBotAvatar(props: ComponentProps<typeof LiveBotAvatar>) {
	const module = useBotDeskModule(true);
	if (module) return <module.LiveBotAvatar {...props} />;
	const { avatar, label, state: _state, device: _device, tabId: _tabId, size: _size, ...data } = props;
	return (
		<span
			{...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
			{...data}
			className="inline-flex size-(--sc-icon-sm) shrink-0"
			data-bot-avatar={avatar.kind === "image" ? "image" : avatar.shape}
		/>
	);
}
