import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FULL_WALK_EVERY_MS, TreeSizes } from "./tree-sizes";

let root = "";
let tree = "";
let file = "";
/** Directory mtimes set by the tests: old enough to be past the racy window, each change a new value. */
let clock = Date.now() - 60 * 60_000;

async function write(relative: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(tree, relative)), { recursive: true });
	await fs.writeFile(path.join(tree, relative), content);
}

/** Every directory under `tree` (and it) to an old mtime, as an idle folder's are. */
async function settle(dir = tree): Promise<void> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true }))
		if (entry.isDirectory()) await settle(path.join(dir, entry.name));
	await fs.utimes(dir, new Date(clock), new Date(clock));
}

/** Marks directories as changed long ago (a new, still old mtime), as a change that happened since the last run. */
async function touched(...relative: string[]): Promise<void> {
	clock += 1_000;
	for (const dir of relative) await fs.utimes(path.join(tree, dir), new Date(clock), new Date(clock));
}

/** What a run that keeps `file` reads now. */
async function measured(now = Date.now()): Promise<{ bytes: number; readdir: number }> {
	const sizes = new TreeSizes(file, () => now);
	await sizes.load();
	const bytes = await sizes.bytes(tree);
	await sizes.save();
	return { bytes, readdir: sizes.work.readdir };
}

/** A full walk that keeps nothing: the truth. */
const truth = () => new TreeSizes(null).bytes(tree);

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-tree-sizes-")));
	tree = path.join(root, "tree");
	file = path.join(root, "sizes.json");
	await write("a/one.txt", "x".repeat(5_000));
	await write("a/b/two.txt", "y".repeat(70_000));
	await write("a/b/c/three.txt", "z".repeat(9_000));
	await write("d/four.txt", "w".repeat(20_000));
	await settle();
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("TreeSizes", () => {
	it("reads every directory once, then nothing but their stamps while nothing changed", async () => {
		const first = await measured();
		expect(first.bytes).toBe(await truth());
		expect(first.bytes).toBeGreaterThanOrEqual(104_000);
		expect(first.readdir).toBe(5);
		const again = await measured();
		expect(again).toEqual({ bytes: first.bytes, readdir: 0 });
	});

	for (const [what, change, dirs] of [
		["a file added deep inside", () => write("a/b/c/new.txt", "n".repeat(30_000)), ["a/b/c"]],
		["a file removed", () => fs.rm(path.join(tree, "a/b/two.txt")), ["a/b"]],
		["a folder removed with all it held", () => fs.rm(path.join(tree, "a/b"), { recursive: true }), ["a"]],
		["a folder renamed", () => fs.rename(path.join(tree, "a/b"), path.join(tree, "d/b")), ["a", "d"]],
		[
			"a folder replaced by a file of its name",
			async () => {
				await fs.rm(path.join(tree, "d"), { recursive: true });
				await fs.writeFile(path.join(tree, "d"), "f".repeat(1_000));
			},
			["."],
		],
		[
			"a new folder tree",
			async () => {
				await write("e/f/g/deep.txt", "q".repeat(40_000));
				await settle(path.join(tree, "e"));
			},
			["."],
		],
	] as const) {
		it(`totals ${what} as a full walk does, reading only the changed directories`, async () => {
			await measured();
			await change();
			await touched(...dirs);
			const after = await measured();
			expect(after.bytes).toBe(await truth());
			expect(after.readdir).toBeLessThanOrEqual(dirs.length + 3);
		});
	}

	it("counts a file installed as hard links once, wherever its links are", async () => {
		const before = (await measured()).bytes;
		// As Bun installs node_modules: a new file and its new links, each in a changed folder.
		await write("d/pkg/index.js", "p".repeat(60_000));
		await fs.mkdir(path.join(tree, "a/pkg"));
		await fs.link(path.join(tree, "d/pkg/index.js"), path.join(tree, "a/pkg/index.js"));
		await touched("d", "d/pkg", "a", "a/pkg");
		const linked = (await measured()).bytes;
		expect(linked).toBe(await truth());
		expect(linked - before).toBeLessThan(2 * 60_000);
		// Still once after one link goes: the other holds the bytes.
		await fs.rm(path.join(tree, "d/pkg/index.js"));
		await touched("d/pkg");
		expect((await measured()).bytes).toBe(linked);
	});

	for (const [what, change] of [
		// Same folder entries, so the folder's mtime stays: an in-place write (a log, a database) is not seen…
		["a file rewritten in place", () => fs.appendFile(path.join(tree, "a/one.txt"), "x".repeat(200_000))],
		// …nor a second link given to a file whose folder did not change (it then counts once in each folder).
		[
			"a link given to a file in an unchanged folder",
			async () => {
				await fs.link(path.join(tree, "a/b/two.txt"), path.join(tree, "d/two-again.txt"));
				await touched("d");
			},
		],
	] as const) {
		it(`is off by ${what} only until the next full walk`, async () => {
			const first = (await measured()).bytes;
			await change();
			const stale = (await measured()).bytes;
			expect(stale).not.toBe(await truth());
			const later = await measured(Date.now() + FULL_WALK_EVERY_MS + 1);
			expect(later.bytes).toBe(await truth());
			expect(later.readdir).toBe(5);
			expect(first).toBeGreaterThan(0);
		});
	}

	it("reads again a directory that changed in the tick the last run saw it", async () => {
		// Fresh mtimes: within the racy window of the reading below, as on a file system with 1 s timestamps.
		await write("a/fresh.txt", "r");
		await measured();
		await fs.appendFile(path.join(tree, "a/fresh.txt"), "r".repeat(100_000));
		expect((await measured()).bytes).toBe(await truth());
	});

	it("reads a folder in full when told not to reuse, so a file appended in place counts", async () => {
		const sizes = async () => {
			const reading = new TreeSizes(file);
			await reading.load();
			const bytes = await reading.bytes(tree, { reuse: false });
			await reading.save();
			return { bytes, readdir: reading.work.readdir };
		};
		await sizes();
		// A session journal grows like this: appended, its folder's entries unchanged.
		await fs.appendFile(path.join(tree, "a/one.txt"), "x".repeat(200_000));
		const after = await sizes();
		expect(after).toEqual({ bytes: await truth(), readdir: 5 });
	});

	it("starts over from a file it cannot read", async () => {
		await fs.writeFile(file, "{not json");
		const sizes = new TreeSizes(file);
		await sizes.load();
		expect(sizes.reused).toBe(false);
		expect(await sizes.bytes(tree)).toBe(await truth());
		expect(sizes.work.readdir).toBe(5);
	});
});
