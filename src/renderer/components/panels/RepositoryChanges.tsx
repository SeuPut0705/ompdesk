import { CheckCircle2, FolderGit2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RpcGitChanges, RpcGitDiff } from "../../../shared/rpc-types";
import { DiffView } from "../../lib/diff";
import { errorDetail } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { TabRpc } from "../../lib/tab-rpc";
import { useTabRpc } from "../../lib/tab-rpc";
import { EmptyState, IconButton, SearchField } from "../common";

export function RepositoryChanges() {
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
		// A reload is not an initial load: only switching to another session's
		// client wipes the rows, so a failed refresh keeps the last good diff up.
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
				setChanges(response.data as RpcGitChanges);
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
	}, [rpc, selected, t]);
	const files = changes?.files.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
			<div className="flex items-start gap-2">
				{/* What "repository" compares only matters once there is a repository. */}
				<p className="flex-1 text-sc-xs leading-relaxed text-(--sc-text-muted)">
					{changes && !changes.isRepo ? null : t("diffPanel.repositoryScope")}
				</p>
				<IconButton
					disabled={loading}
					icon={<RefreshCw />}
					label={t("common.refresh")}
					onClick={() => setRefresh(value => value + 1)}
					size="sm"
				/>
			</div>
			{error && (
				<div
					className="rounded-(--sc-radius-md) bg-(--sc-danger-soft) px-2.5 py-2 text-sc-sm text-(--sc-text)"
					role="alert"
				>
					<p className="font-medium">{t("diffPanel.loadFailed")}</p>
					<p className="mt-0.5 font-mono text-sc-xs break-words text-(--sc-text-muted)">{error}</p>
				</div>
			)}
			{loading && !changes ? (
				<p className="text-sc-sm text-(--sc-text-muted)">{t("common.loading")}</p>
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
					<>
						<SearchField
							controlSize="sm"
							label={t("diffPanel.search")}
							onValueChange={setQuery}
							placeholder={t("diffPanel.search")}
							value={query}
						/>
						{changes.truncated && (
							<p className="text-sc-xs text-(--sc-text-muted)" role="status">
								{t("diffPanel.listLimited")}
							</p>
						)}
						<div className="max-h-48 shrink-0 overflow-y-auto">
							{files.map(file => (
								<button
									type="button"
									key={file.path}
									aria-pressed={selected === file.path}
									className={cx(
										"flex w-full gap-2 rounded-(--sc-radius-sm) px-2 py-1.5 text-left text-sc-sm text-(--sc-text)",
										selected === file.path ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
									)}
									onClick={() => setSelected(file.path)}
								>
									<code className="shrink-0 text-(--sc-text-muted)">{file.status}</code>
									<span className="break-all">
										{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
									</span>
								</button>
							))}
							{files.length === 0 && (
								<p className="px-2 py-1.5 text-sc-sm text-(--sc-text-muted)">{t("diffPanel.noMatch")}</p>
							)}
						</div>
						{selected && !preview && !error && (
							<p className="text-sc-sm text-(--sc-text-muted)">{t("common.loading")}</p>
						)}
						{preview && (
							<div className="min-w-0">
								<p className="mb-2 font-mono text-sc-sm break-all text-(--sc-text)">{preview.path}</p>
								{preview.kind === "text" ? (
									<DiffView diff={preview.diff} filePath={preview.path} />
								) : (
									<p className="text-sc-sm text-(--sc-text-muted)">{t(`diffPanel.kind.${preview.kind}`)}</p>
								)}
								{preview.truncated && (
									<p className="text-sc-xs text-(--sc-warning)">{t("diffPanel.previewLimited")}</p>
								)}
							</div>
						)}
					</>
				)
			)}
		</div>
	);
}
