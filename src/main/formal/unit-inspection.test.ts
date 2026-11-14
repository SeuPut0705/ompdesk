import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TlaEnv } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tla-env";
import type {
	TlcRun,
	TlcRunOptions,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-run";

const fake = vi.hoisted(() => ({
	prepare: vi.fn<() => Promise<TlaEnv>>(),
	probe: vi.fn(async () => ({ ok: true, path: "java", text: "java fixture" })),
	run: vi.fn<(options: TlcRunOptions) => Promise<TlcRun>>(),
}));
vi.mock(
	"../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tla-env",
	async importOriginal => ({
		...(await importOriginal<object>()),
		prepareTla: fake.prepare,
		probeJava: fake.probe,
	}),
);
vi.mock(
	"../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-run",
	async importOriginal => ({
		...(await importOriginal<object>()),
		runTlc: fake.run,
	}),
);

import { Unavailable } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/proc";
import {
	type RowVerdict,
	readVerdict,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/shard";
import { main } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/shard";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "unit-inspection-"));
const model = "inspection-fixture";
const ref = `${model}/r1-negative`;
let serial = 0;
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
	fake.prepare.mockReset().mockResolvedValue({
		java: "java",
		javaSource: "system",
		javaMajor: 21,
		tla2tools: "fixture.jar",
		community: "community.jar",
		classpath: "fixture.jar",
		tlaVersion: "fixture",
		communityVersion: "fixture",
	});
	fake.run.mockReset().mockResolvedValue(result());
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

function result(): TlcRun {
	return {
		code: 12,
		result: { outcome: "invariant", property: "Fence", stats: { distinct: 8 }, trace: [], errors: [], warnings: [] },
		text: "selector fixture result, not TLC evidence",
		configUsed: "Negative.cfg",
		durationMs: 1,
	};
}

function fixture() {
	const dir = path.join(root, `case-${serial++}`);
	const tla = path.join(dir, "tla");
	fs.mkdirSync(tla, { recursive: true });
	fs.writeFileSync(
		path.join(tla, "Fixture.tla"),
		"---- MODULE Fixture ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = x + 1\nFence == x < 3\nSpec == Init /\\ [][Next]_x\n====\n",
	);
	fs.writeFileSync(path.join(tla, "MC.cfg"), "SPECIFICATION Spec\nINVARIANT Fence\n");
	fs.writeFileSync(path.join(tla, "Negative.cfg"), "SPECIFICATION Spec\nINVARIANT Fence\n");
	fs.writeFileSync(
		path.join(tla, "matrix.json"),
		JSON.stringify({
			runs: [
				{ name: "smoke", config: "MC.cfg", expect: "pass" },
				{
					name: "negative",
					config: "Negative.cfg",
					expect: "invariant",
					property: "Fence",
					constants: { Cap: "2" },
					workers: "3",
					args: ["-lncheck", "final"],
					timeoutSec: 321,
				},
				{ name: "deep-negative", config: "Negative.cfg", expect: "invariant", property: "Fence", tier: "deep" },
			],
		}),
	);
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		JSON.stringify({
			version: 1,
			models: [{ id: model, kind: "tla", dir: "tla", spec: "Fixture.tla", matrix: "matrix.json", covers: [] }],
		}),
	);
	const base = [dir, "--only", model, "--tier", "deep", "--skip-mutations"];
	const inspect = [...base, "--inspect-unit", ref];
	const out = path.join(dir, "out");
	return { dir, tla, base, inspect, out };
}

function plan(args: string[]): Promise<{
	code: number;
	value: {
		units: Array<{ unit: string; key: string; workers: string; timeoutSec: number }>;
		jobs: Array<{ units: string[]; key: string }>;
	};
}> {
	return main(["plan", ...args]).then(code => ({
		code,
		value: JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])),
	}));
}

interface Summary {
	status: string;
	expected: { outcome: string; property: string | null };
	actual: { code: number | null; outcome: string; property: string | null };
	judgment: { ok: boolean; reason: string };
	evidence: { complete: boolean };
	modelVerified: boolean;
}
function summary(out: string): Summary {
	return JSON.parse(fs.readFileSync(path.join(out, "inspection", "summary.json"), "utf8"));
}

async function inspect(f: ReturnType<typeof fixture>, extra: string[] = []): Promise<number> {
	return main(["run", ...f.inspect, "--units", ref, "--out", f.out, ...extra]);
}

describe("single matrix-row inspection (selector fixtures, not TLC proofs)", () => {
	it("plans exactly one existing row without changing its options or ordinary keys", async () => {
		const f = fixture();
		const before = await plan(f.base);
		const selected = await plan(f.inspect);
		const after = await plan(f.base);
		const ordinary = before.value.units.find(unit => unit.unit === "r1-negative");
		expect(before.code).toBe(0);
		expect(selected.code).toBe(0);
		expect(selected.value.units).toEqual([{ ...ordinary, key: selected.value.units[0].key }]);
		expect(selected.value.units[0].key).not.toBe(ordinary?.key);
		expect(selected.value.jobs.map(job => job.units)).toEqual([[ref]]);
		expect(after.value).toEqual(before.value);
		expect(fake.run).not.toHaveBeenCalled();
	});

	it.each(["configs", "implicit default"] as const)(
		"refuses a synthesized %s row before tool preparation",
		async kind => {
			const f = fixture();
			fs.writeFileSync(path.join(f.tla, "Fixture.cfg"), "SPECIFICATION Spec\nINVARIANT Fence\n");
			fs.writeFileSync(
				path.join(f.dir, "manifest.json"),
				JSON.stringify({
					version: 1,
					models: [
						{
							id: model,
							kind: "tla",
							dir: "tla",
							spec: "Fixture.tla",
							covers: [],
							...(kind === "configs" ? { configs: ["MC.cfg"] } : {}),
						},
					],
				}),
			);
			const ordinary = await plan(f.base);
			expect(ordinary.code).toBe(0);
			expect(ordinary.value.units).toHaveLength(1);
			const synthesized = `${model}/${ordinary.value.units[0].unit}`;
			fake.prepare.mockClear();
			expect(await main(["plan", ...f.base, "--inspect-unit", synthesized])).toBe(2);
			expect(
				await main(["run", ...f.base, "--inspect-unit", synthesized, "--units", synthesized, "--out", f.out]),
			).toBe(2);
			expect(fake.prepare).not.toHaveBeenCalled();
			expect(fake.run).not.toHaveBeenCalled();
		},
	);

	it("refuses invalid scope before preparing tools", async () => {
		const f = fixture();
		for (const args of [
			[f.dir, "--skip-mutations", "--inspect-unit", ref],
			[f.dir, "--only", "another", "--skip-mutations", "--inspect-unit", ref],
			[f.dir, "--only", model, "--inspect-unit", ref],
			[...f.inspect, "--stamp"],
			[...f.inspect, "--inspect-unit", ref],
			[...f.base, "--inspect-unit", `${ref} ${ref}`],
			[...f.base, "--inspect-unit", `${model}/r*`],
			[...f.base, "--inspect-unit", `${model}/baseline`],
			[...f.base, "--inspect-unit", `${model}/m0-mutation`],
			[...f.base, "--inspect-unit", `${model}/r99-missing`],
			[...f.base, "--tier", "fast", "--inspect-unit", `${model}/r2-deep-negative`],
			[...f.inspect, "--diagnose-r12"],
		])
			expect(await main(["plan", ...args])).toBe(2);
		for (const args of [
			["--units", `${ref} ${ref}`],
			["--units", `${model}/r0-smoke`],
			["--units", ref, "--units", ref],
		])
			expect(await main(["run", ...f.inspect, ...args, "--out", f.out])).toBe(2);
		expect(fake.prepare).not.toHaveBeenCalled();
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("keeps raw negative rc separate from the exact expected judgment", async () => {
		const f = fixture();
		expect(await inspect(f)).toBe(0);
		expect(fake.run.mock.calls[0][0]).toMatchObject({
			config: path.join(f.tla, "Negative.cfg"),
			constants: { Cap: "2" },
			workers: "3",
			extraArgs: ["-lncheck", "final"],
			timeoutMs: 321000,
		});
		expect(summary(f.out)).toMatchObject({
			status: "OBSERVED",
			expected: { outcome: "invariant", property: "Fence" },
			actual: { code: 12, outcome: "invariant", property: "Fence" },
			judgment: { ok: true },
			evidence: { complete: true },
			modelVerified: false,
		});
		const verdict = JSON.parse(fs.readFileSync(path.join(f.out, "inspection", "verdict.json"), "utf8")) as RowVerdict;
		expect(verdict.run.code).toBe(12);
		expect(verdict.cached).toBe(false);
	});

	it("does not accept a violation of another property", async () => {
		const f = fixture();
		const wrong = result();
		wrong.result.property = "AnotherFence";
		fake.run.mockResolvedValueOnce(wrong);
		expect(await inspect(f)).toBe(1);
		expect(summary(f.out)).toMatchObject({ status: "UNEXPECTED", judgment: { ok: false }, modelVerified: false });
	});

	it.each(["error", "timeout", "killed"] as const)("never accepts %s as an observed expectation", async kind => {
		const f = fixture();
		const failed = result();
		if (kind === "killed") failed.code = null;
		else failed.result.outcome = kind;
		fake.run.mockResolvedValueOnce(failed);
		expect(await inspect(f)).toBe(1);
		expect(summary(f.out)).toMatchObject({ status: "INCONCLUSIVE", modelVerified: false });
	});

	it("records tool unavailability without claiming an observation", async () => {
		const f = fixture();
		fake.prepare.mockRejectedValueOnce(new Unavailable("fixture tool unavailable"));
		expect(await inspect(f)).toBe(3);
		expect(summary(f.out)).toMatchObject({ status: "INCONCLUSIVE", actual: { code: null }, modelVerified: false });
		expect(fake.run).not.toHaveBeenCalled();
	});

	it("bypasses a warm ordinary cache without changing its contents", async () => {
		const f = fixture();
		const cache = path.join(f.dir, "cache");
		const ordinaryOut = path.join(f.dir, "ordinary");
		const ordinary = () => main(["run", ...f.base, "--units", ref, "--out", ordinaryOut, "--cache", cache]);
		expect(await ordinary()).toBe(0);
		expect(await ordinary()).toBe(0);
		expect(fake.run).toHaveBeenCalledTimes(1);
		const contents = () =>
			fs
				.readdirSync(cache)
				.sort()
				.map(file => [file, fs.readFileSync(path.join(cache, file), "utf8")]);
		const before = contents();
		expect(await inspect(f, ["--cache", cache])).toBe(0);
		expect(fake.run).toHaveBeenCalledTimes(2);
		expect(contents()).toEqual(before);
		const ordinaryVerdict = readVerdict(ordinaryOut, model, "r1-negative");
		const observed = JSON.parse(
			fs.readFileSync(path.join(f.out, "inspection", "verdict.json"), "utf8"),
		) as RowVerdict;
		expect(observed.key).not.toBe(ordinaryVerdict?.key);
	});

	it("marks oversized evidence inconclusive and keeps both artifacts bounded", async () => {
		const f = fixture();
		const large = result();
		large.result.errors = ["x".repeat(1024 * 1024 + 1)];
		fake.run.mockResolvedValueOnce(large);
		expect(await inspect(f)).toBe(1);
		expect(summary(f.out)).toMatchObject({
			status: "INCONCLUSIVE",
			judgment: { ok: true },
			evidence: { complete: false },
			modelVerified: false,
		});
		for (const file of ["verdict.json", "summary.json"])
			expect(fs.statSync(path.join(f.out, "inspection", file)).size).toBeLessThanOrEqual(1024 * 1024);
	});

	it("does not return success when its inspection artifacts cannot be written", async () => {
		const f = fixture();
		fs.writeFileSync(f.out, "not a directory");
		await expect(inspect(f)).rejects.toThrow();
		expect(fake.run).toHaveBeenCalledTimes(1);
		expect(vi.mocked(console.log).mock.calls.some(call => String(call[0]).includes("inspection OBSERVED"))).toBe(
			false,
		);
	});
});
