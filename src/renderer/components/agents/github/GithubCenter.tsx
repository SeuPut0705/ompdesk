/**
 * Agents › GitHub (C94–C99): issues, Actions, releases, notifications and
 * repositories of the focused tab's machine's `gh`. The bar on top picks the
 * GitHub host (when gh is signed in to more than one, e.g. an Enterprise
 * server) and the repository: the tab checkout's by default, or any
 * `OWNER/NAME` the user names.
 */
import { CircleDot, Github } from "lucide-react";
import { useState } from "react";
import { GITHUB_REPO_PATTERN, type GithubTarget } from "../../../../shared/github";
import { useGithubLoad } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { focusedTabDevice } from "../../../stores/remote";
import { Button, EmptyState, ErrorDetail, Input, Select, Spinner, Tabs } from "../../common";
import { GithubSignIn } from "../../onboarding/GithubSignIn";
import { GithubActions } from "./GithubActions";
import { GithubIssues } from "./GithubIssues";
import { GithubNotifications } from "./GithubNotifications";
import { GithubReleases } from "./GithubReleases";
import { GithubRepos } from "./GithubRepos";

const SECTIONS = ["issues", "actions", "releases", "notifications", "repos"] as const;
type Section = (typeof SECTIONS)[number];
const GH_INSTALL_URL = "https://cli.github.com";

export function GithubCenter() {
	const t = useT();
	const [section, setSection] = useState<Section>("issues");
	const [host, setHost] = useState("");
	const [repoInput, setRepoInput] = useState("");
	const [repoOverride, setRepoOverride] = useState<string | null>(null);
	const [repoInvalid, setRepoInvalid] = useState(false);
	const probe = useGithubLoad({ op: "hosts" }, "hosts");

	if (!probe.data) {
		if (probe.error) {
			const missing = probe.errorCode === "gh_missing";
			return (
				<EmptyState
					actions={
						<>
							{missing && (
								<Button
									onClick={() => void window.omp.system.openExternal(GH_INSTALL_URL)}
									size="sm"
									variant="primary"
								>
									{t("prCenter.installGh")}
								</Button>
							)}
							<Button onClick={probe.reload} size="sm" variant="secondary">
								{t("prCenter.recheck")}
							</Button>
						</>
					}
					description={
						missing ? (
							t("prCenter.unavailableHint.gh_missing")
						) : (
							<span role="alert">
								<ErrorDetail error={probe.error} />
							</span>
						)
					}
					icon={<Github />}
					title={t(missing ? "prCenter.unavailable.gh_missing" : "github.probeFailed")}
				/>
			);
		}
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner label={t("github.probing")} />
			</div>
		);
	}

	const { hosts, repo: checkoutRepo } = probe.data;
	if (hosts.length === 0) {
		const local = focusedTabDevice() === undefined;
		return (
			<div className="flex flex-1 flex-col items-center justify-center overflow-y-auto">
				<EmptyState
					actions={
						<Button onClick={probe.reload} size="sm" variant="secondary">
							{t("prCenter.recheck")}
						</Button>
					}
					description={t(
						local
							? "prCenter.unavailableHint.gh_unauthenticated"
							: "prCenter.unavailableHint.gh_unauthenticated_remote",
					)}
					icon={<Github />}
					title={t("prCenter.unavailable.gh_unauthenticated")}
				/>
				{local && <GithubSignIn className="mb-8 w-full max-w-lg" onSignedIn={probe.reload} />}
			</div>
		);
	}

	const target: GithubTarget = { host: host || undefined, repo: repoOverride ?? undefined };
	// Another host has no checkout repository: its sections need a named one.
	const repoName = repoOverride ?? (host ? null : checkoutRepo);
	const targetKey = `${host}|${repoOverride ?? ""}`;
	const sectionProps = { target, repoName, targetKey };
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-github-center>
			<div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-(--sc-divider) px-6 py-3 min-[1280px]:px-10">
				{hosts.length > 1 && (
					<Select
						aria-label={t("github.host")}
						controlSize="sm"
						onChange={event => {
							setHost(event.target.value === hosts[0] ? "" : event.target.value);
							setRepoOverride(null);
							setRepoInput("");
						}}
						options={hosts.map(value => ({ value, label: value }))}
						value={host || hosts[0]}
					/>
				)}
				<form
					className="flex min-w-0 items-center gap-2"
					onSubmit={event => {
						event.preventDefault();
						const value = repoInput.trim();
						if (!value) {
							setRepoOverride(null);
							setRepoInvalid(false);
							return;
						}
						const valid = GITHUB_REPO_PATTERN.test(value);
						setRepoInvalid(!valid);
						if (valid) setRepoOverride(value);
					}}
				>
					<Input
						aria-invalid={repoInvalid}
						aria-label={t("github.repository")}
						controlSize="sm"
						error={repoInvalid ? t("github.repositoryInvalid") : undefined}
						leadingIcon={<CircleDot />}
						mono
						onChange={event => {
							setRepoInput(event.target.value);
							setRepoInvalid(false);
						}}
						placeholder={checkoutRepo && !host ? checkoutRepo : "owner/name"}
						value={repoInput}
					/>
					<Button size="sm" type="submit" variant="secondary">
						{t("github.useRepository")}
					</Button>
					{repoOverride && (
						<Button
							onClick={() => {
								setRepoOverride(null);
								setRepoInput("");
							}}
							size="sm"
							variant="ghost"
						>
							{t(checkoutRepo && !host ? "github.useProjectRepository" : "common.clear")}
						</Button>
					)}
				</form>
				<span className="min-w-0 truncate font-mono text-sc-sm text-(--sc-text-muted)" data-github-repo-shown>
					{repoName ?? t("github.noRepository")}
				</span>
				<Tabs
					activeId={section}
					ariaLabel={t("github.sections")}
					className="ml-auto"
					onChange={id => setSection(id as Section)}
					tabs={SECTIONS.map(id => ({ id, label: t(`github.section.${id}`) }))}
					variant="segmented"
				/>
			</div>
			{section === "issues" && <GithubIssues {...sectionProps} />}
			{section === "actions" && <GithubActions {...sectionProps} />}
			{section === "releases" && <GithubReleases {...sectionProps} />}
			{section === "notifications" && <GithubNotifications target={target} targetKey={targetKey} />}
			{section === "repos" && (
				<GithubRepos
					onUse={repo => {
						setRepoOverride(repo);
						setRepoInput(repo);
						setSection("issues");
					}}
					target={target}
					targetKey={targetKey}
				/>
			)}
		</div>
	);
}
