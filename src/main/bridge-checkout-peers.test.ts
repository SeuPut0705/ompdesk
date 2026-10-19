/**
 * Sessions sharing a checkout (resources/gui-bridge/modes/checkout-peers-core.ts): the git guard that keeps one
 * session from taking, overwriting or hiding another's work, and the prompt section that names the others.
 */
import { describe, expect, it } from "vitest";
import type { CheckoutPeer, CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import { checkoutRefusal, checkoutSection } from "../../resources/gui-bridge/modes/checkout-peers-core";

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
