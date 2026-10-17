/**
 * Workspace manager (Codex-style): lists every known workspace (the cwds of
 * all sessions + the current project) with the current one highlighted, lets
 * the user jump to any of them (`setProject` → sidecar restarts there) or add
 * a new directory (native picker). Far richer than the bare breadcrumb picker.
 * On a remote tab every row, pick and new session is the tab's host: its
 * sessions, the remote folder picker (this dialog closes first), and
 * `openTab({device})`.
 */

import { Check, Folder, FolderPlus } from "lucide-react";
import { useMemo } from "react";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, cx, shortenPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useProjectNames } from "../../lib/project-origin";
import { pickWorkspaceDirectory, selectFocusedTabProject } from "../../lib/workspace-dirs";
import { useFocusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { Modal } from "../common";

interface WorkspaceRow {
	cwd: string;
	name: string;
	lastModified: number;
	sessionCount: number;
}

export function WorkspaceDialog({
	open,
	onClose,
	intent = "switch",
	thisDevice = false,
}: {
	open: boolean;
	onClose: () => void;
	/** "switch" = jump between workspaces (breadcrumb); "new-session" = the "+"
	 * button — picking a workspace starts a NEW session there. */
	intent?: "switch" | "new-session";
	/** New sessions on this device even while a remote tab is focused (the sidebar's local list). */
	thisDevice?: boolean;
}) {
	const t = useT();
	const focusedDevice = useFocusedTabDevice();
	const device = thisDevice ? undefined : focusedDevice;
	const { sessions } = useSessionList("global", device);
	const cwd = useSessionStore(s => s.cwd);
	const workspaceLastUsed = useSidebarPrefs(s => s.workspaceLastUsed);
	const openTab = useTabsStore(s => s.openTab);

	const workspaces = useMemo<WorkspaceRow[]>(() => {
		const byCwd = new Map<string, WorkspaceRow>();
		for (const session of sessions) {
			const modified = Date.parse(session.modified) || 0;
			const existing = byCwd.get(session.cwd);
			if (existing) {
				existing.sessionCount += 1;
				if (modified > existing.lastModified) existing.lastModified = modified;
			} else {
				byCwd.set(session.cwd, {
					cwd: session.cwd,
					name: basename(session.cwd) || session.cwd,
					lastModified: modified,
					sessionCount: 1,
				});
			}
		}
		// Ensure the current project appears even when it has no sessions yet.
		if (cwd && !byCwd.has(cwd)) {
			byCwd.set(cwd, { cwd, name: basename(cwd) || cwd, lastModified: 0, sessionCount: 0 });
		}
		for (const workspace of byCwd.values()) {
			workspace.lastModified = Math.max(workspace.lastModified, workspaceLastUsed[workspace.cwd] ?? 0);
		}
		return [...byCwd.values()].sort((a, b) => b.lastModified - a.lastModified);
	}, [sessions, cwd, workspaceLastUsed]);
	const projectNameOf = useProjectNames(
		useMemo(() => (device === undefined ? workspaces.map(ws => ws.cwd) : []), [device, workspaces]),
	);

	/** In-place workspace switches abort the active sidecar run. New-session
	 * intent opens an independent agent tab and does not need this guard. */
	const guardBusy = (): boolean => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (!isStreaming && !isCompacting) return false;
		toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
		return true;
	};

	const newSessionHere = async (target: string) => {
		const tabId = await openTab({ cwd: target, kind: "agent", device });
		if (tabId) onClose();
	};

	const pick = async (target: string) => {
		if (intent === "new-session") {
			await newSessionHere(target);
			return;
		}
		// The breadcrumb already points at this workspace.
		if (target === cwd) {
			onClose();
			return;
		}
		if (guardBusy()) return;
		// Breadcrumb switching deliberately re-roots the current tab.
		try {
			const ok = await window.omp.sidecar.setProject(target);
			if (!ok) {
				toast({ variant: "error", title: t("workspaces.switchFailed"), message: target });
				return;
			}
			onClose();
		} catch (error) {
			toastError({ title: t("workspaces.switchFailed"), error });
		}
	};

	const addWorkspace = async () => {
		if (intent === "switch" && guardBusy()) return;
		// The remote picker is a dialog of its own: never stack it on this one.
		if (device !== undefined) onClose();
		try {
			if (intent === "new-session") {
				const picked = await pickWorkspaceDirectory({ device });
				if (picked) await newSessionHere(picked);
				return;
			}
			if (await selectFocusedTabProject()) onClose();
		} catch (error) {
			toastError({ title: t("titlebar.openProjectFailed"), error });
		}
	};

	return (
		<Modal
			open={open}
			title={intent === "new-session" ? t("workspaces.newSessionTitle") : t("workspaces.title")}
			onClose={onClose}
			size="md"
		>
			<div className="flex flex-col gap-2">
				<button
					type="button"
					onClick={() => void addWorkspace()}
					className="omp-pressable flex min-h-10 items-center gap-2.5 rounded-(--sc-radius-md) border border-dashed border-(--sc-border-subtle) px-3 py-2.5 text-sc-md font-medium text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text)"
				>
					<FolderPlus aria-hidden className="size-(--sc-icon-md)" />
					{t("workspaces.add")}
				</button>

				<div className="max-h-[46vh] overflow-y-auto">
					{workspaces.length === 0 ? (
						<div className="px-2 py-8 text-center text-sc-md text-(--sc-text-muted)">{t("workspaces.empty")}</div>
					) : (
						workspaces.map(ws => {
							const isCurrent = ws.cwd === cwd;
							return (
								<button
									key={ws.cwd}
									type="button"
									onClick={() => void pick(ws.cwd)}
									className={cx(
										"omp-pressable group flex min-h-10 w-full items-center gap-3 rounded-(--sc-radius-md) px-2.5 py-2 text-left",
										isCurrent ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
									)}
								>
									<Folder aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
									<span className="min-w-0 flex-1">
										<span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
											<span className={cx("truncate text-sc-md font-medium text-(--sc-text)")}>
												{device === undefined ? projectNameOf(ws.cwd).name : ws.name}
											</span>
											{ws.sessionCount > 0 && (
												<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
													{t("workspaces.sessionCount", { count: ws.sessionCount })}
												</span>
											)}
										</span>
										{/* Middle-truncated: two projects deep under one parent differ only at the tail. */}
										<span className="block truncate text-sc-xs text-(--sc-text-muted)" title={ws.cwd}>
											{shortenPath(ws.cwd)}
										</span>
									</span>
									{isCurrent ? (
										<span className="flex shrink-0 items-center gap-1 text-sc-xs font-medium text-(--sc-text-secondary)">
											<Check aria-hidden className="size-(--sc-icon-sm)" />
											{t("workspaces.current")}
										</span>
									) : null}
								</button>
							);
						})
					)}
				</div>
			</div>
		</Modal>
	);
}
