/**
 * The formal-verification skill on the installed omp (skipped without one): a real session built in a private HOME
 * and agent dir through `stock-probe.ts`. Pins what the design promises:
 * - `-e resources/omp-builtin/formal` makes stock list `ompdesk-formal-verify` (model-invocable, not hidden) and
 *   `skill://` reads its SKILL.md and a reference file;
 * - a user's own skill named `formal-verify` (proof-skills, agent-formal-verify) coexists with it: neither is
 *   renamed, shadowed or dropped, which is why ours is not called `formal-verify`;
 * - the skill adds a small, bounded number of prompt tokens.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ompPackageRoot, systemOmp } from "../omp-runtime";

interface Probe {
	usedTokens: number;
	skillsTokens: number;
	skills: { name: string; path: string; hidden: boolean }[];
	read: Record<string, string>;
}

const FORMAL = path.join(__dirname, "../../../resources/omp-builtin/formal");
const stock = await systemOmp();
const packageRoot = stock.ok ? ompPackageRoot(stock.runtime.bin) : null;
const home = mkdtempSync(path.join(tmpdir(), "omp-formal-stock-"));

function probe(roots: string[], userSkills: Record<string, string> = {}): Probe {
	const agentDir = path.join(home, "agent");
	const cwd = path.join(home, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	for (const [name, text] of Object.entries(userSkills)) {
		mkdirSync(path.join(agentDir, "skills", name), { recursive: true });
		writeFileSync(path.join(agentDir, "skills", name, "SKILL.md"), text);
	}
	const out = execFileSync("bun", [path.join(__dirname, "stock-probe.ts"), packageRoot ?? "", cwd, ...roots], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
		timeout: 90_000,
	});
	return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Probe;
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.skipIf(!packageRoot)("the formal-verification skill on the installed omp", () => {
	const without = packageRoot ? probe([]) : undefined;
	const withFormal = packageRoot ? probe([FORMAL]) : undefined;

	it("lists the skill, model-invocable, from the -e root, and reads it through skill://", () => {
		const ours = withFormal?.skills.filter(skill => skill.path.startsWith(FORMAL)) ?? [];
		expect(ours.map(skill => skill.name)).toEqual(["ompdesk-formal-verify"]);
		expect(ours[0]?.hidden).toBe(false);
		expect(withFormal?.read["skill://ompdesk-formal-verify"]).toContain("name: ompdesk-formal-verify");
		expect(withFormal?.read["skill://ompdesk-formal-verify/references/workflows.md"]).not.toMatch(/^error/);
		expect(without?.skills.some(skill => skill.name === "ompdesk-formal-verify")).toBe(false);
	});

	it("adds a bounded number of prompt tokens", () => {
		const added = (withFormal?.usedTokens ?? 0) - (without?.usedTokens ?? 0);
		expect(added).toBeGreaterThan(0);
		expect(added).toBeLessThan(200);
	});

	it("coexists with a user's own formal-verify skill instead of being shadowed or renamed", () => {
		const theirs =
			"---\nname: formal-verify\ndescription: The user's own formal verification skill.\n---\n\nTheirs.\n";
		const both = probe([FORMAL], { "formal-verify": theirs });
		const names = both.skills.map(skill => skill.name);
		expect(names).toContain("formal-verify");
		expect(names).toContain("ompdesk-formal-verify");
		expect(names.filter(name => name.includes("formal-verify"))).toHaveLength(2);
		expect(both.skills.find(skill => skill.name === "ompdesk-formal-verify")?.path.startsWith(FORMAL)).toBe(true);
	});
});
