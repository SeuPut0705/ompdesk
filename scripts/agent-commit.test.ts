import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "../src/main/local/git/test-repos";
import { withoutGitSelectors } from "../src/shared/git-env";

const SCRIPT = path.join(import.meta.dirname, "agent-commit.sh");

// POSIX only: `bash` on a Windows PATH may be WSL's (System32), which sees neither this checkout's paths nor bun.
describe.skipIf(process.platform === "win32")("agent-commit.sh", () => {
	let repo: string;
	let temp: string;
	beforeEach(async () => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-commit-repo-"));
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-commit-temp-"));
		await initRepo(repo);
	});
	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(temp, { recursive: true, force: true });
	});

	const commit = (...args: string[]) =>
		spawnSync("bash", [SCRIPT, ...args], {
			cwd: repo,
			encoding: "utf8",
			env: { ...withoutGitSelectors(process.env), TMPDIR: temp },
		});

	it("commits TypeScript files and leaves nothing in the temp folder", () => {
		fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(repo, "b.tsx"), "export const b = <i />;\n");

		const done = commit("-m", "feat: two files", "a.ts", "b.tsx");

		expect(done.status, done.stderr).toBe(0);
		expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("feat: two files");
		expect(fs.readdirSync(temp)).toEqual([]);
	});

	it("refuses a file that does not parse, and still leaves nothing in the temp folder", () => {
		fs.writeFileSync(path.join(repo, "broken.ts"), "export const = ;\n");

		const refused = commit("-m", "feat: broken", "broken.ts");

		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("broken.ts does not parse");
		expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("init");
		expect(fs.readdirSync(temp)).toEqual([]);
	});
});
