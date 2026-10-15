import { ExternalLink, Pencil, Plus, RefreshCw, Rocket, Tag } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { GithubReleaseDetail } from "../../../../shared/github";
import { formatBytes, formatTimeAgo } from "../../../lib/format";
import { github, useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { AsyncSection, Badge, Button, ConfirmDialog, IconButton, Input, Modal, Switch, TextArea } from "../../common";
import { type GithubSectionProps, GithubToolbar, ListButton, ListDetail, NeedsRepo, useGithubMutation } from "./shared";

interface ReleaseDraft {
	tag: string;
	title: string;
	notes: string;
	target: string;
	draft: boolean;
	prerelease: boolean;
}

/** New release (tag, target, draft by default) or an edit of one (tag fixed). */
function ReleaseEditor({
	initial,
	editing,
	onClose,
	onSubmit,
}: {
	initial: ReleaseDraft;
	editing: boolean;
	onClose: () => void;
	onSubmit: (value: ReleaseDraft) => Promise<boolean>;
}) {
	const t = useT();
	const [value, setValue] = useState(initial);
	const [busy, setBusy] = useState(false);
	const valid = Boolean(value.tag.trim() && value.title.trim()) && !/^-|\s/.test(value.tag.trim());
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!valid) return;
		setBusy(true);
		const done = await onSubmit({
			...value,
			tag: value.tag.trim(),
			title: value.title.trim(),
			target: value.target.trim(),
		});
		setBusy(false);
		if (done) onClose();
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button disabled={!valid} form="github-release-editor" loading={busy} type="submit" variant="primary">
						{t(editing ? "common.save" : "github.releases.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="lg"
			title={t(editing ? "github.releases.editTitle" : "github.releases.newTitle", { tag: initial.tag })}
		>
			<form className="flex flex-col gap-3" id="github-release-editor" onSubmit={event => void submit(event)}>
				<div className="grid grid-cols-2 gap-3">
					<Input
						autoFocus={!editing}
						disabled={editing}
						label={t("github.releases.tag")}
						mono
						onChange={event => setValue({ ...value, tag: event.target.value })}
						placeholder="v1.0.0"
						value={value.tag}
					/>
					{!editing && (
						<Input
							hint={t("github.releases.targetHint")}
							label={t("github.releases.target")}
							mono
							onChange={event => setValue({ ...value, target: event.target.value })}
							value={value.target}
						/>
					)}
				</div>
				<Input
					autoFocus={editing}
					label={t("github.releases.title")}
					onChange={event => setValue({ ...value, title: event.target.value })}
					value={value.title}
				/>
				<TextArea
					autoGrow
					label={t("github.releases.notes")}
					onChange={event => setValue({ ...value, notes: event.target.value })}
					rows={8}
					value={value.notes}
				/>
				<div className="flex flex-wrap gap-6">
					<Switch
						checked={value.draft}
						label={t("github.releases.draft")}
						onCheckedChange={draft => setValue({ ...value, draft })}
					/>
					<Switch
						checked={value.prerelease}
						label={t("github.releases.prerelease")}
						onCheckedChange={prerelease => setValue({ ...value, prerelease })}
					/>
				</div>
			</form>
		</Modal>
	);
}

function ReleaseBadges({ release }: { release: { isDraft: boolean; isPrerelease: boolean; isLatest: boolean } }) {
	const t = useT();
	return (
		<>
			{release.isDraft && <Badge variant="warning">{t("github.releases.draft")}</Badge>}
			{release.isPrerelease && <Badge variant="info">{t("github.releases.prerelease")}</Badge>}
			{release.isLatest && <Badge variant="success">{t("github.releases.latest")}</Badge>}
		</>
	);
}

function ReleaseDetail({
	release,
	target,
	onChanged,
}: {
	release: GithubReleaseDetail;
	target: GithubSectionProps["target"];
	onChanged: () => void;
}) {
	const t = useT();
	const { busy, run } = useGithubMutation();
	const [editing, setEditing] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const save = (value: ReleaseDraft, success?: string) =>
		run(
			"edit",
			() =>
				github({
					...target,
					op: "release_edit",
					tag: release.tag,
					title: value.title,
					notes: value.notes,
					draft: value.draft,
					prerelease: value.prerelease,
				}),
			t("github.actionFailed"),
			success,
		).then(done => {
			if (done) onChanged();
			return done;
		});
	return (
		<article className="flex flex-col gap-4 px-6 py-5 min-[1280px]:px-10" data-github-release={release.tag}>
			<header className="flex flex-col gap-2">
				<h3 className="text-sc-lg font-semibold text-(--sc-text)">{release.name || release.tag}</h3>
				<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<span className="font-mono">{release.tag}</span>
					{release.target && <span className="font-mono">{release.target}</span>}
					<span>{formatTimeAgo(release.publishedAt || release.createdAt)}</span>
					<ReleaseBadges release={release} />
				</div>
				<div className="flex flex-wrap gap-2">
					<Button icon={<Pencil />} onClick={() => setEditing(true)} size="sm" variant="secondary">
						{t("common.edit")}
					</Button>
					{release.isDraft && (
						<Button
							icon={<Rocket />}
							loading={busy === "edit" && publishing}
							onClick={() => setPublishing(true)}
							size="sm"
							variant="primary"
						>
							{t("github.releases.publish")}
						</Button>
					)}
					{release.url && (
						<Button
							icon={<ExternalLink />}
							onClick={() => void window.omp.system.openExternal(release.url)}
							size="sm"
							variant="ghost"
						>
							{t("github.openOnGithub")}
						</Button>
					)}
				</div>
			</header>
			<div className="text-sc-md">
				{release.body.trim() ? (
					<MarkdownRenderer content={release.body} />
				) : (
					<p className="text-(--sc-text-muted)">{t("github.releases.noNotes")}</p>
				)}
			</div>
			{release.assets.length > 0 && (
				<section aria-label={t("github.releases.assets")} className="border-t border-(--sc-divider) pt-4">
					<h4 className="mb-2 text-sc-sm font-semibold text-(--sc-text)">{t("github.releases.assets")}</h4>
					<ul className="flex flex-col gap-1 text-sc-sm">
						{release.assets.map(asset => (
							<li className="flex items-center gap-3" key={asset.name}>
								<span className="min-w-0 flex-1 truncate font-mono text-(--sc-text)">{asset.name}</span>
								<span className="shrink-0 tabular-nums text-(--sc-text-muted)">{formatBytes(asset.size)}</span>
								<span className="shrink-0 tabular-nums text-(--sc-text-muted)">
									{t("github.releases.downloads", { count: asset.downloads })}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
			{editing && (
				<ReleaseEditor
					editing
					initial={{
						tag: release.tag,
						title: release.name || release.tag,
						notes: release.body,
						target: release.target,
						draft: release.isDraft,
						prerelease: release.isPrerelease,
					}}
					onClose={() => setEditing(false)}
					onSubmit={value => save(value)}
				/>
			)}
			<ConfirmDialog
				busy={busy !== null}
				confirmLabel={t("github.releases.publish")}
				message={t("github.releases.publishConfirm", { tag: release.tag })}
				onCancel={() => setPublishing(false)}
				onConfirm={() =>
					void save(
						{
							tag: release.tag,
							title: release.name || release.tag,
							notes: release.body,
							target: release.target,
							draft: false,
							prerelease: release.isPrerelease,
						},
						t("github.releases.published"),
					).then(() => setPublishing(false))
				}
				open={publishing}
				title={t("github.releases.publishTitle")}
			/>
		</article>
	);
}

export function GithubReleases({ target, repoName, targetKey }: GithubSectionProps) {
	const t = useT();
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const { run } = useGithubMutation();
	const list = useGithubLoad(repoName ? { ...target, op: "release_list" } : null, targetKey);
	const detail = useGithubLoad(
		repoName && selected !== null ? { ...target, op: "release_get", tag: selected } : null,
		`${targetKey}|${selected}`,
	);
	if (!repoName) return <NeedsRepo />;
	const rows = list.data ?? [];
	return (
		<>
			<GithubToolbar>
				<Button icon={<Plus />} onClick={() => setCreating(true)} size="sm" variant="secondary">
					{t("github.releases.new")}
				</Button>
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={list.loading}
					onClick={list.reload}
				/>
			</GithubToolbar>
			<ListDetail
				detail={
					selected === null ? null : (
						<AsyncSection
							error={detail.error}
							hasData={detail.data !== null}
							loading={detail.loading && !detail.data}
							onRetry={detail.reload}
						>
							{detail.data && (
								<ReleaseDetail
									key={detail.data.tag}
									onChanged={() => {
										list.reload();
										detail.reload();
									}}
									release={detail.data}
									target={target}
								/>
							)}
						</AsyncSection>
					)
				}
				label={t("github.releases.list")}
				list={
					<AsyncSection
						emptyLabel={t("github.releases.empty")}
						empty={rows.length === 0}
						error={list.error}
						hasData={rows.length > 0}
						loading={list.loading && !list.data}
						onRetry={list.reload}
					>
						<ul className="flex flex-col gap-0.5">
							{rows.map(item => (
								<ListButton
									active={item.tag === selected}
									key={item.tag}
									onSelect={() => setSelected(item.tag)}
								>
									<span className="flex w-full items-center gap-2">
										<Tag aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
										<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text)">
											{item.name || item.tag}
										</span>
									</span>
									<span className="flex w-full flex-wrap items-center gap-2 pl-6 text-sc-xs text-(--sc-text-muted)">
										<span className="font-mono">{item.tag}</span>
										<ReleaseBadges release={item} />
										<span className="ml-auto shrink-0">
											{formatTimeAgo(item.publishedAt || item.createdAt)}
										</span>
									</span>
								</ListButton>
							))}
						</ul>
					</AsyncSection>
				}
			/>
			{creating && (
				<ReleaseEditor
					editing={false}
					initial={{ tag: "", title: "", notes: "", target: "", draft: true, prerelease: false }}
					onClose={() => setCreating(false)}
					onSubmit={value =>
						run(
							"create",
							() =>
								github({
									...target,
									op: "release_create",
									tag: value.tag,
									title: value.title,
									notes: value.notes,
									draft: value.draft,
									prerelease: value.prerelease,
									target: value.target || undefined,
								}),
							t("github.actionFailed"),
							t(value.draft ? "github.releases.createdDraft" : "github.releases.created"),
						).then(done => {
							if (done) {
								list.reload();
								setSelected(value.tag);
							}
							return done;
						})
					}
				/>
			)}
		</>
	);
}
