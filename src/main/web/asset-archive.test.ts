import {
	existsSync,
	promises as fsp,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARCHIVE_MAX_PREVIOUS, ARCHIVE_RETAIN_MS, AssetArchive, buildIdOf } from "./asset-archive";

let root: string;
let renderer: string;
let archiveDir: string;
let clock: number;

/** Put build `name` in the renderer folder: its own web.html and one hashed chunk named after it. */
function build(name: string): void {
	rmSync(renderer, { recursive: true, force: true });
	mkdirSync(join(renderer, "assets"), { recursive: true });
	writeFileSync(join(renderer, "web.html"), `<!doctype html><script src="./assets/web-${name}.js"></script>`);
	writeFileSync(join(renderer, "assets", `chunk-${name}.js`), `chunk ${name}`);
}

const served = (archive: AssetArchive, file: string) =>
	archive
		.roots()
		.map(dir => join(dir, "assets", file))
		.filter(existsSync)
		.map(path => readFileSync(path, "utf8"));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "asset-archive-"));
	renderer = join(root, "renderer");
	archiveDir = join(root, "web-assets");
	clock = 1_000_000;
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("AssetArchive (the previous builds' assets, served for a while after an update)", () => {
	it("keeps each build once and serves only the replaced ones", async () => {
		const archive = new AssetArchive(archiveDir, () => clock);
		build("a");
		await archive.retain(renderer);
		// The current build is the renderer folder's own: nothing older to serve yet.
		expect(archive.roots()).toEqual([]);
		clock += 1000;
		build("b");
		await archive.retain(renderer);
		expect(served(archive, "chunk-a.js")).toEqual(["chunk a"]);
		expect(served(archive, "chunk-b.js")).toEqual([]);
		// A relaunch on the same build changes nothing and copies nothing again.
		const before = readdirSync(archiveDir).sort();
		await archive.retain(renderer);
		expect(readdirSync(archiveDir).sort()).toEqual(before);
		expect(served(archive, "chunk-a.js")).toEqual(["chunk a"]);
	});

	it("drops a build once it was replaced longer than the window ago, and keeps the newest few", async () => {
		const archive = new AssetArchive(archiveDir, () => clock);
		for (const name of ["a", "b", "c", "d"]) {
			build(name);
			await archive.retain(renderer);
			clock += 1000;
		}
		// d is current; c and b replaced most recently; a is past the count.
		expect(ARCHIVE_MAX_PREVIOUS).toBe(2);
		expect(served(archive, "chunk-c.js")).toEqual(["chunk c"]);
		expect(served(archive, "chunk-b.js")).toEqual(["chunk b"]);
		expect(served(archive, "chunk-a.js")).toEqual([]);
		clock += ARCHIVE_RETAIN_MS;
		await archive.retain(renderer);
		expect(archive.roots()).toEqual([]);
		const currentBuild = await buildIdOf(renderer);
		expect(readdirSync(archiveDir).sort()).toEqual(["builds.json", currentBuild].sort());
	});

	it("does nothing without a built renderer (a dev run) and survives a corrupt index", async () => {
		const archive = new AssetArchive(archiveDir, () => clock);
		await archive.retain(renderer);
		expect(existsSync(archiveDir)).toBe(false);
		build("a");
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "builds.json"), "{not json");
		await archive.retain(renderer);
		expect(archive.roots()).toEqual([]);
		expect(JSON.parse(readFileSync(join(archiveDir, "builds.json"), "utf8")).builds).toHaveLength(1);
	});

	it("runs a second call only after the first ended, so the first call's cleanup never sweeps the second call's copy", async () => {
		const archive = new AssetArchive(archiveDir, () => clock);
		build("a");
		const first = renderer;
		renderer = join(root, "renderer-next");
		build("b");
		const second = renderer;
		const copy = fsp.copyFile.bind(fsp);
		let release = (): void => {};
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		const copied: string[] = [];
		vi.spyOn(fsp, "copyFile").mockImplementation(async (from, to, mode) => {
			copied.push(String(from));
			if (copied.length === 1) await held;
			return copy(from, to, mode);
		});
		const a = archive.retain(first);
		await vi.waitFor(() => expect(copied).toHaveLength(1));
		const b = archive.retain(second);
		// Every step of the second call that could run before the held copy has had its turn.
		for (let tick = 0; tick < 50; tick++) await new Promise(resolve => setImmediate(resolve));
		expect(copied).toEqual([join(first, "assets", "chunk-a.js")]);
		release();
		await Promise.all([a, b]);
		expect(copied).toEqual([join(first, "assets", "chunk-a.js"), join(second, "assets", "chunk-b.js")]);
		expect(served(archive, "chunk-a.js")).toEqual(["chunk a"]);
		expect(existsSync(join(archiveDir, (await buildIdOf(second)) ?? "", "assets", "chunk-b.js"))).toBe(true);
	});
});
