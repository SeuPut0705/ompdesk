import { Download, ExternalLink, FolderOpen, GitFork, Plus, RefreshCw, Star } from "lucide-react";
import { useState } from "react";
import { GITHUB_REPO_NAME_PATTERN, GITHUB_REPO_PATTERN, type GithubVisibility } from "../../../../shared/github";
import { formatTimeAgo } from "../../../lib/format";
import { github, useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { pickWorkspaceDirectory } from "../../../lib/workspace-dirs";
import { focusedTabDevice } from "../../../stores/remote";
import {
	AsyncSection,
	Badge,
	Button,
	ConfirmDialog,
	IconButton,
	Input,
	MasterDetail,
	Modal,
	Select,
} from "../../common";
import { type GithubSectionProps, GithubToolbar, ListButton, useGithubMutation } from "./shared";

const VISIBILITIES: GithubVisibility[] = ["private", "public", "internal"];

/** `parent` + one segment, with the separator `parent` already uses (a host's paths may be Windows ones). */
function childPath(parent: string, name: string): string {
	const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
	return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function CloneDialog({ repo, host, onClose }: { repo: string; host: string | undefined; onClose: () => void }) {
	const t = useT();
	const { busy, run } = useGithubMutation();
	const [destination, setDestination] = useState("");
	const absolute = /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(destination.trim());
	const choose = async () => {
		const parent = await pickWorkspaceDirectory({
			title: t("github.repos.cloneInto"),
			device: focusedTabDevice(),
		});
		if (parent) setDestination(childPath(parent, repo.split("/")[1] ?? repo));
	};
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!absolute}
						form="github-clone"
						loading={busy === "clone"}
						type="submit"
						variant="primary"
					>
						{t("github.repos.clone")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={t("github.repos.cloneTitle", { repo })}
		>
			<form
				className="flex flex-col gap-3"
				id="github-clone"
				onSubmit={event => {
					event.preventDefault();
					if (!absolute) return;
					void run(
						"clone",
						async () => {
							const cloned = await github({ host, repo, op: "repo_clone", destination: destination.trim() });
							setDestination(cloned.path);
						},
						t("github.actionFailed"),
						t("github.repos.cloned"),
					).then(done => done && onClose());
				}}
			>
				<Input
					autoFocus
					error={destination.trim() && !absolute ? t("github.repos.destinationAbsolute") : undefined}
					hint={t("github.repos.destinationHint")}
					label={t("github.repos.destination")}
					mono
					onChange={event => setDestination(event.target.value)}
					trailing={
						<IconButton
							icon={<FolderOpen />}
							label={t("github.repos.chooseFolder")}
							onClick={() => void choose()}
							size="sm"
						/>
					}
					value={destination}
				/>
			</form>
		</Modal>
	);
}

function CreateDialog({
	host,
	onClose,
	onCreated,
}: {
	host: string | undefined;
	onClose: () => void;
	onCreated: () => void;
}) {
	const t = useT();
	const { busy, run } = useGithubMutation();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [visibility, setVisibility] = useState<GithubVisibility | "">("");
	const validName = GITHUB_REPO_NAME_PATTERN.test(name.trim()) || GITHUB_REPO_PATTERN.test(name.trim());
	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!validName || !visibility}
						form="github-repo-create"
						loading={busy === "create"}
						type="submit"
						variant="primary"
					>
						{t("github.repos.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={t("github.repos.newTitle")}
		>
			<form
				className="flex flex-col gap-3"
				id="github-repo-create"
				onSubmit={event => {
					event.preventDefault();
					if (!validName || !visibility) return;
					void run(
						"create",
						() =>
							github({
								host,
								op: "repo_create",
								name: name.trim(),
								visibility,
								description: description.trim(),
							}),
						t("github.actionFailed"),
						t("github.repos.created"),
					).then(done => {
						if (!done) return;
						onCreated();
						onClose();
					});
				}}
			>
				<Input
					autoFocus
					error={name.trim() && !validName ? t("github.repos.nameInvalid") : undefined}
					hint={t("github.repos.nameHint")}
					label={t("github.repos.name")}
					mono
					onChange={event => setName(event.target.value)}
					value={name}
				/>
				<Input
					label={t("github.repos.description")}
					onChange={event => setDescription(event.target.value)}
					value={description}
				/>
				{/* Visibility has no default: the user picks who can see the new repository. */}
				<Select
					label={t("github.repos.visibility")}
					onChange={event => setVisibility(event.target.value as GithubVisibility | "")}
					options={[
						{ value: "", label: t("github.repos.visibilityChoose"), disabled: true },
						...VISIBILITIES.map(value => ({ value, label: t(`github.repos.visibility.${value}`) })),
					]}
					value={visibility}
				/>
			</form>
		</Modal>
	);
}

export function GithubRepos({
	target,
	targetKey,
	onUse,
}: Pick<GithubSectionProps, "target" | "targetKey"> & { onUse: (repo: string) => void }) {
	const t = useT();
	const host = target.host;
	const [ownerInput, setOwnerInput] = useState("");
	const [owner, setOwner] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [cloning, setCloning] = useState(false);
	const [forking, setForking] = useState(false);
	const { busy, run } = useGithubMutation();
	const list = useGithubLoad({ host, op: "repo_list", owner: owner || undefined }, `${targetKey}|${owner}`);
	const detail = useGithubLoad(selected ? { host, repo: selected, op: "repo_get" } : null, `${targetKey}|${selected}`);
	const rows = list.data ?? [];
	const repo = detail.data;
	return (
		<>
			<GithubToolbar>
				<form
					className="flex items-center gap-2"
					onSubmit={event => {
						event.preventDefault();
						setOwner(ownerInput.trim());
						setSelected(null);
					}}
				>
					<Input
						aria-label={t("github.repos.owner")}
						controlSize="sm"
						mono
						onChange={event => setOwnerInput(event.target.value)}
						placeholder={t("github.repos.ownerPlaceholder")}
						value={ownerInput}
					/>
					<Button size="sm" type="submit" variant="secondary">
						{t("github.repos.show")}
					</Button>
				</form>
				<Button icon={<Plus />} onClick={() => setCreating(true)} size="sm" variant="secondary">
					{t("github.repos.new")}
				</Button>
				<IconButton
					className="ml-auto"
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={list.loading}
					onClick={list.reload}
				/>
			</GithubToolbar>
			<MasterDetail
				detail={
					selected === null ? null : (
						<AsyncSection
							error={detail.error}
							hasData={repo !== null}
							loading={detail.loading && !repo}
							onRetry={detail.reload}
						>
							{repo && (
								<article
									className="flex flex-col gap-4 px-6 py-5 min-[1280px]:px-10"
									data-github-repo={repo.nameWithOwner}
								>
									<header className="flex flex-col gap-2">
										<h3 className="font-mono text-sc-lg font-semibold text-(--sc-text)">
											{repo.nameWithOwner}
										</h3>
										{repo.description && (
											<p className="text-sc-md text-(--sc-text-secondary)">{repo.description}</p>
										)}
										<div className="flex flex-wrap gap-2">
											<Button
												icon={<Download />}
												onClick={() => setCloning(true)}
												size="sm"
												variant="secondary"
											>
												{t("github.repos.clone")}
											</Button>
											<Button
												icon={<GitFork />}
												loading={busy === "fork"}
												onClick={() => setForking(true)}
												size="sm"
												variant="secondary"
											>
												{t("github.repos.fork")}
											</Button>
											<Button onClick={() => onUse(repo.nameWithOwner)} size="sm" variant="secondary">
												{t("github.repos.use")}
											</Button>
											<Button
												icon={<ExternalLink />}
												onClick={() => openExternal(repo.url)}
												size="sm"
												variant="ghost"
											>
												{t("github.openOnGithub")}
											</Button>
										</div>
									</header>
									<dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sc-sm">
										<dt className="text-(--sc-text-muted)">{t("github.repos.visibility")}</dt>
										<dd className="text-(--sc-text)">{repo.visibility}</dd>
										<dt className="text-(--sc-text-muted)">{t("github.repos.defaultBranch")}</dt>
										<dd className="font-mono text-(--sc-text)">{repo.defaultBranch || "—"}</dd>
										<dt className="text-(--sc-text-muted)">{t("github.repos.license")}</dt>
										<dd className="text-(--sc-text)">{repo.license || "—"}</dd>
										<dt className="text-(--sc-text-muted)">{t("github.repos.homepage")}</dt>
										<dd className="truncate text-(--sc-text)">{repo.homepage || "—"}</dd>
										<dt className="text-(--sc-text-muted)">SSH</dt>
										<dd className="truncate font-mono text-(--sc-text)">{repo.sshUrl}</dd>
										<dt className="text-(--sc-text-muted)">{t("github.repos.updated")}</dt>
										<dd className="text-(--sc-text)">{formatTimeAgo(repo.updatedAt)}</dd>
									</dl>
								</article>
							)}
						</AsyncSection>
					)
				}
				label={t("github.repos.list")}
				list={
					<AsyncSection
						emptyLabel={t("github.repos.empty")}
						empty={rows.length === 0}
						error={list.error}
						hasData={rows.length > 0}
						loading={list.loading && !list.data}
						onRetry={list.reload}
					>
						<ul className="flex flex-col gap-0.5">
							{rows.map(item => (
								<ListButton
									active={item.nameWithOwner === selected}
									key={item.nameWithOwner}
									onSelect={() => setSelected(item.nameWithOwner)}
								>
									<span className="flex w-full items-center gap-2">
										{item.isFork && (
											<GitFork aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
										)}
										<span className="min-w-0 flex-1 truncate font-mono text-sc-md text-(--sc-text)">
											{item.nameWithOwner}
										</span>
										<Badge variant="muted">{item.visibility}</Badge>
									</span>
									<span className="flex w-full items-center gap-2 text-sc-xs text-(--sc-text-muted)">
										<span className="min-w-0 flex-1 truncate">{item.description}</span>
										<span className="flex shrink-0 items-center gap-0.5 tabular-nums">
											<Star aria-hidden className="size-3" />
											{item.stars}
										</span>
										<span className="shrink-0">{formatTimeAgo(item.updatedAt)}</span>
									</span>
								</ListButton>
							))}
						</ul>
					</AsyncSection>
				}
				onBack={() => setSelected(null)}
				open={selected !== null}
			/>
			{creating && <CreateDialog host={host} onClose={() => setCreating(false)} onCreated={list.reload} />}
			{cloning && repo && <CloneDialog host={host} onClose={() => setCloning(false)} repo={repo.nameWithOwner} />}
			<ConfirmDialog
				busy={busy === "fork"}
				confirmLabel={t("github.repos.fork")}
				message={t("github.repos.forkConfirm", { repo: repo?.nameWithOwner ?? "" })}
				onCancel={() => setForking(false)}
				onConfirm={() => {
					if (!repo) return;
					void run(
						"fork",
						() => github({ host, repo: repo.nameWithOwner, op: "repo_fork" }),
						t("github.actionFailed"),
						t("github.repos.forked"),
					).then(done => {
						setForking(false);
						if (done) list.reload();
					});
				}}
				open={forking && repo !== null}
				title={t("github.repos.forkTitle")}
			/>
		</>
	);
}
