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
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, shortenPath } from "../../lib/format";
import { pathMatcher } from "../../lib/fuzzy-score";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listboxTarget } from "../../lib/listbox-nav";
import { useProjectNames } from "../../lib/project-origin";
import { pickWorkspaceDirectory, selectFocusedTabProject } from "../../lib/workspace-dirs";
import { useFocusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { Button, Modal, OptionRow, SearchField } from "../common";

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

	const nameOf = (ws: WorkspaceRow) => (device === undefined ? projectNameOf(ws.cwd).name : ws.name);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const listboxId = useId();
	// Name first (a project named like the query wins), then anywhere in its folder's path; recency breaks ties.
	const shown = useMemo(() => {
		const text = query.trim().normalize("NFC");
		if (!text) return workspaces;
		const match = pathMatcher(text);
		return workspaces
			.map((ws, order) => {
				const name = device === undefined ? projectNameOf(ws.cwd).name : ws.name;
				return { ws, order, score: match(`${ws.cwd}/${name}`, false)?.score };
			})
			.filter((row): row is { ws: WorkspaceRow; order: number; score: number } => row.score !== undefined)
			.sort((a, b) => b.score - a.score || a.order - b.order)
			.map(row => row.ws);
	}, [query, workspaces, projectNameOf, device]);
	const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
	const optionId = (index: number) => `${listboxId}-${index}`;

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

	const onFilterKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "Enter") {
			const target = shown[activeIndex];
			if (!target) return;
			event.preventDefault();
			void pick(target.cwd);
			return;
		}
		const next = listboxTarget(event.key, activeIndex, shown.length, { wrap: false });
		if (next === null || event.key === "Home" || event.key === "End") return;
		event.preventDefault();
		setActive(next);
		document.getElementById(optionId(next))?.scrollIntoView?.({ block: "nearest" });
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
				<Button
					className="justify-start border-dashed"
					icon={<FolderPlus aria-hidden />}
					onClick={() => void addWorkspace()}
					size="lg"
				>
					{t("workspaces.add")}
				</Button>

				{workspaces.length > 0 && (
					<SearchField
						autoFocus
						label={t("workspaces.filter")}
						listbox={{ id: listboxId, activeId: shown.length > 0 ? optionId(activeIndex) : undefined }}
						onKeyDown={onFilterKey}
						onValueChange={value => {
							setQuery(value);
							setActive(0);
						}}
						placeholder={t("workspaces.filter")}
						value={query}
					/>
				)}

				<div
					aria-label={t("workspaces.title")}
					className="max-h-[46vh] overflow-y-auto"
					id={listboxId}
					role={shown.length > 0 ? "listbox" : undefined}
				>
					{workspaces.length === 0 ? (
						<div className="px-2 py-8 text-center text-sc-md text-(--sc-text-muted)">{t("workspaces.empty")}</div>
					) : shown.length === 0 ? (
						<div className="px-2 py-8 text-center text-sc-md text-(--sc-text-muted)">
							{t("workspaces.noMatch")}
						</div>
					) : (
						shown.map((ws, index) => {
							const isCurrent = ws.cwd === cwd;
							return (
								<OptionRow
									active={index === activeIndex}
									aria-current={isCurrent ? "true" : undefined}
									id={optionId(index)}
									key={ws.cwd}
									onClick={() => void pick(ws.cwd)}
									onPointerMove={() => setActive(index)}
									pointerMoves
								>
									<Folder aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
									<span className="min-w-0 flex-1">
										<span className="flex min-w-0 items-baseline gap-2">
											<span className="truncate text-sc-md text-(--sc-text)">{nameOf(ws)}</span>
											{ws.sessionCount > 0 && (
												<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
													{t("workspaces.sessionCount", { count: ws.sessionCount })}
												</span>
											)}
										</span>
										{/* Middle-truncated: two projects deep under one parent differ only at the tail. */}
										<span className="block truncate text-sc-sm text-(--sc-text-muted)" title={ws.cwd}>
											{shortenPath(ws.cwd)}
										</span>
									</span>
									{isCurrent ? (
										<span className="flex shrink-0 items-center gap-1 text-sc-xs font-medium text-(--sc-text-secondary)">
											<Check aria-hidden className="size-(--sc-icon-sm)" />
											{t("workspaces.current")}
										</span>
									) : null}
								</OptionRow>
							);
						})
					)}
				</div>
			</div>
		</Modal>
	);
}
