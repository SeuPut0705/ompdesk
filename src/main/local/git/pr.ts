/**
 * PR Center commands over the `gh` CLI (port of fork rpc-pr.ts). gh's runs and their rules (the checkout's GitHub
 * repository, the list, a PR's detail and one file's diff, create, merge, review, comment, the conversation, edit and
 * the commits and changed files a draft is written from) run in the core process
 * (`native/ompdesk/crates/core/src/gh/pr.rs`, methods `gh.*`); this is their typed client, which keeps what main owns:
 * the checks of what the page sent that come before the repository is read (a PR number, the text a review or comment
 * needs, and its trim), the draft's model call (stock `omp -p`) with its prompt, the checkout through the bridge, and
 * the timeouts. Failures map to typed codes: gh_missing / gh_unauthenticated / not_a_repo / no_github_remote /
 * pr_not_found / pr_create_failed / pr_checkout_failed / pr_draft_failed / pr_merge_failed / pr_review_failed /
 * pr_edit_failed.
 */
import type {
	RpcPrComments,
	RpcPrCreateResult,
	RpcPrDetail,
	RpcPrDraftResult,
	RpcPrListItem,
	RpcPrListView,
	RpcPrMergeMethod,
	RpcPrRepo,
	RpcPrReviewEvent,
} from "../../../shared/rpc-types";
import { CoreError } from "../../core/process";
import type { BridgeClient, OmpRuntime } from "../types";
import { LocalCommandError } from "../types";
import { coreGh, DEFAULT_TIMEOUT_MS, GH_TEXT_TIMEOUT_MS } from "./exec";
import { extractDraftJson, renderPrompt } from "./parse";
import prDraftSystemPrompt from "./pr-draft-system.md?raw";
import prDraftUserPrompt from "./pr-draft-user.md?raw";

const DRAFT_TIMEOUT_MS = 170_000;
const PR_CREATE_TIMEOUT_MS = 110_000;
const PR_MERGE_TIMEOUT_MS = 110_000;

/**
 * Longest each command runs before main answers, counting every git/gh step on
 * its slowest path at that step's timeout (finding the repository is two: repo
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
	pr_merge: 2 * DEFAULT_TIMEOUT_MS + PR_MERGE_TIMEOUT_MS,
	pr_review: 3 * DEFAULT_TIMEOUT_MS,
	pr_comments: 4 * DEFAULT_TIMEOUT_MS,
	pr_edit: 3 * DEFAULT_TIMEOUT_MS,
	pr_comment: 3 * DEFAULT_TIMEOUT_MS,
} as const;

/**
 * The core's longest look for the checkout's GitHub repository: the root, `gh repo view`, and when that fails gh's
 * sign-in check (`auth status` with `--active`, then without it on a gh older than 2.40).
 */
export const GITHUB_REPO_MS = 2 * DEFAULT_TIMEOUT_MS + 2 * GH_TEXT_TIMEOUT_MS;

/** The codes the core refuses a PR Center or GitHub center request with, which the page gets as the command's `code`. */
const REFUSALS = new Set([
	"gh_missing",
	"gh_unauthenticated",
	"not_a_repo",
	"no_github_remote",
	"pr_not_found",
	"pr_create_failed",
	"pr_draft_failed",
	"pr_merge_failed",
	"pr_review_failed",
	"pr_edit_failed",
	"github_failed",
]);

/** One gh request to the core (`timeoutMs`: see `coreGh`); its refusals keep their code. */
export async function ghRequest<T>(method: string, params: object, timeoutMs: number): Promise<T> {
	try {
		return await coreGh<T>(method, params, timeoutMs);
	} catch (error) {
		if (error instanceof CoreError && REFUSALS.has(error.code))
			throw new LocalCommandError(error.message, error.code);
		throw error;
	}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function prRepo(cwd: string): Promise<RpcPrRepo> {
	return ghRequest("gh.prRepo", { cwd }, GITHUB_REPO_MS);
}

export function prList(
	cwd: string,
	input: { state?: "open" | "closed" | "merged" | "all"; limit?: number; view?: RpcPrListView },
): Promise<RpcPrListItem[]> {
	return ghRequest("gh.prList", { cwd, ...input }, GITHUB_REPO_MS + DEFAULT_TIMEOUT_MS);
}

export function prGet(cwd: string, input: { number: number }): Promise<RpcPrDetail> {
	return ghRequest("gh.prGet", { cwd, number: input.number }, GITHUB_REPO_MS + DEFAULT_TIMEOUT_MS);
}

/** One file's unified-diff slice (lazy per expand — the file index rides pr_get). */
export function prDiff(cwd: string, input: { number: number; path: string }): Promise<{ diff: string }> {
	return ghRequest("gh.prDiff", { cwd, ...input }, GITHUB_REPO_MS + DEFAULT_TIMEOUT_MS);
}

/** What the core reads for a draft: the checkout's root and the head branch's commits and changes against the base. */
interface DraftFacts {
	root: string;
	base: string;
	head: string;
	commits: string[];
	files: string[];
	diffStat: string;
}

/** AI-draft title/body from the head branch's commits + change summary, via stock `omp -p`. */
export async function prDraft(
	cwd: string,
	omp: OmpRuntime,
	input: { base?: string; head?: string },
): Promise<RpcPrDraftResult> {
	// The repository, the current branch, two revisions at up to two rev-parses each, then log and diffs at once.
	const facts = await ghRequest<DraftFacts>(
		"gh.prDraftFacts",
		{ cwd, ...input },
		GITHUB_REPO_MS + 6 * DEFAULT_TIMEOUT_MS,
	);
	const userPrompt = renderPrompt(prDraftUserPrompt, {
		base: facts.base,
		head: facts.head,
		commitCount: String(facts.commits.length),
		commits: facts.commits.join("\n"),
		fileCount: String(facts.files.length),
		files: facts.files.join("\n").slice(0, 6000),
		diffStat: facts.diffStat.slice(0, 3000),
	});
	let output: { code: number; stdout: string; stderr: string };
	try {
		output = await omp.run(["-p", "--no-session", "--no-tools", "--no-lsp"], {
			cwd: facts.root,
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

/**
 * `gh pr create` with the flags stock tools/gh-pr-checkout.ts#executePrCreate passes for the same input (stock needs a
 * live ToolSession, so the bridge; PR Center creates from main with no session), pinned to stock by
 * pr-create-stock.test.ts.
 */
export function prCreate(
	cwd: string,
	input: { title: string; body: string; base?: string; head?: string; draft?: boolean },
): Promise<RpcPrCreateResult> {
	return ghRequest(
		"gh.prCreate",
		{ cwd, ...input, timeoutMs: PR_CREATE_TIMEOUT_MS },
		GITHUB_REPO_MS + PR_CREATE_TIMEOUT_MS,
	);
}

/** Stock checkout writes the PR branch metadata that stock pr_push consumes. */
export async function prCheckout(
	cwd: string,
	input: { number: number },
	bridge: Pick<BridgeClient, "request">,
): Promise<{ path: string; branch: string }> {
	const number = checkPrNumber(input.number, "pr_checkout_failed");
	const { repo } = await ghRequest<{ repo: string }>("gh.repo", { cwd }, GITHUB_REPO_MS);
	try {
		return await bridge.request<{ path: string; branch: string }>("git.pr_checkout", { number, repo });
	} catch (error) {
		throw new LocalCommandError(errorText(error), "pr_checkout_failed");
	}
}

function checkPrNumber(number: number, code: string): number {
	if (!Number.isSafeInteger(number) || number <= 0)
		throw new LocalCommandError(`Invalid PR number: ${String(number)}`, code);
	return number;
}

/**
 * Merge on GitHub with the chosen method. `--repo` keeps gh from touching the
 * local checkout: with it, `--delete-branch` removes only the remote head branch.
 */
export async function prMerge(
	cwd: string,
	input: { number: number; method: RpcPrMergeMethod; deleteBranch?: boolean },
): Promise<{ merged: true }> {
	const number = checkPrNumber(input.number, "pr_merge_failed");
	return ghRequest(
		"gh.prMerge",
		{ cwd, number, method: input.method, deleteBranch: input.deleteBranch, timeoutMs: PR_MERGE_TIMEOUT_MS },
		GITHUB_REPO_MS + PR_MERGE_TIMEOUT_MS,
	);
}

export async function prReview(
	cwd: string,
	input: { number: number; event: RpcPrReviewEvent; body: string },
): Promise<{ submitted: true }> {
	const number = checkPrNumber(input.number, "pr_review_failed");
	const body = input.body.trim();
	if (input.event !== "approve" && !body)
		throw new LocalCommandError("A comment or change request needs text", "pr_review_failed");
	return ghRequest("gh.prReview", { cwd, number, event: input.event, body }, GITHUB_REPO_MS + DEFAULT_TIMEOUT_MS);
}

export async function prComment(cwd: string, input: { number: number; body: string }): Promise<{ submitted: true }> {
	const number = checkPrNumber(input.number, "pr_review_failed");
	const body = input.body.trim();
	if (!body) throw new LocalCommandError("A comment needs text", "pr_review_failed");
	return ghRequest("gh.prComment", { cwd, number, body }, GITHUB_REPO_MS + DEFAULT_TIMEOUT_MS);
}

/** Conversation comments, reviews and inline review comments, oldest first. */
export async function prComments(cwd: string, input: { number: number }): Promise<RpcPrComments> {
	const number = checkPrNumber(input.number, "pr_not_found");
	return ghRequest("gh.prComments", { cwd, number }, GITHUB_REPO_MS + DEFAULT_TIMEOUT_MS);
}

export async function prEdit(
	cwd: string,
	input: { number: number; title?: string; body?: string; base?: string },
): Promise<{ edited: true }> {
	const number = checkPrNumber(input.number, "pr_edit_failed");
	return ghRequest("gh.prEdit", { cwd, ...input, number }, GITHUB_REPO_MS + DEFAULT_TIMEOUT_MS);
}
