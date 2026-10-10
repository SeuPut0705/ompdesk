/**
 * PR Center commands over the `gh` CLI (port of fork rpc-pr.ts). Failures map to
 * typed codes: gh_missing / not_a_repo / no_github_remote / pr_not_found /
 * pr_create_failed / pr_checkout_failed / pr_draft_failed.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	RpcPrCreateResult,
	RpcPrDetail,
	RpcPrDraftResult,
	RpcPrListItem,
	RpcPrRepo,
} from "../../../shared/rpc-types";
import type { BridgeClient, OmpRuntime } from "../types";
import { LocalCommandError } from "../types";
import { repoRoot } from "./changes";
import { DEFAULT_TIMEOUT_MS, gh, git, gitRaw, resolveBin } from "./exec";
import { extractDraftJson, parsePrUnifiedDiff, renderPrompt, rollupCounts } from "./parse";
import prDraftSystemPrompt from "./pr-draft-system.md?raw";
import prDraftUserPrompt from "./pr-draft-user.md?raw";

interface GhPrListRow {
	number?: number;
	title?: string;
	url?: string;
	isDraft?: boolean;
	author?: { login?: string } | null;
	headRefName?: string;
	baseRefName?: string;
	additions?: number;
	deletions?: number;
	updatedAt?: string;
	reviewDecision?: string | null;
	statusCheckRollup?: Array<{ name?: string; context?: string; status?: string; conclusion?: string | null }> | null;
}

interface GhPrDetailRow extends GhPrListRow {
	body?: string | null;
	mergeStateStatus?: string;
	files?: Array<{ path?: string; additions?: number; deletions?: number; changeType?: string }> | null;
}

const PR_LIST_FIELDS =
	"number,title,url,isDraft,author,headRefName,baseRefName,additions,deletions,updatedAt,reviewDecision,statusCheckRollup";
const PR_DETAIL_FIELDS =
	"number,title,url,isDraft,author,body,baseRefName,headRefName,mergeStateStatus,additions,deletions,reviewDecision,files,statusCheckRollup";
const DRAFT_TIMEOUT_MS = 170_000;
const PR_CREATE_TIMEOUT_MS = 110_000;

/**
 * Longest each command runs before main answers, counting every git/gh step on
 * its slowest path at that step's timeout (`requireGithubRepo` is two: repo
 * root and `gh repo view`). The renderer's RPC timeouts (shared/rpc-client.ts)
 * must not be shorter, or it reports a failure while the work still lands.
 */
export const PR_COMMAND_BUDGETS_MS = {
	pr_repo: 2 * DEFAULT_TIMEOUT_MS,
	pr_list: 3 * DEFAULT_TIMEOUT_MS,
	pr_get: 3 * DEFAULT_TIMEOUT_MS,
	pr_diff: 3 * DEFAULT_TIMEOUT_MS,
	// + current branch, two revisions at up to two rev-parses each, then log/diff in parallel.
	pr_draft: 8 * DEFAULT_TIMEOUT_MS + DRAFT_TIMEOUT_MS,
	pr_create: 2 * DEFAULT_TIMEOUT_MS + PR_CREATE_TIMEOUT_MS,
	// Preflight plus the bridge's bounded stock checkout (including clone/fetch).
	pr_checkout: 2 * DEFAULT_TIMEOUT_MS + 600_000,
} as const;

interface GithubRepo {
	ghBin: string;
	root: string;
	repo: string;
	defaultBranch: string | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Resolve gh + the GitHub repo for `cwd`, or throw the typed reason. */
async function requireGithubRepo(cwd: string): Promise<GithubRepo> {
	const ghBin = await resolveBin("gh");
	if (!ghBin)
		throw new LocalCommandError("GitHub CLI (gh) is not installed — see https://cli.github.com", "gh_missing");
	const root = await repoRoot(cwd);
	if (!root) throw new LocalCommandError(`Not a git repository: ${cwd}`, "not_a_repo");
	let view: { nameWithOwner?: string; defaultBranchRef?: { name?: string } | null };
	try {
		view = JSON.parse(await gh(root, ghBin, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]));
	} catch (error) {
		throw new LocalCommandError(`No GitHub remote for ${root}: ${errorText(error)}`, "no_github_remote");
	}
	if (!view.nameWithOwner) throw new LocalCommandError(`No GitHub remote for ${root}`, "no_github_remote");
	return { ghBin, root, repo: view.nameWithOwner, defaultBranch: view.defaultBranchRef?.name || null };
}

export async function prRepo(cwd: string): Promise<RpcPrRepo> {
	try {
		const { repo, defaultBranch } = await requireGithubRepo(cwd);
		return { available: true, repo, defaultBranch };
	} catch (error) {
		if (
			error instanceof LocalCommandError &&
			(error.code === "gh_missing" || error.code === "not_a_repo" || error.code === "no_github_remote")
		)
			return { available: false, reason: error.code };
		throw error;
	}
}

export async function prList(
	cwd: string,
	input: { state?: "open" | "closed" | "merged" | "all"; limit?: number },
): Promise<RpcPrListItem[]> {
	const { ghBin, root, repo } = await requireGithubRepo(cwd);
	const args = ["pr", "list", "--repo", repo, "--state", input.state ?? "open", "--limit", String(input.limit ?? 50)];
	const rows: GhPrListRow[] = JSON.parse(await gh(root, ghBin, [...args, "--json", PR_LIST_FIELDS]));
	return rows.map(row => ({
		number: row.number ?? 0,
		title: row.title ?? "",
		url: row.url ?? "",
		isDraft: row.isDraft ?? false,
		authorLogin: row.author?.login ?? "ghost",
		headRefName: row.headRefName ?? "",
		baseRefName: row.baseRefName ?? "",
		additions: row.additions ?? 0,
		deletions: row.deletions ?? 0,
		updatedAt: row.updatedAt ?? "",
		reviewDecision: row.reviewDecision ?? null,
		checks: rollupCounts(row.statusCheckRollup),
	}));
}

export async function prGet(cwd: string, input: { number: number }): Promise<RpcPrDetail> {
	const { ghBin, root, repo } = await requireGithubRepo(cwd);
	let row: GhPrDetailRow;
	try {
		row = JSON.parse(
			await gh(root, ghBin, ["pr", "view", String(input.number), "--repo", repo, "--json", PR_DETAIL_FIELDS]),
		);
	} catch (error) {
		throw new LocalCommandError(`PR #${input.number}: ${errorText(error)}`, "pr_not_found");
	}
	return {
		number: row.number ?? input.number,
		title: row.title ?? "",
		url: row.url ?? "",
		isDraft: row.isDraft ?? false,
		authorLogin: row.author?.login ?? "ghost",
		body: row.body ?? "",
		baseRefName: row.baseRefName ?? "",
		headRefName: row.headRefName ?? "",
		mergeStateStatus: row.mergeStateStatus ?? "",
		additions: row.additions ?? 0,
		deletions: row.deletions ?? 0,
		reviewDecision: row.reviewDecision ?? null,
		files: (row.files ?? []).map(file => ({
			path: file.path ?? "",
			changeType: file.changeType ?? "modified",
			additions: file.additions ?? 0,
			deletions: file.deletions ?? 0,
		})),
		checks: (row.statusCheckRollup ?? []).map(check => ({
			name: check.name ?? check.context ?? "check",
			status: check.status ?? "",
			conclusion: check.conclusion ?? null,
		})),
	};
}

/** One file's unified-diff slice (lazy per expand — the file index rides pr_get). */
export async function prDiff(cwd: string, input: { number: number; path: string }): Promise<{ diff: string }> {
	const { ghBin, root, repo } = await requireGithubRepo(cwd);
	let text: string;
	try {
		text = await gh(root, ghBin, ["pr", "diff", String(input.number), "--repo", repo, "--color", "never"]);
	} catch (error) {
		throw new LocalCommandError(`PR #${input.number}: ${errorText(error)}`, "pr_not_found");
	}
	const file = parsePrUnifiedDiff(text).find(entry => entry.path === input.path);
	if (!file) throw new LocalCommandError(`PR #${input.number} has no file ${input.path}`, "pr_not_found");
	return { diff: text.slice(file.startOffset, file.endOffset) };
}

/** `name` when it resolves locally, else `origin/name` (a fresh clone often lacks the local default branch). */
async function resolveRev(root: string, name: string): Promise<string> {
	if ((await gitRaw(root, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).code === 0) return name;
	if ((await gitRaw(root, ["rev-parse", "--verify", "--quiet", `origin/${name}^{commit}`])).code === 0)
		return `origin/${name}`;
	throw new LocalCommandError(`Unknown revision: ${name}`, "pr_draft_failed");
}

/** AI-draft title/body from the head branch's commits + change summary, via stock `omp -p`. */
export async function prDraft(
	cwd: string,
	omp: OmpRuntime,
	input: { base?: string; head?: string },
): Promise<RpcPrDraftResult> {
	const { root, defaultBranch } = await requireGithubRepo(cwd);
	const base = input.base ?? defaultBranch ?? "HEAD~1";
	const currentBranch = (await gitRaw(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout
		.toString("utf8")
		.trim();
	const head = input.head ?? (currentBranch || "HEAD");
	const range = `${await resolveRev(root, base)}...${await resolveRev(root, head)}`;
	const [log, nameOnly, numstat] = await Promise.all([
		git(root, ["log", "--no-merges", "--format=%s", "-n", "50", range]),
		git(root, ["diff", "--name-only", range]),
		git(root, ["diff", "--numstat", range]),
	]);
	const commits = log.split("\n").filter(Boolean);
	const files = nameOnly.split("\n").filter(Boolean);
	if (commits.length === 0 && files.length === 0) {
		throw new LocalCommandError(`No changes between ${base} and ${head}`, "pr_draft_failed");
	}
	const userPrompt = renderPrompt(prDraftUserPrompt, {
		base,
		head,
		commitCount: String(commits.length),
		commits: commits.join("\n"),
		fileCount: String(files.length),
		files: files.join("\n").slice(0, 6000),
		diffStat: numstat.trim().slice(0, 3000),
	});
	let output: { code: number; stdout: string; stderr: string };
	try {
		output = await omp.run(["-p", "--no-session", "--no-tools", "--no-lsp"], {
			cwd: root,
			input: `${prDraftSystemPrompt.trim()}\n\n---\n\n${userPrompt}`,
			timeoutMs: DRAFT_TIMEOUT_MS,
		});
	} catch (error) {
		throw new LocalCommandError(`Draft failed: ${errorText(error)}`, "pr_draft_failed");
	}
	const draft = output.code === 0 ? extractDraftJson(output.stdout) : null;
	if (!draft) {
		const detail = (output.stderr || output.stdout).trim().slice(0, 300);
		throw new LocalCommandError(`The model did not return a draft${detail ? `: ${detail}` : ""}`, "pr_draft_failed");
	}
	return { title: draft.title.trim(), body: draft.body.trim() };
}

export async function prCreate(
	cwd: string,
	input: { title: string; body: string; base?: string; head?: string; draft?: boolean },
): Promise<RpcPrCreateResult> {
	const { ghBin, root, repo } = await requireGithubRepo(cwd);
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pr-body-"));
	try {
		const bodyFile = path.join(tempDir, "body.md");
		await fs.writeFile(bodyFile, input.body);
		const args = ["pr", "create", "--repo", repo, "--title", input.title, "--body-file", bodyFile];
		if (input.base) args.push("--base", input.base);
		if (input.head) args.push("--head", input.head);
		if (input.draft) args.push("--draft");
		const output = await gh(root, ghBin, args, { timeoutMs: PR_CREATE_TIMEOUT_MS });
		const url = output.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
		const number = url ? Number(url.split("/").pop()) : Number.NaN;
		if (!url || !Number.isFinite(number)) {
			throw new LocalCommandError(`gh pr create returned no PR URL: ${output.slice(0, 300)}`, "pr_create_failed");
		}
		return { url, number };
	} catch (error) {
		if (error instanceof LocalCommandError) throw error;
		throw new LocalCommandError(errorText(error), "pr_create_failed");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

/** Stock checkout writes the PR branch metadata that stock pr_push consumes. */
export async function prCheckout(
	cwd: string,
	input: { number: number },
	bridge: Pick<BridgeClient, "request">,
): Promise<{ path: string; branch: string }> {
	const number = input.number;
	if (!Number.isSafeInteger(number) || number <= 0) {
		throw new LocalCommandError(`Invalid PR number: ${String(number)}`, "pr_checkout_failed");
	}
	const { repo } = await requireGithubRepo(cwd);
	try {
		return await bridge.request<{ path: string; branch: string }>("git.pr_checkout", { number, repo });
	} catch (error) {
		throw new LocalCommandError(errorText(error), "pr_checkout_failed");
	}
}
