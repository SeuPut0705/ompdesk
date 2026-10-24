/**
 * This repository's rules: a small AGENTS.md in front of every request, and each area's detail in `.omp/rules/` that
 * omp lists as domain rules and serves as `rule://<name>` (read on demand).
 *
 * Why: AGENTS.md grew to 792 KB, and omp put all of it in front of every request of every session here (a one-word
 * reply on `smol` wrote 323,006 prompt tokens to the cache, $0.32). Split, the same request is about a tenth of that.
 * The size bound keeps it from growing back; the stock half checks that the installed omp still finds every rule.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ompPackageRoot, systemOmp } from "./omp-runtime";

const REPO = path.join(__dirname, "../..");
const RULES = path.join(REPO, ".omp/rules");
const AGENTS_MD_MAX_BYTES = 64 * 1024;
const agents = readFileSync(path.join(REPO, "AGENTS.md"), "utf8");
const ruleNames = readdirSync(RULES)
	.filter(file => file.endsWith(".md"))
	.map(file => file.slice(0, -3))
	.sort();

describe("AGENTS.md and the area rules", () => {
	it("keeps AGENTS.md under 64 KB", () => {
		expect(Buffer.byteLength(agents)).toBeLessThan(AGENTS_MD_MAX_BYTES);
	});

	it("lists every area rule in AGENTS.md, and no rule that does not exist", () => {
		const listed = [...agents.matchAll(/^- `([a-z0-9-]+)` \(`\.omp\/rules\/\1\.md`\)/gm)]
			.map(match => match[1])
			.sort();
		expect(listed).toEqual(ruleNames);
	});

	it("gives every rule a description and file globs, so omp lists it as a domain rule", () => {
		for (const name of ruleNames) {
			const text = readFileSync(path.join(RULES, `${name}.md`), "utf8");
			const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
			expect(front, name).toMatch(/^description: ".+"$/m);
			expect(front, name).toMatch(/^globs:\n {2}- "/m);
			expect(text.slice(front.length), name).toMatch(/^## /m);
		}
	});

	it("keeps the sections Autopilot's release detection reads in AGENTS.md", () => {
		expect(agents).toMatch(/^## Change workflow$/m);
		expect(agents).toMatch(/^## Release$/m);
	});
});

const stock = await systemOmp();
const packageRoot = stock.ok ? ompPackageRoot(stock.runtime.bin) : null;
const home = mkdtempSync(path.join(tmpdir(), "omp-agents-md-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.skipIf(!packageRoot)("the area rules on the installed omp", () => {
	const probe = packageRoot
		? (JSON.parse(
				execFileSync("bun", [path.join(__dirname, "agents-md-probe.ts"), packageRoot, REPO, "composer"], {
					encoding: "utf8",
					env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, "agent") },
					timeout: 60_000,
				})
					.trim()
					.split("\n")
					.findLast(line => line.startsWith("{")) ?? "{}",
			) as { listed: string[]; contextFiles: string[]; read: string; usedTokens: number })
		: undefined;

	it("lists every rule as a domain rule and loads only the small AGENTS.md", () => {
		expect([...(probe?.listed ?? [])].sort()).toEqual(ruleNames);
		expect(probe?.contextFiles.map(file => path.basename(file))).toEqual(["AGENTS.md"]);
		expect(probe?.usedTokens).toBeLessThan(40_000);
	});

	it("reads a rule whole through rule://", () => {
		expect(probe?.read).toMatch(/^## Composer\n/);
	});
});
