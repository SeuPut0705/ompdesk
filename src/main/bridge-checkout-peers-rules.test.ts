/**
 * Sessions sharing a checkout, round 3: what the guard (checkout-peers-core.ts, over Autopilot's shell parser) judged
 * wrongly. Each case names the report finding it pins (GuardRules 1-19).
 */
import { describe, expect, it } from "vitest";
import { bashViolation, fileToolEffects, shellEffects } from "../../resources/gui-bridge/modes/autopilot-guard-core";
import type { CheckoutPeer, CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import {
	type CallVerdict,
	CheckoutLedger,
	checkoutRefusal,
	shellChanges,
} from "../../resources/gui-bridge/modes/checkout-peers-core";

const REPO = "/work/app";
const OTHER = "/work/wt/app-feature";
const b = `${REPO}/src/b.ts`;
const a = `${REPO}/src/a.ts`;
const peer = (over: Partial<CheckoutPeer> = {}): CheckoutPeer => ({ id: "tab-b", title: "Rename helper", ...over });
const alone: CheckoutPeers = {
	toplevel: REPO,
	commonDir: `${REPO}/.git`,
	worktree: [],
	repo: [],
	canMessage: true,
};
const sharing: CheckoutPeers = { ...alone, worktree: [peer({ files: [b] })] };
const elsewhere: CheckoutPeers = {
	...alone,
	repo: [peer({ worktree: OTHER, files: [b], worktreeFiles: [`${OTHER}/src/b.ts`] })],
};
const own = [a];

/** What exists on disk: the folders and files of the repo (the guard asks with absolute paths). */
const exists = (path: string) => /^\/work\/app(\/(src|docs)(\/|$)|\/README|$)/.test(path);
const isDirectory = (path: string) => path === REPO || path === `${REPO}/src` || path === `${REPO}/docs`;
const refusal = (peers: CheckoutPeers, command: string, ownFiles: readonly string[] = own, cwd = REPO) =>
	checkoutRefusal(command, cwd, peers, ownFiles, undefined, isDirectory, exists);
const refused = (peers: CheckoutPeers, command: string, ownFiles?: readonly string[], cwd?: string) =>
	refusal(peers, command, ownFiles, cwd) !== undefined;

describe("1: a file both sessions changed can be taken by name, never dropped", () => {
	const both = [a, b];
	it("lets a session stage and commit by name a file the other session changed too", () => {
		for (const command of [
			"git add -- src/b.ts",
			"git add src/b.ts",
			"git commit -m x -- src/b.ts",
			"git commit -m x src/b.ts",
			"git add -- src/a.ts src/b.ts",
		])
			expect(refused(sharing, command, both), command).toBe(false);
	});

	it("still refuses taking a file only the other session changed, and dropping a file both changed", () => {
		for (const command of ["git add -- src/b.ts", "git commit -m x -- src/b.ts"])
			expect(refused(sharing, command, own), command).toBe(true);
		for (const command of [
			"git restore src/b.ts",
			"git checkout -- src/b.ts",
			"git reset -- src/b.ts",
			"git rm src/b.ts",
			"rm src/b.ts",
			"echo x > src/b.ts",
			"git clean -f -- src/b.ts",
		])
			expect(refused(sharing, command, both), command).toBe(true);
	});

	it("lets the edit tool change it, and refuses a whole-file write of it", () => {
		const ledger = new CheckoutLedger();
		const host = { realpath: (p: string) => p, isDirectory: () => false };
		const block = (verdict: CallVerdict) => "block" in verdict;
		expect(block(ledger.call("edit", { path: "src/b.ts" }, REPO, sharing, host))).toBe(false);
		expect(ledger.claims.files).toEqual([b]);
		expect(block(ledger.call("bash", { command: "git commit -m x -- src/b.ts" }, REPO, sharing, host))).toBe(false);
		expect(block(ledger.call("write", { path: "src/b.ts", content: "x" }, REPO, sharing, host))).toBe(true);
	});
});

describe("2: the file tools can no longer delete or replace a peer's file with only a notice", () => {
	const blocked = (toolName: string, input: unknown) => {
		const ledger = new CheckoutLedger();
		const verdict = ledger.call(toolName, input, REPO, sharing, { realpath: p => p });
		return "block" in verdict ? verdict.block : undefined;
	};

	it("refuses every way to delete it", () => {
		for (const [tool, input] of [
			["edit", { path: "src/b.ts", edits: [{ op: "delete" }] }],
			["edit", { input: "[src/b.ts#1A2B]\nREM" }],
			["edit", { input: "[src/b.ts#1A2B]\nMV src/z.ts" }],
			["edit", { input: "*** Begin Patch\n*** Delete File: src/b.ts\n*** End Patch" }],
			[
				"edit",
				{ input: "*** Begin Patch\n*** Update File: src/b.ts\n*** Move to: src/z.ts\n@@\n-x\n+y\n*** End Patch" },
			],
			["edit", { path: "src/b.ts", edits: [{ op: "update", rename: "src/z.ts", diff: "@@" }] }],
			["lsp", { action: "rename_file", file: "src/b.ts", new_name: "src/z.ts" }],
		] as const)
			expect(blocked(tool, input), JSON.stringify(input)).toContain("deleting src/b.ts");
	});

	it("refuses a move or rename onto it", () => {
		for (const [tool, input] of [
			["edit", { path: "src/a.ts", edits: [{ op: "update", rename: "src/b.ts", diff: "@@" }] }],
			[
				"edit",
				{ input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-x\n+y\n*** End Patch" },
			],
			["edit", { input: "[src/a.ts#1A2B]\nMV src/b.ts" }],
			["lsp", { action: "rename_file", file: "src/a.ts", new_name: "src/b.ts" }],
		] as const)
			expect(blocked(tool, input), JSON.stringify(input)).toContain("writing src/b.ts whole with the");
	});

	it("lets a plain edit of it through, and reads what each effect is", () => {
		expect(blocked("edit", { path: "src/b.ts", edits: [{ op: "update", diff: "@@\n-x\n+y\n" }] })).toBeUndefined();
		expect(fileToolEffects("edit", { input: "[src/b.ts#1A2B]\nREM" })).toEqual([
			{ path: "src/b.ts", kind: "delete" },
		]);
		expect(fileToolEffects("write", { path: "src/a.ts", content: "x" })).toEqual([
			{ path: "src/a.ts", kind: "replace" },
		]);
	});
});

describe("3: git reset <revision> moves HEAD under the other session", () => {
	it("refuses a reset to any revision, spelled any way", () => {
		for (const command of [
			"git reset origin/main",
			"git reset --soft origin/main",
			"git reset main",
			"git reset @{u}",
			"git reset HEAD@{1}",
			"git reset abc12",
			"git reset --mixed v1.0",
			"git reset HEAD~1",
			"git reset",
		])
			expect(refusal(sharing, command), command).toContain("moves HEAD");
	});

	it("lets a reset of files, named or after --, through", () => {
		for (const command of ["git reset -- src/a.ts", "git reset src/a.ts", "git reset HEAD -- src/a.ts"])
			expect(refused(sharing, command), command).toBe(false);
	});
});

describe("4 and 18: commits that take what the other session staged", () => {
	it("refuses a clustered -m, --include and --amend as a commit without paths or a rewrite", () => {
		for (const command of [
			"git commit -vm wip",
			"git commit -sm wip",
			"git commit -nm wip",
			"git commit -m wip -i src/a.ts",
			"git commit -m wip --include src/a.ts",
			"git commit --amend -m x -- src/a.ts",
			"git commit --amend --no-edit -- src/a.ts",
		])
			expect(refused(sharing, command), command).toBe(true);
	});

	it("lets a clustered -m with paths, and the same value flag spelled out, commit by name", () => {
		for (const command of [
			"git commit -vm wip -- src/a.ts",
			"git commit -sm wip src/a.ts",
			"git commit -mwip src/a.ts",
			"git commit --message wip -- src/a.ts",
			"git commit -m wip -- src/a.ts",
		])
			expect(refused(sharing, command), command).toBe(false);
	});
});

describe("5: a heredoc with an apostrophe inside $(...)", () => {
	const message = "git commit -m \"$(cat <<'EOF'\nfix: don't crash\nEOF\n)\"";

	it("keeps the paths after it, so the usual commit idiom is not a commit without paths", () => {
		expect(refused(sharing, `${message} -- src/a.ts`)).toBe(false);
		expect(refused(sharing, `${message}`)).toBe(true);
	});

	it("keeps judging what follows it", () => {
		expect(refused(sharing, `echo "$(cat <<'X'\ndon't\nX\n)" > /tmp/m; git add -A`)).toBe(true);
		expect(refused(sharing, `gh pr create --body "$(cat <<'X'\nIt's fixed\nX\n)"; git checkout main`)).toBe(true);
		expect(refused(sharing, `echo "$(cat <<-'X'\n\tit's\n\tX\n)" && git stash`)).toBe(true);
	});

	it("reaches Autopilot's own judge, which saw nothing after it", () => {
		expect(
			bashViolation(`${message} -- a.ts && git -C /Users/me/other reset --hard`, { root: "/work/app" }),
		).toBeDefined();
		expect(bashViolation(`${message} -- a.ts`, { root: "/work/app" })).toBeUndefined();
		expect(bashViolation("echo $((1 << 2)) && git reset --hard", { root: "/work/app" })).toBeDefined();
	});
});

describe("6: staging or deleting through -p, command substitution or xargs", () => {
	it("refuses interactive staging and a substituted path list", () => {
		for (const command of [
			"git add -p",
			"yes | git add -p",
			"git add -i",
			"git add -e",
			"git add $(git diff --name-only)",
			"git add `git ls-files -m`",
			"git commit -m x -- $(git diff --name-only)",
			"git status --porcelain | awk '{print $2}' | xargs git add",
		])
			expect(refused(sharing, command), command).toBe(true);
	});

	it("refuses deleting through a substituted or piped list", () => {
		for (const command of [
			"git ls-files | xargs rm",
			"echo src/b.ts | xargs rm",
			"rm -f $(git diff --name-only)",
			"git ls-files -m | xargs -n1 rm -f",
		])
			expect(refusal(sharing, command), command).toContain("deleting");
	});

	it("still lets a plain add of its own file and a substitution-free command through", () => {
		for (const command of ["git add -- src/a.ts", "echo $(date) > /tmp/x", "ls | xargs echo"])
			expect(refused(sharing, command), command).toBe(false);
	});
});

describe("7: a cd the parser cannot resolve", () => {
	it("judges shell writes and deletes after it against the top level, like the git runs", () => {
		for (const command of [
			'cd "$(git rev-parse --show-toplevel)" && rm src/b.ts',
			"cd $PWD && echo x > src/b.ts",
			"cd $SOMEWHERE && cp /tmp/x src/b.ts",
		])
			expect(refused(sharing, command), command).toBe(true);
		expect(refused(sharing, 'cd "$(git rev-parse --show-toplevel)" && rm src/a.ts')).toBe(false);
	});

	it("claims what such a command changes at that place", () => {
		const ledger = new CheckoutLedger();
		ledger.call("bash", { command: "cd $PWD && echo x > src/new.ts" }, REPO, sharing, { realpath: p => p });
		expect(ledger.claims.files).toEqual([`${REPO}/src/new.ts`]);
	});
});

describe("11: shell writers the parser misread", () => {
	it("refuses find -delete and find -exec rm, scoped by -name", () => {
		for (const command of [
			"find . -name '*.ts' -delete",
			"find src -name b.ts -delete",
			"find . -name '*.ts' -exec rm {} +",
			"find src -type f -delete",
		])
			expect(refusal(sharing, command), command).toContain("deleting");
		expect(refused(sharing, "find src -name '*.md' -delete")).toBe(false);
		expect(shellEffects("find . -name '*.ts' -exec rm {} +", REPO).deletes).toEqual([`${REPO}/**/*.ts`]);
	});

	it("refuses rsync --delete into a folder, ln -f onto the file and cp --target-directory=", () => {
		expect(refusal(sharing, "rsync -a --delete /tmp/x/ src/")).toContain("deleting src");
		expect(refusal(sharing, "ln -sf /tmp/x src/b.ts")).toContain("writing src/b.ts whole");
		expect(refusal(sharing, "cp --target-directory=src /tmp/b.ts")).toContain("writing src/b.ts whole");
		expect(refused(sharing, "ln -s /tmp/x src/new-link")).toBe(false);
	});

	it("treats patch like git apply when the files are inside the patch", () => {
		for (const command of ["patch -p1 < x.patch", "patch -p1 -i x.patch"])
			expect(refusal(sharing, command), command).toContain("`patch`");
		expect(refused(sharing, "patch --dry-run -p1 < x.patch")).toBe(false);
		expect(refused(sharing, "patch src/a.ts fix.diff")).toBe(false);
	});

	it("refuses inline interpreter code that visibly writes the peer's file", () => {
		for (const command of [
			`python3 -c "open('src/b.ts','w').write('x')"`,
			`node -e "require('fs').writeFileSync('src/b.ts', 'x')"`,
			`bun -e "await Bun.write('src/b.ts', 'x')"`,
			`python3 - <<'PY'\nimport os\nos.remove("src/b.ts")\nPY`,
		])
			expect(refused(sharing, command), command).toBe(true);
		expect(refused(sharing, `python3 -c "open('src/a.ts','w').write('x')"`)).toBe(false);
		expect(refused(sharing, `python3 -c "print(open('src/b.ts').read())"`)).toBe(false);
	});

	it("reads the eval tool's cells the same way", () => {
		const ledger = new CheckoutLedger();
		const verdict = ledger.call("eval", { input: "write('src/b.ts', 'x')" }, REPO, sharing, { realpath: p => p });
		expect("block" in verdict && verdict.block).toContain("writing src/b.ts whole");
		const fine = new CheckoutLedger();
		fine.call("eval", { input: "Bun.write('src/a.ts', 'x')" }, REPO, sharing, { realpath: p => p });
		expect(fine.claims.files).toEqual([a]);
	});
});

describe("12: git steps and wrappers that were never judged", () => {
	it("refuses bisect, checkout-index --all and symbolic-ref HEAD, and lets bisect reset and a read through", () => {
		for (const command of [
			"git bisect start",
			"git bisect run ./t.sh",
			"git bisect good",
			"git checkout-index -a -f",
			"git symbolic-ref HEAD refs/heads/other",
		])
			expect(refused(sharing, command), command).toBe(true);
		for (const command of [
			"git bisect reset",
			"git bisect log",
			"git symbolic-ref HEAD",
			"git symbolic-ref --short HEAD",
		])
			expect(refused(sharing, command), command).toBe(false);
	});

	it("reads a git run or a delete through GIT_DIR=, GIT_WORK_TREE= and sudo", () => {
		for (const command of [
			"GIT_DIR=.git git reset --hard",
			"GIT_WORK_TREE=. git checkout main",
			"env GIT_INDEX_FILE=/tmp/i git add -A",
			"sudo rm src/b.ts",
			"sudo -u me git stash",
		])
			expect(refused(sharing, command), command).toBe(true);
	});

	it("keeps Autopilot's own verdicts as strict as before", () => {
		for (const command of ["GIT_DIR=.git git status", "sudo ls", "env GIT_WORK_TREE=/x git status"])
			expect(bashViolation(command, { root: REPO }), command).toBeDefined();
	});
});

describe("13: an append keeps the other session's lines", () => {
	it("allows >> and tee -a on its file with a notice, and still refuses > and tee", () => {
		for (const command of ["echo x >> src/b.ts", "printf x | tee -a src/b.ts", "echo x >> CHANGELOG.md"])
			expect(refused(sharing, command), command).toBe(false);
		for (const command of ["echo x > src/b.ts", "printf x | tee src/b.ts"])
			expect(refused(sharing, command), command).toBe(true);
		expect(shellChanges("echo x >> src/b.ts", REPO).edits).toEqual([b]);
	});

	it("claims the appended file, with the overlap notice", () => {
		const ledger = new CheckoutLedger();
		const verdict = ledger.call("bash", { command: "echo x >> src/b.ts" }, REPO, sharing, { realpath: p => p });
		expect(ledger.claims.files).toEqual([b]);
		expect("notice" in verdict && verdict.notice).toContain("Another session changed a file you just edited");
	});
});

describe("14: two sessions writing the same scratch output", () => {
	it("never refuses a log or build output file", () => {
		const busy: CheckoutPeers = {
			...alone,
			worktree: [peer({ files: [`${REPO}/build.log`, `${REPO}/dist/app.js`, `${REPO}/coverage/lcov.info`] })],
		};
		for (const command of ["bun run build > build.log", "echo x > dist/app.js", "rm -rf dist", "rm -rf coverage"])
			expect(refused(busy, command), command).toBe(false);
	});
});

describe("15: formatters and package managers", () => {
	const claims = (command: string, peers: CheckoutPeers | undefined = undefined) => {
		const ledger = new CheckoutLedger();
		const verdict = ledger.call("bash", { command }, REPO, peers, {
			realpath: p => p,
			isDirectory: p => p === `${REPO}/src`,
		});
		return { files: [...ledger.claims.files].sort(), verdict };
	};

	it("refuses a formatter run over a folder, a glob or the tree when the other session changed a file in it", () => {
		for (const command of [
			"prettier --write .",
			"npx biome format --write .",
			"bunx biome check --write",
			"eslint --fix src",
			"ruff format .",
			"black .",
			"gofmt -w .",
			"cargo fmt",
			"bun x prettier --write 'src/**/*.ts'",
		])
			expect(refused(sharing, command), command).toBe(true);
	});

	it("claims a formatter's named files as edits with the notice, and lets a read-only run through", () => {
		expect(claims("prettier --write src/b.ts", sharing).files).toEqual([b]);
		expect(refused(sharing, "prettier --write src/a.ts")).toBe(false);
		for (const command of [
			"prettier --check .",
			"biome check .",
			"ruff check .",
			"black --check .",
			"cargo fmt --check",
			"gofmt -l .",
		])
			expect(refused(sharing, command), command).toBe(false);
	});

	it("claims package.json and the lockfile for an install or a dependency change", () => {
		for (const [command, lock] of [
			["bun add zod", "bun.lock"],
			["bun install", "bun.lock"],
			["npm version patch", "package-lock.json"],
			["pnpm add -D x", "pnpm-lock.yaml"],
			["yarn add y", "yarn.lock"],
		] as const)
			expect(claims(command).files, command).toEqual([`${REPO}/package.json`, `${REPO}/${lock}`].sort());
		for (const command of [
			"bun run build",
			"bun test",
			"bun install --frozen-lockfile",
			"npm run lint",
			"bun add -g x",
		])
			expect(claims(command).files, command).toEqual([]);
	});
});

describe("16: smaller false refusals", () => {
	it("lets git checkout name its own file without --, and refuses a branch switch", () => {
		expect(refused(sharing, "git checkout src/a.ts")).toBe(false);
		expect(refused(sharing, "git checkout main")).toBe(true);
		expect(refusal(sharing, "git checkout -p")).toContain("hunks");
		expect(refused(sharing, "git checkout -p src/a.ts")).toBe(false);
	});

	it("scopes git clean to the paths it names", () => {
		expect(refused(sharing, "git clean -f -- src/new.ts")).toBe(false);
		expect(refused(sharing, "git clean -fd src/new")).toBe(false);
		expect(refused(sharing, "git clean -fd src")).toBe(true);
		expect(refused(sharing, "git clean -fd")).toBe(true);
		expect(refused(sharing, "git clean -nfd")).toBe(false);
	});

	it("lets a session delete or move a branch it made, and nobody else's", () => {
		const mine = new Set(["feat"]);
		expect(
			checkoutRefusal("git branch -D feat", REPO, elsewhere, own, undefined, undefined, exists, mine),
		).toBeUndefined();
		expect(
			checkoutRefusal("git branch -m feat feat2", REPO, elsewhere, own, undefined, undefined, exists, mine),
		).toContain("branch");
		expect(
			checkoutRefusal("git branch -D other", REPO, elsewhere, own, undefined, undefined, exists, mine),
		).toContain("branch");
		const ledger = new CheckoutLedger();
		const host = { realpath: (p: string) => p };
		ledger.call("bash", { command: "git branch feat" }, REPO, elsewhere, host);
		expect("block" in ledger.call("bash", { command: "git branch -D feat" }, REPO, elsewhere, host)).toBe(false);
		expect("block" in ledger.call("bash", { command: "git branch -D main" }, REPO, elsewhere, host)).toBe(true);
	});

	it("lets read-only forms of am and stash through, and a fast-forward pull or merge", () => {
		for (const command of [
			"git am --show-current-patch",
			"git am --show-current-patch=diff",
			"git stash --help",
			"git pull --ff-only",
			"git merge --ff-only main",
		])
			expect(refused(sharing, command), command).toBe(false);
		expect(refused(sharing, "git merge main")).toBe(true);
	});
});

describe("19: refusal wording", () => {
	it("names the checkout as . when a delete reaches the top level", () => {
		expect(refusal(sharing, "rm -rf .")).toContain("deleting . from the shell");
	});
});

describe("GuardRules 12 and 6 in Autopilot's own collect mode only", () => {
	it("reads wrappers in collect mode without stopping, leaving the judge's walk as it was", () => {
		expect(shellEffects("sudo rm src/b.ts", REPO).deletes).toEqual([b]);
		expect(bashViolation("sudo rm src/b.ts", { root: REPO })).toContain("privilege");
	});
});

describe("worktrees of the repository: a git run or a write aimed into a repo peer's worktree", () => {
	it("judges git runs there as it would in its own checkout (LedgerLifecycle 6)", () => {
		for (const command of [
			`git -C ${OTHER} stash`,
			`cd ${OTHER} && git stash`,
			`git -C ${OTHER} reset --hard`,
			`git -C ${OTHER} clean -fd`,
			`git -C ${OTHER} add -A`,
			`git -C ${OTHER} branch -D feature`,
			`git -C ${OTHER} checkout -- src/b.ts`,
		])
			expect(refused(elsewhere, command), command).toBe(true);
		for (const command of [
			`git -C ${OTHER} status`,
			`git -C ${OTHER} add -- src/other.ts`,
			`git -C ${OTHER} commit -m x -- src/other.ts`,
		])
			expect(refused(elsewhere, command), command).toBe(false);
	});

	it("refuses a write, rm or checkout of the peer's uncommitted file in its folder, and notices only for this checkout's spelling", () => {
		for (const command of [`echo x > ${OTHER}/src/b.ts`, `rm ${OTHER}/src/b.ts`, `cp /tmp/x ${OTHER}/src/b.ts`])
			expect(refused(elsewhere, command), command).toBe(true);
		expect(refused(elsewhere, `echo x > ${OTHER}/src/other.ts`)).toBe(false);
		// This checkout's own file of the same name is only noticed: another worktree is its own branch.
		for (const command of ["echo x > src/b.ts", "rm src/b.ts", "git add -A"])
			expect(refused(elsewhere, command), command).toBe(false);
	});
});
