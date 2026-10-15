/**
 * Commit history of the session checkout (the Changes panel's "Commits"
 * source): a searchable, paged log with branch and tag marks; a commit opens
 * its message, files and per-file diff, and its menu checks it out, branches
 * or tags from it, cherry-picks, reverts, resets, copies the id or opens it on
 * the hosted remote.
 */
import {
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	Check,
	Cherry,
	Copy,
	ExternalLink,
	GitBranchPlus,
	GitCommitHorizontal,
	History,
	MoreHorizontal,
	RefreshCw,
	RotateCcw,
	Tag,
	Trash2,
	Undo2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { RpcGitCommit, RpcGitCommitDetail, RpcGitDiff, RpcGitLog } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { cx, formatAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import {
	Button,
	ConfirmDialog,
	type ContextMenuItem,
	CopyButton,
	EmptyState,
	IconButton,
	InlineNotice,
	MenuButton,
	SearchField,
	Spinner,
} from "../../common";
import { ChangeCounts, PanelListRow, PanelToolbar } from "../PanelChrome";
import { parseRepositoryDiff, STATUS_STYLE } from "../RepositoryChanges";
import { FileIcon } from "../viewers/FileViewer";
import { DiffLines, VirtualRows } from "./DiffLines";
import { NameDialog, type NameRequest } from "./NameDialog";
import { useScmAction } from "./use-scm-action";

const PAGE = 100;

const COMMIT_STATUS: Record<string, string> = {
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "added",
	M: "modified",
	T: "modified",
};

function RefMarks({ commit }: { commit: RpcGitCommit }) {
	if (commit.refs.length === 0 && commit.tags.length === 0) return null;
	return (
		<span className="flex min-w-0 shrink flex-wrap gap-1">
			{commit.refs.map(ref => (
				<span
					className="truncate rounded-(--sc-radius-sm) border border-(--sc-border-subtle) px-1 text-sc-xs text-(--sc-text-secondary)"
					key={ref}
				>
					{ref}
				</span>
			))}
			{commit.tags.map(tag => (
				<span
					className="flex items-center gap-0.5 truncate rounded-(--sc-radius-sm) border border-(--sc-border-subtle) px-1 text-sc-xs text-(--sc-text-secondary)"
					key={tag}
				>
					<Tag aria-hidden className="size-3" />
					{tag}
				</span>
			))}
		</span>
	);
}

export function CommitHistory({ sourceSelector }: { sourceSelector?: ReactNode }) {
	const t = useT();
	const rpc = useTabRpc();
	const [query, setQuery] = useState("");
	const [applied, setApplied] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [log, setLog] = useState<RpcGitLog | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [detail, setDetail] = useState<RpcGitCommitDetail | null>(null);
	const [file, setFile] = useState<string | null>(null);
	const [diff, setDiff] = useState<RpcGitDiff | null>(null);
	const [listScroller, setListScroller] = useState<HTMLDivElement | null>(null);
	const [diffScroller, setDiffScroller] = useState<HTMLDivElement | null>(null);
	const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
	const [hardReset, setHardReset] = useState<RpcGitCommit | null>(null);
	const reload = useCallback(() => setRefresh(value => value + 1), []);
	const runner = useScmAction(rpc, reload);

	// Search applies after a short pause, not per keystroke.
	useEffect(() => {
		const timer = setTimeout(() => setApplied(query.trim()), 250);
		return () => clearTimeout(timer);
	}, [query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the log.
	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		void rpc
			.command({ type: "git_log", limit: PAGE, query: applied || undefined })
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				setLog(response.data as RpcGitLog);
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [rpc, applied, refresh, t]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh reloads the open commit too.
	useEffect(() => {
		let active = true;
		setDetail(null);
		setFile(null);
		if (!selected) return;
		void rpc
			.command({ type: "git_commit_detail", sha: selected })
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				setDetail(response.data as RpcGitCommitDetail);
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			});
		return () => {
			active = false;
		};
	}, [rpc, selected, refresh, t]);

	useEffect(() => {
		let active = true;
		setDiff(null);
		if (!selected || !file) return;
		void rpc
			.command({ type: "git_commit_diff", sha: selected, path: file })
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				setDiff(response.data as RpcGitDiff);
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			});
		return () => {
			active = false;
		};
	}, [rpc, selected, file, t]);

	const loadMore = async () => {
		if (!log) return;
		const response = await rpc
			.command({ type: "git_log", limit: PAGE, skip: log.commits.length, query: applied || undefined })
			.catch(cause => ({ success: false as const, error: errorDetail(cause) }));
		if (!response.success) {
			setError(response.error ?? t("rpc.failed"));
			return;
		}
		const page = response.data as RpcGitLog;
		setLog(previous => (previous ? { ...page, commits: [...previous.commits, ...page.commits] } : page));
	};

	const lines = useMemo(() => parseRepositoryDiff(diff?.diff ?? ""), [diff]);

	const commitMenu = (commit: RpcGitCommit): ContextMenuItem[] => {
		const action = (key: string, command: Parameters<typeof runner.run>[1], failure: string, success?: string) =>
			void runner.run(key, command, { failure, success });
		// The commit right after this one on the shown line (only an unfiltered log shows it).
		const index = log?.commits.findIndex(entry => entry.sha === commit.sha) ?? -1;
		const after = !applied && index > 0 ? log?.commits[index - 1] : undefined;
		const hasChild = after?.parents.length === 1 && after.parents[0] === commit.sha;
		const items: ContextMenuItem[] = [
			{
				id: "copy",
				label: t("scm.history.copySha"),
				icon: Copy,
				onSelect: () => void navigator.clipboard.writeText(commit.sha),
			},
		];
		if (log?.commitUrl) {
			const url = log.commitUrl.replace("{sha}", commit.sha);
			items.push({
				id: "remote",
				label: t("scm.history.openRemote"),
				icon: ExternalLink,
				onSelect: () => void window.omp.system.openExternal(url),
			});
		}
		items.push(
			{
				id: "checkout",
				label: t("scm.history.checkout"),
				icon: Check,
				separatorBefore: true,
				onSelect: () =>
					action(
						"checkout",
						{ type: "git_history_action", action: "checkout", sha: commit.sha },
						t("scm.history.actionFailed"),
						t("scm.history.checkedOut", { sha: commit.shortSha }),
					),
			},
			{
				id: "branch",
				label: t("scm.history.branch"),
				icon: GitBranchPlus,
				onSelect: () =>
					setNameRequest({
						title: t("scm.history.branchTitle", { sha: commit.shortSha }),
						label: t("scm.branch.nameLabel"),
						submitLabel: t("scm.history.branchSubmit"),
						onSubmit: name =>
							action(
								"branch",
								{ type: "git_history_action", action: "branch", sha: commit.sha, name },
								t("scm.history.actionFailed"),
							),
					}),
			},
			{
				id: "tag",
				label: t("scm.history.tag"),
				icon: Tag,
				onSelect: () =>
					setNameRequest({
						title: t("scm.history.tagTitle", { sha: commit.shortSha }),
						label: t("scm.history.tagLabel"),
						submitLabel: t("scm.history.tagSubmit"),
						onSubmit: name =>
							action(
								"tag",
								{ type: "git_history_action", action: "tag", sha: commit.sha, name },
								t("scm.history.actionFailed"),
							),
					}),
			},
			{
				id: "cherry",
				label: t("scm.history.cherryPick"),
				icon: Cherry,
				separatorBefore: true,
				onSelect: () =>
					action(
						"cherry",
						{ type: "git_history_action", action: "cherry_pick", sha: commit.sha },
						t("scm.history.actionFailed"),
					),
			},
			{
				id: "revert",
				label: t("scm.history.revert"),
				icon: Undo2,
				onSelect: () =>
					action(
						"revert",
						{ type: "git_history_action", action: "revert", sha: commit.sha },
						t("scm.history.actionFailed"),
					),
			},
			{
				// C77: the log is newest first, so "later" moves a commit up the list and "earlier" down.
				id: "move-later",
				label: t("scm.history.moveLater"),
				icon: ArrowUp,
				separatorBefore: true,
				disabled: !hasChild,
				onSelect: () =>
					action(
						"move",
						{ type: "git_history_action", action: "move_later", sha: commit.sha },
						t("scm.history.actionFailed"),
						t("scm.history.moved", { sha: commit.shortSha }),
					),
			},
			{
				id: "move-earlier",
				label: t("scm.history.moveEarlier"),
				icon: ArrowDown,
				disabled: commit.parents.length !== 1,
				onSelect: () =>
					action(
						"move",
						{ type: "git_history_action", action: "move_earlier", sha: commit.sha },
						t("scm.history.actionFailed"),
						t("scm.history.moved", { sha: commit.shortSha }),
					),
			},
			{
				id: "reset-soft",
				label: t("scm.history.resetSoft"),
				icon: RotateCcw,
				separatorBefore: true,
				onSelect: () =>
					action(
						"reset",
						{ type: "git_history_action", action: "reset", sha: commit.sha, mode: "soft" },
						t("scm.history.actionFailed"),
					),
			},
			{
				id: "reset-mixed",
				label: t("scm.history.resetMixed"),
				icon: RotateCcw,
				onSelect: () =>
					action(
						"reset",
						{ type: "git_history_action", action: "reset", sha: commit.sha, mode: "mixed" },
						t("scm.history.actionFailed"),
					),
			},
			{
				id: "reset-hard",
				label: t("scm.history.resetHard"),
				icon: RotateCcw,
				danger: true,
				onSelect: () => setHardReset(commit),
			},
			...commit.tags.map(tag => ({
				id: `untag:${tag}`,
				label: t("scm.history.deleteTag", { tag }),
				icon: Trash2,
				danger: true,
				onSelect: () =>
					action(
						"untag",
						{ type: "git_history_action", action: "delete_tag", sha: commit.sha, name: tag },
						t("scm.history.actionFailed"),
					),
			})),
		);
		return items;
	};

	const open = log?.commits.find(commit => commit.sha === selected) ?? detail;

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-commit-history>
			<PanelToolbar>
				{sourceSelector}
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={loading || runner.busy !== null}
					onClick={reload}
					size="sm"
				/>
			</PanelToolbar>
			{error && (
				<InlineNotice
					action={
						<Button onClick={reload} size="sm" variant="ghost">
							{t("common.retry")}
						</Button>
					}
					className="px-3"
					detail={error}
					live
					title={t("scm.history.loadFailed")}
					tone="danger"
				/>
			)}
			{!selected ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" ref={setListScroller}>
					<div className="sticky top-0 z-(--sc-z-sticky) bg-(--sc-surface-1) pt-2 pb-1">
						<SearchField
							controlSize="sm"
							label={t("scm.history.search")}
							onValueChange={setQuery}
							placeholder={t("scm.history.search")}
							value={query}
						/>
					</div>
					{loading && !log ? (
						<Spinner className="px-2 py-2" label={t("common.loading")} size="sm" />
					) : log && log.commits.length === 0 ? (
						<EmptyState
							icon={<History />}
							size="sm"
							title={applied ? t("scm.history.noMatch") : t("scm.history.empty")}
						/>
					) : (
						log && (
							<>
								<VirtualRows
									estimate={44}
									itemKey={commit => commit.sha}
									items={log.commits}
									scroller={listScroller}
								>
									{commit => (
										<div className="flex items-center gap-1">
											<PanelListRow
												className="min-w-0 flex-1 flex-col items-stretch gap-0.5"
												onClick={() => setSelected(commit.sha)}
												title={commit.subject}
											>
												<span className="flex min-w-0 items-center gap-2">
													<span className="min-w-0 flex-1 truncate">{commit.subject}</span>
													<RefMarks commit={commit} />
												</span>
												<span className="flex min-w-0 gap-2 text-sc-xs text-(--sc-text-muted)">
													<span className="font-mono">{commit.shortSha}</span>
													<span className="min-w-0 truncate">{commit.author}</span>
													<span className="ml-auto shrink-0">{formatAgo(commit.date * 1000)}</span>
												</span>
											</PanelListRow>
											<MenuButton
												align="end"
												disabled={runner.busy !== null}
												icon={<MoreHorizontal />}
												items={commitMenu(commit)}
												label={t("scm.history.actions", { sha: commit.shortSha })}
												size="sm"
											/>
										</div>
									)}
								</VirtualRows>
								{log.more && (
									<div className="flex justify-center pt-2">
										<Button onClick={() => void loadMore()} size="sm" variant="ghost">
											{t("scm.history.loadMore")}
										</Button>
									</div>
								)}
							</>
						)
					)}
				</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto" ref={setDiffScroller}>
					<div className="sticky top-0 z-(--sc-z-sticky) flex items-center gap-1 bg-(--sc-surface-1) px-2 py-2">
						<IconButton
							icon={<ArrowLeft />}
							label={file ? t("scm.history.backToCommit") : t("scm.history.back")}
							onClick={() => (file ? setFile(null) : setSelected(null))}
							size="sm"
						/>
						<span className="min-w-0 flex-1 truncate text-sc-sm" title={file ?? open?.subject}>
							{file ?? open?.subject}
						</span>
						{open && !file && (
							<MenuButton
								align="end"
								disabled={runner.busy !== null}
								icon={<MoreHorizontal />}
								items={commitMenu(open)}
								label={t("scm.history.actions", { sha: open.shortSha })}
								size="sm"
							/>
						)}
						{file && <CopyButton disabled={!diff?.diff} label={t("diff.copy")} text={diff?.diff ?? ""} />}
					</div>
					{!detail ? (
						!error && <Spinner className="p-3" label={t("common.loading")} size="sm" />
					) : file ? (
						!diff ? (
							!error && <Spinner className="p-3" label={t("common.loading")} size="sm" />
						) : diff.kind === "text" ? (
							<>
								<DiffLines lines={lines} path={file} scroller={diffScroller} />
								{diff.truncated && (
									<p className="p-3 text-sc-xs text-(--sc-warning)">{t("diffPanel.previewLimited")}</p>
								)}
							</>
						) : (
							<p className="p-3 text-sc-sm text-(--sc-text-muted)">{t(`diffPanel.kind.${diff.kind}`)}</p>
						)
					) : (
						<div className="flex flex-col gap-2 px-3 pb-3">
							<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
								<GitCommitHorizontal aria-hidden className="size-(--sc-icon-sm)" />
								<span className="font-mono">{detail.shortSha}</span>
								<CopyButton label={t("scm.history.copySha")} text={detail.sha} />
								<span>{detail.author}</span>
								<span>{formatAgo(detail.date * 1000)}</span>
								<RefMarks commit={detail} />
							</div>
							{detail.body && (
								<p className="whitespace-pre-wrap break-words text-sc-sm text-(--sc-text-secondary)">
									{detail.body}
								</p>
							)}
							<p className="pt-1 text-sc-xs text-(--sc-text-muted)">
								{t("scm.history.files", { count: detail.files.length })}
							</p>
							<div>
								{detail.files.map(entry => {
									const status = COMMIT_STATUS[entry.status] ?? "modified";
									const slash = entry.path.lastIndexOf("/");
									return (
										<PanelListRow
											key={entry.path}
											onClick={() => setFile(entry.path)}
											title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
										>
											<FileIcon
												className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)"
												path={entry.path}
											/>
											<span className="min-w-0 flex-1 truncate">
												{entry.path.slice(slash + 1)}
												{slash >= 0 && (
													<span className="ml-2 text-sc-xs text-(--sc-text-subtle)">
														{entry.path.slice(0, slash)}
													</span>
												)}
											</span>
											<span className={cx("shrink-0 text-sc-xs", STATUS_STYLE[status])}>
												{t(`diffPanel.status.${status}`)}
											</span>
											<ChangeCounts added={entry.added} removed={entry.removed} />
										</PanelListRow>
									);
								})}
							</div>
						</div>
					)}
				</div>
			)}
			<ConfirmDialog
				confirmLabel={t("scm.history.resetHard")}
				message={t("scm.history.resetHardBody", { sha: hardReset?.shortSha ?? "" })}
				onCancel={() => setHardReset(null)}
				onConfirm={() => {
					const target = hardReset;
					setHardReset(null);
					if (target)
						void runner.run(
							"reset",
							{ type: "git_history_action", action: "reset", sha: target.sha, mode: "hard" },
							{ failure: t("scm.history.actionFailed") },
						);
				}}
				open={hardReset !== null}
				title={t("scm.history.resetHardTitle")}
				warning={t("scm.discardWarning")}
			/>
			<NameDialog onClose={() => setNameRequest(null)} request={nameRequest} />
		</div>
	);
}
