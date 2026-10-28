/** verify-all: the manifest, drift against the sync commit (real git), and the exit codes of the real script. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	checkDrift,
	hasUncommitted,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/drift";
import { parseManifest } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/manifest";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-verify-all-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

const model = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	id: "a",
	kind: "tla",
	dir: "a/tla",
	spec: "A.tla",
	...extra,
});

describe("manifest", () => {
	it("accepts the shipped examples", () => {
		for (const example of ["job-lease", "bounded-queue"]) {
			const raw = JSON.parse(fs.readFileSync(path.join(SKILL, "examples", example, "formal/manifest.json"), "utf8"));
			expect(parseManifest(raw).models).toHaveLength(1);
		}
		const parsed = parseManifest({ version: 1, models: [model({ covers: ["src/a.ts"], syncCommit: "abcdef1" })] });
		expect(parsed.codeRoot).toBe("..");
		expect(parsed.models[0]).toMatchObject({ covers: ["src/a.ts"], syncCommit: "abcdef1" });
	});

	it("rejects bad input with the field named, and paths that leave the formal folder", () => {
		expect(() => parseManifest({ version: 2, models: [] })).toThrow(/version/);
		expect(() => parseManifest({ version: 1, models: [] })).toThrow(/models/);
		expect(() => parseManifest({ version: 1, models: [model({ kind: "coq" })] })).toThrow(/kind/);
		expect(() => parseManifest({ version: 1, models: [{ id: "a", kind: "tla", dir: "x" }] })).toThrow(/spec/);
		expect(() => parseManifest({ version: 1, models: [model(), model()] })).toThrow(/duplicate/);
		expect(() => parseManifest({ version: 1, models: [model({ dir: "../outside" })] })).toThrow(/without \.\./);
		expect(() => parseManifest({ version: 1, models: [model({ matrix: "/etc/passwd" })] })).toThrow(/relative/);
		expect(() => parseManifest({ version: 1, models: [model({ covers: ["../../secret"] })] })).toThrow(/covers/);
		expect(() => parseManifest({ version: 1, models: [model({ syncCommit: "not a sha" })] })).toThrow(/syncCommit/);
	});
});

describe("drift", () => {
	const repo = path.join(temp, "repo");
	const git = (...args: string[]): string => {
		const run = spawnSync(
			"git",
			["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
			{
				cwd: repo,
				encoding: "utf8",
			},
		);
		return run.stdout.trim();
	};
	let first = "";

	beforeAll(() => {
		fs.mkdirSync(path.join(repo, "src"), { recursive: true });
		fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(repo, "src/b.ts"), "export const b = 1;\n");
		git("init", "-q");
		git("add", "-A");
		git("commit", "-q", "-m", "first");
		first = git("rev-parse", "HEAD");
	});

	it("is ok while the covered files are unchanged, even when others changed", async () => {
		expect(await checkDrift(repo, ["src/a.ts"], first)).toMatchObject({ status: "ok", files: [] });
		fs.writeFileSync(path.join(repo, "src/b.ts"), "export const b = 2;\n");
		git("commit", "-q", "-am", "touch b");
		expect((await checkDrift(repo, ["src/a.ts"], first)).status).toBe("ok");
	});

	it("reports the covered files that changed since the sync commit, committed or not", async () => {
		const drift = await checkDrift(repo, ["src/a.ts", "src/b.ts"], first);
		expect(drift.status).toBe("drift");
		expect(drift.files).toEqual(["src/b.ts"]);
		expect(drift.message).toContain("DRIFT");
		expect(await hasUncommitted(repo, ["src/a.ts"])).toBe(false);
		fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 9;\n");
		expect(await hasUncommitted(repo, ["src/a.ts"])).toBe(true);
		expect((await checkDrift(repo, ["src/a.ts"], first)).files).toEqual(["src/a.ts"]);
	});

	it("says so when there is no sync commit, no covered file, or an unknown commit", async () => {
		expect((await checkDrift(repo, ["src/a.ts"], null)).status).toBe("unstamped");
		expect((await checkDrift(repo, [], first)).status).toBe("no-covers");
		expect((await checkDrift(repo, ["src/a.ts"], "0123456789abcdef0123456789abcdef01234567")).status).toBe(
			"bad-commit",
		);
	});
});

describe("verify-all.ts", () => {
	const run = (args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; out: string } => {
		const result = spawnSync("bun", [path.join(SKILL, "scripts/verify-all.ts"), ...args], {
			encoding: "utf8",
			env: { ...process.env, OMPDESK_FORMAL_CACHE: path.join(temp, "cache"), ...env },
		});
		return { code: result.status, out: result.stdout + result.stderr };
	};

	it("exits 2 on usage errors, a missing or invalid manifest, and an unknown model id", () => {
		expect(run([]).code).toBe(2);
		expect(run([path.join(temp, "nowhere")]).code).toBe(2);
		const dir = path.join(temp, "bad");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), '{"version": 1, "models": [{"id": "x"}]}');
		expect(run([dir]).code).toBe(2);
		const example = path.join(SKILL, "examples/job-lease/formal");
		const unknown = run([example, "--only", "ghost"]);
		expect(unknown.code).toBe(2);
		expect(unknown.out).toContain("no model ghost");
	});

	it("exits 1 when a model's files are missing", () => {
		const dir = path.join(temp, "missing");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, models: [model()] }));
		const result = run([dir]);
		expect(result.code).toBe(1);
		expect(result.out).toContain("FAIL");
	});

	it("exits 3 and says NOT CHECKED when TLC cannot be prepared and nothing else failed", () => {
		const example = path.join(SKILL, "examples/job-lease/formal");
		const result = run([example, "--skip-mutations"], {
			OMPDESK_FORMAL_OFFLINE: "1",
			OMPDESK_FORMAL_NO_SYSTEM_JAVA: "1",
		});
		expect(result.code).toBe(3);
		expect(result.out).toContain("NOT CHECKED");
		expect(result.out).not.toMatch(/^PASS {2}job-lease/m);
	}, 30_000);
});
