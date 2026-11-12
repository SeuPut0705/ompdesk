import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionFolder } from "./worktree-facts";

const KEYS = ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "PI_CODING_AGENT_DIR"];
const kept: Record<string, string | undefined> = {};
let root = "";

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-folder-")));
	for (const key of KEYS) kept[key] = process.env[key];
	const home = path.join(root, "home");
	// The temp folder inside the home folder, as on Windows.
	const temp = path.join(home, "Temp");
	await fs.mkdir(temp, { recursive: true });
	Object.assign(process.env, {
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temp,
		TEMP: temp,
		TMP: temp,
		PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
	});
});

afterEach(async () => {
	for (const key of KEYS) {
		if (kept[key] === undefined) delete process.env[key];
		else process.env[key] = kept[key];
	}
	await fs.rm(root, { recursive: true, force: true });
});

// stock's names (pi-coding-agent `session/session-paths.ts` `getDefaultSessionDirName`): disk care reads a worktree's
// newest session file from the folder stock keeps for it, and a worktree made by hand can be anywhere.
describe("sessionFolder", () => {
	const name = (cwd: string) =>
		path.relative(path.join(root, "home", ".omp", "agent", "sessions"), sessionFolder(cwd));

	it("names a folder under the home folder by its path from it", () => {
		expect(name(path.join(root, "home", ".omp", "wt", "gui-a-abc1234"))).toBe("-.omp-wt-gui-a-abc1234");
		expect(name(path.join(root, "home"))).toBe("-");
	});

	it("names a folder under the temp folder by its path from it, also where the temp folder is inside the home", () => {
		expect(name(path.join(root, "home", "Temp", "ompdesk-main", "src"))).toBe("-tmp-ompdesk-main-src");
		expect(name(path.join(root, "home", "Temp"))).toBe("-tmp");
	});

	it("names a folder outside both by its whole path", () => {
		const outside = path.join(root, "yuyu-wt", "a");
		// `/private/x/yuyu-wt/a` is `--private-x-yuyu-wt-a--`, `C:\x\yuyu-wt\a` is `--C--x-yuyu-wt-a--`.
		const parts = outside.split(/[/\\:]/);
		expect(name(outside)).toBe(`--${(parts[0] === "" ? parts.slice(1) : parts).join("-")}--`);
		expect(name(outside)).toMatch(/^--(?:[A-Za-z]--)?[^/\\:]+-yuyu-wt-a--$/);
	});
});
