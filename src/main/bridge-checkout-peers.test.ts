/**
 * Sessions sharing a checkout (resources/gui-bridge/modes/checkout-peers-core.ts): the git guard that keeps one
 * session from taking, overwriting or hiding another's work, and the prompt section that names the others.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePath } from "../../resources/gui-bridge/modes/autopilot-guard-core";
import type { CheckoutPeer, CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import {
	canonicalPath,
	checkoutRefusal,
	checkoutSection,
	shellWrites,
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
		expect(shellWrites("cd src && cat > b.ts <<'EOF'\nx\nEOF\necho y >> ../README.md 2>/dev/null", REPO)).toEqual([
			`${REPO}/src/b.ts`,
			`${REPO}/README.md`,
		]);
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
