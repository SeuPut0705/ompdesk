/**
 * Settings › Project folders (TUI /dirs /add-dir /remove-dir /move parity):
 * lists the current session's folders with the primary (cwd) badge, adds
 * folders via the native directory picker, removes non-primary folders behind
 * a confirm, and moves the session file's cwd association to a picked folder
 * (move_session → toast + session rehydrate). Loads on mount and whenever the
 * tab or session changes. Mutations are blocked while streaming — the server
 * also refuses with the "busy" code.
 */
import { FolderGit2, FolderPlus, PackageOpen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RpcWorkspaceDirectoriesResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import {
	addWorkspaceDirectory,
	moveSessionTo,
	pickFocusedTabDirectory,
	type RpcWorkspaceDirectory,
	removeWorkspaceDirectory,
} from "../../lib/workspace-dirs";
import { useSessionStore } from "../../stores/session";
import { Badge, Banner, Button, ConfirmDialog, ErrorDetail, IconButton, ListRow, SkeletonRows } from "../common";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

export function WorkspaceSection() {
	const tabRpc = useTabRpc();
	const t = useT();
	const busy = useSessionStore(state => state.isStreaming || state.isCompacting);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const sessionId = useSessionStore(state => state.sessionId);
	const [directories, setDirectories] = useState<RpcWorkspaceDirectory[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mutating, setMutating] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		if (!sidecarReady) {
			setError(t("sidecar.notResponding"));
			setLoading(false);
			return;
		}
		try {
			const response = await tabRpc.getDirectories();
			if (response.success) {
				setDirectories((response.data as RpcWorkspaceDirectoriesResult | undefined)?.directories ?? []);
			} else {
				setError(response.error);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [sidecarReady, t, tabRpc.getDirectories]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a session switch re-scopes the folder list.
	useEffect(() => {
		setConfirmRemove(null);
		void reload();
	}, [reload, sessionId]);

	const onAdd = async (): Promise<void> => {
		if (!sidecarReady) return;
		const path = await pickFocusedTabDirectory();
		if (!path) return;
		setMutating(true);
		try {
			const result = await addWorkspaceDirectory(path);
			if (result) setDirectories(result);
		} finally {
			setMutating(false);
		}
	};

	const onRemove = async (path: string): Promise<void> => {
		setConfirmRemove(null);
		if (!sidecarReady) return;
		setMutating(true);
		try {
			const result = await removeWorkspaceDirectory(path);
			if (result) setDirectories(result);
		} finally {
			setMutating(false);
		}
	};

	const onMove = async (): Promise<void> => {
		if (!sidecarReady) return;
		const path = await pickFocusedTabDirectory();
		if (!path) return;
		setMutating(true);
		try {
			const moved = await moveSessionTo(path);
			// move_session returns only the new cwd — refetch for the post-move list.
			if (moved) await reload();
		} finally {
			setMutating(false);
		}
	};

	const blockedReason = !sidecarReady ? t("sidecar.notResponding") : busy ? t("workspaceDirs.busy") : undefined;
	const mutationDisabled = mutating || busy || loading || !sidecarReady;
	const addButton = (
		<Button
			disabled={mutationDisabled}
			icon={<FolderPlus />}
			onClick={() => void onAdd()}
			size="sm"
			title={blockedReason}
		>
			{t("workspaceDirs.add")}
		</Button>
	);

	const showEmpty = !loading && !error && directories.length === 0;

	return (
		<SettingsSection actions={showEmpty ? undefined : addButton} title={t("workspaceDirs.title")}>
			{error && (
				<Banner
					actions={
						<Button disabled={loading} onClick={() => void reload()} size="sm">
							{t("common.retry")}
						</Button>
					}
					className="my-3"
					live
					title={t("workspaceDirs.loadFailed")}
					variant="danger"
				>
					<ErrorDetail error={error} />
				</Banner>
			)}
			{loading && directories.length === 0 ? (
				<SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />
			) : directories.length > 0 ? (
				<div className="py-2">
					{directories.map(directory => (
						<ListRow
							actions={
								directory.primary ? undefined : (
									<IconButton
										disabled={mutating || busy || !sidecarReady}
										icon={<Trash2 />}
										label={t("workspaceDirs.remove")}
										onClick={() => setConfirmRemove(directory.path)}
										size="sm"
									/>
								)
							}
							key={directory.path}
							leading={<FolderGit2 />}
							meta={directory.primary ? <Badge variant="info">{t("workspaceDirs.primary")}</Badge> : undefined}
							title={<span className="font-mono">{directory.path}</span>}
							titleText={directory.path}
						/>
					))}
				</div>
			) : (
				showEmpty && (
					// One row like every other line here, not a centered empty card.
					<SettingsRow
						compactControl
						control={addButton}
						icon={<FolderGit2 />}
						id="settings-workspace-empty"
						label={<span className="text-(--sc-text-muted)">{t("workspaceDirs.empty")}</span>}
					/>
				)
			)}
			{busy && sidecarReady && (
				<p className="pb-2 text-sc-sm text-(--sc-text-muted)" role="status">
					{t("workspaceDirs.busy")}
				</p>
			)}
			<SettingsRow
				compactControl
				control={
					<Button disabled={mutationDisabled} onClick={() => void onMove()} size="sm" title={blockedReason}>
						{t("workspaceDirs.moveChoose")}
					</Button>
				}
				description={t("workspaceDirs.moveDesc")}
				icon={<PackageOpen />}
				label={t("workspaceDirs.moveTitle")}
			/>

			<ConfirmDialog
				busy={mutating}
				confirmLabel={t("workspaceDirs.remove")}
				message={<span className="font-mono">{confirmRemove ?? ""}</span>}
				onCancel={() => setConfirmRemove(null)}
				onConfirm={() => {
					if (confirmRemove) void onRemove(confirmRemove);
				}}
				open={confirmRemove !== null}
				title={t("workspaceDirs.removeTitle")}
				warning={t("workspaceDirs.removeWarning")}
			/>
		</SettingsSection>
	);
}
