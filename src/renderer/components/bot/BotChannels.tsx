/**
 * The bot's side chats (Muse's side chats, Duet's channels) as a section of its work board: one row per topic that
 * opens its session (its own tab, the bot's bar on top, the same desk, memory and rules), a menu to delete it, and a
 * field to start one. Main makes and deletes the session (`BOT_DESK_EDIT channel_add / channel_remove`); the row comes
 * and goes when the desk's push lands.
 */
import { Hash, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { BOT_CHANNEL_TITLE_MAX, BOT_CHANNELS_MAX, type BotChannel } from "../../../shared/bot-desk";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useTabsStore } from "../../stores/tabs";
import { ConfirmDialog, IconButton, Input, LinkButton, MenuButton } from "../common";
import { BoardRow, KindMark } from "../layout/work-board/board-parts";

/** Its tab when one holds it, else a new tab on the session (on the paired host for a host's bot). */
export function openBotChannel(channel: BotChannel, device?: string): void {
	const tabs = useTabsStore.getState();
	const held = tabs.tabs.find(tab => tab.sessionPath === channel.sessionPath && tab.device === device);
	if (held) {
		void tabs.switchTab(held.id);
		return;
	}
	void tabs.openTab({ sessionPath: channel.sessionPath, kind: "chat", ...(device === undefined ? {} : { device }) });
}

export function BotChannelRows({ channels, device }: { channels: readonly BotChannel[]; device?: string }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState(false);
	const [deleting, setDeleting] = useState<BotChannel | null>(null);
	const full = channels.length >= BOT_CHANNELS_MAX;
	const create = async () => {
		const title = draft.trim();
		if (!title || full || pending) return;
		setPending(true);
		const ok = await edit({ op: "channel_add", title }, device);
		setPending(false);
		if (ok) setDraft("");
	};
	return (
		<>
			{channels.map(channel => (
				<BoardRow
					action={
						<MenuButton
							align="end"
							icon={<MoreHorizontal />}
							items={[
								{
									id: "delete",
									label: t("botChannels.delete"),
									icon: Trash2,
									danger: true,
									onSelect: () => setDeleting(channel),
								},
							]}
							label={t("botChannels.menu", { title: channel.title })}
							size="sm"
						/>
					}
					data={{ "data-bot-channel": channel.id }}
					key={channel.id}
					title={channel.title}
					lead={<KindMark icon={Hash} tone="muted" />}
					label={
						<LinkButton data-bot-channel-open={channel.id} onClick={() => openBotChannel(channel, device)}>
							{channel.title}
						</LinkButton>
					}
				/>
			))}
			<li className="omp-work-board-item flex items-center gap-1.5 py-1">
				<div className="min-w-0 flex-1">
					<Input
						aria-label={t("botChannels.topic")}
						controlSize="sm"
						data-bot-channel-input
						disabled={full || pending}
						maxLength={BOT_CHANNEL_TITLE_MAX}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								void create();
							}
						}}
						placeholder={
							full
								? t("botChannels.full", { count: String(BOT_CHANNELS_MAX) })
								: t("botChannels.topicPlaceholder")
						}
						value={draft}
					/>
				</div>
				<IconButton
					data-bot-channel-add
					disabled={full || pending || draft.trim() === ""}
					icon={<Plus />}
					label={t("botChannels.new")}
					onClick={() => void create()}
					size="sm"
				/>
			</li>
			<ConfirmDialog
				confirmLabel={t("botChannels.delete")}
				message={t("botChannels.deleteMessage", { title: deleting?.title ?? "" })}
				onCancel={() => setDeleting(null)}
				onConfirm={() => {
					const target = deleting;
					setDeleting(null);
					if (target) void edit({ op: "channel_remove", id: target.id }, device);
				}}
				open={deleting !== null}
				title={t("botChannels.deleteTitle")}
			/>
		</>
	);
}
