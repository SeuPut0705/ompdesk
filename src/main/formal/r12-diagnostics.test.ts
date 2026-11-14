import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	prepare: vi.fn(async () => ({
		java: "java",
		javaSource: "system",
		javaMajor: 17,
		tla2tools: "",
		community: "",
		classpath: "",
		tlaVersion: "test",
		communityVersion: "test",
	})),
	probe: vi.fn(async () => ({ ok: true, path: "java", text: "java test" })),
	run: vi.fn(async (_options: unknown) => ({
		code: 0 as number | null,
		result: { outcome: "pass", stats: {}, trace: [], errors: [], warnings: [] },
		text: "done",
		configUsed: "formal/checks-admission/tla/MC_live_account.cfg",
		durationMs: 1,
	})),
}));
vi.mock(
	"../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tla-env",
	async importOriginal => ({ ...(await importOriginal<object>()), prepareTla: fake.prepare, probeJava: fake.probe }),
);
vi.mock(
	"../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-run",
	async importOriginal => ({ ...(await importOriginal<object>()), runTlc: fake.run }),
);

import { readVerdict } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/shard";
import { main } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/shard";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "r12-diagnostics-"));
const ref = "checks-admission/r12-liveness-account";
const base = ["formal", "--only", "checks-admission", "--tier", "fast"];
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(() => {
	fake.prepare.mockClear();
	fake.run.mockClear();
});

describe("r12 diagnostic selector", () => {
	it("plans only the unchanged r12 row with a distinct job key", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await main(["plan", ...base, "--skip-mutations"])).toBe(0);
			const ordinary = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			log.mockClear();
			expect(await main(["plan", ...base, "--diagnose-r12"])).toBe(0);
			const diagnostic = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			const row = ordinary.units.find((unit: { unit: string }) => unit.unit === "r12-liveness-account");
			expect(diagnostic.units).toHaveLength(1);
			expect(diagnostic.units[0]).toEqual({ ...row, key: diagnostic.units[0].key });
			expect(diagnostic.units[0].key).not.toBe(row.key);
			expect(diagnostic.jobs[0].key).not.toBe(
				ordinary.jobs.find((job: { units: string[] }) => job.units.includes(ref))?.key,
			);
		} finally {
			log.mockRestore();
		}
	});

	it("refuses incompatible options and extra units before preparing tools", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const args of [
				["formal", "--only", "other", "--tier", "fast"],
				["formal", "--only", "checks-admission", "--tier", "deep"],
				[...base, "--stamp"],
			])
				expect(await main(["plan", ...args, "--diagnose-r12"])).toBe(2);
			for (const refs of [`${ref} ${ref}`, "checks-admission/r0-other"]) {
				expect(await main(["run", ...base, "--diagnose-r12", "--units", refs, "--out", temp])).toBe(2);
			}
			expect(fake.prepare).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
		}
	});

	it("bypasses a warm ordinary cache without writing a diagnostic verdict into it", async () => {
		const cache = path.join(temp, "cache");
		const ordinaryOut = path.join(temp, "ordinary");
		const diagnosticOut = path.join(temp, "diagnostic");
		const run = (out: string, diagnostic = false) =>
			main([
				"run",
				...base,
				...(diagnostic ? ["--diagnose-r12"] : []),
				"--units",
				ref,
				"--out",
				out,
				"--cache",
				cache,
			]);
		expect(await run(ordinaryOut)).toBe(0);
		expect(fake.run).toHaveBeenCalledTimes(1);
		const cacheContents = () =>
			fs
				.readdirSync(cache)
				.sort()
				.map(file => [file, fs.readFileSync(path.join(cache, file), "utf8")]);
		const before = cacheContents();
		expect(await run(ordinaryOut)).toBe(0);
		expect(fake.run).toHaveBeenCalledTimes(1);
		expect(await run(diagnosticOut, true)).toBe(0);
		expect(fake.run).toHaveBeenCalledTimes(2);
		expect(fake.run.mock.calls[1]?.[0]).toMatchObject({
			diagnostics: { outDir: path.join(diagnosticOut, "diagnostics") },
			workers: "1",
			timeoutMs: 3600000,
			extraArgs: ["-lncheck", "final"],
			config: expect.stringContaining("MC_live_account.cfg"),
		});
		expect(cacheContents()).toEqual(before);
		const ordinary = readVerdict(ordinaryOut, "checks-admission", "r12-liveness-account");
		const diagnostic = readVerdict(diagnosticOut, "checks-admission", "r12-liveness-account");
		expect(ordinary?.cached).toBe(true);
		expect(diagnostic?.cached).toBe(false);
		expect(diagnostic?.key).not.toBe(ordinary?.key);
		expect(diagnostic?.kind === "row" && ordinary?.kind === "row" && diagnostic.run.result).toEqual(
			ordinary?.kind === "row" && ordinary.run.result,
		);
	});
	it("reports an interrupted diagnostic as failure while retaining its result", async () => {
		fake.run.mockResolvedValueOnce({
			code: null,
			result: { outcome: "error", stats: {}, trace: [], errors: [], warnings: [] },
			text: "interrupted",
			configUsed: "formal/checks-admission/tla/MC_live_account.cfg",
			durationMs: 1,
		});
		const out = path.join(temp, "interrupted");
		expect(await main(["run", ...base, "--diagnose-r12", "--units", ref, "--out", out])).toBe(1);
		const verdict = readVerdict(out, "checks-admission", "r12-liveness-account");
		expect(verdict?.kind === "row" && verdict.run).toMatchObject({ code: null, result: { outcome: "error" } });
	});
});
