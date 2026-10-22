/**
 * The Chats section of a device's list: one quiet header (fold, "Chats", new chat) under that device's projects, then
 * its chats and other no-project sessions. The sidebar has no Code/Chat switch (the user's call, 22 Oct 2026): code
 * projects come first and chats follow in the same list, this computer's and every paired host's alike.
 */
import { MessageCircle, MessageSquarePlus } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { IconButton } from "../../common";
import { SidebarFoldButton } from "./SidebarFoldButton";

export function SidebarChats({
	deviceId,
	count,
	filtering,
	newChatLabel,
	canAdd = true,
	onNewChat,
	newChatData,
	children,
}: {
	/** `LOCAL_DEVICE` or a paired host's id: whose fold this is. */
	deviceId: string;
	/** Rows to show; with none the header alone offers a new chat. */
	count: number;
	/** A filter is typed: every match shows, folded or not. */
	filtering: boolean;
	newChatLabel: string;
	canAdd?: boolean;
	onNewChat: () => void;
	/** The new-chat button's hook attribute (this device's `data-sidebar-new-chat`, a host's `data-sidebar-device-new-chat`). */
	newChatData: Record<string, string>;
	children: ReactNode;
}) {
	const t = useT();
	const storedFold = useSidebarFolds(s => s.chats[deviceId] === true);
	const folded = !filtering && storedFold;
	return (
		<section aria-label={t("sidebar.chats")} className="mt-1" data-sidebar-chats={deviceId}>
			<div className="group/head flex h-8 items-center rounded-(--sc-radius-md) hover:bg-(--sc-hover)">
				<SidebarFoldButton
					className="text-(--sc-text-muted) hover:text-(--sc-text)"
					data-roving-item={`chats:${deviceId}`}
					data-sidebar-chats-toggle={deviceId}
					folded={folded}
					icon={<MessageCircle aria-hidden className="size-(--sc-icon-sm) shrink-0" />}
					onClick={() => useSidebarFolds.getState().setChatsFolded(deviceId, !folded)}
					tabIndex={-1}
				>
					<span className="min-w-0 flex-1 truncate">{t("sidebar.chats")}</span>
					{folded && count > 0 && <span className="shrink-0 text-sc-2xs text-(--sc-text-subtle)">{count}</span>}
				</SidebarFoldButton>
				<IconButton
					className="mr-1 text-(--sc-text-subtle) hover:text-(--sc-text)"
					{...newChatData}
					// The next tab stop after the header while the header holds the list's roving focus (Sidebar.tsx).
					data-roving-action=""
					disabled={!canAdd}
					icon={<MessageSquarePlus />}
					label={newChatLabel}
					onClick={onNewChat}
					size="sm"
					tabIndex={-1}
				/>
			</div>
			{!folded && count > 0 && (
				<div className="space-y-px" data-chat-lane>
					{children}
				</div>
			)}
		</section>
	);
}
