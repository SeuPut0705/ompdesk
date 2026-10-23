/**
 * Right-click menu for links in replies. Web links: open in the Preview
 * panel, open in the browser, copy. Mail links: open in the mail app, copy
 * the address. Local paths: the file's own menu (file-actions.tsx: preview,
 * open or show it where it lives, save a copy here, copy the path).
 */
import { AppWindow, Copy, Globe, Mail } from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import {
	anchorFromEvent,
	ContextMenu,
	type ContextMenuAnchor,
	type ContextMenuItem,
} from "../components/common/ContextMenu";
import { fileActionItems, useFileSurface } from "../components/tools/media/file-actions";
import { toast } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { copyText } from "./format";
import { useT } from "./i18n";
import { openExternal } from "./open-external";

export type LinkMenuTarget = { kind: "web"; url: string } | { kind: "path"; path: string; line?: number; dir: boolean };

/** `onContextMenu` takes the target, or a promise of it while a path is still being checked (null = no menu). */
export function useLinkMenu(tabId: string | null): {
	onContextMenu: (event: MouseEvent<HTMLElement>, target: LinkMenuTarget | Promise<LinkMenuTarget | null>) => void;
	menu: ReactNode;
} {
	const t = useT();
	const surface = useFileSurface(tabId);
	const [open, setOpen] = useState<{ anchor: ContextMenuAnchor; target: LinkMenuTarget } | null>(null);

	const copy = async (text: string) => {
		if (await copyText(text)) toast({ variant: "success", message: t("common.copied") });
		else toast({ variant: "error", message: t("common.copyFailed") });
	};
	const items = (target: LinkMenuTarget): ContextMenuItem[] => {
		if (target.kind === "web") {
			if (/^mailto:/i.test(target.url))
				return [
					{
						id: "mail",
						label: t("markdown.link.openMail"),
						icon: Mail,
						onSelect: () => openExternal(target.url),
					},
					{
						id: "copy",
						label: t("markdown.link.copyAddress"),
						icon: Copy,
						onSelect: () => void copy(decodeURIComponent(target.url.replace(/^mailto:/i, ""))),
					},
				];
			return [
				{
					id: "preview",
					label: t("markdown.link.openPreview"),
					icon: AppWindow,
					onSelect: () => useUiStore.getState().openPreview(target.url),
				},
				{
					id: "browser",
					label: t("markdown.link.openBrowser"),
					icon: Globe,
					onSelect: () => openExternal(target.url),
				},
				{
					id: "copy",
					label: t("markdown.link.copy"),
					icon: Copy,
					separatorBefore: true,
					onSelect: () => void copy(target.url),
				},
			];
		}
		return fileActionItems({ ...target, tabId, surface, t });
	};

	return {
		onContextMenu: (event, target) => {
			const anchor = anchorFromEvent(event);
			void Promise.resolve(target).then(next => {
				if (next) setOpen({ anchor, target: next });
			});
		},
		// React bubbles portal events through the link's ancestors; a tool card's
		// disclosure row must not toggle when a menu item is chosen.
		menu: open ? (
			<span
				className="contents"
				onClick={event => event.stopPropagation()}
				onKeyDown={event => event.stopPropagation()}
				onPointerDown={event => event.stopPropagation()}
			>
				<ContextMenu
					ariaLabel={t("markdown.link.menu")}
					// ContextMenu leaves closing to its owner: a choice closes the menu first.
					items={items(open.target).map(item => ({
						...item,
						onSelect: () => {
							setOpen(null);
							item.onSelect();
						},
					}))}
					onClose={() => setOpen(null)}
					x={open.anchor.x}
					y={open.anchor.y}
				/>
			</span>
		) : null,
	};
}
