import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Copy, FolderGit2, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { RpcGitChanges, RpcGitDiff } from "../../../shared/rpc-types";
import { parseDiff } from "../../lib/diff";
import { errorDetail } from "../../lib/error-detail";
import { copyText, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { TabRpc } from "../../lib/tab-rpc";
import { useTabRpc } from "../../lib/tab-rpc";
import { EmptyState, IconButton, SearchField } from "../common";
import { ChangeCounts, PanelActions, PanelListRow, PanelToolbar } from "./PanelChrome";
import { FileIcon } from "./viewers/FileViewer";

type ChangedFile = RpcGitChanges["files"][number];
function statusName(file: ChangedFile) {
	if (file.status === "??") return "untracked";
	if (file.oldPath || file.status.includes("R")) return "renamed";
	if (file.status.includes("D")) return "deleted";
	if (file.status.includes("A")) return "added";
	return "modified";
}
const STATUS_STYLE: Record<string, string> = {
	added: "text-(--sc-success)",
	untracked: "text-(--sc-success)",
	deleted: "text-(--sc-danger)",
	modified: "text-(--sc-warning)",
	renamed: "text-(--sc-text-muted)",
};

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
	const loadedFor = useRef<TabRpc | null>(null);
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
	// Git metadata is chrome, not source. Keep the shared tool diff renderer unchanged.
	const lines = useMemo(
		() =>
			parseDiff(
				(preview?.diff ?? "")
					.split("\n")
					.filter(
						line =>
							!/^(index |(?:new|deleted) file mode |(?:old|new) mode |similarity index |rename (?:from|to) )/.test(
								line,
							),
					)
					.join("\n"),
			),
		[preview],
	);
	const previewCounts = {
		added: lines.filter(line => line.type === "add").length,
		removed: lines.filter(line => line.type === "remove").length,
	};
	return (
		<div className="omp-changes flex min-h-0 flex-1 flex-col">
			<PanelActions>
				<IconButton
					disabled={loading}
					icon={<RefreshCw />}
					label={t("common.refresh")}
					onClick={() => setRefresh(value => value + 1)}
					size="sm"
				/>
			</PanelActions>
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
				{changes?.truncated && (
					<span className="text-sc-xs text-(--sc-text-muted)" role="status">
						{t("diffPanel.listLimited")}
					</span>
				)}
			</PanelToolbar>
			{error && (
				<div className="mx-3 rounded-(--sc-radius-md) bg-(--sc-danger-soft) p-2 text-sc-sm" role="alert">
					<p>{t("diffPanel.loadFailed")}</p>
					<p className="mt-1 break-words text-sc-xs text-(--sc-text-muted)">{error}</p>
				</div>
			)}
			{loading && !changes ? (
				<p className="px-3 py-2 text-sc-sm text-(--sc-text-muted)">{t("common.loading")}</p>
			) : changes && !changes.isRepo ? (
				<EmptyState
					description={t("diffPanel.notRepoHint")}
					icon={<FolderGit2 />}
					size="sm"
					title={t("diffPanel.notRepoTitle")}
				/>
			) : changes?.files.length === 0 ? (
				<EmptyState icon={<CheckCircle2 />} size="sm" title={t("diffPanel.clean")} />
			) : (
				changes && (
					<div className="omp-changes-body min-h-0 flex-1" data-open={!!selected}>
						<div className="omp-changes-list min-h-0 overflow-y-auto px-3 pb-3">
							<SearchField
								controlSize="sm"
								label={t("diffPanel.search")}
								onValueChange={setQuery}
								placeholder={t("diffPanel.search")}
								value={query}
							/>
							<div className="mt-2">
								{files.map(file => {
									const slash = file.path.lastIndexOf("/");
									const status = statusName(file);
									return (
										<PanelListRow
											key={file.path}
											aria-pressed={selected === file.path}
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
									);
								})}
								{files.length === 0 && (
									<p className="px-2 py-3 text-sc-sm text-(--sc-text-muted)">{t("diffPanel.noMatch")}</p>
								)}
							</div>
						</div>
						{selected && (
							<div className="omp-changes-preview min-h-0 min-w-0 overflow-y-auto">
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
										icon={<Copy />}
										label={t("diff.copy")}
										disabled={!preview?.diff}
										onClick={() => void copyText(preview?.diff ?? "")}
										size="sm"
									/>
								</div>
								{!preview && !error ? (
									<p className="p-3 text-sc-sm text-(--sc-text-muted)">{t("common.loading")}</p>
								) : preview?.kind === "text" ? (
									<div className="omp-pane-diff font-mono text-sc-xs leading-(--sc-leading-relaxed)">
										{lines.map((line, index) => (
											<div
												className={cx(
													"flex items-start px-2",
													line.type === "add" && "bg-(--sc-success-soft)",
													line.type === "remove" && "bg-(--sc-danger-soft)",
												)}
												key={index}
											>
												<span
													aria-hidden
													className="omp-pane-gutter shrink-0 select-none pr-2 text-right text-(--sc-text-subtle)"
												>
													{line.oldLine}
												</span>
												<span
													aria-hidden
													className="omp-pane-gutter shrink-0 select-none pr-2 text-right text-(--sc-text-subtle)"
												>
													{line.newLine}
												</span>
												<span aria-hidden className="shrink-0 pr-2 text-(--sc-text-subtle)">
													{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
												</span>
												<span className="min-w-0 whitespace-pre-wrap break-words text-(--sc-text)">
													{line.content}
												</span>
											</div>
										))}
									</div>
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
		</div>
	);
}
