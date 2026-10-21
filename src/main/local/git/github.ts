/**
 * Agents › GitHub (C94–C99) over the user's `gh` CLI: issues, Actions,
 * releases, notifications and repositories, plus a GitHub Enterprise host and
 * another repository than the tab's checkout. Contract: `src/shared/github.ts`.
 * Failures carry gh_missing / gh_unauthenticated / not_a_repo / no_github_remote
 * (from `requireGithubRepo`) or github_failed with gh's own message.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
	GITHUB_HOST_PATTERN,
	GITHUB_REPO_NAME_PATTERN,
	GITHUB_REPO_PATTERN,
	type GithubIssue,
	type GithubOp,
	type GithubRelease,
	type GithubRequest,
	type GithubResults,
	type GithubRun,
	notificationWebUrl,
} from "../../../shared/github";
import { LocalCommandError } from "../types";
import { gh, ghText, resolveBin } from "./exec";
import { requireGithubRepo, withBodyFile } from "./pr";

/** Longest a clone may take before main gives up on it. */
const CLONE_TIMEOUT_MS = 600_000;
const LOG_TIMEOUT_MS = 120_000;
/** Lines of a run log kept for the viewer (its end, where failures show). */
const LOG_LINES = 3000;
/** Main's answer budget for one `github` command: the clone plus resolving gh and the repository. */
export const GITHUB_COMMAND_BUDGET_MS = CLONE_TIMEOUT_MS + 120_000;

/** A positional gh argument: never empty, never read as a flag. */
const word = z
	.string()
	.trim()
	.min(1)
	.max(250)
	.refine(value => !value.startsWith("-") && !/\s/.test(value));
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(65_536);
const title = z.string().trim().min(1).max(256);

const requestSchema = z
	.discriminatedUnion("op", [
		z.object({ op: z.literal("hosts") }),
		z.object({
			op: z.literal("issue_list"),
			state: z.enum(["open", "closed", "all"]),
			search: z.string().trim().max(256).optional(),
		}),
		z.object({ op: z.literal("issue_get"), number: id }),
		z.object({ op: z.literal("issue_create"), title, body: text }),
		z.object({ op: z.literal("issue_edit"), number: id, title, body: text }),
		z.object({ op: z.literal("issue_state"), number: id, state: z.enum(["open", "closed"]) }),
		z.object({ op: z.literal("issue_comment"), number: id, body: z.string().trim().min(1).max(65_536) }),
		z.object({ op: z.literal("repo_list"), owner: word.optional() }),
		z.object({ op: z.literal("repo_get") }),
		z.object({
			op: z.literal("repo_create"),
			name: z.string().refine(name => GITHUB_REPO_NAME_PATTERN.test(name) || GITHUB_REPO_PATTERN.test(name)),
			visibility: z.enum(["public", "private", "internal"]),
			description: z.string().trim().max(350),
		}),
		z.object({ op: z.literal("repo_clone"), destination: z.string().refine(path.isAbsolute) }),
		z.object({ op: z.literal("repo_fork") }),
		z.object({ op: z.literal("workflow_list") }),
		z.object({ op: z.literal("run_list"), workflow: word.optional() }),
		z.object({ op: z.literal("run_get"), id }),
		z.object({ op: z.literal("run_log"), id, failedOnly: z.boolean() }),
		z.object({ op: z.literal("workflow_dispatch"), workflow: word, ref: word.optional() }),
		z.object({ op: z.literal("run_rerun"), id, failedOnly: z.boolean() }),
		z.object({ op: z.literal("run_cancel"), id }),
		z.object({ op: z.literal("release_list") }),
		z.object({ op: z.literal("release_get"), tag: word }),
		z.object({
			op: z.literal("release_create"),
			tag: word,
			title,
			notes: text,
			draft: z.boolean(),
			prerelease: z.boolean(),
			target: word.optional(),
		}),
		z.object({
			op: z.literal("release_edit"),
			tag: word,
			title,
			notes: text,
			draft: z.boolean(),
			prerelease: z.boolean(),
		}),
		z.object({ op: z.literal("notification_list"), all: z.boolean() }),
		z.object({ op: z.literal("notification_read"), id: z.string().regex(/^\d{1,20}$/) }),
		z.object({ op: z.literal("notification_read_all") }),
	])
	.and(
		z.object({
			host: z.string().regex(GITHUB_HOST_PATTERN).optional(),
			repo: z.string().regex(GITHUB_REPO_PATTERN).optional(),
		}),
	);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface GhUser {
	login?: string;
}
interface GhIssueRow {
	number?: number;
	title?: string;
	state?: string;
	author?: GhUser | null;
	labels?: Array<{ name?: string }>;
	comments?: Array<{ author?: GhUser | null; body?: string; createdAt?: string }>;
	updatedAt?: string;
	url?: string;
	body?: string;
}
interface GhRunRow {
	databaseId?: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	headBranch?: string;
	event?: string;
	createdAt?: string;
	url?: string;
	jobs?: Array<{ name?: string; status?: string; conclusion?: string }>;
}
interface GhReleaseRow {
	tagName?: string;
	name?: string;
	isDraft?: boolean;
	isPrerelease?: boolean;
	isLatest?: boolean;
	publishedAt?: string | null;
	createdAt?: string;
	body?: string;
	targetCommitish?: string;
	url?: string;
	assets?: Array<{ name?: string; size?: number; downloadCount?: number }>;
}
interface GhRepoRow {
	nameWithOwner?: string;
	description?: string | null;
	visibility?: string;
	isFork?: boolean;
	stargazerCount?: number;
	updatedAt?: string;
	url?: string;
	defaultBranchRef?: { name?: string } | null;
	homepageUrl?: string | null;
	sshUrl?: string;
	licenseInfo?: { name?: string } | null;
}
interface GhNotificationRow {
	id?: string;
	unread?: boolean;
	reason?: string;
	updated_at?: string;
	subject?: { title?: string; url?: string | null; type?: string };
	repository?: { full_name?: string; html_url?: string };
}

const ISSUE_FIELDS = "number,title,state,author,labels,comments,updatedAt,url";
const RUN_FIELDS = "databaseId,workflowName,displayTitle,status,conclusion,headBranch,event,createdAt,url";
const RELEASE_FIELDS = "tagName,name,isDraft,isPrerelease,isLatest,publishedAt,createdAt";
const REPO_FIELDS = "nameWithOwner,description,visibility,isFork,stargazerCount,updatedAt,url";

function issue(row: GhIssueRow): GithubIssue {
	return {
		number: row.number ?? 0,
		title: row.title ?? "",
		state: row.state === "CLOSED" ? "CLOSED" : "OPEN",
		author: row.author?.login ?? "ghost",
		labels: (row.labels ?? []).flatMap(label => (label.name ? [label.name] : [])),
		commentCount: row.comments?.length ?? 0,
		updatedAt: row.updatedAt ?? "",
		url: row.url ?? "",
	};
}
function run(row: GhRunRow): GithubRun {
	return {
		id: row.databaseId ?? 0,
		workflow: row.workflowName ?? "",
		title: row.displayTitle ?? "",
		status: row.status ?? "",
		conclusion: row.conclusion ?? "",
		branch: row.headBranch ?? "",
		event: row.event ?? "",
		createdAt: row.createdAt ?? "",
		url: row.url ?? "",
	};
}
function release(row: GhReleaseRow): GithubRelease {
	return {
		tag: row.tagName ?? "",
		name: row.name ?? "",
		isDraft: row.isDraft ?? false,
		isPrerelease: row.isPrerelease ?? false,
		isLatest: row.isLatest ?? false,
		publishedAt: row.publishedAt ?? "",
		createdAt: row.createdAt ?? "",
	};
}
function repoItem(row: GhRepoRow) {
	return {
		nameWithOwner: row.nameWithOwner ?? "",
		description: row.description ?? "",
		visibility: (row.visibility ?? "").toLowerCase(),
		isFork: row.isFork ?? false,
		stars: row.stargazerCount ?? 0,
		updatedAt: row.updatedAt ?? "",
		url: row.url ?? "",
	};
}
/** The URL gh prints last (create commands), or "". */
function printedUrl(output: string): string {
	return (
		output
			.trim()
			.split("\n")
			.reverse()
			.find(line => /^https?:\/\//.test(line.trim()))
			?.trim() ?? ""
	);
}

export function parseGithubRequest(raw: unknown): GithubRequest {
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) throw new LocalCommandError(`Invalid GitHub request: ${parsed.error.message}`, "github_failed");
	return parsed.data;
}

export async function githubCommand(cwd: string, raw: unknown): Promise<GithubResults[GithubOp]> {
	const request = parseGithubRequest(raw);
	const ghBin = await resolveBin("gh");
	if (!ghBin)
		throw new LocalCommandError("GitHub CLI (gh) is not installed — see https://cli.github.com", "gh_missing");
	const host = request.host;
	const call = async (args: string[], timeoutMs?: number) => {
		try {
			return await gh(cwd, ghBin, args, { timeoutMs, env: host ? { GH_HOST: host } : undefined });
		} catch (error) {
			const message = errorText(error);
			throw new LocalCommandError(
				message,
				/gh auth login|not logged in|authentication required/i.test(message)
					? "gh_unauthenticated"
					: "github_failed",
			);
		}
	};
	const json = async <T>(args: string[]): Promise<T> => JSON.parse(await call(args)) as T;
	/** `--repo` for repository operations: the named repository (on the chosen host) or the checkout's. */
	const repo = async () => {
		if (request.repo) return host ? `${host}/${request.repo}` : request.repo;
		return (await requireGithubRepo(cwd)).repo;
	};
	const hostArgs = host ? ["--hostname", host] : [];
	switch (request.op) {
		case "hosts": {
			const status = await ghText(cwd, ghBin, ["auth", "status"]);
			const hosts = [
				...new Set(
					[...`${status.stdout}\n${status.stderr}`.matchAll(/Logged in to (\S+)/g)].map(match => match[1]),
				),
			];
			const checkout = await requireGithubRepo(cwd).then(
				found => found.repo,
				() => null,
			);
			return { hosts, repo: checkout } satisfies GithubResults["hosts"];
		}
		case "issue_list": {
			const args = ["issue", "list", "--repo", await repo(), "--state", request.state, "--limit", "50"];
			if (request.search) args.push("--search", request.search);
			const rows = await json<GhIssueRow[]>([...args, "--json", ISSUE_FIELDS]);
			return rows.map(issue) satisfies GithubResults["issue_list"];
		}
		case "issue_get": {
			const row = await json<GhIssueRow>([
				"issue",
				"view",
				String(request.number),
				"--repo",
				await repo(),
				"--json",
				`${ISSUE_FIELDS},body`,
			]);
			return {
				...issue(row),
				body: row.body ?? "",
				comments: (row.comments ?? []).map(comment => ({
					author: comment.author?.login ?? "ghost",
					body: comment.body ?? "",
					createdAt: comment.createdAt ?? "",
				})),
			} satisfies GithubResults["issue_get"];
		}
		case "issue_create": {
			const target = await repo();
			const output = await withBodyFile(request.body, file =>
				call(["issue", "create", "--repo", target, "--title", request.title, "--body-file", file]),
			);
			const url = printedUrl(output);
			return { url, number: Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? 0) } satisfies GithubResults["issue_create"];
		}
		case "issue_edit": {
			const target = await repo();
			await withBodyFile(request.body, file =>
				call([
					"issue",
					"edit",
					String(request.number),
					"--repo",
					target,
					"--title",
					request.title,
					"--body-file",
					file,
				]),
			);
			return { ok: true } satisfies GithubResults["issue_edit"];
		}
		case "issue_state":
			await call([
				"issue",
				request.state === "closed" ? "close" : "reopen",
				String(request.number),
				"--repo",
				await repo(),
			]);
			return { ok: true } satisfies GithubResults["issue_state"];
		case "issue_comment": {
			const target = await repo();
			await withBodyFile(request.body, file =>
				call(["issue", "comment", String(request.number), "--repo", target, "--body-file", file]),
			);
			return { ok: true } satisfies GithubResults["issue_comment"];
		}
		case "repo_list": {
			const rows = await json<GhRepoRow[]>([
				"repo",
				"list",
				...(request.owner ? [request.owner] : []),
				"--limit",
				"100",
				"--json",
				REPO_FIELDS,
			]);
			return rows.map(repoItem) satisfies GithubResults["repo_list"];
		}
		case "repo_get": {
			const row = await json<GhRepoRow>([
				"repo",
				"view",
				await repo(),
				"--json",
				`${REPO_FIELDS},defaultBranchRef,homepageUrl,sshUrl,licenseInfo`,
			]);
			return {
				...repoItem(row),
				defaultBranch: row.defaultBranchRef?.name ?? "",
				homepage: row.homepageUrl ?? "",
				license: row.licenseInfo?.name ?? "",
				sshUrl: row.sshUrl ?? "",
			} satisfies GithubResults["repo_get"];
		}
		case "repo_create": {
			const args = ["repo", "create", request.name, `--${request.visibility}`];
			if (request.description) args.push("--description", request.description);
			return { url: printedUrl(await call(args)) } satisfies GithubResults["repo_create"];
		}
		case "repo_clone": {
			if (!request.repo) throw new LocalCommandError("Name the repository to clone", "github_failed");
			const destination = path.resolve(request.destination);
			const parent = await fs.stat(path.dirname(destination)).catch(() => null);
			if (!parent?.isDirectory())
				throw new LocalCommandError(`The folder ${path.dirname(destination)} does not exist`, "github_failed");
			if (
				await fs.lstat(destination).then(
					() => true,
					() => false,
				)
			)
				throw new LocalCommandError(`${destination} already exists`, "github_failed");
			await call(["repo", "clone", await repo(), destination], CLONE_TIMEOUT_MS);
			return { path: destination } satisfies GithubResults["repo_clone"];
		}
		case "repo_fork":
			await call(["repo", "fork", await repo(), "--clone=false"]);
			return { ok: true } satisfies GithubResults["repo_fork"];
		case "workflow_list": {
			const rows = await json<Array<{ id?: number; name?: string; path?: string; state?: string }>>([
				"workflow",
				"list",
				"--repo",
				await repo(),
				"--all",
				"--json",
				"id,name,path,state",
			]);
			return rows.map(row => ({
				id: row.id ?? 0,
				name: row.name ?? "",
				path: row.path ?? "",
				state: row.state ?? "",
			})) satisfies GithubResults["workflow_list"];
		}
		case "run_list": {
			const args = ["run", "list", "--repo", await repo(), "--limit", "30"];
			if (request.workflow) args.push("--workflow", request.workflow);
			const rows = await json<GhRunRow[]>([...args, "--json", RUN_FIELDS]);
			return rows.map(run) satisfies GithubResults["run_list"];
		}
		case "run_get": {
			const row = await json<GhRunRow>([
				"run",
				"view",
				String(request.id),
				"--repo",
				await repo(),
				"--json",
				`${RUN_FIELDS},jobs`,
			]);
			return {
				...run(row),
				jobs: (row.jobs ?? []).map(job => ({
					name: job.name ?? "",
					status: job.status ?? "",
					conclusion: job.conclusion ?? "",
				})),
			} satisfies GithubResults["run_get"];
		}
		case "run_log": {
			const output = await call(
				["run", "view", String(request.id), "--repo", await repo(), request.failedOnly ? "--log-failed" : "--log"],
				LOG_TIMEOUT_MS,
			);
			const lines = output.replace(/\n$/, "").split("\n");
			return {
				text: lines.slice(-LOG_LINES).join("\n"),
				truncated: lines.length > LOG_LINES,
			} satisfies GithubResults["run_log"];
		}
		case "workflow_dispatch":
			await call([
				"workflow",
				"run",
				request.workflow,
				"--repo",
				await repo(),
				...(request.ref ? ["--ref", request.ref] : []),
			]);
			return { ok: true } satisfies GithubResults["workflow_dispatch"];
		case "run_rerun":
			await call([
				"run",
				"rerun",
				String(request.id),
				"--repo",
				await repo(),
				...(request.failedOnly ? ["--failed"] : []),
			]);
			return { ok: true } satisfies GithubResults["run_rerun"];
		case "run_cancel":
			await call(["run", "cancel", String(request.id), "--repo", await repo()]);
			return { ok: true } satisfies GithubResults["run_cancel"];
		case "release_list": {
			const rows = await json<GhReleaseRow[]>([
				"release",
				"list",
				"--repo",
				await repo(),
				"--limit",
				"30",
				"--json",
				RELEASE_FIELDS,
			]);
			return rows.map(release) satisfies GithubResults["release_list"];
		}
		case "release_get": {
			const row = await json<GhReleaseRow>([
				"release",
				"view",
				request.tag,
				"--repo",
				await repo(),
				"--json",
				"tagName,name,isDraft,isPrerelease,publishedAt,createdAt,body,targetCommitish,url,assets",
			]);
			return {
				...release(row),
				body: row.body ?? "",
				target: row.targetCommitish ?? "",
				url: row.url ?? "",
				assets: (row.assets ?? []).map(asset => ({
					name: asset.name ?? "",
					size: asset.size ?? 0,
					downloads: asset.downloadCount ?? 0,
				})),
			} satisfies GithubResults["release_get"];
		}
		case "release_create": {
			const target = await repo();
			const output = await withBodyFile(request.notes, file =>
				call([
					"release",
					"create",
					request.tag,
					"--repo",
					target,
					"--title",
					request.title,
					"--notes-file",
					file,
					...(request.draft ? ["--draft"] : []),
					...(request.prerelease ? ["--prerelease"] : []),
					...(request.target ? ["--target", request.target] : []),
				]),
			);
			return { url: printedUrl(output) } satisfies GithubResults["release_create"];
		}
		case "release_edit": {
			const target = await repo();
			await withBodyFile(request.notes, file =>
				call([
					"release",
					"edit",
					request.tag,
					"--repo",
					target,
					"--title",
					request.title,
					"--notes-file",
					file,
					`--draft=${request.draft}`,
					`--prerelease=${request.prerelease}`,
				]),
			);
			return { ok: true } satisfies GithubResults["release_edit"];
		}
		case "notification_list": {
			const rows = await json<GhNotificationRow[]>([
				"api",
				...hostArgs,
				`notifications?per_page=50${request.all ? "&all=true" : ""}`,
			]);
			return rows.map(row => ({
				id: row.id ?? "",
				unread: row.unread ?? false,
				reason: row.reason ?? "",
				title: row.subject?.title ?? "",
				type: row.subject?.type ?? "",
				repo: row.repository?.full_name ?? "",
				updatedAt: row.updated_at ?? "",
				url: notificationWebUrl(row.subject?.url) ?? row.repository?.html_url ?? "",
			})) satisfies GithubResults["notification_list"];
		}
		case "notification_read":
			await call(["api", ...hostArgs, "-X", "PATCH", `notifications/threads/${request.id}`]);
			return { ok: true } satisfies GithubResults["notification_read"];
		case "notification_read_all":
			await call(["api", ...hostArgs, "-X", "PUT", "notifications"]);
			return { ok: true } satisfies GithubResults["notification_read_all"];
	}
}
