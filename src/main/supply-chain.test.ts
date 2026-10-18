/**
 * Supply-chain pins. `bunfig.toml` delays brand-new dependency versions, and every
 * workflow installs one exact Bun, so neither a hijacked release nor a Bun that
 * changed overnight reaches CI or a release build unreviewed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");
const MIN_RELEASE_AGE_SECONDS = 3 * 24 * 60 * 60;

interface Workflow {
	jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }>;
}

function setupBunVersions(): { file: string; job: string; version: unknown }[] {
	const found: { file: string; job: string; version: unknown }[] = [];
	for (const file of fs.readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name))) {
		const workflow = parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as Workflow;
		for (const [job, { steps = [] }] of Object.entries(workflow.jobs ?? {})) {
			for (const step of steps) {
				if (step.uses?.startsWith("oven-sh/setup-bun@"))
					found.push({ file, job, version: step.with?.["bun-version"] });
			}
		}
	}
	return found;
}

describe("supply chain", () => {
	it("bunfig.toml holds new package versions back for at least three days", () => {
		const toml = fs.readFileSync(path.join(ROOT, "bunfig.toml"), "utf8");
		const install = /^\[install\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
		const age = /^minimumReleaseAge\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(install);
		expect(age, "[install] minimumReleaseAge (seconds) is missing").not.toBeNull();
		expect(Number(age?.[1])).toBeGreaterThanOrEqual(MIN_RELEASE_AGE_SECONDS);
	});

	it("every workflow job that sets up Bun pins one exact version, never latest", () => {
		const uses = setupBunVersions();
		expect(uses.length).toBeGreaterThan(0);
		for (const { file, job, version } of uses) {
			expect(version, `${file} › ${job}`).toMatch(/^\d+\.\d+\.\d+$/);
		}
		expect(new Set(uses.map(use => use.version)).size, "workflows pin different Bun versions").toBe(1);
	});

	it("every workflow's global omp install is exempt from the release hold, so CI tests the newest omp", () => {
		let installs = 0;
		for (const file of fs.readdirSync(WORKFLOWS).filter(name => /\.ya?ml$/.test(name))) {
			for (const line of fs.readFileSync(path.join(WORKFLOWS, file), "utf8").split("\n")) {
				if (!/^\s*bun install -g\b.*@oh-my-pi\/pi-coding-agent/.test(line)) continue;
				installs++;
				expect(line, file).toContain("--minimum-release-age 0");
			}
		}
		expect(installs).toBeGreaterThan(0);
	});
});
