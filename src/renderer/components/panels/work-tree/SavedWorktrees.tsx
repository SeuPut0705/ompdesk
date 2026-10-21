/**
 * Side panel › Work tree › Saved worktrees: the idle worktrees disk care saved (a branch plus a private archive) and
 * removed (`get_saved_worktrees`, `src/main/disk/`; a paired host's tab answers on the host). One line each: the
 * folder, the branch, how long ago it went. Restore (`restore_saved_worktree`) brings back the folder, the
 * uncommitted work and the archived files. Hidden while the list is empty; paints the last read at once
 * (`lib/last-read.ts`).
 */

import { ArchiveRestore, History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SavedWorktree, SavedWorktreeRestore } from "../../../../shared/disk-care";
import { useFocusedScope } from "../../../lib/focused-scope";
import { cx, formatBytes, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { lastRead, rememberRead } from "../../../lib/last-read";
import { useTabRpc } from "../../../lib/tab-rpc";
import { toast, toastError } from "../../../stores/toast";
import { Button } from "../../common";
import { SettingInfo } from "../../common/SettingInfo";
import { PANEL_ROW_SURFACE } from "../PanelChrome";

interface SavedList {
	worktrees: SavedWorktree[];
}

const PATH_SEPARATOR = /[\\/]/;

export function SavedWorktrees() {
	const t = useT();
	const rpc = useTabRpc();
	const scope = useFocusedScope();
	const key = `saved-worktrees:${scope.cwd}`;
	const [data, setData] = useState<SavedList | null>(() => lastRead<SavedList>(scope.device, key) ?? null);
	const [error, setError] = useState<string | null>(null);
	const [restoring, setRestoring] = useState<string | null>(null);

	const read = useCallback(async () => {
		if (!scope.cwd) return;
		const response = await rpc.command({ type: "get_saved_worktrees" });
		if (!response.success) {
			setError(response.error ?? t("workTree.saved.error"));
			return;
		}
		const next = response.data as SavedList;
		setError(null);
		setData(next);
		rememberRead(scope.device, key, next);
	}, [rpc, scope.cwd, scope.device, key, t]);

	useEffect(() => {
		setData(lastRead<SavedList>(scope.device, key) ?? null);
		void read();
	}, [read, scope.device, key]);

	const restore = async (worktree: SavedWorktree, name: string) => {
		setRestoring(worktree.id);
		try {
			const response = await rpc.command({ type: "restore_saved_worktree", savedId: worktree.id });
			if (response.success) {
				const result = response.data as SavedWorktreeRestore;
				toast({
					message: t(result.branch === null ? "workTree.saved.restoredDetached" : "workTree.saved.restored", {
						path: result.path,
					}),
				});
			} else toastError({ title: t("workTree.saved.restoreFailed", { name }), error: response.error ?? "" });
		} finally {
			setRestoring(null);
			await read();
		}
	};

	const worktrees = data?.worktrees ?? [];
	if (worktrees.length === 0 && !error) return null;

	return (
		<section aria-labelledby="work-tree-saved" className="mt-3" data-saved-worktrees>
			<h3
				className="flex items-center gap-1 px-3 pt-2 pb-1 text-sc-xs font-medium text-(--sc-text-muted)"
				id="work-tree-saved"
			>
				<span className="min-w-0 flex-1 truncate">
					{t("workTree.saved.title")}
					{data ? ` · ${worktrees.length}` : ""}
				</span>
				<SettingInfo text={t("workTree.saved.info")} />
			</h3>
			{error ? (
				<p className="px-3 text-sc-xs text-(--sc-danger)" role="alert">
					{error}
				</p>
			) : null}
			<ul>
				{worktrees.map(worktree => {
					const name = worktree.path.split(PATH_SEPARATOR).filter(Boolean).at(-1) ?? worktree.path;
					const branch = worktree.branch ?? worktree.savedBranch ?? "";
					const age = formatTimeAgo(worktree.removedAt);
					const title = [
						name,
						worktree.path,
						worktree.savedBranch ? t("workTree.saved.tip.savedBranch", { branch: worktree.savedBranch }) : "",
						worktree.archivedFiles > 0
							? t("workTree.saved.tip.archive", {
									count: worktree.archivedFiles,
									size: formatBytes(worktree.archivedBytes),
								})
							: t("workTree.saved.tip.noArchive"),
					]
						.filter(Boolean)
						.join("\n");
					return (
						<li
							className={cx(
								PANEL_ROW_SURFACE,
								"omp-work-tree-row flex h-(--sc-control-md) items-center gap-1.5 rounded-none py-0 pl-3",
							)}
							data-saved-worktree={worktree.id}
							key={worktree.id}
							title={title}
						>
							<History aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
							<span className="min-w-0 shrink-0 truncate font-mono text-sc-xs">{name}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-sc-xs text-(--sc-text-muted)">
								{branch}
							</span>
							<span className="shrink-0 text-sc-xs text-(--sc-text-subtle) tabular-nums">{age}</span>
							<Button
								aria-label={t("workTree.saved.restoreLabel", { name })}
								data-saved-restore={worktree.id}
								disabled={restoring !== null}
								icon={<ArchiveRestore />}
								loading={restoring === worktree.id}
								onClick={() => void restore(worktree, name)}
								size="sm"
								variant="ghost"
							>
								{t("workTree.saved.restore")}
							</Button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
