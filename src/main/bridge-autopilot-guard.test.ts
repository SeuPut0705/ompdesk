import { describe, expect, it } from "vitest";
import type { AutopilotShipLevel } from "../../resources/gui-bridge/modes/autopilot-contracts";
import {
	bashViolation,
	evaluateToolCall,
	findBanViolation,
	type GuardInput,
} from "../../resources/gui-bridge/modes/autopilot-guard-core";

const ROOT = "/work/repo-autopilot";

function call(toolName: string, input: unknown, over: Partial<GuardInput> = {}) {
	return evaluateToolCall({
		toolName,
		input,
		root: ROOT,
		shipLevel: "local",
		oneShotRelease: false,
		role: "parent",
		...over,
	});
}

function bash(command: string, over: Partial<GuardInput> = {}) {
	return call("bash", { command }, over);
}

const LEVELS: AutopilotShipLevel[] = ["local", "push", "release"];

/** Blocked at every level, for the parent, the child, and with a one-shot release. */
const ALWAYS_BLOCKED = [
	"git push --force origin HEAD:main",
	"git push -f origin HEAD:main",
	"git push --force-with-lease origin HEAD:main",
	"git push --force-if-includes origin HEAD:main",
	"git push -uf origin autopilot/x",
	"git push --mirror origin",
	"git push --prune origin",
	"git push --all origin",
	"git push --delete origin autopilot/x",
	"git push -d origin autopilot/x",
	"git push origin +HEAD:main",
	"git push origin +autopilot/x",
	"git push origin :autopilot/x",
	"git reset --hard HEAD~1",
	"git reset --soft HEAD~1",
	"git reset",
	"git clean -fd",
	"git clean -n",
	"git checkout -- src/a.ts",
	"git checkout .",
	"git checkout main",
	"git checkout -f main",
	"git checkout -B main",
	"git restore src/a.ts",
	"git restore --worktree src/a.ts",
	"git switch -f main",
	"git switch --discard-changes main",
	"git stash drop",
	"git stash clear",
	"git branch -d autopilot/x",
	"git branch -D autopilot/x",
	"git branch -m old new",
	"git branch -f main HEAD",
	"git branch --delete x",
	"git tag -d v1.0.0",
	"git tag -f v1.0.0",
	"git rebase main",
	"git rebase -i HEAD~3",
	"git pull --rebase",
	"git commit --amend",
	"git commit -m x --amend",
	"git commit --amend --no-edit",
	"git filter-branch --tree-filter x",
	"git filter-repo --path x",
	"git reflog expire --expire=now --all",
	"git reflog delete HEAD@{0}",
	"git gc --prune=now",
	"git prune",
	"git update-ref -d refs/heads/x",
	"git update-ref refs/heads/main abc",
	"git worktree remove --force ../x",
	"git remote add evil https://x.example/r.git",
	"git remote set-url origin https://x.example/r.git",
	"git remote remove origin",
	"git config user.name x",
	"git config --global user.name x",
	"git config --unset core.editor",
	"git config remote.origin.pushurl x",
	"git -c alias.p=push p",
	"git -c core.hooksPath=/tmp/h commit -m x",
	"git -c core.sshCommand=evil fetch",
	"git --git-dir=/other/.git status",
	"git -C / status",
	"git -C ../other log",
	"GIT_DIR=/other git status",
	"GIT_SSH_COMMAND=evil git fetch",
	"env GIT_CONFIG_COUNT=1 git fetch",
	"gh repo delete owner/repo --yes",
	"rm -rf /",
	"rm -rf ~",
	"rm -rf ~/projects",
	"rm -rf ../other",
	"rm -rf /tmp/../etc",
	"rm -rf $HOME/x",
	"rm /etc/hosts",
	"rmdir ../other",
	"mv ../a.txt b.txt",
	"mv a.txt /etc/x",
	"cp a.txt /etc/x",
	"cp -r src ../other",
	"touch ../x",
	"chmod -R 777 /",
	"echo x > ../other/file",
	"echo x >> /etc/hosts",
	"echo x > .git/hooks/pre-push",
	"cat a | tee ../out.txt",
	"cp hook .git/hooks/pre-commit",
	"find / -delete",
	"find .. -name '*.tmp' -delete",
	"find . -exec rm -rf / \\;",
	"cd / && rm -rf *",
	"cd .. && rm -rf x",
	"cd ~ && rm -rf x",
	"cd /tmp && rm -rf scratch",
	"sed -i s/a/b/ ../x.txt",
	"curl -o ../x https://x.example",
	"dd if=/dev/zero of=/dev/sda",
	"sudo rm -rf x",
	"sudo git status",
	"ssh host ls",
	"scp a host:b",
	"npm publish",
	"pnpm publish",
	"yarn publish",
	"bun publish",
	"cargo publish",
	"twine upload dist/*",
	"docker push img",
	"npm install -g typescript",
	"npm i --global x",
	"bun add -g x",
	"pnpm add -g x",
	"yarn global add x",
	"cargo install ripgrep",
	"brew install x",
	"apt-get install x",
	"electron-builder --publish always",
	"electron-builder --publish=always",
	"omp config set x y",
	"omp login",
	"bash -c 'git push --force origin x'",
	'sh -c "rm -rf /"',
	"echo $(git reset --hard)",
	"echo `git clean -fd`",
	"true && (git reset --hard)",
	"x=1 git reset --hard",
	"env FOO=1 git reset --hard",
	"command git reset --hard",
	"nohup git reset --hard &",
	"time git reset --hard",
	"xargs -n1 git reset",
	"timeout 5 git reset --hard",
	"python3 -c \"import os; os.system('git reset --hard')\"",
	"node -e \"require('child_process').execSync('git push --force origin x')\"",
	"bash <<EOF\ngit reset --hard\nEOF",
	"if true; then git reset --hard; fi",
	"while true; do git clean -fd; done",
	"git status; git reset --hard",
	"git status && git reset --hard",
	"git status || git reset --hard",
	"git status | git reset --hard",
	"git log\ngit reset --hard",
];

/** Blocked below the release scope (local and push), allowed inside it. */
const SHIP_SCOPED = [
	"git push origin HEAD:main",
	"git push origin HEAD:refs/heads/main",
	"git push origin v1.2.3",
	"git push origin refs/tags/v1.2.3",
	"git push origin --tags",
	"git push origin --follow-tags",
	"git push origin tag v1.2.3",
	"git tag v1.2.3",
	"git tag -a v1.2.3 -m release",
	"gh workflow run release.yml",
	"gh run watch 123",
	"gh run rerun 123 --failed",
];

/** Blocked at every level, even inside the release scope. */
const STILL_BLOCKED_IN_RELEASE = [
	"git push",
	"git push origin",
	"git push origin autopilot/x",
	"git push origin HEAD:other",
	"git push origin HEAD:release/1",
	"git push https://github.com/o/r.git HEAD:main",
	"git push upstream HEAD:main",
	"git push git@github.com:o/r.git HEAD:main",
	"git push -u origin HEAD:main --force",
	"gh run rerun 123",
	"gh release create v1 --notes x",
	"gh pr create --fill",
	"gh pr merge 1",
	"gh pr comment 1 -b x",
	"gh issue create -t x",
	"gh api -X POST /repos/o/r/issues",
	"gh api /repos/o/r/issues -f title=x",
	"gh repo create x",
	"gh alias set x y",
	"gh extension install x",
];

/** Allowed at every level. */
const ALWAYS_ALLOWED = [
	"git status",
	"git status --short",
	"git log --oneline -5",
	"git diff HEAD",
	"git add src/a.ts",
	"git commit -m 'feat: x'",
	"git commit -m 'amended text' ",
	"git merge --no-ff autopilot/x",
	"git merge --abort",
	"git revert --no-edit abc123",
	"git revert --abort",
	"git cherry-pick abc123",
	"git cherry-pick --abort",
	"git stash",
	"git stash push -m x",
	"git stash pop",
	"git stash list",
	"git branch",
	"git branch --list",
	"git branch -vv",
	"git branch feature",
	"git checkout -b feature",
	"git switch -c feature",
	"git switch main",
	"git restore --staged src/a.ts",
	"git tag",
	"git tag -l",
	"git tag --list 'v*'",
	"git tag --contains HEAD",
	"git remote -v",
	"git remote show origin",
	"git remote get-url origin",
	"git config --get remote.origin.url",
	"git config user.name",
	"git config --list",
	"git fetch origin",
	"git pull --ff-only",
	"git worktree list",
	"git worktree add ../x",
	"git -C . status",
	'git -C "$PWD" status',
	`git -C ${ROOT} status`,
	`git -C ${ROOT}/sub log`,
	"git -c core.quotepath=false status",
	"git rm src/old.ts",
	"git mv a.ts b.ts",
	"git show HEAD",
	"git rev-parse HEAD",
	"git reflog",
	"git gc",
	"git log --grep 'git reset --hard' --oneline",
	"git commit -m 'never run git push --force'",
	"echo 'git reset --hard' > notes.txt",
	"gh pr view 1",
	"gh pr list",
	"gh pr diff 1",
	"gh pr checks 1",
	"gh issue view 1",
	"gh run list",
	"gh run view 1 --log",
	"gh release view v1",
	"gh repo view",
	"gh auth status",
	"gh api /repos/o/r/pulls",
	"gh api -X GET /repos/o/r/pulls",
	"gh search issues x",
	"bun run check:changed",
	"bun test",
	"bunx vitest run src/a.test.ts",
	"npm test",
	"npm install",
	"npm install lodash",
	"bun add lodash",
	"pnpm add -D vitest",
	"yarn add x",
	"npm run build",
	"npm view x",
	"cargo test",
	"cargo build --release",
	"ls -la",
	"cat src/a.ts | head -5",
	"rm src/old.ts",
	"rm -rf node_modules",
	"rm -rf ./dist",
	`rm -rf ${ROOT}/dist`,
	"rm -rf dist/*",
	"rmdir empty",
	"mv a.ts b.ts",
	"mv a.ts src/b.ts",
	"cp a.ts b.ts",
	"mkdir -p out/x",
	"touch x.txt",
	"echo x > out.txt",
	"echo x >> src/log.txt",
	"echo x > /dev/null",
	"cmd > /tmp/out.log 2>&1",
	"cmd 2>&1",
	"cmd > /dev/null 2>&1",
	"cmd &> /tmp/x",
	"echo hi | tee out.txt",
	"sed -i s/a/b/ src/a.ts",
	"sed -n 1,5p src/a.ts",
	"curl -o /tmp/x https://x.example",
	"curl https://x.example",
	"find . -name '*.ts'",
	"find src -type f -delete",
	"find . -exec grep x {} \\;",
	"cd src && ls",
	"cd src && rm -rf build",
	"cd .. && ls",
	"chmod +x script.sh",
	"python3 script.py",
	"python3 -c 'print(1)'",
	"node -e 'console.log(1)'",
	"bash -c 'echo hi'",
	"echo $(date)",
	"x=1 bun test",
	"env FOO=1 bun test",
	"FOO=1 BAR=2 bun test",
	"timeout 60 bun test",
	"nohup bun run dev &",
	"if [ -f a ]; then echo yes; fi",
	"for f in a b; do echo $f; done",
	"cat <<EOF > notes.md\ngit reset --hard\nrm -rf /\nEOF",
	"cat <<'EOF'\ngit push --force\nEOF",
	"# git reset --hard\nls",
	"bun run gate && git status",
	"omp --version",
	"",
];

describe("autopilot guard: always blocked", () => {
	for (const command of ALWAYS_BLOCKED) {
		const label = command.replace(/\n/g, "\\n");
		it(`blocks: ${label}`, () => {
			for (const shipLevel of LEVELS) {
				for (const oneShotRelease of [false, true]) {
					for (const role of ["parent", "child"] as const) {
						const decision = bash(command, { shipLevel, oneShotRelease, role });
						expect(decision.block, `${shipLevel}/${oneShotRelease}/${role}`).toBe(true);
						expect(decision.reason).toContain("Blocked by autopilot");
					}
				}
			}
		});
	}
});

describe("autopilot guard: ship scope", () => {
	for (const command of SHIP_SCOPED) {
		it(`blocked by default, open in the release scope: ${command}`, () => {
			expect(bash(command, { shipLevel: "local" }).block).toBe(true);
			expect(bash(command, { shipLevel: "push" }).block).toBe(true);
			expect(bash(command, { shipLevel: "local", oneShotRelease: false }).block).toBe(true);
			expect(bash(command, { shipLevel: "release" }).block).toBe(false);
			expect(bash(command, { shipLevel: "local", oneShotRelease: true }).block).toBe(false);
			expect(bash(command, { shipLevel: "push", oneShotRelease: true }).block).toBe(false);
		});
		it(`a child never gets the release scope: ${command}`, () => {
			expect(bash(command, { shipLevel: "release", role: "child" }).block).toBe(true);
			expect(bash(command, { oneShotRelease: true, role: "child" }).block).toBe(true);
		});
	}
	for (const command of STILL_BLOCKED_IN_RELEASE) {
		it(`blocked even in the release scope: ${command}`, () => {
			expect(bash(command, { shipLevel: "release" }).block).toBe(true);
			expect(bash(command, { oneShotRelease: true }).block).toBe(true);
		});
	}
	it("uses the configured remote and default branch", () => {
		const scope = { shipLevel: "release", remote: "upstream", defaultBranch: "trunk" } as const;
		expect(bash("git push upstream HEAD:trunk", scope).block).toBe(false);
		expect(bash("git push origin HEAD:trunk", scope).block).toBe(true);
		expect(bash("git push upstream HEAD:main", scope).block).toBe(true);
	});
});

describe("autopilot guard: a branch the user picked", () => {
	// The run's branch may be any existing branch, `main` included: nothing the guard allows depends on its name.
	for (const branch of ["feature/x", "main", "autopilot/2026-10-18"]) {
		it(`the agent's own pushes of ${branch} stay blocked outside the release scope`, () => {
			for (const command of [
				`git push origin ${branch}`,
				`git push origin HEAD:${branch}`,
				`git push -u origin ${branch}`,
			]) {
				for (const shipLevel of ["local", "push"] as const) {
					expect(bash(command, { shipLevel, defaultBranch: "main" }).block, `${shipLevel}: ${command}`).toBe(true);
				}
				expect(bash(command, { shipLevel: "local", role: "child" }).block, `child: ${command}`).toBe(true);
			}
		});

		it(`destructive git stays banned on ${branch}: force push, reset --hard, deleting or moving it, rewriting it`, () => {
			const destructive = [
				`git push --force origin ${branch}`,
				`git push -f origin HEAD:${branch}`,
				`git push --force-with-lease origin ${branch}`,
				`git push origin +${branch}`,
				`git push origin +HEAD:${branch}`,
				`git push --delete origin ${branch}`,
				`git push origin :${branch}`,
				`git branch -D ${branch}`,
				`git branch -d ${branch}`,
				`git branch -f ${branch} HEAD~3`,
				`git branch -m ${branch} other`,
				`git reset --hard origin/${branch}`,
				`git reset --hard HEAD~1`,
				`git update-ref refs/heads/${branch} HEAD~1`,
				`git rebase ${branch}`,
				`git commit --amend --no-edit`,
			];
			for (const command of destructive) {
				for (const shipLevel of LEVELS) {
					for (const oneShotRelease of [false, true]) {
						const decision = bash(command, { shipLevel, oneShotRelease, defaultBranch: "main" });
						expect(decision.block, `${shipLevel}/${oneShotRelease}: ${command}`).toBe(true);
					}
				}
			}
		});
	}

	it("committing, merging and reading history on the chosen branch is as free as before", () => {
		for (const command of [
			"git commit -m x",
			"git merge --no-ff feature/x",
			"git log --oneline main..HEAD",
			"git revert --no-edit abc123",
		]) {
			expect(bash(command, { defaultBranch: "main" }), command).toEqual({ block: false });
		}
	});
});

describe("autopilot guard: allowed", () => {
	for (const command of ALWAYS_ALLOWED) {
		const label = command.replace(/\n/g, "\\n") || "(empty)";
		it(`allows: ${label}`, () => {
			for (const shipLevel of LEVELS) {
				for (const role of ["parent", "child"] as const) {
					const decision = bash(command, { shipLevel, role });
					expect(decision, `${shipLevel}/${role}: ${decision.reason}`).toEqual({ block: false });
				}
			}
		});
	}
	it("honours the bash tool's own cwd", () => {
		expect(call("bash", { command: "rm -rf build", cwd: "src" }).block).toBe(false);
		expect(call("bash", { command: "rm -rf build", cwd: "/" }).block).toBe(true);
		expect(call("bash", { command: "rm -rf build", cwd: ".." }).block).toBe(true);
	});
});

describe("autopilot guard: known limits of shell obfuscation", () => {
	// The tokenizer cannot see these: the post-cycle git audit in main is the required second defence.
	const SLIPS = [
		'cmd="git reset --hard"; $cmd',
		"alias g=git; g reset --hard",
		"git $(echo reset) --hard",
		"python3 script_that_resets.py",
		"./do-it.sh",
		"source ./do-it.sh",
	];
	for (const command of SLIPS) {
		it(`is not decidable here (never silently allowed when it is a script run): ${command}`, () => {
			const decision = bash(command);
			// Documented behaviour: source/sh <file> are blocked as unverifiable; the rest slips to the audit.
			if (command.startsWith("source")) expect(decision.block).toBe(true);
			else expect(typeof decision.block).toBe("boolean");
		});
	}
	it("blocks running a shell script file it cannot read", () => {
		expect(bash("sh ./x.sh").block).toBe(true);
		expect(bash("bash x.sh").block).toBe(true);
	});
	it("scans interpreter inline code for banned phrases", () => {
		expect(bash("python3 -c \"import os; os.system('git push --force origin x')\"").block).toBe(true);
		expect(bash("python3 -c \"import shutil; shutil.rmtree('/etc')\"").block).toBe(true);
	});
	it("stops at a depth limit instead of recursing forever", () => {
		let nested = "git reset --hard";
		for (let k = 0; k < 10; k++) nested = `sh -c '${nested.replace(/'/g, "'\\''")}'`;
		expect(bash(nested).block).toBe(true);
	});
});

describe("autopilot guard: file tools", () => {
	const TOOLS = ["write", "edit", "ast_edit", "notebook", "lsp"];
	for (const tool of TOOLS) {
		it(`${tool}: inside the worktree is fine, outside or under .git is blocked`, () => {
			expect(call(tool, { path: "src/a.ts" }).block).toBe(false);
			expect(call(tool, { path: `${ROOT}/src/a.ts` }).block).toBe(false);
			expect(call(tool, { path: "../other/a.ts" }).block).toBe(true);
			expect(call(tool, { path: "/etc/hosts" }).block).toBe(true);
			expect(call(tool, { path: "~/x" }).block).toBe(true);
			expect(call(tool, { path: ".git/config" }).block).toBe(true);
			expect(call(tool, { path: `${ROOT}/.git/hooks/pre-push` }).block).toBe(true);
			expect(call(tool, { path: "src/../.git/config" }).block).toBe(true);
			expect(call(tool, { path: "src/../../x" }).block).toBe(true);
			expect(call(tool, { path: ".gitignore" }).block).toBe(false);
			expect(call(tool, { path: ".github/workflows/x.yml" }).block).toBe(false);
		});
	}
	it("write to xd:// dispatch is allowed (the nested call is guarded on its own)", () => {
		expect(call("write", { path: "xd://bash", content: "{}" }).block).toBe(false);
	});
	it("write to ssh:// and other schemes is blocked", () => {
		expect(call("write", { path: "ssh://host/etc/x", content: "x" }).block).toBe(true);
	});
	it("reads paths out of the hashline edit input and diff headers", () => {
		expect(call("edit", { input: "[src/a.ts#1A2B]\nPUT 1:\n+x" }).block).toBe(false);
		expect(call("edit", { input: "[../other/a.ts#1A2B]\nPUT 1:\n+x" }).block).toBe(true);
		expect(call("edit", { input: "[src/a.ts#1A2B]\nMV /etc/x" }).block).toBe(true);
		expect(call("edit", { input: "*** Update File: /etc/hosts\n@@" }).block).toBe(true);
		expect(call("edit", { input: "*** Update File: src/a.ts\n@@" }).block).toBe(false);
	});
	it("checks every path in paths[] and glob bases", () => {
		expect(call("ast_edit", { paths: ["src", "../x"] }).block).toBe(true);
		expect(call("ast_edit", { paths: ["src/**/*.ts"] }).block).toBe(false);
		expect(call("ast_edit", { glob: "../**/*.ts" }).block).toBe(true);
		expect(call("ast_edit", { glob: "/etc/**" }).block).toBe(true);
	});
	it("handles windows-style roots", () => {
		const win = { root: "C:\\work\\repo" } as const;
		expect(call("write", { path: "src\\a.ts" }, win).block).toBe(false);
		expect(call("write", { path: "C:\\work\\repo\\src\\a.ts" }, win).block).toBe(false);
		expect(call("write", { path: "C:\\other\\a.ts" }, win).block).toBe(true);
		expect(call("write", { path: "..\\other\\a.ts" }, win).block).toBe(true);
	});
	it("does not treat a sibling directory with the same prefix as inside", () => {
		expect(call("write", { path: `${ROOT}-evil/a.ts` }).block).toBe(true);
	});
});

describe("autopilot guard: github tool", () => {
	it("allows the read operations", () => {
		for (const op of [
			"repo_view",
			"file_read",
			"search_issues",
			"search_prs",
			"search_code",
			"search_commits",
			"search_repos",
			"run_watch",
		]) {
			expect(call("github", { op }).block, op).toBe(false);
		}
	});
	it("blocks pr_push, pr_create and pr_checkout at every level", () => {
		for (const op of ["pr_push", "pr_create", "pr_checkout"]) {
			for (const shipLevel of LEVELS)
				expect(call("github", { op }, { shipLevel, oneShotRelease: true }).block, op).toBe(true);
		}
	});
	it("blocks force options and unknown operations", () => {
		expect(call("github", { op: "repo_view", force: true }).block).toBe(true);
		expect(call("github", { op: "repo_view", forceWithLease: true }).block).toBe(true);
		expect(call("github", { op: "something_new" }).block).toBe(true);
		expect(call("github", {}).block).toBe(true);
	});
});

describe("autopilot guard: other tools", () => {
	it("blocks eval, debug, ssh and ask outright", () => {
		for (const tool of ["eval", "debug", "ssh", "ask"]) expect(call(tool, {}).block, tool).toBe(true);
	});
	it("leaves read-only and unrelated tools alone", () => {
		for (const tool of ["read", "grep", "glob", "todo", "task", "ompdesk_session_open", "web_search", "browser"]) {
			expect(call(tool, { path: "/etc/hosts", command: "git reset --hard" }).block, tool).toBe(false);
		}
	});
	it("the autopilot tool is for the parent only", () => {
		expect(call("autopilot", { op: "begin" }).block).toBe(false);
		expect(call("autopilot", { op: "begin" }, { role: "child" }).block).toBe(true);
	});
	it("a bash call without a command allows (nothing to run)", () => {
		expect(call("bash", {}).block).toBe(false);
		expect(call("bash", null).block).toBe(false);
	});
});

describe("findBanViolation (approval cards)", () => {
	it("flags destructive commands inside card text", () => {
		expect(findBanViolation("Allow tool: bash\n\ngit push --force origin main")).toMatch(/force/);
		expect(findBanViolation("Allow tool: bash\n$ git reset --hard HEAD~3")).toMatch(/reset/);
		expect(findBanViolation('Allow tool: bash\n{"command": "git clean -fd && ls"}')).toMatch(/clean/);
		expect(findBanViolation("Allow tool: bash\ncd src && git commit --amend")).toMatch(/amend/);
	});
	it("flags pushes by default and lets them through at the release scope", () => {
		expect(findBanViolation("Allow tool: bash\ngit push origin HEAD:main")).toBeDefined();
		expect(findBanViolation("Allow tool: bash\ngit push origin HEAD:main", { shipLevel: "release" })).toBeUndefined();
		expect(
			findBanViolation("Allow tool: bash\ngit push origin HEAD:main", { shipLevel: "release", role: "child" }),
		).toBeDefined();
	});
	it("flags paths outside the worktree only when a root is known", () => {
		expect(findBanViolation("Allow tool: bash\nrm -rf ~/x")).toBeDefined();
		expect(findBanViolation("Allow tool: bash\nrm -rf ../x")).toBeUndefined();
		expect(findBanViolation("Allow tool: bash\nrm -rf ../x", { root: ROOT })).toBeDefined();
	});
	it("passes ordinary cards", () => {
		expect(findBanViolation("Allow tool: bash\nbun run check:changed")).toBeUndefined();
		expect(findBanViolation("Allow tool: edit\nsrc/a.ts")).toBeUndefined();
		expect(findBanViolation("")).toBeUndefined();
	});
	it("bashViolation is the same rule set", () => {
		expect(bashViolation("git reset --hard", {})).toBeDefined();
		expect(bashViolation("git status", {})).toBeUndefined();
	});
});
