import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timeoutForCommand } from "../../../shared/rpc-client";
import type { RpcCommand } from "../../../shared/rpc-types";
import { PR_COMMAND_BUDGETS_MS } from "./pr";
import { removableWorktreePath, removeWorktree, WORKTREE_COMMAND_BUDGETS_MS } from "./worktree";

let scratch: string;
let root: string;
let outside: string;
const savedWorktreeDir = process.env.OMP_WORKTREE_DIR;

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

		await expect(removeWorktree({ path: outside, force: true })).rejects.toMatchObject({
			code: "worktree_outside_root",
		});
		expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("user work");
	});
});

describe("renderer RPC timeouts", () => {
	it("wait at least as long as main can take to answer each worktree and PR command", () => {
		const budgets: Record<string, number> = { ...WORKTREE_COMMAND_BUDGETS_MS, ...PR_COMMAND_BUDGETS_MS };
		for (const [type, budget] of Object.entries(budgets)) {
			// Only the type selects the timeout; the rest of the command is irrelevant here.
			const command = { type } as RpcCommand;
			expect(timeoutForCommand(command), type).toBeGreaterThanOrEqual(budget);
		}
	});
});
