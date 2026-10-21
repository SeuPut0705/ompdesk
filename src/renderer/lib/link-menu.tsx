/**
 * Right-click menu for links in replies. Web links: open in the Preview
 * panel, open in the browser, copy. Mail links: open in the mail app, copy
 * the address. Local paths: open (viewer, or the Files tree for a folder),
 * open in the default app, reveal in Finder/Explorer, copy the path; the two
 * native actions are left out for a paired host's tab, whose files are not
 * on this machine.
 */
import { AppWindow, Copy, ExternalLink, FileText, FolderOpen, Globe, Mail } from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import {
	anchorFromEvent,
	ContextMenu,
	type ContextMenuAnchor,
	type ContextMenuItem,
} from "../components/common/ContextMenu";
import { useTabsStore } from "../stores/tabs";
import { toast, toastError } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { copyText } from "./format";
import { useT } from "./i18n";
import { PLATFORM } from "./keymap";
import { openExternal } from "./open-external";

export type LinkMenuTarget = { kind: "web"; url: string } | { kind: "path"; path: string; line?: number; dir: boolean };

/** `onContextMenu` takes the target, or a promise of it while a path is still being checked (null = no menu). */
export function useLinkMenu(tabId: string | null): {
	onContextMenu: (event: MouseEvent<HTMLElement>, target: LinkMenuTarget | Promise<LinkMenuTarget | null>) => void;
	menu: ReactNode;
} {
	const t = useT();
	const remote = useTabsStore(state => {
		const id = tabId ?? state.activeTabId;
		return state.tabs.some(tab => tab.id === id && tab.device !== undefined);
	});
	const [open, setOpen] = useState<{ anchor: ContextMenuAnchor; target: LinkMenuTarget } | null>(null);

	const copy = async (text: string) => {
		if (await copyText(text)) toast({ variant: "success", message: t("common.copied") });
		else toast({ variant: "error", message: t("common.copyFailed") });
	};
	const native = async (run: () => Promise<{ ok: boolean; error?: string }>) => {
		try {
			const result = await run();
			if (!result.ok) toastError({ title: t("markdown.link.nativeFailed"), error: result });
		} catch (cause) {
			toastError({ title: t("markdown.link.nativeFailed"), error: cause });
		}
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
		const { path, line, dir } = target;
		const list: ContextMenuItem[] = [
			{
				id: "open",
				label: t(dir ? "markdown.path.showInFiles" : "markdown.path.open"),
				icon: dir ? FolderOpen : FileText,
				onSelect: () =>
					dir
						? useUiStore.getState().revealInFiles(path)
						: useUiStore.getState().openFilePreview(path, line ? { line } : undefined),
			},
		];
		if (!remote)
			list.push(
				{
					id: "default-app",
					label: t("markdown.path.openDefault"),
					icon: ExternalLink,
					onSelect: () => void native(() => window.omp.system.openPath(path, tabId ?? undefined)),
				},
				{
					id: "reveal",
					label: t(PLATFORM === "windows" ? "markdown.path.revealExplorer" : "markdown.path.revealFinder"),
					icon: FolderOpen,
					onSelect: () => void native(() => window.omp.system.revealPath(path, tabId ?? undefined)),
				},
			);
		list.push({
			id: "copy",
			label: t("markdown.path.copy"),
			icon: Copy,
			separatorBefore: true,
			onSelect: () => void copy(path),
		});
		return list;
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
