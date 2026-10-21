/**
 * Agents › Pull requests: the project's GitHub pull requests — list (checks,
 * branch, diff stat, age) beside the selected PR's detail (markdown body,
 * checks, per-file lazy diffs), an AI-drafted create flow (Dialog), and
 * one-click checkout into a worktree tab. Data rides the active tab's sidecar
 * via the pr_* RPCs; the store re-probes the repo when the tab mounts.
 */

import { CheckCircle2, Circle, GitPullRequest, GitPullRequestDraft, Plus, RefreshCw, XCircle } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type { RpcPrListItem } from "../../../shared/rpc-types";
import { useFocusedScope } from "../../lib/focused-scope";
import { cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { selectFocusedTabProject } from "../../lib/workspace-dirs";
import { usePrCenterStore } from "../../stores/pr-center";
import { focusedTabDevice } from "../../stores/remote";
import { toastError } from "../../stores/toast";
import {
	Banner,
	Button,
	EmptyState,
	ErrorDetail,
	IconButton,
	MasterDetail,
	Skeleton,
	SkeletonRows,
	Tabs,
} from "../common";
import { GithubSignIn } from "../onboarding/GithubSignIn";
import { PrCreateDialog } from "./pr/PrCreateDialog";
import { PrDetail } from "./pr/PrDetail";

const GH_INSTALL_URL = "https://cli.github.com";
const LIST_STATES = ["open", "closed", "merged", "all"] as const;
const LIST_VIEWS = ["all", "review", "mine"] as const;

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
	const listView = usePrCenterStore(state => state.listView);
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

	// Before the first paint: what this repository showed last time is the state at once, the probe reads again.
	const scope = useFocusedScope();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scope.id` names the host and folder; `scope` is rebuilt every render
	useLayoutEffect(() => {
		usePrCenterStore.getState().enter(scope);
		void usePrCenterStore.getState().probe();
	}, [scope.id]);

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
			<div aria-busy className="flex min-h-0 flex-1 flex-col">
				<div className="shrink-0 border-b border-(--sc-divider) px-6 py-3 min-[1280px]:px-10">
					<Skeleton className="h-7 w-80 rounded-(--sc-radius-md)" />
				</div>
				<SkeletonRows className="px-3 py-2" label={t("prCenter.probing")} widths={[70, 56, 64, 48, 60]} />
			</div>
		);
	}

	if (!repo.available) {
		const reason = repo.reason;
		// Signed out, or gh missing: connect right here when the tab runs on this computer (its gh is ours; the
		// card installs a missing gh by itself, then signs in). A paired host's gh is the host's to set up.
		const local = focusedTabDevice() === undefined;
		if (reason === "gh_unauthenticated" || (reason === "gh_missing" && local)) {
			const hint =
				reason === "gh_missing"
					? "prCenter.unavailableHint.gh_missing_local"
					: local
						? "prCenter.unavailableHint.gh_unauthenticated"
						: "prCenter.unavailableHint.gh_unauthenticated_remote";
			return (
				<div className="flex flex-1 flex-col items-center justify-center overflow-y-auto">
					<EmptyState
						actions={retry}
						description={t(hint)}
						icon={<GitPullRequest />}
						title={t(`prCenter.unavailable.${reason}`)}
					/>
					{local && <GithubSignIn className="mb-8 w-full max-w-lg" onSignedIn={() => void probe()} />}
				</div>
			);
		}
		return (
			<EmptyState
				actions={
					<>
						{reason === "gh_missing" && (
							<Button onClick={() => openExternal(GH_INSTALL_URL)} size="sm" variant="primary">
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
				<Tabs
					activeId={listView}
					ariaLabel={t("prCenter.viewFilter")}
					onChange={id => usePrCenterStore.getState().setListView(id as (typeof LIST_VIEWS)[number])}
					tabs={LIST_VIEWS.map(view => ({ id: view, label: t(`prCenter.view.${view}`) }))}
					variant="segmented"
				/>
				<div className="ml-auto flex items-center gap-2">
					<IconButton
						icon={<RefreshCw />}
						label={t("common.refresh")}
						loading={listLoading}
						onClick={() => void usePrCenterStore.getState().refresh()}
					/>
					<Button icon={<Plus />} onClick={() => setCreateOpen(true)} size="sm" variant="secondary">
						{t("prCenter.create")}
					</Button>
				</div>
			</div>
			<MasterDetail
				detail={<PrDetail onCreateOpen={() => setCreateOpen(true)} />}
				label={t("prCenter.listLabel")}
				list={
					<>
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
							<SkeletonRows className="py-1" label={t("prCenter.loading")} widths={[72, 58, 66, 50, 62]} />
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
					</>
				}
				onBack={() => usePrCenterStore.getState().deselect()}
				open={selected !== null}
			/>
			<PrCreateDialog onClose={() => setCreateOpen(false)} open={createOpen} />
		</div>
	);
}
