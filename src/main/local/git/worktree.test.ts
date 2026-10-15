import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timeoutForCommand } from "../../../shared/rpc-client";
import type { RpcCommand } from "../../../shared/rpc-types";
import type { BridgeClient } from "../types";
import { GITHUB_COMMAND_BUDGET_MS } from "./github";
import { PR_COMMAND_BUDGETS_MS } from "./pr";
import { SCM_COMMAND_BUDGETS_MS } from "./scm";
import { gitSync, initRepo, pathExists, stockShapedWorktree } from "./test-repos";
import { createWorktree, removableWorktreePath, removeWorktree, WORKTREE_COMMAND_BUDGETS_MS } from "./worktree";

let scratch: string;
let root: string;
let outside: string;
const savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
const bridge: Pick<BridgeClient, "request"> = {
	async request<T>() {
		return { root, hash: "abc1234" } as T;
	},
};

beforeEach(async () => {
	scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-guard-")));
	root = path.join(scratch, "wt");
	outside = path.join(scratch, "projects", "app");
	await fs.mkdir(path.join(root, "gui-fix-1234567"), { recursive: true });
	await fs.mkdir(outside, { recursive: true });
	process.env.OMP_WORKTREE_DIR = root;
});

afterEach(async () => {
	if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
	await fs.rm(scratch, { recursive: true, force: true });
});

describe("removableWorktreePath", () => {
	it("accepts a checkout inside the worktree root", async () => {
		const inside = path.join(root, "gui-fix-1234567");
		expect(await removableWorktreePath(inside, root)).toBe(inside);
	});

	it("refuses the user's own checkout, the root itself, and missing or relative paths", async () => {
		expect(await removableWorktreePath(outside, root)).toBeNull();
		expect(await removableWorktreePath(root, root)).toBeNull();
		expect(await removableWorktreePath(path.join(root, "gone"), root)).toBeNull();
		expect(await removableWorktreePath("wt/gui-fix-1234567", root)).toBeNull();
		expect(await removableWorktreePath("", root)).toBeNull();
	});

	it("refuses paths that only look inside the root", async () => {
		expect(await removableWorktreePath(path.join(root, "..", "projects", "app"), root)).toBeNull();
		const link = path.join(root, "gui-link-1234567");
		await fs.symlink(outside, link, "dir");
		expect(await removableWorktreePath(link, root)).toBeNull();
	});
});

describe("removeWorktree", () => {
	it("refuses a force removal outside the worktree root and leaves the directory alone", async () => {
		await fs.writeFile(path.join(outside, "keep.txt"), "user work");

		await expect(removeWorktree({ path: outside, force: true }, bridge, outside)).rejects.toMatchObject({
			code: "worktree_outside_root",
		});
		expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("user work");
	});
	it("creates with the stock-provided location, removes linked checkouts, and retains their branches", async () => {
		await initRepo(outside);
		const created = await createWorktree(outside, { name: "feature" }, bridge);
		expect(created.path).toBe(path.join(root, "gui-feature-abc1234"));
		await removeWorktree({ path: created.path }, bridge, outside);
		expect(await pathExists(created.path)).toBe(false);
		expect(gitSync(outside, "branch", "--list", created.branch)).toContain(created.branch);
		const old = await stockShapedWorktree(outside, root, "legacy-sha-name");
		await removeWorktree({ path: old.path }, bridge, outside);
		expect(await pathExists(old.path)).toBe(false);
	});
	it("names the branch with the user's prefix, keeps the folder name, and refuses a prefix git would reject", async () => {
		await initRepo(outside);
		const plain = await createWorktree(outside, { name: "plain" }, bridge);
		expect(plain.branch).toBe("omp/gui/plain");
		const created = await createWorktree(outside, { name: "login", branchPrefix: "alice/" }, bridge);
		expect(created.branch).toBe("alice/login");
		expect(created.path).toBe(path.join(root, "gui-login-abc1234"));
		expect(gitSync(outside, "branch", "--list", "alice/login")).toContain("alice/login");
		await expect(createWorktree(outside, { name: "x", branchPrefix: "../evil/" }, bridge)).rejects.toMatchObject({
			code: "invalid_name",
		});
	});
	it("refuses a primary checkout under the root and a linked checkout subdirectory", async () => {
		const primary = path.join(root, "user-clone");
		await initRepo(primary);
		await expect(removeWorktree({ path: primary, force: true }, bridge, primary)).rejects.toMatchObject({
			code: "not_a_worktree",
		});
		const linked = await stockShapedWorktree(primary, root, "linked");
		const nested = path.join(linked.path, "nested");
		await fs.mkdir(nested);
		await expect(removeWorktree({ path: nested, force: true }, bridge, primary)).rejects.toMatchObject({
			code: "not_a_worktree",
		});
		expect(await pathExists(linked.path)).toBe(true);
	});
});

describe("renderer RPC timeouts", () => {
	it("wait at least as long as main can take to answer each worktree, PR and source-control command", () => {
		const budgets: Record<string, number> = {
			...WORKTREE_COMMAND_BUDGETS_MS,
			...PR_COMMAND_BUDGETS_MS,
			...SCM_COMMAND_BUDGETS_MS,
			github: GITHUB_COMMAND_BUDGET_MS,
		};
		for (const [type, budget] of Object.entries(budgets)) {
			// Only the type selects the timeout; the rest of the command is irrelevant here.
			const command = { type } as RpcCommand;
			expect(timeoutForCommand(command), type).toBeGreaterThanOrEqual(budget);
		}
	});
});
