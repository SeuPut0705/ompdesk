import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedReaders } from "./changed-readers";

describe("changedReaders", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("finds the test that reads a stylesheet by name once the stylesheet is deleted", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "changed-readers-"));
		dirs.push(dir);
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, env });
		mkdirSync(path.join(dir, "src", "styles"), { recursive: true });
		writeFileSync(path.join(dir, "src", "styles", "mobile.css"), "a { color: red }");
		writeFileSync(path.join(dir, "src", "styles", "touch.test.ts"), 'const css = read("mobile.css");');
		writeFileSync(path.join(dir, "src", "styles", "other.test.ts"), 'const css = read("desktop.css");');
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-q", "-m", "chore: base");

		rmSync(path.join(dir, "src", "styles", "mobile.css"));

		expect(changedReaders("HEAD", dir)).toEqual(["src/styles/touch.test.ts"]);
	});
});
