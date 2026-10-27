/**
 * Sessions sharing a checkout (resources/gui-bridge/modes/checkout-peers-core.ts): the git guard that keeps one
 * session from taking, overwriting or hiding another's work, and the prompt section that names the others.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePath } from "../../resources/gui-bridge/modes/autopilot-guard-core";
import {
	CHECKOUT_REFUSAL_PREFIX,
	type CheckoutPeer,
	type CheckoutPeers,
} from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import {
	type CallVerdict,
	CheckoutLedger,
	canonicalPath,
	checkoutRefusal,
	checkoutSection,
	currentTask,
	overlapNotice,
	shellChanges,
	writeRefusal,
} from "../../resources/gui-bridge/modes/checkout-peers-core";

const REPO = "/work/app";
const OTHER_WORKTREE = "/work/wt/app-feature";
const common = `${REPO}/.git`;

const peer = (over: Partial<CheckoutPeer> = {}): CheckoutPeer => ({ id: "tab-b", title: "Rename helper", ...over });

const alone: CheckoutPeers = { toplevel: REPO, commonDir: common, worktree: [], repo: [], canMessage: true };
/** Another session in the same checkout that changed src/b.ts. */
const sharing: CheckoutPeers = { ...alone, worktree: [peer({ files: [`${REPO}/src/b.ts`] })] };
/** Another session in another worktree of the same repository (today's stash swap). */
const otherWorktree: CheckoutPeers = { ...alone, repo: [peer({ worktree: OTHER_WORKTREE })] };
const own = [`${REPO}/src/a.ts`];

const refused = (peers: CheckoutPeers, command: string, cwd = REPO) =>
	checkoutRefusal(command, cwd, peers, own) !== undefined;

describe("checkout guard: the repository's stash and branches", () => {
	it("refuses git stash while a session works in another worktree of the same repository", () => {
		const reason = checkoutRefusal("git stash", REPO, otherWorktree, own);
		expect(reason).toContain("stash");
		expect(reason).toContain(`"Rename helper" [tab-b] in ${OTHER_WORKTREE}`);
		expect(reason).toContain('ompdesk_report {"to": "tab-b", "kind": "question"');
	});

	it("refuses every stash that writes, however it is spelled, and lets list and show through", () => {
		for (const command of [
			"git stash push -m wip",
			"git stash pop",
			"cd src && git stash -u",
			"bash -c 'git stash apply'",
			"git -C . stash",
		])
			expect(refused(otherWorktree, command), command).toBe(true);
		for (const command of ["git stash list", "git stash show -p"])
			expect(refused(otherWorktree, command)).toBe(false);
	});

	it("refuses deleting or moving a branch, not creating or listing one", () => {
		expect(refused(otherWorktree, "git branch -D feature")).toBe(true);
		expect(refused(otherWorktree, "git branch -m old new")).toBe(true);
		expect(refused(otherWorktree, "git branch feature")).toBe(false);
		expect(refused(otherWorktree, "git branch --list")).toBe(false);
	});

	it("leaves a session working alone untouched", () => {
		for (const command of ["git stash", "git add -A", "git reset --hard", "git clean -fdx", "git commit -am x"])
			expect(refused(alone, command), command).toBe(false);
	});
});

describe("checkout guard: one worktree's files and index", () => {
	it("refuses bulk staging and names the other session, its files and this session's own files", () => {
		const reason = checkoutRefusal("git add -A && git commit -m wip", REPO, sharing, own);
		expect(reason).toContain("bulk staging");
		expect(reason).toContain("(changed lately: src/b.ts)");
		expect(reason).toContain("Files you changed: src/a.ts");
		expect(reason).toContain("git add -- <file>");
	});

	it("refuses every step that takes, overwrites or drops the other session's changes", () => {
		for (const command of [
			"git add .",
			"git add -u",
			"git add src/b.ts",
			"git commit -m 'whatever is staged'",
			"cd src && git add .",
			"git commit -am 'wip'",
			"git commit --all -m wip",
			"git checkout -- .",
			"git checkout .",
			"git checkout main",
			"git switch -c other",
			"git restore src/b.ts",
			"git restore .",
			"git reset --hard",
			"git reset",
			"git reset HEAD~1",
			"git clean -fd",
			"git rm -r src",
		])
			expect(refused(sharing, command), command).toBe(true);
	});

	it("lets a session work on its own files by name", () => {
		for (const command of [
			"git add -- src/a.ts",
			"git add src/a.ts",
			"git commit -m 'validate input' -- src/a.ts",
			"git commit -m 'by name' src/a.ts",
			"git restore src/a.ts",
			"git restore --staged src/a.ts",
			"git reset -- src/a.ts",
			"git clean -n",
			"git status && git diff",
			"cd docs && git add .",
		])
			expect(refused(sharing, command), command).toBe(false);
	});

	it("refuses writing a file the other session changed whole, from the shell or the write tool, and points to the edit tool", () => {
		for (const command of ["echo 'x' > src/b.ts", "cat > src/b.ts <<'EOF'\nx\nEOF", "cd src && printf x >> b.ts"])
			expect(checkoutRefusal(command, REPO, sharing, own), command).toContain("edit tool");
		expect(writeRefusal([`${REPO}/src/b.ts`], sharing, own)).toContain("writing src/b.ts whole with the write tool");
		// Its own files, new files and scratch output stay free.
		for (const command of ["echo x > src/a.ts", "echo x > src/new.ts", "bun test > /tmp/out.txt 2>&1"])
			expect(refused(sharing, command), command).toBe(false);
		expect(writeRefusal([`${REPO}/src/a.ts`, `${REPO}/src/new.ts`], sharing, own)).toBeUndefined();
	});

	it("counts a file written from the shell as the session's own, so the other session's guard sees it", () => {
		expect(
			shellChanges("cd src && cat > b.ts <<'EOF'\nx\nEOF\necho y >> ../README.md 2>/dev/null", REPO).replaces,
		).toEqual([`${REPO}/src/b.ts`, `${REPO}/README.md`]);
	});

	it("does not judge worktree steps for a session in another worktree, nor git runs in another repository", () => {
		expect(refused(otherWorktree, "git add -A")).toBe(false);
		expect(refused(otherWorktree, "git reset --hard")).toBe(false);
		expect(refused(sharing, "git -C /elsewhere/repo add -A")).toBe(false);
		expect(refused(sharing, "cd /tmp/scratch && git reset --hard")).toBe(false);
	});

	it("names a session hidden from agents without its title, id or files, and sends the agent to the user", () => {
		const hidden: CheckoutPeers = {
			...alone,
			worktree: [{ id: null, title: "Secret", files: [`${REPO}/src/secret.ts`] }],
		};
		const reason = checkoutRefusal("git add -A", REPO, hidden, own) ?? "";
		expect(reason).toContain("a session hidden from agents");
		expect(reason).not.toContain("Secret");
		expect(reason).not.toContain("secret.ts");
		expect(reason).toContain("ask the user");
	});
});

describe("checkout guard: a session whose folder runs through a symlink", () => {
	it("judges git runs there against main's real path of the checkout (macOS /var is /private/var)", () => {
		const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "checkout-link-")));
		try {
			fs.mkdirSync(path.join(dir, "real", "app", "src"), { recursive: true });
			// A junction needs no privilege on Windows; POSIX ignores the type.
			fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"), "junction");
			// Every path in the spelling the bridge keeps (`normalizePath`: forward slashes, lower-case drive).
			const real = normalizePath(path.join(dir, "real", "app"), "/");
			const linked = normalizePath(path.join(dir, "link", "app"), "/");
			const peers: CheckoutPeers = { ...alone, toplevel: real, worktree: [peer({ files: [`${real}/src/b.ts`] })] };
			const realpath = (p: string) => fs.realpathSync.native(p);
			// Main resolved the top level; the session's own cwd and its `cd` still name the link.
			expect(checkoutRefusal("git add -A", canonicalPath(linked, realpath), peers, [], realpath)).toBeDefined();
			expect(checkoutRefusal(`cd "${linked}" && git stash`, "/", peers, [], realpath)).toBeDefined();
			// A file a write is about to create gets the real spelling of its existing folder.
			expect(canonicalPath(`${linked}/src/new.ts`, realpath)).toBe(`${real}/src/new.ts`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("shared-checkout prompt section", () => {
	it("is absent while the session works alone", () => {
		expect(checkoutSection(undefined)).toBeUndefined();
		expect(checkoutSection(alone)).toBeUndefined();
	});

	it("names both groups with the ids to message, and says to announce shared steps with one note", () => {
		const text =
			checkoutSection({ ...sharing, repo: [peer({ id: "tab-c", title: "Docs", worktree: OTHER_WORKTREE })] }) ?? "";
		expect(text).toContain('- "Rename helper" [tab-b]');
		expect(text).toContain(`- "Docs" [tab-c] in ${OTHER_WORKTREE}`);
		expect(text).toContain("other worktrees of this repository");
		expect(text).toContain('ompdesk_report {"to": <id>, "kind": "note"');
	});

	it("stays the same text while only the other sessions' files change, so the prompt cache holds", () => {
		const later = { ...sharing, worktree: [peer({ files: [`${REPO}/src/b.ts`, `${REPO}/src/c.ts`] })] };
		expect(checkoutSection(later)).toBe(checkoutSection(sharing));
	});

	it("tells a session without the control tools to leave the others' files alone and ask the user", () => {
		const text = checkoutSection({ ...sharing, canMessage: false }) ?? "";
		expect(text).not.toContain("ompdesk_report");
		expect(text).toContain("ask the user");
	});
});

describe("peers' tasks", () => {
	const mine = `${REPO}/src/b.ts`;
	const busy: CheckoutPeers = {
		...alone,
		worktree: [peer({ files: [mine], shared: [mine], task: "Rename helper everywhere" })],
	};

	it("keeps the prompt section identical for payloads differing only in task, shared and files", () => {
		const bare: CheckoutPeers = { ...alone, worktree: [peer()] };
		expect(checkoutSection(busy)).toBe(checkoutSection(bare));
		expect(checkoutSection(busy)).not.toContain("Rename helper everywhere");
	});

	it("names the task in a guard refusal and a write refusal", () => {
		expect(checkoutRefusal("git add -A", REPO, busy, own)).toContain("(working on: Rename helper everywhere)");
		expect(writeRefusal([mine], busy, own)).toContain("(working on: Rename helper everywhere)");
	});

	it("reads the first in-progress task as one trimmed line", () => {
		expect(
			currentTask([
				{ tasks: [{ content: "a", status: "completed" }] },
				{
					tasks: [
						{ content: "  Fix\n  the   parser ", status: "in_progress" },
						{ content: "x", status: "in_progress" },
					],
				},
			]),
		).toBe("Fix the parser");
		expect(currentTask([{ tasks: [{ content: "a", status: "pending" }] }])).toBeUndefined();
		expect(currentTask([{ tasks: [{ content: "y".repeat(300), status: "in_progress" }] }])?.length).toBe(120);
	});
});

describe("overlap notice", () => {
	const mine = `${REPO}/src/b.ts`;
	const peers: CheckoutPeers = { ...alone, worktree: [peer({ files: [mine], task: "Rename helper" })] };

	it("names the peer, its task, the file and the action, once per file and peer", () => {
		const first = overlapNotice([mine], peers, new Set());
		expect(first.text).toContain("<shared-checkout-overlap>");
		expect(first.text).toContain('"Rename helper" [tab-b]');
		expect(first.text).toContain("working on: Rename helper");
		expect(first.text).toContain("src/b.ts");
		expect(first.text).toContain('"to": "tab-b", "kind": "note"');
		expect(first.text).toContain('"kind": "question"');
		const again = overlapNotice([mine], peers, first.told);
		expect(again.text).toBeUndefined();
	});

	it("is silent for a file only one session changed, and for another worktree's peer that changed nothing", () => {
		expect(overlapNotice([`${REPO}/src/a.ts`], peers, new Set()).text).toBeUndefined();
		expect(
			overlapNotice([mine], { ...alone, repo: [peer({ worktree: OTHER_WORKTREE })] }, new Set()).text,
		).toBeUndefined();
	});

	it("sends a session without the control tools to the user", () => {
		const text = overlapNotice([mine], { ...peers, canMessage: false }, new Set()).text ?? "";
		expect(text).toContain("tell the user");
		expect(text).not.toContain("ompdesk_report");
	});
});

describe("shell changes beyond redirects", () => {
	const changes = (command: string) => shellChanges(command, REPO, undefined, path => path === `${REPO}/docs`);
	const at = (...files: string[]) => files.map(file => `${REPO}/${file}`);

	it("lists what a command changes in place", () => {
		for (const command of [
			"sed -i s/a/b/ src/b.ts",
			"sed -i '' s/a/b/ src/b.ts",
			"sed -i -e s/a/b/ -e s/c/d/ src/b.ts",
			"perl -pi -e 's/a/b/' src/b.ts",
			"patch src/b.ts fix.diff",
		])
			expect(changes(command), command).toEqual({ edits: at("src/b.ts"), replaces: [], deletes: [] });
		for (const command of ["sed -n 1,5p src/b.ts", "patch -p1 -i fix.diff", "perl -e 'print 1' src/b.ts"])
			expect(changes(command), command).toEqual({ edits: [], replaces: [], deletes: [] });
	});

	it("lists what a command replaces whole, a copy or move into a folder as the file it creates there", () => {
		for (const command of [
			"cp /tmp/x src/b.ts",
			"install -m 644 /tmp/x src/b.ts",
			"rsync -a /tmp/x src/b.ts",
			"echo x | tee src/b.ts",
			"dd if=/tmp/x of=src/b.ts bs=1",
			"truncate -s 0 src/b.ts",
			"cp /tmp/b.ts src/",
			"cp -t src /tmp/b.ts",
			"cp /tmp/b.ts docs/",
			"cp /tmp/b.ts docs",
		])
			expect(changes(command).replaces, command).toHaveLength(1);
		expect(changes("cp /tmp/b.ts src/").replaces).toEqual(at("src/b.ts"));
		expect(changes("cp -t src /tmp/b.ts").replaces).toEqual(at("src/b.ts"));
		expect(changes("cp /tmp/b.ts docs").replaces).toEqual(at("docs/b.ts"));
		expect(changes("truncate -s 0 src/b.ts").replaces).toEqual(at("src/b.ts"));
	});

	it("lists a move's source as deleted and its destination as replaced", () => {
		expect(changes("mv src/a.ts src/b.ts")).toEqual({ edits: [], replaces: at("src/b.ts"), deletes: at("src/a.ts") });
		expect(changes("mv src/a.ts docs").replaces).toEqual(at("docs/a.ts"));
	});

	it("lists what a command deletes", () => {
		expect(changes("rm -rf build && unlink src/b.ts && rmdir out").deletes).toEqual(at("build", "src/b.ts", "out"));
	});

	it("lists nothing for commands that change no content, and nothing a failed cd left unresolved", () => {
		for (const command of [
			"touch src/b.ts",
			"mkdir -p src/x",
			"chmod +x src/b.ts",
			"chown me src/b.ts",
			"cat src/b.ts",
		])
			expect(changes(command), command).toEqual({ edits: [], replaces: [], deletes: [] });
		expect(changes("cd $SOMEWHERE && rm b.ts")).toEqual({ edits: [], replaces: [], deletes: [] });
	});

	it("refuses replacing or deleting a file the other session changed, and lets everything else through", () => {
		for (const command of [
			"cp /tmp/x src/b.ts",
			"cp /tmp/b.ts src/",
			"mv /tmp/x src/b.ts",
			"echo x | tee src/b.ts",
			"dd if=/tmp/x of=src/b.ts",
			"truncate -s 0 src/b.ts",
			"install /tmp/x src/b.ts",
		])
			expect(checkoutRefusal(command, REPO, sharing, own), command).toContain(
				"writing src/b.ts whole from the shell",
			);
		for (const command of ["rm src/b.ts", "rm -rf src", "rm src/*.ts", "mv src/b.ts /tmp/b.ts", "unlink src/b.ts"])
			expect(checkoutRefusal(command, REPO, sharing, own), command).toContain("deleting");
		for (const command of [
			"cp /tmp/x src/a.ts",
			"cp src/b.ts /tmp/b.bak",
			"rm src/a.ts",
			"rm -rf build",
			"rm src/c*.ts",
			"touch src/b.ts",
			"chmod +x src/b.ts",
			"mkdir -p src/b",
			"sed -i s/a/b/ src/b.ts",
		])
			expect(refused(sharing, command), command).toBe(false);
	});
});

describe("git steps that rewrite the shared worktree", () => {
	it("refuses each while another session works in the worktree, naming the danger and what to do instead", () => {
		for (const command of [
			"git merge feature",
			"git pull",
			"git pull --rebase origin main",
			"git rebase main",
			"git cherry-pick abc1234",
			"git revert HEAD",
			"git am fix.patch",
			"git apply fix.diff",
			"git apply --index fix.diff",
			"git apply --check --apply fix.diff",
			"cd src && git merge feature",
		]) {
			const reason = checkoutRefusal(command, REPO, sharing, own);
			expect(reason, command).toContain(CHECKOUT_REFUSAL_PREFIX);
			expect(reason, command).toContain("worktree of your own");
		}
	});

	it("lets a session working alone, and a session whose peer is in another worktree, run them", () => {
		for (const command of [
			"git merge feature",
			"git pull",
			"git rebase main",
			"git cherry-pick abc1234",
			"git am x",
		]) {
			expect(refused(alone, command), command).toBe(false);
			expect(refused(otherWorktree, command), command).toBe(false);
		}
	});

	it("lets an operation already underway be finished or left", () => {
		for (const command of [
			"git merge --abort",
			"git merge --continue",
			"git rebase --abort",
			"git rebase --continue",
			"git rebase --skip",
			"git rebase --quit",
			"git cherry-pick --abort",
			"git cherry-pick --continue",
			"git revert --abort",
			"git revert --skip",
			"git am --abort",
			"git am --continue",
		])
			expect(refused(sharing, command), command).toBe(false);
	});

	it("lets git apply only check or report, and judges other git commands that merely start with the same word", () => {
		for (const command of [
			"git apply --check fix.diff",
			"git apply --stat fix.diff",
			"git apply --numstat fix.diff",
			"git apply --summary fix.diff",
			"git merge-base HEAD main",
			"git fetch origin",
			"git log --merges",
		])
			expect(refused(sharing, command), command).toBe(false);
	});

	it("refuses removing or moving the worktree of a session in another worktree, from anywhere, and the shared one", () => {
		for (const command of [
			`git worktree remove ${OTHER_WORKTREE}`,
			"git worktree remove --force ../wt/app-feature",
			`git worktree move ${OTHER_WORKTREE} /work/wt/elsewhere`,
			`cd ${OTHER_WORKTREE} && git worktree remove .`,
		])
			expect(checkoutRefusal(command, REPO, otherWorktree, own), command).toContain(OTHER_WORKTREE);
		expect(checkoutRefusal("git worktree remove .", REPO, sharing, own)).toContain(CHECKOUT_REFUSAL_PREFIX);
		for (const command of [
			"git worktree remove /work/wt/mine",
			"git worktree add ../wt/new",
			"git worktree list",
			"git worktree prune",
			`git worktree move /work/wt/mine ${OTHER_WORKTREE}-x`,
		])
			expect(refused(otherWorktree, command), command).toBe(false);
	});
});

describe("guard refusals", () => {
	it("every refusal starts with the one prefix the work card reads", () => {
		const reasons = [
			checkoutRefusal("git add -A", REPO, sharing, own),
			checkoutRefusal("git stash", REPO, otherWorktree, own),
			checkoutRefusal("git merge x", REPO, sharing, own),
			checkoutRefusal("echo x > src/b.ts", REPO, sharing, own),
			checkoutRefusal("rm src/b.ts", REPO, sharing, own),
			checkoutRefusal(`git worktree remove ${OTHER_WORKTREE}`, REPO, otherWorktree, own),
			writeRefusal([`${REPO}/src/b.ts`], sharing, own),
		];
		for (const reason of reasons) expect(reason?.startsWith(`${CHECKOUT_REFUSAL_PREFIX}: `), reason).toBe(true);
	});
});

describe("the checkout ledger", () => {
	const host = { realpath: (file: string) => file, isDirectory: () => false };
	const b = `${REPO}/src/b.ts`;
	const run = (ledger: CheckoutLedger, peers: CheckoutPeers | undefined, toolName: string, input: unknown) =>
		ledger.call(toolName, input, REPO, peers, host);
	const bash = (ledger: CheckoutLedger, peers: CheckoutPeers | undefined, command: string) =>
		run(ledger, peers, "bash", { command });
	const block = (verdict: CallVerdict) => ("block" in verdict ? verdict.block : undefined);
	const notice = (verdict: CallVerdict) => ("notice" in verdict ? verdict.notice : undefined);
	const gained = (verdict: CallVerdict) => "gained" in verdict && verdict.gained;
	/** The peer changed src/b.ts and src/c.ts; this session changed src/b.ts too. */
	const overlapping = (extra: Partial<CheckoutPeer> = {}): CheckoutPeers => ({
		...alone,
		worktree: [peer({ files: [b, `${REPO}/src/c.ts`], shared: [b], ...extra })],
	});

	it("claims the file a shell edit changes in place and notices the overlap, like the edit tool", () => {
		const ledger = new CheckoutLedger();
		const verdict = bash(ledger, sharing, "sed -i s/a/b/ src/b.ts");
		expect(block(verdict)).toBeUndefined();
		expect(notice(verdict)).toContain("Another session changed a file you just edited");
		expect(notice(verdict)).toContain("src/b.ts");
		expect(ledger.files).toEqual([b]);
	});

	it("drops a claim main saw committed, but keeps one changed again since", () => {
		const ledger = new CheckoutLedger();
		const a = `${REPO}/src/a.ts`;
		run(ledger, undefined, "edit", { path: "src/a.ts" });
		run(ledger, undefined, "edit", { path: "src/b.ts" });
		const seen = [a, b].map(file => ({ file, stamp: ledger.stamp(file) }));
		run(ledger, undefined, "edit", { path: "src/b.ts" });
		ledger.retire(seen);
		expect(ledger.files).toEqual([b]);
		run(ledger, undefined, "edit", { path: "src/a.ts" });
		expect(ledger.files).toEqual([a, b]);
	});

	it("never retires the claim of a write still running, nor one main read while it ran", () => {
		const ledger = new CheckoutLedger();
		const tracked = `${REPO}/tracked.ts`;
		// The hook runs before the command: `sleep 8` keeps the file clean while main takes a pass.
		ledger.call("bash", { command: "sleep 8; echo changed > tracked.ts" }, REPO, undefined, host, "c1");
		const seenWhileRunning = [{ file: tracked, stamp: ledger.stamp(tracked) }];
		ledger.retire(seenWhileRunning);
		expect(ledger.files).toEqual([tracked]);
		// The write lands; a retirement main decided from its read during the run arrives late.
		expect(ledger.settle("c1")).toBe(true);
		ledger.retire(seenWhileRunning);
		expect(ledger.files).toEqual([tracked]);
		// A pass after the write that finds it committed retires it.
		ledger.retire([{ file: tracked, stamp: ledger.stamp(tracked) }]);
		expect(ledger.files).toEqual([]);
		expect(ledger.settle("c1")).toBe(false);
	});

	it("lets a call that never reported back stop holding its claim at the end of its agent's run", () => {
		const ledger = new CheckoutLedger();
		const tracked = `${REPO}/tracked.ts`;
		ledger.call("write", { path: "tracked.ts", content: "x" }, REPO, undefined, host, "denied", "main");
		ledger.settleAll("main");
		ledger.retire([{ file: tracked, stamp: ledger.stamp(tracked) }]);
		expect(ledger.files).toEqual([]);
	});

	it("keeps an agent's running write claimed when another agent of the session ends its run", () => {
		const ledger = new CheckoutLedger();
		const tracked = `${REPO}/tracked.ts`;
		// The main agent's `sleep; echo >` runs on while a short subagent finishes.
		ledger.call("bash", { command: "sleep 8; echo changed > tracked.ts" }, REPO, undefined, host, "a1", "main");
		ledger.call("edit", { path: "src/b.ts" }, REPO, undefined, host, "b1", "Scout");
		ledger.settle("b1");
		expect(ledger.settleAll("Scout")).toBe(false);
		ledger.retire([{ file: tracked, stamp: ledger.stamp(tracked) }]);
		expect(ledger.files).toContain(tracked);
		// Its result still settles and reannounces it.
		expect(ledger.settle("a1")).toBe(true);
	});

	it("claims every file a command replaces or deletes, and no file one only touches", () => {
		const ledger = new CheckoutLedger();
		bash(ledger, undefined, "cp /tmp/x src/new.ts && rm src/old.ts && mv src/m.ts src/n.ts");
		const expected = ["new.ts", "old.ts", "n.ts", "m.ts"].map(file => `${REPO}/src/${file}`).sort();
		expect([...ledger.files].sort()).toEqual(expected);
		const touching = new CheckoutLedger();
		bash(touching, undefined, "touch src/t.ts && mkdir -p src/d && chmod +x src/t.ts && chown me src/t.ts");
		expect(touching.files).toEqual([]);
	});

	it("refuses a shell replace or delete of the peer's file and claims nothing for it", () => {
		for (const command of [
			"cp /tmp/x src/b.ts",
			"mv /tmp/x src/b.ts",
			"echo x | tee src/b.ts",
			"dd if=/tmp/x of=src/b.ts",
			"rm src/b.ts",
		]) {
			const ledger = new CheckoutLedger();
			expect(block(bash(ledger, sharing, command)), command).toContain("from the shell");
			expect(ledger.files, command).toEqual([]);
		}
	});

	it("says a new claim once per call, never for a path the session already holds", () => {
		const ledger = new CheckoutLedger();
		expect(gained(bash(ledger, undefined, "echo x > src/a.ts && echo y > src/new.ts"))).toBe(true);
		expect(gained(bash(ledger, undefined, "echo z >> src/a.ts"))).toBe(false);
		expect(gained(run(ledger, undefined, "edit", { path: "src/a.ts" }))).toBe(false);
		expect(gained(run(ledger, undefined, "edit", { path: "src/c.ts" }))).toBe(true);
		expect(gained(run(ledger, undefined, "read", { path: "src/c.ts" }))).toBe(false);
		expect(gained(bash(ledger, undefined, "touch src/never.ts"))).toBe(false);
	});

	it("claims no file for a refused call, so it says nothing of it", () => {
		const ledger = new CheckoutLedger();
		const verdict = run(ledger, sharing, "write", { path: "src/b.ts", content: "x" });
		expect(block(verdict)).toContain("writing src/b.ts whole with the write tool");
		expect(gained(verdict)).toBe(false);
		expect(ledger.files).toEqual([]);
	});

	it("claims the paths of the edit tool in every form, a patch's move and an lsp rename, not an lsp read", () => {
		const claims = (toolName: string, input: unknown) => {
			const ledger = new CheckoutLedger();
			run(ledger, undefined, toolName, input);
			return [...ledger.files].sort();
		};
		const files = (...names: string[]) => names.map(name => `${REPO}/${name}`).sort();
		expect(
			claims("edit", {
				input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/z.ts\n@@\n-x\n+y\n*** Delete File: old.txt\n*** End Patch\n",
			}),
		).toEqual(files("src/a.ts", "src/z.ts", "old.txt"));
		expect(claims("edit", { path: "src/a.ts", edits: [{ op: "update", rename: "src/y.ts", diff: "@@" }] })).toEqual(
			files("src/a.ts", "src/y.ts"),
		);
		expect(claims("ast_edit", { paths: ["src/a.ts"], ops: [] })).toEqual(files("src/a.ts"));
		expect(claims("lsp", { action: "rename", file: "src/a.ts", line: 1, symbol: "x", new_name: "y" })).toEqual(
			files("src/a.ts"),
		);
		expect(claims("lsp", { action: "rename_file", file: "src/a.ts", new_name: "src/q.ts" })).toEqual(
			files("src/a.ts", "src/q.ts"),
		);
		expect(claims("lsp", { action: "rename", file: "src/a.ts", symbol: "x", new_name: "y", apply: false })).toEqual(
			[],
		);
		expect(claims("lsp", { action: "diagnostics", file: "src/a.ts" })).toEqual([]);
		expect(claims("lsp", { action: "code_actions", file: "src/a.ts", query: "fix", apply: true })).toEqual(
			files("src/a.ts"),
		);
		expect(claims("write", { path: "local://note.md", content: "x" })).toEqual([]);
	});

	it("tells a session at its next call of any kind that a peer started changing a file it changed, once per pair", () => {
		const ledger = new CheckoutLedger();
		const first = notice(run(ledger, overlapping(), "read", { path: "README.md" }));
		expect(first).toContain("Another session also changed files you changed:");
		expect(first).toContain("src/b.ts");
		expect(first).not.toContain("src/c.ts");
		expect(first).toContain('"to": "tab-b", "kind": "note"');
		expect(notice(run(ledger, overlapping(), "read", { path: "README.md" }))).toBeUndefined();
		expect(notice(bash(ledger, overlapping(), "git status"))).toBeUndefined();
	});

	it("says a pair again once the peer's file left its list (committed) and came back", () => {
		const ledger = new CheckoutLedger();
		expect(notice(run(ledger, overlapping(), "read", {}))).toContain("src/b.ts");
		const committed = { ...alone, worktree: [peer({ files: [`${REPO}/src/c.ts`], shared: [] })] };
		expect(notice(run(ledger, committed, "read", {}))).toBeUndefined();
		expect(notice(run(ledger, overlapping(), "read", {}))).toContain("src/b.ts");
		expect(notice(run(ledger, overlapping(), "read", {}))).toBeUndefined();
	});

	it("keeps the reverse notice for the next call when the call that would carry it is refused", () => {
		const ledger = new CheckoutLedger();
		expect(block(bash(ledger, overlapping(), "git add -A"))).toContain(CHECKOUT_REFUSAL_PREFIX);
		expect(notice(run(ledger, overlapping(), "read", {}))).toContain("src/b.ts");
	});

	it("joins a forward and a reverse notice into one text, each pair said once", () => {
		const ledger = new CheckoutLedger();
		const peers = overlapping({ files: [b, `${REPO}/src/c.ts`], shared: [`${REPO}/src/c.ts`] });
		const text = notice(run(ledger, peers, "edit", { path: "src/b.ts" })) ?? "";
		expect(text).toContain("Another session changed a file you just edited:");
		expect(text).toContain("Another session also changed files you changed:");
		expect(text.match(/<shared-checkout-overlap>/g)).toHaveLength(2);
		expect(notice(run(ledger, peers, "edit", { path: "src/b.ts" }))).toBeUndefined();
	});

	it("never refuses over a peer in another worktree, and warns of the merge ahead instead", () => {
		const elsewhere: CheckoutPeers = { ...alone, repo: [peer({ worktree: OTHER_WORKTREE, files: [b], shared: [] })] };
		const ledger = new CheckoutLedger();
		for (const command of ["cp /tmp/x src/b.ts", "echo x > src/b.ts", "rm src/b.ts", "git merge x", "git pull"])
			expect(block(bash(new CheckoutLedger(), elsewhere, command)), command).toBeUndefined();
		const written = run(ledger, elsewhere, "write", { path: "src/b.ts", content: "x" });
		expect(block(written)).toBeUndefined();
		const text = notice(written) ?? "";
		expect(text).toContain("another worktree of this repository, on its own branch");
		expect(text).toContain("conflict when the branches merge");
		expect(text).toContain(`in ${OTHER_WORKTREE}`);
		expect(text).toContain('"to": "tab-b", "kind": "note"');
		const told = notice(run(new CheckoutLedger(), { ...elsewhere, canMessage: false }, "edit", { path: "src/b.ts" }));
		expect(told).toContain("Tell the user");
	});

	it("tells a repo peer's shared files at the next call, never naming a hidden session's place", () => {
		const hidden: CheckoutPeers = {
			...alone,
			repo: [{ id: null, title: "Secret", files: [b], shared: [b] }],
		};
		const text = notice(run(new CheckoutLedger(), hidden, "read", {})) ?? "";
		expect(text).toContain("a session hidden from agents");
		expect(text).toContain("conflict when the branches merge");
		expect(text).not.toContain("Secret");
		expect(text).not.toMatch(/ in \//);
	});

	it("forgets what it was told when the session works alone again", () => {
		const ledger = new CheckoutLedger();
		expect(notice(run(ledger, overlapping(), "read", {}))).toBeDefined();
		run(ledger, undefined, "read", {});
		expect(notice(run(ledger, overlapping(), "read", {}))).toBeDefined();
	});
});
