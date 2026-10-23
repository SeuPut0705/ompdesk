/**
 * What a person can do with a file the conversation names, by where they sit: one rule for the
 * cards under a reply or a prompt (FileCard), their ⋯ menu, and a link's right-click menu
 * (lib/link-menu.tsx).
 *
 * - This computer's tab: preview, open in the default app, show in Finder/Explorer, save a copy,
 *   copy the path. The card's own button shows the file in Finder/Explorer.
 * - A paired host's tab in a desktop window: the file is on the host, so preview, save it to this
 *   computer (the card's own button), copy the path; nothing native here can open it.
 * - The phone's page: preview, save it to the phone (its own button), open or show it on the
 *   computer (the host actions of shim.ts), copy the path.
 */
import { Copy, Download, ExternalLink, Eye, FolderOpen, type LucideIcon, MoreHorizontal } from "lucide-react";
import { copyText } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { PLATFORM } from "../../../lib/keymap";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { webPwa } from "../../../web/pwa";
import { type ContextMenuItem, MenuButton } from "../../common/ContextMenu";
import { IconButton } from "../../common/IconButton";

/** Where the person looking at the file sits, which decides how they reach it. */
export type FileSurface = "local" | "remote" | "web";

/** The surface for a tab's files in this window. */
export function useFileSurface(tabId: string | null): FileSurface {
	const remote = useTabsStore(state => {
		const id = tabId ?? state.activeTabId;
		return state.tabs.some(tab => tab.id === id && tab.device !== undefined);
	});
	if (webPwa()) return "web";
	return remote ? "remote" : "local";
}

type Translate = ReturnType<typeof useT>;

export interface FileActionContext {
	path: string;
	line?: number;
	dir: boolean;
	tabId: string | null;
	surface: FileSurface;
	t: Translate;
}

async function runNative(t: Translate, run: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
	try {
		const result = await run();
		if (!result.ok) toastError({ title: t("markdown.link.nativeFailed"), error: result });
	} catch (cause) {
		toastError({ title: t("markdown.link.nativeFailed"), error: cause });
	}
}

/** Save a copy where this device picks; says where it went, with a way to it on this computer. */
export async function saveFileCopy(context: Pick<FileActionContext, "path" | "tabId" | "surface" | "t">) {
	const { path, tabId, surface, t } = context;
	try {
		const result = await window.omp.fs.saveCopy(path, tabId ?? undefined);
		if (result.cancelled) return;
		if (!result.ok) {
			toastError({ title: t("fileCard.saveFailed"), error: result });
			return;
		}
		const savedTo = result.savedTo;
		toast({
			variant: "success",
			message: surface === "web" ? t("fileCard.savedPhone") : t("fileCard.saved", { path: savedTo ?? "" }),
			action:
				savedTo && surface !== "web"
					? {
							label: t(PLATFORM === "windows" ? "markdown.path.revealExplorer" : "markdown.path.revealFinder"),
							run: () => void runNative(t, () => window.omp.fs.revealCopy(savedTo)),
						}
					: undefined,
		});
	} catch (cause) {
		toastError({ title: t("fileCard.saveFailed"), error: cause });
	}
}

export async function copyFilePath(path: string, t: Translate): Promise<void> {
	if (await copyText(path)) toast({ variant: "success", message: t("common.copied") });
	else toast({ variant: "error", message: t("common.copyFailed") });
}

export function previewFile(path: string, dir: boolean, line?: number): void {
	if (dir) useUiStore.getState().revealInFiles(path);
	else useUiStore.getState().openFilePreview(path, line ? { line } : undefined);
}

function revealLabel(surface: FileSurface): string {
	if (surface === "web") return "fileCard.revealOnComputer";
	return PLATFORM === "windows" ? "markdown.path.revealExplorer" : "markdown.path.revealFinder";
}

/** The menu of a file: what the person here can do with it, in one order everywhere. */
export function fileActionItems(context: FileActionContext): ContextMenuItem[] {
	const { path, line, dir, tabId, surface, t } = context;
	const tab = tabId ?? undefined;
	const items: ContextMenuItem[] = [
		{
			id: "open",
			label: t(dir ? "markdown.path.showInFiles" : "fileCard.preview"),
			icon: dir ? FolderOpen : Eye,
			onSelect: () => previewFile(path, dir, line),
		},
	];
	if (surface !== "remote") {
		if (!dir)
			items.push({
				id: "default-app",
				label: t(surface === "web" ? "fileCard.openOnComputer" : "markdown.path.openDefault"),
				icon: ExternalLink,
				onSelect: () => void runNative(t, () => window.omp.system.openPath(path, tab)),
			});
		items.push({
			id: "reveal",
			label: t(revealLabel(surface)),
			icon: FolderOpen,
			onSelect: () => void runNative(t, () => window.omp.system.revealPath(path, tab)),
		});
	}
	if (!dir)
		items.push({
			id: "save",
			label: t(
				surface === "local" ? "fileCard.saveCopy" : surface === "web" ? "fileCard.savePhone" : "fileCard.saveHere",
			),
			icon: Download,
			onSelect: () => void saveFileCopy({ path, tabId, surface, t }),
		});
	items.push({
		id: "copy",
		label: t("markdown.path.copy"),
		icon: Copy,
		separatorBefore: true,
		onSelect: () => void copyFilePath(path, t),
	});
	return items;
}

export interface PrimaryFileAction {
	id: "reveal" | "save";
	label: string;
	icon: LucideIcon;
	run: () => void;
}

/**
 * The one action a card shows beside its menu: where the file is on this computer, or, when it
 * is on another one, bringing it here.
 */
export function primaryFileAction(context: Omit<FileActionContext, "line">): PrimaryFileAction | null {
	const { path, dir, tabId, surface, t } = context;
	if (surface === "local")
		return {
			id: "reveal",
			label: t(revealLabel(surface)),
			icon: FolderOpen,
			run: () => void runNative(t, () => window.omp.system.revealPath(path, tabId ?? undefined)),
		};
	if (dir) return null;
	return {
		id: "save",
		label: t(surface === "web" ? "fileCard.savePhone" : "fileCard.saveHere"),
		icon: Download,
		run: () => void saveFileCopy({ path, tabId, surface, t }),
	};
}

/**
 * A file's own buttons: its place (show it in Finder/Explorer here, or save it here) and a ⋯ menu
 * with the rest, for the tab this file belongs to. A file that is gone has none.
 */
export function FileActions({
	path,
	name,
	dir = false,
	disabled = false,
}: {
	path: string;
	name: string;
	dir?: boolean;
	disabled?: boolean;
}) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const surface = useFileSurface(tabId);
	if (disabled) return null;
	const primary = primaryFileAction({ path, dir, tabId, surface, t });
	const PrimaryIcon = primary?.icon;
	return (
		<span className="omp-file-card-actions">
			{primary && PrimaryIcon ? (
				<IconButton
					data-file-card-action={primary.id}
					icon={<PrimaryIcon />}
					label={primary.label}
					onClick={event => {
						event.stopPropagation();
						primary.run();
					}}
					size="sm"
				/>
			) : null}
			<MenuButton
				className="omp-file-card-more"
				icon={<MoreHorizontal />}
				items={fileActionItems({ path, dir, tabId, surface, t })}
				label={t("fileCard.actions", { name })}
				size="sm"
				variant="ghost"
			/>
		</span>
	);
}
