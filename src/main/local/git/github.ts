/**
 * Agents › GitHub (C94–C99) over the user's `gh` CLI: issues, Actions,
 * releases, notifications and repositories, plus a GitHub Enterprise host and
 * another repository than the tab's checkout. Contract: `src/shared/github.ts`.
 * The operations run in the core process (`native/ompdesk/crates/core/src/gh/center.rs`,
 * `gh.github`); main keeps the check of what the page sent (`parseGithubRequest`)
 * and spells a clone's destination and its folder with node's `path`.
 * Failures carry gh_missing / gh_unauthenticated / not_a_repo / no_github_remote
 * (as `pr_repo` finds the checkout's repository) or github_failed with gh's own message.
 */
import * as path from "node:path";
import { z } from "zod";
import {
	GITHUB_HOST_PATTERN,
	GITHUB_REPO_NAME_PATTERN,
	GITHUB_REPO_PATTERN,
	type GithubOp,
	type GithubRequest,
	type GithubResults,
} from "../../../shared/github";
import { LocalCommandError } from "../types";
import { GITHUB_REPO_MS, ghRequest } from "./pr";

/** Longest a clone may take before main gives up on it. */
const CLONE_TIMEOUT_MS = 600_000;
const LOG_TIMEOUT_MS = 120_000;
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

export function parseGithubRequest(raw: unknown): GithubRequest {
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) throw new LocalCommandError(`Invalid GitHub request: ${parsed.error.message}`, "github_failed");
	return parsed.data;
}

export async function githubCommand(cwd: string, raw: unknown): Promise<GithubResults[GithubOp]> {
	const request = parseGithubRequest(raw);
	const destination = request.op === "repo_clone" ? path.resolve(request.destination) : null;
	return ghRequest(
		"gh.github",
		{
			cwd,
			request: destination === null ? request : { ...request, destination, parent: path.dirname(destination) },
			cloneTimeoutMs: CLONE_TIMEOUT_MS,
			logTimeoutMs: LOG_TIMEOUT_MS,
		},
		GITHUB_REPO_MS + CLONE_TIMEOUT_MS,
	);
}
