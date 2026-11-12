/**
 * Electron patches `fs` so that a path through a `*.asar` is read as a folder: stat, copy, read or remove such a file
 * and the archive is opened and held for the life of the process, which on Windows keeps the file from being deleted
 * (every Electron project's node_modules holds one). Main's code over a user's folders therefore uses `original-fs`,
 * Electron's unpatched `fs`; `e2e/disk-care-asar.e2e.ts` proves it on disk care in a real app. A vitest run is plain
 * Node, where this checks the import that makes it so (`vitest.config.ts` aliases `original-fs` to `node:fs`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = __dirname;

/** Modules that walk, copy, read or remove files of the user's folders and worktrees. */
const USER_FOLDER_MODULES = [
	"open-path.ts",
	"worktree-orphans.ts",
	"worktree-removals.ts",
	"web/host-actions.ts",
	"local/git/changes.ts",
	"local/git/scm.ts",
	"local/git/session-worktree.ts",
	"local/git/worktree.ts",
	"local/git/worktree-seed.ts",
	...fs
		.readdirSync(path.join(MAIN, "disk"))
		.filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith("-fixture.ts"))
		.map(file => `disk/${file}`),
];

const PLAIN_FS_IMPORT = /^import (?!type\b)[^;]*\bfrom "(?:node:)?fs(?:\/promises)?";/m;

describe("main's code over a user's folders", () => {
	it.each(USER_FOLDER_MODULES)("%s never imports Electron's patched fs", file => {
		const source = fs.readFileSync(path.join(MAIN, file), "utf8");
		expect(source.match(PLAIN_FS_IMPORT)?.[0]).toBeUndefined();
	});
});

/**
 * Modules that read the app's own files, which a packaged app keeps inside `app.asar`. Electron serves a `copyFile`,
 * `cp`, `open` or read stream of a file there by copying it out to a temp file first (`.<bundle id>.XXXXXX` on macOS),
 * never removed: the web server's asset archive left a build's 218 assets in the temp folder at every update. A
 * `readFile` is served from the archive with no copy. Plain Node has no archive, so this checks the calls.
 */
const APP_FILE_MODULES = ["web/asset-archive.ts"];
const COPIES_OUT = /\b(?:copyFile|copyFileSync|cp|cpSync|open|openSync|createReadStream)\(/;

describe("main's code over the app's own files", () => {
	it.each(APP_FILE_MODULES)("%s never copies a file out of the app's archive", file => {
		const source = fs.readFileSync(path.join(MAIN, file), "utf8");
		expect(source.match(COPIES_OUT)?.[0]).toBeUndefined();
	});
});
