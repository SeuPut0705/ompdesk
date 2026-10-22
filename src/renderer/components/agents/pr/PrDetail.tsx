/**
 * Pull request detail (Agents › Pull requests): header (title, state,
 * branches, diff stat, review decision, actions), collapsible markdown body,
 * checks, and the files index with per-file lazy DiffView expansion. Diff
 * text loads on first expand via pr_diff — closed files cost nothing.
 */

import {
	CheckCircle2,
	Circle,
	ExternalLink,
	GitBranch,
	GitPullRequest,
	GitPullRequestDraft,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { githubConclusionPassed } from "../../../../shared/github-checks";
import { DiffView } from "../../../lib/diff";
import { githubStateLabel } from "../../../lib/github-state";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { openExternal } from "../../../lib/open-external";
import { usePrCenterStore } from "../../../stores/pr-center";
import { Badge, Button, DisclosureButton, EmptyState, ErrorDetail, InlineNotice, Skeleton } from "../../common";
import { PrConversation, PrEditButton, PrMergeButton } from "./PrActions";

const BODY_COLLAPSE_LINES = 12;

function CheckIcon({ conclusion, status }: { conclusion: string | null; status: string }) {
	const className = "size-(--sc-icon-sm) shrink-0";
	if (conclusion && githubConclusionPassed(conclusion)) {
		return <CheckCircle2 aria-hidden className={`${className} text-(--sc-success)`} />;
	}
	if (conclusion) return <XCircle aria-hidden className={`${className} text-(--sc-danger)`} />;
	if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING") {
		return <Circle aria-hidden className={`${className} fill-current text-(--sc-warning)`} />;
	}
	return <Circle aria-hidden className={`${className} text-(--sc-text-subtle)`} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className="text-sc-md font-semibold text-(--sc-text)">{title}</h3>
			{children}
		</section>
	);
}

function FileRow({ path, additions, deletions }: { path: string; additions: number; deletions: number }) {
	const t = useT();
	const expanded = usePrCenterStore(state => state.expandedFiles[path]);
	return (
		<li className="overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
			<DisclosureButton
				className="px-3 py-2 hover:bg-(--sc-hover)"
				onToggle={() => void usePrCenterStore.getState().toggleFile(path)}
				open={expanded !== undefined}
			>
				<span className="min-w-0 flex-1 truncate font-mono text-sc-sm text-(--sc-text)">{path}</span>
				<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-success)">+{additions}</span>
				<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-danger)">−{deletions}</span>
			</DisclosureButton>
			{expanded?.phase === "loading" && (
				<div className="border-t border-(--sc-divider) px-3 py-2">
					<div aria-label={t("prCenter.diffLoading")} className="flex flex-col gap-2" role="status">
						<Skeleton className="h-3 w-[70%]" />
						<Skeleton className="h-3 w-[85%]" />
						<Skeleton className="h-3 w-[55%]" />
					</div>
				</div>
			)}
			{expanded?.phase === "error" && (
				<InlineNotice
					className="border-t border-(--sc-divider) px-3"
					live
					title={t("prCenter.diffFailed")}
					tone="danger"
				/>
			)}
			{expanded?.phase === "ready" && (
				<div className="overflow-x-auto border-t border-(--sc-divider) bg-(--sc-surface-1) py-1">
					<DiffView diff={expanded.diff} filePath={path} />
				</div>
			)}
		</li>
	);
}

export function PrDetail({ onCreateOpen }: { onCreateOpen: () => void }) {
	const t = useT();
	const detail = usePrCenterStore(state => state.detail);
	const detailLoading = usePrCenterStore(state => state.detailLoading);
	const selected = usePrCenterStore(state => state.selected);
	const error = usePrCenterStore(state => state.error);
	const [bodyExpanded, setBodyExpanded] = useState(false);

	if (selected === null) {
		return (
			<EmptyState
				actions={
					<Button onClick={onCreateOpen} size="sm" variant="primary">
						{t("prCenter.create")}
					</Button>
				}
				className="h-full"
				description={t("prCenter.noSelection")}
				icon={<GitPullRequest />}
				title={t("prCenter.noSelectionTitle")}
			/>
		);
	}
	// A PR seen before shows its last read while it loads again; one never seen is the shape of a PR. A read that
	// failed must not sit on a skeleton forever.
	if (!detail && (detailLoading || !error)) {
		return (
			<div
				aria-label={t("prCenter.loading")}
				className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-6 min-[1280px]:px-10"
				role="status"
			>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-6 w-3/4" />
					<Skeleton className="h-4 w-1/2" />
					<div className="flex gap-2 pt-1">
						<Skeleton className="h-8 w-28 rounded-(--sc-radius-md)" />
						<Skeleton className="h-8 w-28 rounded-(--sc-radius-md)" />
						<Skeleton className="h-8 w-28 rounded-(--sc-radius-md)" />
					</div>
				</div>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-[92%]" />
					<Skeleton className="h-3 w-[64%]" />
				</div>
				<div className="flex flex-col gap-2">
					{[0, 1, 2, 3].map(index => (
						<Skeleton className="h-9 w-full rounded-(--sc-radius-md)" key={index} />
					))}
				</div>
			</div>
		);
	}
	if (!detail) {
		return (
			<EmptyState
				actions={
					<Button
						icon={<RefreshCw />}
						onClick={() => void usePrCenterStore.getState().select(selected)}
						size="sm"
						variant="secondary"
					>
						{t("common.retry")}
					</Button>
				}
				className="h-full"
				description={
					<span role="alert">
						<ErrorDetail error={error} />
					</span>
				}
				title={t("prCenter.detailFailed")}
			/>
		);
	}

	const bodyLines = detail.body.split("\n");
	const collapsible = bodyLines.length > BODY_COLLAPSE_LINES;
	const shownBody = bodyExpanded || !collapsible ? detail.body : bodyLines.slice(0, BODY_COLLAPSE_LINES).join("\n");

	return (
		// Keyed on the selection so switching PRs resets the body expansion that
		// belongs to the PR being left behind.
		<article className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-6 min-[1280px]:px-10" key={selected}>
			<header className="flex flex-col gap-3">
				<div className="flex items-start gap-3">
					{detail.isDraft ? (
						<GitPullRequestDraft
							aria-hidden
							className="mt-1 size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)"
						/>
					) : (
						<GitPullRequest aria-hidden className="mt-1 size-(--sc-icon-md) shrink-0 text-(--sc-success)" />
					)}
					<h2 className="min-w-0 flex-1 text-sc-xl font-semibold text-(--sc-text)">
						{detail.title} <span className="font-normal text-(--sc-text-muted)">#{detail.number}</span>
					</h2>
					{detail.isDraft && <Badge variant="default">{t("prCenter.draft")}</Badge>}
				</div>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sc-sm text-(--sc-text-muted)">
					<span className="text-(--sc-text-secondary)">@{detail.authorLogin}</span>
					<span aria-hidden>·</span>
					<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="font-mono">{detail.headRefName}</span>
					<span aria-hidden>→</span>
					<span className="font-mono">{detail.baseRefName}</span>
					<span aria-hidden>·</span>
					<span className="tabular-nums text-(--sc-success)">+{detail.additions}</span>
					<span className="tabular-nums text-(--sc-danger)">−{detail.deletions}</span>
					{detail.reviewDecision && (
						<>
							<span aria-hidden>·</span>
							<span>{detail.reviewDecision.toLowerCase().replace(/_/g, " ")}</span>
						</>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						icon={<GitBranch />}
						onClick={() => void usePrCenterStore.getState().checkout(detail.number)}
						size="sm"
						variant="primary"
					>
						{t("prCenter.checkout")}
					</Button>
					<Button icon={<ExternalLink />} onClick={() => openExternal(detail.url)} size="sm" variant="secondary">
						{t("prCenter.openInBrowser")}
					</Button>
					<PrEditButton detail={detail} />
					<PrMergeButton detail={detail} />
					{detail.state && detail.state !== "OPEN" && (
						<Badge variant={detail.state === "MERGED" ? "accent" : "muted"}>
							{t(`prCenter.state.${detail.state.toLowerCase()}`)}
						</Badge>
					)}
				</div>
			</header>

			{detail.body.trim().length > 0 && (
				<Section title={t("prCenter.section.body")}>
					<div className="text-sc-lg">
						<MarkdownRenderer content={shownBody} />
					</div>
					{collapsible && (
						<div>
							<Button onClick={() => setBodyExpanded(expanded => !expanded)} size="sm" variant="ghost">
								{bodyExpanded
									? t("prCenter.collapse")
									: t("prCenter.expand", { count: String(bodyLines.length - BODY_COLLAPSE_LINES) })}
							</Button>
						</div>
					)}
				</Section>
			)}

			{detail.checks.length > 0 && (
				<Section title={t("prCenter.section.checks", { count: String(detail.checks.length) })}>
					<ul className="flex flex-col divide-y divide-(--sc-divider) rounded-(--sc-radius-lg) border border-(--sc-border-subtle)">
						{detail.checks.map((check, index) => (
							<li
								className="flex items-center gap-2 px-3 py-2 text-sc-sm"
								data-pr-check
								// One rollup can hold two checks of one name (a `check` job in two workflows).
								key={`${index}:${check.name}`}
							>
								<CheckIcon conclusion={check.conclusion} status={check.status} />
								<span className="min-w-0 truncate text-(--sc-text)">{check.name}</span>
								<span className="ml-auto shrink-0 text-sc-xs text-(--sc-text-muted)">
									{githubStateLabel(t, check.conclusion ?? check.status)}
								</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			<Section title={t("prCenter.section.files", { count: String(detail.files.length) })}>
				<ul className="flex flex-col gap-2">
					{detail.files.map(file => (
						<FileRow additions={file.additions} deletions={file.deletions} key={file.path} path={file.path} />
					))}
				</ul>
			</Section>

			<PrConversation detail={detail} />
		</article>
	);
}
