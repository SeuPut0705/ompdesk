/**
 * Opt-in (OMP_GUI_REAL_FORMAL=1): the real toolchain, downloaded into a temp cache (never the user's home): setup of
 * TLC (with and without a system Java), the bundled TLA+ example passing with every mutation DETECTED, and the same
 * for the bundled Lean example (about 0.9 GB download, a few minutes). Needs network access.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-real-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

/** Async on purpose: the Lean download takes minutes, and a blocked worker cannot answer vitest's RPC. */
function bunRun(
	script: string,
	args: string[],
	cache: string,
	env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; out: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string }>();
	execFile(
		"bun",
		[path.join(SKILL, "scripts", script), ...args],
		{
			encoding: "utf8",
			env: { ...process.env, HOME: temp, USERPROFILE: temp, OMPDESK_FORMAL_CACHE: cache, ...env },
			maxBuffer: 64 * 1024 * 1024,
		},
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ code, out: `${stdout}${stderr}` });
		},
	);
	return promise;
}

function copyExample(name: string, as = name): string {
	const dest = path.join(temp, as);
	fs.cpSync(path.join(SKILL, "examples", name), dest, { recursive: true });
	return path.join(dest, "formal");
}

describe.skipIf(!REAL)("the real formal toolchain", () => {
	const cache = path.join(temp, "cache");

	it("sets TLC up, idempotently, and the TLA+ example passes with every mutation DETECTED", async () => {
		const first = await bunRun("setup.ts", ["tla"], cache);
		expect(first.out).toContain("READY tla");
		expect(first.code).toBe(0);
		const again = await bunRun("setup.ts", ["tla"], cache);
		expect(again.out).not.toContain("downloading");
		const verified = await bunRun("verify-all.ts", [copyExample("job-lease")], cache);
		expect(verified.out).toContain("PASS  matrix: all 4 runs ended as expected");
		expect(verified.out).toContain("4 of 4 mutations detected");
		expect(verified.out).not.toMatch(/MISSED|UNCOVERED|INVALID/);
		expect(verified.code).toBe(0);
	}, 300_000);

	it("spreads the TLA+ example over units, prints the serial run's report from their verdicts and reuses them after a tag edit", async () => {
		const formal = copyExample("job-lease", "job-lease-sharded");
		const unitsOf = async (): Promise<string> => {
			const plan = await bunRun("shard.ts", ["plan", formal, "--tier", "fast"], cache);
			expect(plan.code).toBe(0);
			const parsed: { matrix: { include: { units: string }[] } } = JSON.parse(plan.out);
			return parsed.matrix.include.map(job => job.units).join(" ");
		};
		/** The report without the times and the cache marks, which are what may differ. */
		const lines = (out: string): string =>
			out
				.split("\n")
				.map(line => line.replace(/, [0-9.]+s(, cached)?\)/, ")"))
				.join("\n");
		const serial = await bunRun("verify-all.ts", [formal, "--tier", "fast"], cache);
		expect(serial.code).toBe(0);
		const verdicts = path.join(temp, "verdicts");
		const cacheDir = path.join(temp, "verdict-cache");
		const first = await bunRun(
			"shard.ts",
			["run", formal, "--tier", "fast", "--units", await unitsOf(), "--out", verdicts, "--cache", cacheDir],
			cache,
		);
		expect(first.code).toBe(0);
		expect(first.out).not.toContain("(cached)");
		const replayed = await bunRun("verify-all.ts", [formal, "--tier", "fast", "--verdicts", verdicts], cache);
		expect(replayed.code).toBe(0);
		expect(lines(replayed.out)).toBe(lines(serial.out));
		// A comment-only edit of the spec (an `@code` tag moving) keeps every digest: nothing is checked again.
		const spec = path.join(formal, "job-lease/tla/JobLease.tla");
		fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replaceAll("@code ", "@code (moved) "));
		const again = await bunRun(
			"shard.ts",
			[
				"run",
				formal,
				"--tier",
				"fast",
				"--units",
				await unitsOf(),
				"--out",
				path.join(temp, "verdicts2"),
				"--cache",
				cacheDir,
			],
			cache,
		);
		expect(again.out.match(/\(cached\)/g)).toHaveLength(9);
		// A change of the model's code is checked again.
		fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replace("token < MaxClaims", "token < MaxClaims /\\ TRUE"));
		const changed = await bunRun(
			"shard.ts",
			[
				"run",
				formal,
				"--tier",
				"fast",
				"--units",
				await unitsOf(),
				"--out",
				path.join(temp, "verdicts3"),
				"--cache",
				cacheDir,
			],
			cache,
		);
		expect(changed.out).not.toContain("(cached)");
	}, 300_000);

	it("falls back to the portable Temurin JRE when no system java runs, and TLC still passes", async () => {
		const portable = path.join(temp, "cache-portable");
		const setup = await bunRun("setup.ts", ["tla"], portable, { OMPDESK_FORMAL_NO_SYSTEM_JAVA: "1", JAVA_HOME: "" });
		expect(setup.out).toContain("(cache, Java 21)");
		const spec = path.join(SKILL, "examples/job-lease/formal/job-lease/tla/JobLease.tla");
		const run = await bunRun("tlc.ts", [spec, "--config", path.join(path.dirname(spec), "MC.cfg")], portable, {
			OMPDESK_FORMAL_NO_SYSTEM_JAVA: "1",
		});
		expect(run.out).toContain("PASS");
		expect(run.code).toBe(0);
	}, 300_000);

	it("sets Lean up and the Lean example passes with every mutation DETECTED", async () => {
		const setup = await bunRun("setup.ts", ["lean"], cache);
		expect(setup.out).toContain("READY lean");
		expect(setup.code).toBe(0);
		const verified = await bunRun("verify-all.ts", [copyExample("bounded-queue")], cache);
		expect(verified.out).toContain("3 of 3 mutations detected");
		expect(verified.out).not.toMatch(/MISSED|UNCOVERED|INVALID/);
		expect(verified.code).toBe(0);
	}, 1_200_000);
});
