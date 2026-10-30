/**
 * Side panel › Work tree › Unused worktrees: the linked worktrees OMPdesk made for the focused tab's repository that
 * no open session uses (`get_orphan_worktrees`, `src/main/worktree-orphans.ts`; a paired host's tab answers on the
 * host). One line each: the branch, what git says about its work, the age. A worktree whose work landed (by ancestry
 * or by a squash merge) or that never had work of its own can be removed after a confirm: main re-checks and removes
 * it without `--force` and deletes the branch only with `branch -d`, so nothing unlanded is ever lost. Paints the
 * last read at once (`lib/last-read.ts`) and reads again in place when the view opens.
 */

import { GitBranch, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RpcOrphanWorktree, RpcOrphanWorktrees } from "../../../../shared/rpc-types";
import { useFocusedScope } from "../../../lib/focused-scope";
import { cx, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { lastRead, rememberRead } from "../../../lib/last-read";
import { useTabRpc } from "../../../lib/tab-rpc";
import { toast, toastError } from "../../../stores/toast";
import { ConfirmDialog, IconButton, SkeletonRows } from "../../common";
import { SettingInfo } from "../../common/SettingInfo";
import { PANEL_ROW_SURFACE } from "../PanelChrome";

/** The ones a removal may take: nothing in them the user could lose. */
const REMOVABLE: Readonly<Record<RpcOrphanWorktree["state"], boolean>> = {
	landed: true,
	untouched: true,
	unlanded: false,
	dirty: false,
};

const ORPHAN_SKELETON_WIDTHS = [62, 48, 70] as const;
/** A few git reads per worktree; a removal re-lists, then `worktree remove` (src/main/worktree-orphans.ts). */
const LIST_TIMEOUT_MS = 180_000;
const REMOVE_TIMEOUT_MS = 360_000;

/** Its name: the branch, else (a detached HEAD) the folder's last segment. */
function worktreeName(worktree: RpcOrphanWorktree): string {
	return worktree.branch ?? worktree.path.split(/[\\/]/).filter(Boolean).at(-1) ?? worktree.path;
}

export function OrphanWorktrees() {
	const t = useT();
	const rpc = useTabRpc();
	const scope = useFocusedScope();
	const key = `orphan-worktrees:${scope.cwd}`;
	const [data, setData] = useState<RpcOrphanWorktrees | null>(() => lastRead(scope.device, key) ?? null);
	const [error, setError] = useState<string | null>(null);
	const [reading, setReading] = useState(false);
	const [pending, setPending] = useState<readonly RpcOrphanWorktree[] | null>(null);
	const [removing, setRemoving] = useState(false);

	const read = useCallback(async () => {
		if (!scope.cwd) return;
		setReading(true);
		try {
			const response = await rpc.command({ type: "get_orphan_worktrees" }, LIST_TIMEOUT_MS);
			if (!response.success) {
				setError(response.error ?? t("workTree.orphans.error"));
				return;
			}
			const next = response.data as RpcOrphanWorktrees;
			setError(null);
			setData(next);
			rememberRead(scope.device, key, next);
		} finally {
			setReading(false);
		}
	}, [rpc, scope.cwd, scope.device, key, t]);

	useEffect(() => {
		setData(lastRead(scope.device, key) ?? null);
		void read();
	}, [read, scope.device, key]);

	const worktrees = data?.worktrees ?? [];
	const removable = worktrees.filter(worktree => REMOVABLE[worktree.state]);

	const remove = async (targets: readonly RpcOrphanWorktree[]) => {
		setRemoving(true);
		let removed = 0;
		try {
			for (const worktree of targets) {
				const response = await rpc.command(
					{ type: "remove_orphan_worktree", path: worktree.path },
					REMOVE_TIMEOUT_MS,
				);
				if (response.success) removed++;
				else
					toastError({
						title: t("workTree.orphans.removeFailed", { name: worktreeName(worktree) }),
						error: response.error ?? "",
					});
			}
			if (removed > 0) toast({ message: t("workTree.orphans.removed", { count: removed }) });
		} finally {
			setRemoving(false);
			setPending(null);
			await read();
		}
	};

	const stateText = (worktree: RpcOrphanWorktree) =>
		worktree.state === "landed"
			? t(worktree.squashed ? "workTree.orphans.state.squashed" : "workTree.orphans.state.landed")
			: worktree.state === "untouched"
				? t("workTree.orphans.state.untouched")
				: worktree.state === "dirty"
					? t("workTree.orphans.state.dirty", { count: worktree.dirtyFiles })
					: t("workTree.orphans.state.unlanded", { count: worktree.commitsAhead });

	return (
		<section aria-labelledby="work-tree-orphans" className="mt-3" data-orphan-worktrees>
			<h3
				className="flex items-center gap-1 px-3 pt-2 pb-1 text-sc-xs font-medium text-(--sc-text-muted)"
				id="work-tree-orphans"
			>
				<span className="min-w-0 flex-1 truncate">
					{t("workTree.orphans.title")}
					{data ? ` · ${worktrees.length}` : ""}
				</span>
				<SettingInfo text={t("workTree.orphans.info")} />
				{removable.length > 1 ? (
					<IconButton
						data-orphan-remove-all={removable.length}
						disabled={removing}
						icon={<Trash2 />}
						label={t("workTree.orphans.removeAll", { count: removable.length })}
						onClick={() => setPending(removable)}
						size="sm"
					/>
				) : null}
				<IconButton
					disabled={reading}
					icon={<RotateCw />}
					label={t("common.refresh")}
					onClick={() => void read()}
					size="sm"
				/>
			</h3>
			{error ? (
				<p className="px-3 text-sc-xs text-(--sc-danger)" role="alert">
					{error}
				</p>
			) : null}
			{data === null && !error ? (
				<SkeletonRows className="px-1" label={t("workTree.orphans.loading")} widths={ORPHAN_SKELETON_WIDTHS} />
			) : worktrees.length === 0 && !error ? (
				<p className="px-3 py-1 text-sc-xs text-(--sc-text-subtle)">{t("workTree.orphans.none")}</p>
			) : (
				<ul>
					{worktrees.map(worktree => {
						const name = worktreeName(worktree);
						const state = stateText(worktree);
						const age = formatTimeAgo(worktree.modifiedAt);
						return (
							<li
								className={cx(
									PANEL_ROW_SURFACE,
									"omp-work-tree-row flex h-(--sc-control-md) items-center gap-1.5 rounded-none py-0 pl-3",
								)}
								data-orphan-worktree={worktree.path}
								data-state={worktree.state}
								data-squashed={worktree.squashed ? true : undefined}
								key={worktree.path}
								title={[name, state, worktree.path].join("\n")}
							>
								<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
								<span className="min-w-0 flex-1 truncate font-mono text-sc-xs">{name}</span>
								<span
									className={cx(
										"shrink-0 text-sc-xs",
										REMOVABLE[worktree.state] ? "text-(--sc-success)" : "text-(--sc-warning)",
									)}
								>
									{state}
								</span>
								<span className="shrink-0 text-sc-xs text-(--sc-text-subtle) tabular-nums">{age}</span>
								{REMOVABLE[worktree.state] ? (
									<IconButton
										data-orphan-remove={worktree.path}
										disabled={removing}
										icon={<Trash2 />}
										label={t("workTree.orphans.remove", { name })}
										onClick={() => setPending([worktree])}
										size="sm"
									/>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
			<ConfirmDialog
				busy={removing}
				confirmLabel={t("workTree.orphans.removeConfirm")}
				message={
					pending?.length === 1
						? t("workTree.orphans.confirmOne", { name: worktreeName(pending[0] as RpcOrphanWorktree) })
						: t("workTree.orphans.confirmMany", { count: pending?.length ?? 0 })
				}
				onCancel={() => setPending(null)}
				onConfirm={() => pending && void remove(pending)}
				open={pending !== null}
				title={t("workTree.orphans.confirmTitle")}
				warning={t("workTree.orphans.confirmSafe")}
			/>
		</section>
	);
}
