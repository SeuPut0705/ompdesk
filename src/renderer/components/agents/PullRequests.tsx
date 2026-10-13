/**
 * Agents › Pull requests: the project's GitHub pull requests — list (checks,
 * branch, diff stat, age) beside the selected PR's detail (markdown body,
 * checks, per-file lazy diffs), an AI-drafted create flow (Dialog), and
 * one-click checkout into a worktree tab. Data rides the active tab's sidecar
 * via the pr_* RPCs; the store re-probes the repo when the tab mounts.
 */

import { CheckCircle2, Circle, GitPullRequest, GitPullRequestDraft, Plus, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcPrListItem } from "../../../shared/rpc-types";
import { cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { selectFocusedTabProject } from "../../lib/workspace-dirs";
import { usePrCenterStore } from "../../stores/pr-center";
import { toastError } from "../../stores/toast";
import { Banner, Button, EmptyState, ErrorDetail, IconButton, Spinner, Tabs } from "../common";
import { PrCreateDialog } from "./pr/PrCreateDialog";
import { PrDetail } from "./pr/PrDetail";

const GH_INSTALL_URL = "https://cli.github.com";
const LIST_STATES = ["open", "closed", "merged", "all"] as const;

/** CI rollup: failure wins, then pending, then success; nothing reported is neutral. */
function ChecksIcon({ item }: { item: RpcPrListItem }) {
	const t = useT();
	const { success, failure, pending } = item.checks;
	const [Icon, className, key] =
		failure > 0
			? [XCircle, "text-(--sc-danger)", "prCenter.checks.failing"]
			: pending > 0
				? [Circle, "text-(--sc-warning)", "prCenter.checks.pending"]
				: success > 0
					? [CheckCircle2, "text-(--sc-success)", "prCenter.checks.passing"]
					: [Circle, "text-(--sc-text-subtle)", "prCenter.checks.none"];
	return (
		<span className={cx("flex shrink-0 [&>svg]:size-(--sc-icon-sm)", className)} title={t(key)}>
			<Icon aria-hidden />
			<span className="sr-only">{t(key)}</span>
		</span>
	);
}

function PrListRow({ item, active, onSelect }: { item: RpcPrListItem; active: boolean; onSelect: () => void }) {
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={cx(
					"flex w-full flex-col gap-1 rounded-(--sc-radius-md) px-3 py-2 text-left",
					active ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
				)}
				onClick={onSelect}
				type="button"
			>
				<span className="flex w-full items-center gap-2">
					<ChecksIcon item={item} />
					<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text)">{item.title}</span>
					{item.isDraft && (
						<GitPullRequestDraft aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
					)}
				</span>
				<span className="flex w-full items-center gap-2 pl-6 text-sc-xs text-(--sc-text-muted)">
					<span className="shrink-0 tabular-nums">#{item.number}</span>
					<span className="min-w-0 truncate">{item.authorLogin}</span>
					<span className="min-w-0 flex-1 truncate font-mono">{item.headRefName}</span>
					<span className="shrink-0 tabular-nums text-(--sc-success)">+{item.additions}</span>
					<span className="shrink-0 tabular-nums text-(--sc-danger)">−{item.deletions}</span>
					<span className="shrink-0">{formatTimeAgo(item.updatedAt)}</span>
				</span>
			</button>
		</li>
	);
}

export function PullRequests() {
	const t = useT();
	const repo = usePrCenterStore(state => state.repo);
	const list = usePrCenterStore(state => state.list);
	const listState = usePrCenterStore(state => state.listState);
	const listLoading = usePrCenterStore(state => state.listLoading);
	const selected = usePrCenterStore(state => state.selected);
	const error = usePrCenterStore(state => state.error);
	const [createOpen, setCreateOpen] = useState(false);
	const [probing, setProbing] = useState(false);

	const probe = async () => {
		setProbing(true);
		try {
			await usePrCenterStore.getState().probe();
		} finally {
			setProbing(false);
		}
	};

	useEffect(() => {
		void usePrCenterStore.getState().probe();
	}, []);

	const openProject = async () => {
		try {
			if (await selectFocusedTabProject()) await probe();
		} catch (cause) {
			toastError({ title: t("titlebar.openProjectFailed"), error: cause });
		}
	};

	const retry = (
		<Button
			icon={<RefreshCw />}
			loading={probing}
			onClick={() => void probe()}
			size="sm"
			variant={repo?.available === false && repo.reason !== "no_github_remote" ? "secondary" : "primary"}
		>
			{t("prCenter.recheck")}
		</Button>
	);

	if (!repo) {
		if (error) {
			return (
				<EmptyState
					actions={retry}
					description={
						<span role="alert">
							<ErrorDetail error={error} />
						</span>
					}
					icon={<GitPullRequest />}
					title={t("prCenter.probeFailed")}
				/>
			);
		}
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner label={t("prCenter.probing")} />
			</div>
		);
	}

	if (!repo.available) {
		const reason = repo.reason;
		return (
			<EmptyState
				actions={
					<>
						{reason === "gh_missing" && (
							<Button
								onClick={() => void window.omp.system.openExternal(GH_INSTALL_URL)}
								size="sm"
								variant="primary"
							>
								{t("prCenter.installGh")}
							</Button>
						)}
						{reason === "not_a_repo" && (
							<Button onClick={() => void openProject()} size="sm" variant="primary">
								{t("titlebar.openProject")}
							</Button>
						)}
						{retry}
					</>
				}
				description={t(`prCenter.unavailableHint.${reason}`)}
				icon={<GitPullRequest />}
				title={t(`prCenter.unavailable.${reason}`)}
			/>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-(--sc-divider) px-6 py-3 min-[1280px]:px-10">
				<span className="min-w-0 truncate font-mono text-sc-sm text-(--sc-text-muted)">{repo.repo}</span>
				<Tabs
					activeId={listState}
					ariaLabel={t("prCenter.stateFilter")}
					onChange={id => usePrCenterStore.getState().setListState(id as (typeof LIST_STATES)[number])}
					tabs={LIST_STATES.map(state => ({ id: state, label: t(`prCenter.state.${state}`) }))}
					variant="segmented"
				/>
				<div className="ml-auto flex items-center gap-2">
					<IconButton
						disabled={listLoading}
						icon={<RefreshCw className={listLoading ? "animate-spin" : undefined} />}
						label={t("common.refresh")}
						onClick={() => void usePrCenterStore.getState().refresh()}
					/>
					<Button icon={<Plus />} onClick={() => setCreateOpen(true)} size="sm" variant="secondary">
						{t("prCenter.create")}
					</Button>
				</div>
			</div>
			<div className="flex min-h-0 flex-1">
				<nav
					aria-label={t("prCenter.listLabel")}
					className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-(--sc-divider) p-2 min-[1280px]:w-96"
				>
					{error && list.length > 0 && (
						<Banner className="mb-2" live title={t("prCenter.loadFailed")} variant="warning">
							<ErrorDetail error={error} />
						</Banner>
					)}
					{error && list.length === 0 ? (
						<EmptyState
							actions={
								<Button
									icon={<RefreshCw />}
									onClick={() => void usePrCenterStore.getState().refresh()}
									size="sm"
									variant="secondary"
								>
									{t("common.retry")}
								</Button>
							}
							className="flex-1"
							description={
								<span role="alert">
									<ErrorDetail error={error} />
								</span>
							}
							icon={<GitPullRequest />}
							size="sm"
							title={t("prCenter.loadFailed")}
						/>
					) : listLoading && list.length === 0 ? (
						<div className="flex flex-1 items-center justify-center">
							<Spinner label={t("prCenter.loading")} />
						</div>
					) : list.length === 0 ? (
						<EmptyState
							actions={
								<Button icon={<Plus />} onClick={() => setCreateOpen(true)} size="sm" variant="secondary">
									{t("prCenter.create")}
								</Button>
							}
							size="sm"
							title={t("prCenter.empty")}
						/>
					) : (
						<ul className="flex flex-col gap-0.5">
							{list.map(item => (
								<PrListRow
									active={item.number === selected}
									item={item}
									key={item.number}
									onSelect={() => void usePrCenterStore.getState().select(item.number)}
								/>
							))}
						</ul>
					)}
				</nav>
				<div className="min-w-0 flex-1 overflow-y-auto">
					<PrDetail onCreateOpen={() => setCreateOpen(true)} />
				</div>
			</div>
			<PrCreateDialog onClose={() => setCreateOpen(false)} open={createOpen} />
		</div>
	);
}
