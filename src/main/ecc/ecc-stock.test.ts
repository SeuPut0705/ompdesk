/**
 * The ECC pack on the installed omp (skipped without one): a real session built in a private HOME and agent dir with
 * pstack, then with pstack and ECC, through `stock-probe.ts`. Pins what the curation promises:
 * - the pack adds one listed skill (the `ecc` index) and under 150 estimated prompt tokens; every other ECC skill is
 *   hidden yet loads, and `skill://<name>` reads it;
 * - all 24 prompt commands are offered as file commands: none is hidden behind a stock or extension command of the
 *   same name (`/plan` would be, hence `ecc-plan`);
 * - no ECC skill shares a name with a pstack one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ompPackageRoot, systemOmp } from "../omp-runtime";

interface Probe {
	usedTokens: number;
	skillsTokens: number;
	skills: { name: string; path: string; hidden: boolean }[];
	commands: { name: string; source: string }[];
	/** Stock's built-in slash command names and aliases (TUI-only ones too). */
	reserved: string[];
	read: Record<string, string>;
}

const BUILTIN = path.join(__dirname, "../../../resources/omp-builtin");
const PACK = path.join(BUILTIN, "ecc");
const stock = await systemOmp();
const packageRoot = stock.ok ? ompPackageRoot(stock.runtime.bin) : null;
const home = mkdtempSync(path.join(tmpdir(), "omp-ecc-stock-"));

function probe(roots: string[]): Probe {
	const agentDir = path.join(home, "agent");
	const cwd = path.join(home, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const out = execFileSync("bun", [path.join(__dirname, "stock-probe.ts"), packageRoot ?? "", cwd, ...roots], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
		timeout: 60_000,
	});
	return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Probe;
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.skipIf(!packageRoot)("the ECC pack on the installed omp", () => {
	const pstackOnly = packageRoot ? probe([path.join(BUILTIN, "pstack")]) : undefined;
	const withEcc = packageRoot ? probe([path.join(BUILTIN, "pstack"), PACK]) : undefined;
	const ecc = withEcc?.skills.filter(skill => skill.path.startsWith(PACK)) ?? [];

	it("adds one listed skill and under 150 prompt tokens", () => {
		expect(ecc.filter(skill => !skill.hidden).map(skill => skill.name)).toEqual(["ecc"]);
		const added = (withEcc?.usedTokens ?? 0) - (pstackOnly?.usedTokens ?? 0);
		expect(added).toBeGreaterThan(0);
		expect(added).toBeLessThan(150);
	});

	it("loads every skill of the pack and reads them through skill://", () => {
		expect(ecc.map(skill => skill.name).sort()).toEqual(readdirSync(path.join(PACK, "skills")).sort());
		const names = withEcc?.skills.map(skill => skill.name) ?? [];
		expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
		for (const name of ["ecc", "golang-patterns", "django-tdd"]) {
			expect(withEcc?.read[name], name).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
		}
	});

	it("offers every prompt command as itself: none takes a stock command's name, TUI-only ones included", () => {
		const files = readdirSync(path.join(PACK, "commands")).map(file => file.replace(/\.md$/, ""));
		const offered = withEcc?.commands.filter(command => command.source === "file").map(command => command.name);
		expect(offered).toEqual(expect.arrayContaining(files));
		expect(files.filter(name => withEcc?.reserved.includes(name))).toEqual([]);
	});
});
