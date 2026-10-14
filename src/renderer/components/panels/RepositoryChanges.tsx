import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, FolderGit2, RefreshCw, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isConflictStatus, stagedState } from "../../../shared/git-status";
import type { RpcGitChanges, RpcGitDiff } from "../../../shared/rpc-types";
import { parseDiff } from "../../lib/diff";
import { errorDetail } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { TabRpc } from "../../lib/tab-rpc";
import { useTabRpc } from "../../lib/tab-rpc";
import {
	anchorFromEvent,
	Button,
	ConfirmDialog,
	ContextMenu,
	type ContextMenuAnchor,
	CopyButton,
	EmptyState,
	IconButton,
	InlineNotice,
	SearchField,
	Spinner,
} from "../common";
import { ChangeCounts, PanelListRow, PanelToolbar } from "./PanelChrome";
import { CommitBox } from "./scm/CommitBox";
import { DiffLines, VirtualRows } from "./scm/DiffLines";
import { NameDialog, type NameRequest } from "./scm/NameDialog";
import { SourceControlBar } from "./scm/SourceControlBar";
import { useScmAction } from "./scm/use-scm-action";
import { FileIcon } from "./viewers/FileViewer";

type ChangedFile = RpcGitChanges["files"][number];
export function statusName(file: { status: string; oldPath?: string }) {
	if (isConflictStatus(file.status)) return "conflicted";
	if (file.status === "??") return "untracked";
	if (file.oldPath || file.status.includes("R")) return "renamed";
	if (file.status.includes("D")) return "deleted";
	if (file.status.includes("A")) return "added";
	return "modified";
}
export const STATUS_STYLE: Record<string, string> = {
	added: "text-(--sc-success)",
	untracked: "text-(--sc-success)",
	deleted: "text-(--sc-danger)",
	modified: "text-(--sc-warning)",
	renamed: "text-(--sc-text-muted)",
	conflicted: "text-(--sc-danger)",
};

const CHECKBOX = "size-4 shrink-0 accent-(--sc-accent) disabled:cursor-not-allowed";

/** Git metadata is chrome, not source. Keep the shared tool diff renderer unchanged. */
export function parseRepositoryDiff(diff: string) {
	return parseDiff(
		diff
			.split("\n")
			.filter(
				line =>
					!/^(diff --git |index |(?:new|deleted) file mode |(?:old|new) mode |similarity index |rename (?:from|to) )/.test(
						line,
					),
			)
			.join("\n"),
	);
}

export function RepositoryChanges({ sourceSelector }: { sourceSelector?: ReactNode }) {
	const t = useT();
	const rpc = useTabRpc();
	const [refresh, setRefresh] = useState(0);
	const [changes, setChanges] = useState<RpcGitChanges | null>(null);
	const [selected, setSelected] = useState("");
	const [preview, setPreview] = useState<RpcGitDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [query, setQuery] = useState("");
	const [listScroller, setListScroller] = useState<HTMLDivElement | null>(null);
	const [previewScroller, setPreviewScroller] = useState<HTMLDivElement | null>(null);
	const [nameRequest, setNameRequest] = useState<NameRequest | null>(null);
	const [discarding, setDiscarding] = useState<string[] | null>(null);
	const [menu, setMenu] = useState<{ anchor: ContextMenuAnchor; file: ChangedFile } | null>(null);
	const loadedFor = useRef<TabRpc | null>(null);
	const reload = useCallback(() => setRefresh(value => value + 1), []);
	const runner = useScmAction(rpc, reload);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the checkout.
	useEffect(() => {
		let active = true;
		setLoading(true);
		if (loadedFor.current !== rpc) {
			setChanges(null);
			setSelected("");
		}
		setError(null);
		void Promise.resolve()
			.then(() => rpc.getGitChanges())
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				loadedFor.current = rpc;
				const data = response.data as RpcGitChanges;
				setChanges(data);
				setSelected(previous => (data.files.some(file => file.path === previous) ? previous : ""));
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
	}, [rpc, refresh, t]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a refresh must also reload the selected diff.
	useEffect(() => {
		let active = true;
		setPreview(null);
		if (!selected) return;
		setError(null);
		void Promise.resolve()
			.then(() => rpc.getGitDiff(selected))
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				setPreview(response.data as RpcGitDiff);
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			});
		return () => {
			active = false;
		};
	}, [rpc, selected, refresh, t]);
	const files = changes?.files.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
	const current = changes?.files.find(file => file.path === selected);
	const position = files.findIndex(file => file.path === selected);
	const totals = changes?.files.reduce(
		(sum, file) => ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }),
		{ added: 0, removed: 0 },
	);
	const counted = changes?.files.some(file => file.added !== undefined);
	const staged = changes?.files.filter(file => stagedState(file.status) !== "none").length ?? 0;
	const fullyStaged = changes?.files.filter(file => stagedState(file.status) === "all").length ?? 0;
	const conflicts = changes?.files.filter(file => isConflictStatus(file.status)).length ?? 0;
	const head = changes?.head;
	const scmBusy = runner.busy !== null;
	const lines = useMemo(() => parseRepositoryDiff(preview?.diff ?? ""), [preview]);
	const previewCounts = {
		added: lines.filter(line => line.type === "add").length,
		removed: lines.filter(line => line.type === "remove").length,
	};
	const setStaged = (paths: string[] | "all", stage: boolean) =>
		void runner.run(
			stage ? "stage" : "unstage",
			stage ? { type: "git_stage", paths } : { type: "git_unstage", paths },
			{ failure: stage ? t("scm.stageFailed") : t("scm.unstageFailed") },
		);
	const allChecked = changes !== null && changes.files.length > 0 && fullyStaged === changes.files.length;
	return (
		<div className="omp-changes flex min-h-0 flex-1 flex-col">
			<PanelToolbar>
				{sourceSelector}
				{changes?.isRepo && (
					<span className="ml-auto text-sc-xs text-(--sc-text-muted)">
						{t("diffPanel.repositorySummary", { count: changes.files.length })}
					</span>
				)}
				{counted && (
					<>
						<span aria-hidden className="text-(--sc-text-subtle)">
							·
						</span>
						<ChangeCounts {...totals} />
					</>
				)}
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					loading={loading}
					label={t("common.refresh")}
					onClick={reload}
					size="sm"
				/>
				{changes?.truncated && (
					<span className="text-sc-xs text-(--sc-text-muted)" role="status">
						{t("diffPanel.listLimited")}
					</span>
				)}
			</PanelToolbar>
			{changes?.isRepo && head && (
				<SourceControlBar
					conflicts={conflicts}
					head={head}
					requestName={setNameRequest}
					rpc={rpc}
					runner={runner}
				/>
			)}
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
					title={t("diffPanel.loadFailed")}
					tone="danger"
				/>
			)}
			{changes?.isRepo && head && !selected && (
				<CommitBox branch={head.branch} conflicts={conflicts} rpc={rpc} runner={runner} staged={staged} />
			)}
			{loading && !changes ? (
				<Spinner className="px-3 py-2" label={t("common.loading")} size="sm" />
			) : changes && !changes.isRepo ? (
				<EmptyState icon={<FolderGit2 />} size="sm" title={t("diffPanel.notRepoTitle")} />
			) : changes?.files.length === 0 ? (
				<EmptyState icon={<CheckCircle2 />} size="sm" title={t("diffPanel.clean")} />
			) : (
				changes && (
					<div className="omp-changes-body min-h-0 flex-1" data-open={!!selected}>
						<div ref={setListScroller} className="omp-changes-list min-h-0 overflow-y-auto px-3 pb-3">
							<div className="sticky top-0 z-(--sc-z-sticky) bg-(--sc-surface-1) pt-2 pb-1">
								<SearchField
									controlSize="sm"
									label={t("diffPanel.search")}
									onValueChange={setQuery}
									placeholder={t("diffPanel.search")}
									value={query}
								/>
								<div className="mt-1 flex items-center gap-2 px-2 text-sc-xs text-(--sc-text-muted)">
									<label className="flex min-w-0 items-center gap-2">
										<input
											aria-checked={allChecked ? "true" : staged > 0 ? "mixed" : "false"}
											checked={allChecked}
											className={CHECKBOX}
											disabled={scmBusy}
											onChange={() => setStaged("all", !allChecked)}
											ref={element => {
												if (element) element.indeterminate = !allChecked && staged > 0;
											}}
											type="checkbox"
										/>
										<span className="truncate">
											{t("scm.stagedSummary", { staged, total: changes.files.length })}
										</span>
									</label>
									<Button
										className="ml-auto"
										disabled={scmBusy || changes.files.length === 0}
										icon={<Undo2 />}
										onClick={() => setDiscarding(changes.files.map(file => file.path))}
										size="sm"
										variant="ghost"
									>
										{t("scm.discardAll")}
									</Button>
								</div>
							</div>
							<div>
								<VirtualRows estimate={30} itemKey={file => file.path} items={files} scroller={listScroller}>
									{file => {
										const slash = file.path.lastIndexOf("/");
										const status = statusName(file);
										const state = stagedState(file.status);
										const conflicted = status === "conflicted";
										return (
											<div
												className="group flex items-center gap-1"
												data-staged={state}
												onContextMenu={event => {
													event.preventDefault();
													setMenu({ anchor: anchorFromEvent(event), file });
												}}
											>
												<input
													aria-checked={state === "all" ? "true" : state === "partial" ? "mixed" : "false"}
													aria-label={
														state === "all"
															? t("scm.unstageFile", { path: file.path })
															: t("scm.stageFile", { path: file.path })
													}
													checked={state === "all"}
													className={cx(CHECKBOX, "ml-2")}
													disabled={scmBusy}
													onChange={() => setStaged([file.path], state !== "all")}
													ref={element => {
														if (element) element.indeterminate = state === "partial";
													}}
													type="checkbox"
												/>
												<PanelListRow
													aria-pressed={selected === file.path}
													className="min-w-0 flex-1"
													onClick={() => setSelected(file.path)}
													title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
												>
													<FileIcon
														path={file.path}
														className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)"
													/>
													<span className="min-w-0 flex-1 truncate">
														{file.path.slice(slash + 1)}
														{slash >= 0 && (
															<span className="ml-2 text-sc-xs text-(--sc-text-subtle)">
																{file.path.slice(0, slash)}
															</span>
														)}
													</span>
													<span
														className={cx("shrink-0 text-sc-xs", STATUS_STYLE[status])}
														title={t(`diffPanel.status.${status}`)}
														aria-label={t(`diffPanel.status.${status}`)}
													>
														{t(`diffPanel.status.${status}`)}
													</span>
													<ChangeCounts added={file.added} removed={file.removed} />
												</PanelListRow>
												<IconButton
													className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
													disabled={scmBusy || conflicted}
													icon={<Undo2 />}
													label={t("scm.discardFile", { path: file.path })}
													onClick={() => setDiscarding([file.path])}
													size="sm"
												/>
											</div>
										);
									}}
								</VirtualRows>
								{files.length === 0 && (
									<EmptyState
										icon={<FolderGit2 />}
										size="sm"
										title={t("diffPanel.noMatch")}
										actions={
											<Button size="sm" variant="secondary" onClick={() => setQuery("")}>
												{t("common.clear")}
											</Button>
										}
									/>
								)}
							</div>
						</div>
						{selected && (
							<div ref={setPreviewScroller} className="omp-changes-preview min-h-0 min-w-0 overflow-y-auto">
								<div className="sticky top-0 z-(--sc-z-sticky) flex flex-wrap items-center gap-1 bg-(--sc-surface-1) px-2 py-2">
									<IconButton
										icon={<ArrowLeft />}
										label={t("diffPanel.back")}
										onClick={() => setSelected("")}
										size="sm"
									/>
									<span className="min-w-0 flex-1 truncate text-sc-sm" title={selected}>
										{selected}
									</span>
									<ChangeCounts
										added={current?.added ?? (preview?.kind === "text" ? previewCounts.added : undefined)}
										removed={
											current?.removed ?? (preview?.kind === "text" ? previewCounts.removed : undefined)
										}
									/>
									<IconButton
										icon={<ChevronLeft />}
										label={t("diffPanel.previous")}
										disabled={position <= 0}
										onClick={() => setSelected(files[position - 1]!.path)}
										size="sm"
									/>
									<IconButton
										icon={<ChevronRight />}
										label={t("diffPanel.next")}
										disabled={position < 0 || position >= files.length - 1}
										onClick={() => setSelected(files[position + 1]!.path)}
										size="sm"
									/>
									<IconButton
										disabled={scmBusy || !current || isConflictStatus(current.status)}
										icon={<Undo2 />}
										label={t("scm.revertToHead")}
										onClick={() => setDiscarding([selected])}
										size="sm"
									/>
									<CopyButton disabled={!preview?.diff} label={t("diff.copy")} text={preview?.diff ?? ""} />
								</div>
								{!preview && !error ? (
									<Spinner className="p-3" label={t("common.loading")} size="sm" />
								) : preview?.kind === "text" ? (
									<DiffLines lines={lines} path={selected} scroller={previewScroller} />
								) : (
									preview && (
										<p className="p-3 text-sc-sm text-(--sc-text-muted)">
											{t(`diffPanel.kind.${preview.kind}`)}
										</p>
									)
								)}
								{preview?.truncated && (
									<p className="p-3 text-sc-xs text-(--sc-warning)">{t("diffPanel.previewLimited")}</p>
								)}
							</div>
						)}
					</div>
				)
			)}
			{menu && (
				<ContextMenu
					ariaLabel={menu.file.path}
					items={[
						stagedState(menu.file.status) === "all"
							? {
									id: "unstage",
									label: t("scm.unstage"),
									onSelect: () => setStaged([menu.file.path], false),
								}
							: {
									id: "stage",
									label: t("scm.stage"),
									onSelect: () => setStaged([menu.file.path], true),
								},
						{ id: "open", label: t("scm.showDiff"), onSelect: () => setSelected(menu.file.path) },
						{
							id: "discard",
							label: t("scm.discard"),
							icon: Undo2,
							danger: true,
							separatorBefore: true,
							disabled: isConflictStatus(menu.file.status),
							onSelect: () => setDiscarding([menu.file.path]),
						},
					]}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
			<ConfirmDialog
				confirmLabel={t("scm.discard")}
				message={
					discarding?.length === 1
						? t("scm.discardBody", { path: discarding[0] ?? "" })
						: t("scm.discardAllBody", { count: discarding?.length ?? 0 })
				}
				onCancel={() => setDiscarding(null)}
				onConfirm={() => {
					const paths = discarding;
					setDiscarding(null);
					if (!paths) return;
					if (paths.includes(selected)) setSelected("");
					void runner.run("discard", { type: "git_discard", paths }, { failure: t("scm.discardFailed") });
				}}
				open={discarding !== null}
				title={discarding?.length === 1 ? t("scm.discardTitle") : t("scm.discardAllTitle")}
				warning={t("scm.discardWarning")}
			/>
			<NameDialog onClose={() => setNameRequest(null)} request={nameRequest} />
		</div>
	);
}
