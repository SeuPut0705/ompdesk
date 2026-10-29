import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// OMPdesk updates its ai-memory build only with the app. Upstream's `upgrade` command and anything
// that fetches upstream releases are deleted from native/memory; a subtree pull brings them back,
// and this test fails until they are deleted again (see .omp/rules/memory.md, "Merging upstream").
const ROOT = join(__dirname, "../../../native/memory");
const CLI = join(ROOT, "crates/ai-memory-cli");

function rustFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (name !== "target" && name !== "node_modules") rustFiles(path, out);
		} else if (name.endsWith(".rs")) out.push(path);
	}
	return out;
}

describe("ai-memory build has no self-update", () => {
	it("has no upgrade command module or test", () => {
		expect(existsSync(join(CLI, "src/commands/upgrade.rs"))).toBe(false);
		expect(existsSync(join(CLI, "tests/suite/upgrade_e2e.rs"))).toBe(false);
	});

	it("registers no upgrade command", () => {
		expect(readFileSync(join(CLI, "src/cli.rs"), "utf8")).not.toMatch(/\bUpgrade\(|UpgradeArgs/);
		expect(readFileSync(join(CLI, "src/lib.rs"), "utf8")).not.toMatch(/Command::Upgrade|commands::upgrade/);
		expect(readFileSync(join(CLI, "src/commands/mod.rs"), "utf8")).not.toMatch(/\bmod upgrade\b/);
	});

	it("fetches no upstream release in Rust code", () => {
		const forbidden = /api\.github\.com\/repos|\/releases\/(latest|download|tag)|release_base_url/;
		const hits = rustFiles(join(ROOT, "crates"))
			.filter(file => !file.endsWith("/build.rs"))
			.filter(file => !file.includes("/tests/"))
			.filter(file => forbidden.test(readFileSync(file, "utf8")))
			.map(file => file.slice(ROOT.length + 1));
		expect(hits).toEqual([]);
	});
});
