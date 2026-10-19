/** A removal and a tab opening on the same worktree exclude each other. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removalHolds, withRemovalClaim } from "./worktree-removals";

let root: string;
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-removals-")));
	await fs.mkdir(path.join(root, "gui-a", "src"), { recursive: true });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("withRemovalClaim", () => {
	it("holds the worktree (and every folder in it) until the removal ends, refusing a second removal meanwhile", async () => {
		const worktree = path.join(root, "gui-a");
		let release: () => void = () => undefined;
		const running = withRemovalClaim(
			worktree,
			() => [],
			() => new Promise<void>(resolve => (release = resolve)),
		);
		expect(removalHolds(worktree)).toBe(true);
		expect(removalHolds(path.join(worktree, "src"))).toBe(true);
		expect(removalHolds(root)).toBe(false);
		await expect(
			withRemovalClaim(
				worktree,
				() => [],
				async () => "again",
			),
		).rejects.toMatchObject({ code: "in_use" });
		release();
		await running;
		expect(removalHolds(worktree)).toBe(false);
	});

	it("refuses when an open session's folder is the worktree or inside it, read at the claim", async () => {
		const worktree = path.join(root, "gui-a");
		let ran = false;
		await expect(
			withRemovalClaim(
				worktree,
				() => [path.join(worktree, "src")],
				async () => {
					ran = true;
				},
			),
		).rejects.toMatchObject({ code: "in_use" });
		expect(ran).toBe(false);
		expect(removalHolds(worktree)).toBe(false);
	});
});
