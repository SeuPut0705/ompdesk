import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubCommand, parseGithubRequest } from "./github";
import { prCreate, prList, prRepo } from "./pr";
import { initRepo } from "./test-repos";

describe("github requests", () => {
	it("accepts each operation's shape with an optional host and OWNER/NAME repository", () => {
		expect(
			parseGithubRequest({ op: "issue_list", state: "open", repo: "octo-org/app.js", host: "ghe.example.com" }),
		).toEqual({
			op: "issue_list",
			state: "open",
			repo: "octo-org/app.js",
			host: "ghe.example.com",
		});
		expect(parseGithubRequest({ op: "repo_clone", repo: "o/r", destination: "/tmp/r" })).toMatchObject({
			destination: "/tmp/r",
		});
		expect(
			parseGithubRequest({
				op: "release_create",
				tag: "v1.0.0",
				title: "One",
				notes: "",
				draft: true,
				prerelease: false,
			}),
		).toMatchObject({ draft: true });
		expect(parseGithubRequest({ op: "workflow_dispatch", workflow: "ci.yml" })).toEqual({
			op: "workflow_dispatch",
			workflow: "ci.yml",
		});
	});

	it("refuses anything gh could read as a flag, a host part in repo, and a clone without an absolute path", () => {
		for (const bad of [
			{ op: "release_get", tag: "--help" },
			{ op: "workflow_dispatch", workflow: "ci.yml", ref: "-x" },
			{ op: "workflow_dispatch", workflow: "ci.yml", ref: "a b" },
			{ op: "issue_list", state: "open", repo: "github.com/o/r" },
			{ op: "issue_list", state: "open", host: "evil.com/x" },
			{ op: "repo_clone", repo: "o/r", destination: "relative/dir" },
			{ op: "repo_create", name: "a b", visibility: "public", description: "" },
			{ op: "repo_create", name: "ok", description: "" },
			{ op: "notification_read", id: "../user" },
			{ op: "issue_get", number: 0 },
			{ op: "issue_create", title: "  ", body: "" },
			{ op: "unknown" },
		]) {
			expect(() => parseGithubRequest(bad), JSON.stringify(bad)).toThrow(/Invalid GitHub request/);
		}
	});
});

interface Rule {
	match: string;
	stdout?: string;
	stderr?: string;
	code?: number;
}
interface Seen {
	argv: string[];
	cwd: string;
	env: Record<string, string | null>;
	body?: { content: string; file: string; dirMode: string };
}

/** A gh that answers by the first rule its arguments start with and records what it saw (a shebang script: POSIX). */
const STAND_IN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.STAND_IN_GH;
const argv = process.argv.slice(2);
const seen = { argv: [...argv], cwd: process.cwd(), env: {} };
for (const k of ["GH_HOST", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "NO_COLOR", "GIT_OPTIONAL_LOCKS"]) seen.env[k] = process.env[k] ?? null;
const at = argv.findIndex(arg => arg === "--body-file" || arg === "--notes-file");
if (at >= 0) {
	const file = argv[at + 1];
	seen.body = { content: fs.readFileSync(file, "utf8"), file, dirMode: (fs.statSync(path.dirname(file)).mode & 0o777).toString(8) };
	seen.argv[at + 1] = "<file>";
}
fs.appendFileSync(path.join(dir, "seen.jsonl"), JSON.stringify(seen) + "\\n");
const rules = JSON.parse(fs.readFileSync(path.join(dir, "rules.json"), "utf8"));
const rule = rules.find(r => argv.join(" ").startsWith(r.match)) ?? { stderr: "no rule\\n", code: 9 };
if (rule.stdout) process.stdout.write(rule.stdout);
if (rule.stderr) process.stderr.write(rule.stderr);
process.exitCode = rule.code ?? 0;
`;

const VIEW: Rule = {
	match: "repo view --json",
	stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }),
};

describe.skipIf(process.platform === "win32")("gh through the core, against a stand-in gh", () => {
	let dir = "";
	let repo = "";
	const saved = { PATH: process.env.PATH, BREW: process.env.OMP_GUI_TEST_BREW_DIRS };
	beforeAll(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-gh-core-")));
		await fs.mkdir(path.join(dir, "bin"));
		await fs.writeFile(path.join(dir, "bin", "gh"), STAND_IN, { mode: 0o755 });
		// The stand-in answers before any gh the machine has (`resolveBin` reads the inherited PATH first).
		process.env.PATH = `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
		process.env.OMP_GUI_TEST_BREW_DIRS = "";
		process.env.STAND_IN_GH = dir;
		repo = path.join(dir, "repo");
		await initRepo(repo);
	});
	afterAll(async () => {
		process.env.PATH = saved.PATH;
		if (saved.BREW === undefined) delete process.env.OMP_GUI_TEST_BREW_DIRS;
		else process.env.OMP_GUI_TEST_BREW_DIRS = saved.BREW;
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function run<T>(rules: Rule[], fn: () => Promise<T>): Promise<{ result: T | Error; seen: Seen[] }> {
		await fs.writeFile(path.join(dir, "rules.json"), JSON.stringify(rules));
		await fs.rm(path.join(dir, "seen.jsonl"), { force: true });
		const result = await fn().catch((error: Error) => error);
		const text = await fs.readFile(path.join(dir, "seen.jsonl"), "utf8").catch(() => "");
		return {
			result,
			seen: text
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Seen),
		};
	}

	it("names the checkout's repository with gh's quiet environment, and tells a signed-out gh from a missing remote", async () => {
		const found = await run([VIEW], () => prRepo(path.join(repo, ".")));
		expect(found.result).toEqual({ available: true, repo: "o/r", defaultBranch: "main" });
		expect(found.seen).toEqual([
			{
				argv: ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
				cwd: repo,
				env: {
					GH_HOST: null,
					GH_PROMPT_DISABLED: "1",
					GH_NO_UPDATE_NOTIFIER: "1",
					NO_COLOR: "1",
					GIT_OPTIONAL_LOCKS: "0",
				},
			},
		]);
		const signedOut = await run(
			[
				{ match: "repo view", code: 1, stderr: "To get started, run: gh auth login\n" },
				{ match: "auth status --hostname github.com --active", code: 1, stderr: "unknown flag: --active\n" },
				{ match: "auth status", code: 1, stderr: "You are not logged into any GitHub hosts.\n" },
			],
			() => prRepo(repo),
		);
		expect(signedOut.result).toEqual({ available: false, reason: "gh_unauthenticated" });
		expect(signedOut.seen.map(seen => seen.argv.join(" "))).toEqual([
			"repo view --json nameWithOwner,defaultBranchRef",
			"auth status --hostname github.com --active",
			"auth status --hostname github.com",
		]);
		const noRemote = await run([{ match: "repo view", code: 1 }, { match: "auth status" }], () => prRepo(repo));
		expect(noRemote.result).toEqual({ available: false, reason: "no_github_remote" });
		const outside = await run([VIEW], () => prList(dir, {}));
		expect(outside.result).toMatchObject({ message: `Not a git repository: ${dir}`, code: "not_a_repo" });
		expect(outside.seen).toEqual([]);
	});

	it("lists PRs with their checks counted as the page reads them", async () => {
		const rows = [
			{
				number: 7,
				title: "Add 한 😀",
				author: { login: "octo" },
				statusCheckRollup: [
					{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
					{ context: "ci/linux", state: "FAILURE" },
					{ context: "tide", state: "PENDING" },
				],
			},
			{ number: 8, author: null, reviewDecision: null },
		];
		const listed = await run([VIEW, { match: "pr list", stdout: JSON.stringify(rows) }], () =>
			prList(repo, { state: "closed", limit: 5, view: "mine" }),
		);
		expect(listed.seen[1]?.argv).toEqual([
			"pr",
			"list",
			"--repo",
			"o/r",
			"--state",
			"closed",
			"--limit",
			"5",
			"--search",
			"author:@me",
			"--json",
			"number,title,url,isDraft,author,headRefName,baseRefName,additions,deletions,updatedAt,reviewDecision,statusCheckRollup",
		]);
		expect(listed.result).toEqual([
			{
				number: 7,
				title: "Add 한 😀",
				url: "",
				isDraft: false,
				authorLogin: "octo",
				headRefName: "",
				baseRefName: "",
				additions: 0,
				deletions: 0,
				updatedAt: "",
				reviewDecision: null,
				checks: { success: 1, failure: 1, pending: 1 },
			},
			expect.objectContaining({ number: 8, authorLogin: "ghost", checks: { success: 0, failure: 0, pending: 0 } }),
		]);
		const failed = await run([VIEW, { match: "pr list", code: 2 }], () => prList(repo, {}));
		expect(failed.result).toMatchObject({ message: "gh pr list exited with code 2" });
	});

	it("creates a PR from a private body file that is gone once gh answered", async () => {
		const created = await run(
			[VIEW, { match: "pr create", stdout: "Creating pull request\n\nhttps://github.com/o/r/pull/7\n" }],
			() => prCreate(repo, { title: "T", body: "Line 한\n\ntwo", base: "main", head: "feature", draft: true }),
		);
		expect(created.result).toEqual({ url: "https://github.com/o/r/pull/7", number: 7 });
		const create = created.seen[1];
		expect(create?.argv).toEqual([
			"pr",
			"create",
			"--repo",
			"o/r",
			"--title",
			"T",
			"--body-file",
			"<file>",
			"--base",
			"main",
			"--head",
			"feature",
			"--draft",
		]);
		expect(create?.body?.content).toBe("Line 한\n\ntwo");
		expect(create?.body?.dirMode).toBe("700");
		expect(path.basename(path.dirname(create?.body?.file ?? ""))).toMatch(/^omp-pr-body-[A-Za-z0-9]{6}$/);
		await expect(fs.stat(path.dirname(create?.body?.file ?? ""))).rejects.toThrow(/ENOENT/);
		const failed = await run([VIEW, { match: "pr create", code: 1, stderr: "already exists\n" }], () =>
			prCreate(repo, { title: "T", body: "b" }),
		);
		expect(failed.result).toMatchObject({ message: "already exists", code: "pr_create_failed" });
		await expect(fs.stat(path.dirname(failed.seen[1]?.body?.file ?? ""))).rejects.toThrow(/ENOENT/);
	});

	it("runs an operation on a named host and repository, and reads gh's words for a signed-out gh", async () => {
		const listed = await run([{ match: "issue list", stdout: "[]" }], () =>
			githubCommand(repo, { op: "issue_list", state: "all", search: "is:x", host: "ghe.example.com", repo: "a/b" }),
		);
		expect(listed.result).toEqual([]);
		expect(listed.seen[0]?.argv.slice(0, 10)).toEqual([
			"issue",
			"list",
			"--repo",
			"ghe.example.com/a/b",
			"--state",
			"all",
			"--limit",
			"50",
			"--search",
			"is:x",
		]);
		expect(listed.seen[0]?.env.GH_HOST).toBe("ghe.example.com");
		const refused = await run(
			[VIEW, { match: "issue list", code: 4, stderr: "To authenticate, run: GH AUTH LOGIN\n" }],
			() => githubCommand(repo, { op: "issue_list", state: "open" }),
		);
		expect(refused.result).toMatchObject({ code: "gh_unauthenticated" });
		expect(refused.seen[0]?.env.GH_HOST).toBeNull();
		const notes = await run(
			[
				{
					match: "api",
					stdout: JSON.stringify([{ id: "1", subject: { url: "https://api.github.com/repos/o/r/pulls/7" } }]),
				},
			],
			() => githubCommand(repo, { op: "notification_list", all: true }),
		);
		expect(notes.result).toEqual([
			{
				id: "1",
				unread: false,
				reason: "",
				title: "",
				type: "",
				repo: "",
				updatedAt: "",
				url: "https://github.com/o/r/pull/7",
			},
		]);
	});

	it("refuses a clone into a folder that exists before gh runs", async () => {
		const taken = await run([], () =>
			githubCommand(repo, { op: "repo_clone", repo: "o/r", destination: `${repo}${path.sep}.${path.sep}` }),
		);
		expect(taken.result).toMatchObject({ message: `${repo} already exists`, code: "github_failed" });
		expect(taken.seen).toEqual([]);
	});
});
