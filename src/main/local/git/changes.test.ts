import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitChanges } from "./changes";
import { gitSync, initRepo } from "./test-repos";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-change-counts-"));
	await initRepo(root);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("checkout numstat", () => {
	it("counts net HEAD changes, including staged and unstaged lines, without inventing untracked or binary counts", async () => {
		await fs.writeFile(path.join(root, "README.md"), "hello\nstaged\n");
		await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1]));
		gitSync(root, "add", ".");
		await fs.writeFile(path.join(root, "README.md"), "hello\nstaged\nunstaged\n");
		await fs.writeFile(path.join(root, "new.txt"), "new\n");
		const { files } = await getGitChanges(root);
		expect(files.find(file => file.path === "README.md")).toMatchObject({ added: 2, removed: 0 });
		expect(files.find(file => file.path === "new.txt")).not.toHaveProperty("added");
		expect(files.find(file => file.path === "binary.dat")).not.toHaveProperty("added");
	});
	it("preserves renamed paths and their modification counts", async () => {
		await fs.writeFile(path.join(root, "old name.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
		gitSync(root, "add", ".");
		gitSync(root, "commit", "-qm", "rename base");
		gitSync(root, "mv", "old name.txt", "new name.txt");
		await fs.appendFile(path.join(root, "new name.txt"), "seven\n");
		const { files } = await getGitChanges(root);
		expect(files).toEqual([
			expect.objectContaining({ path: "new name.txt", oldPath: "old name.txt", added: 1, removed: 0 }),
		]);
	});
});
