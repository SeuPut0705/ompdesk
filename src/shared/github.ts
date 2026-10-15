/**
 * Agents › GitHub (C94–C99): issues, Actions, releases, notifications and
 * repositories over the user's `gh` CLI, one `github` RPC command whose
 * `request.op` picks the operation (main: `src/main/local/git/github.ts`).
 *
 * Every request may name a GitHub Enterprise `host` the user signed `gh` in to;
 * repository operations may name another `repo` (`OWNER/NAME`) than the tab's
 * checkout. Both are checked by the shapes below before gh sees them.
 */

/** `OWNER/NAME` as GitHub allows them (no host part; the host travels separately). */
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** A host name gh can be signed in to, e.g. `github.com` or `ghe.example.com:8443`. */
export const GITHUB_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;
/** A new repository's name. */
export const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Where an operation runs: the gh host (default: gh's own) and, for repository operations, the repository. */
export interface GithubTarget {
	host?: string;
	/** `OWNER/NAME`; default: the tab checkout's GitHub repository. */
	repo?: string;
}

export type GithubIssueState = "open" | "closed" | "all";
export type GithubVisibility = "public" | "private" | "internal";

export type GithubRequest = GithubTarget &
	(
		| { op: "hosts" }
		| { op: "issue_list"; state: GithubIssueState; search?: string }
		| { op: "issue_get"; number: number }
		| { op: "issue_create"; title: string; body: string }
		| { op: "issue_edit"; number: number; title: string; body: string }
		| { op: "issue_state"; number: number; state: "open" | "closed" }
		| { op: "issue_comment"; number: number; body: string }
		| { op: "repo_list"; owner?: string }
		| { op: "repo_get" }
		| { op: "repo_create"; name: string; visibility: GithubVisibility; description: string }
		/** Clone `repo` into `destination`, an absolute path that does not exist yet. */
		| { op: "repo_clone"; destination: string }
		| { op: "repo_fork" }
		| { op: "workflow_list" }
		| { op: "run_list"; workflow?: string }
		| { op: "run_get"; id: number }
		| { op: "run_log"; id: number; failedOnly: boolean }
		/** Start a `workflow_dispatch` workflow on `ref`. */
		| { op: "workflow_dispatch"; workflow: string; ref: string }
		| { op: "run_rerun"; id: number; failedOnly: boolean }
		| { op: "run_cancel"; id: number }
		| { op: "release_list" }
		| { op: "release_get"; tag: string }
		| {
				op: "release_create";
				tag: string;
				title: string;
				notes: string;
				draft: boolean;
				prerelease: boolean;
				target?: string;
		  }
		| { op: "release_edit"; tag: string; title: string; notes: string; draft: boolean; prerelease: boolean }
		| { op: "notification_list"; all: boolean }
		| { op: "notification_read"; id: string }
		| { op: "notification_read_all" }
	);

export type GithubOp = GithubRequest["op"];

export interface GithubIssue {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED";
	author: string;
	labels: string[];
	commentCount: number;
	updatedAt: string;
	url: string;
}
export interface GithubComment {
	author: string;
	body: string;
	createdAt: string;
}
export interface GithubIssueDetail extends GithubIssue {
	body: string;
	comments: GithubComment[];
}
export interface GithubRepo {
	nameWithOwner: string;
	description: string;
	visibility: string;
	isFork: boolean;
	stars: number;
	updatedAt: string;
	url: string;
}
export interface GithubRepoDetail extends GithubRepo {
	defaultBranch: string;
	homepage: string;
	license: string;
	sshUrl: string;
}
export interface GithubWorkflow {
	id: number;
	name: string;
	path: string;
	state: string;
}
export interface GithubRun {
	id: number;
	workflow: string;
	title: string;
	/** queued, in_progress, completed, … */
	status: string;
	/** success, failure, cancelled, … ("" while it runs). */
	conclusion: string;
	branch: string;
	event: string;
	createdAt: string;
	url: string;
}
export interface GithubJob {
	name: string;
	status: string;
	conclusion: string;
}
export interface GithubRunDetail extends GithubRun {
	jobs: GithubJob[];
}
export interface GithubRelease {
	tag: string;
	name: string;
	isDraft: boolean;
	isPrerelease: boolean;
	isLatest: boolean;
	publishedAt: string;
	createdAt: string;
}
export interface GithubAsset {
	name: string;
	size: number;
	downloads: number;
}
export interface GithubReleaseDetail extends GithubRelease {
	body: string;
	target: string;
	url: string;
	assets: GithubAsset[];
}
export interface GithubNotification {
	id: string;
	unread: boolean;
	reason: string;
	title: string;
	type: string;
	repo: string;
	updatedAt: string;
	/** The web page of the issue, PR, release or repository it is about. */
	url: string;
}

/** What each operation answers. */
export interface GithubResults {
	hosts: { hosts: string[]; repo: string | null };
	issue_list: GithubIssue[];
	issue_get: GithubIssueDetail;
	issue_create: { number: number; url: string };
	issue_edit: { ok: true };
	issue_state: { ok: true };
	issue_comment: { ok: true };
	repo_list: GithubRepo[];
	repo_get: GithubRepoDetail;
	repo_create: { url: string };
	repo_clone: { path: string };
	repo_fork: { ok: true };
	workflow_list: GithubWorkflow[];
	run_list: GithubRun[];
	run_get: GithubRunDetail;
	/** The log's last lines (`truncated` when earlier ones were dropped). */
	run_log: { text: string; truncated: boolean };
	workflow_dispatch: { ok: true };
	run_rerun: { ok: true };
	run_cancel: { ok: true };
	release_list: GithubRelease[];
	release_get: GithubReleaseDetail;
	release_create: { url: string };
	release_edit: { ok: true };
	notification_list: GithubNotification[];
	notification_read: { ok: true };
	notification_read_all: { ok: true };
}

/**
 * A notification subject's API URL → its web page: `https://api.github.com/repos/o/r/pulls/1` →
 * `https://github.com/o/r/pull/1`; Enterprise `https://host/api/v3/repos/…` → `https://host/…`.
 * `null` when the subject has no URL (e.g. a discussion) or it is not an API URL.
 */
export function notificationWebUrl(apiUrl: string | null | undefined): string | null {
	if (!apiUrl) return null;
	const match = /^https:\/\/(?:api\.(github\.com)|([^/]+)\/api\/v3)\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(apiUrl);
	if (!match) return null;
	const host = match[1] ?? match[2];
	const rest = (match[4] ?? "")
		.replace(/^\/pulls\//, "/pull/")
		.replace(/^\/commits\//, "/commit/")
		.replace(/^\/releases\/\d+$/, "/releases");
	return `https://${host}/${match[3]}${rest}`;
}
