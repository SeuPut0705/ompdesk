import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pickTests, RELATED_CAP, reach, sourceImports } from "./changed-tests";

const graph = (edges: Record<string, string[]>, extra: string[] = []) => ({
	files: new Set([...Object.keys(edges), ...extra]),
	imports: Object.entries(edges).flatMap(([importer, specifiers]) =>
		specifiers.map(specifier => [importer, specifier] as const),
	),
});

describe("reach", () => {
	it("tells the tests one import away from the ones that reach a change through other files", () => {
		const world = graph({
			"src/main/seed.ts": [],
			"src/main/seed.test.ts": ["./seed"],
			"src/main/worktree.ts": ["./seed"],
			"src/main/worktree.test.ts": ["./worktree"],
			"src/main/ship.ts": ["./worktree"],
			"src/main/ship.test.ts": ["./ship", "vitest"],
			"src/main/other.test.ts": ["./other"],
			"src/main/other.ts": [],
		});
		expect(reach(["src/main/seed.ts"], world)).toEqual({
			direct: ["src/main/seed.test.ts"],
			related: ["src/main/seed.test.ts", "src/main/ship.test.ts", "src/main/worktree.test.ts"],
		});
	});

	it("counts a changed test as its own, and ends on files that import each other", () => {
		const world = graph({
			"src/a.ts": ["./b"],
			"src/b.ts": ["./a"],
			"src/b.test.ts": ["./b"],
		});
		expect(reach(["src/a.ts", "src/lone.test.ts"], world)).toEqual({
			direct: ["src/lone.test.ts"],
			related: ["src/b.test.ts", "src/lone.test.ts"],
		});
	});

	it("resolves the spellings an import takes: an alias, a folder's index, a .js ending, a bridge file from main", () => {
		const world = graph(
			{
				"src/renderer/lib/a.test.tsx": ["@shared/web-protocol", "../components/common"],
				"src/main/bridge.test.ts": ["../../resources/gui-bridge/core.js"],
			},
			["src/shared/web-protocol.ts", "src/renderer/components/common/index.tsx", "resources/gui-bridge/core.ts"],
		);
		for (const changed of [
			"src/shared/web-protocol.ts",
			"src/renderer/components/common/index.tsx",
			"resources/gui-bridge/core.ts",
		])
			expect(reach([changed], world).direct).toHaveLength(1);
	});
});

describe("pickTests", () => {
	const tests = (count: number) => Array.from({ length: count }, (_, index) => `src/t${index}.test.ts`);

	it("runs a change's whole reach up to the cap, and with it the tests naming a changed file", () => {
		const related = tests(RELATED_CAP);
		expect(pickTests(["src/a.ts"], ["src/reads-a.test.ts"], { direct: related.slice(0, 2), related })).toEqual({
			command: "related",
			files: ["src/a.ts", "src/reads-a.test.ts"],
			left: 0,
		});
	});

	it("past the cap runs only the tests one step away and counts what it leaves to CI", () => {
		const related = tests(RELATED_CAP + 1);
		const pick = pickTests(["src/hub.ts"], ["src/reads-hub.test.ts", related[0] ?? ""], {
			direct: related.slice(0, 2),
			related,
		});
		expect(pick).toEqual({
			command: "run",
			files: [...related.slice(0, 2), "src/reads-hub.test.ts"],
			left: RELATED_CAP - 1,
		});
	});
});

describe("sourceImports", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reads every way a test loads a file, in tracked and untracked files, and no ignored one", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "changed-tests-"));
		dirs.push(dir);
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...args],
				{ cwd: dir, env },
			);
		const write = (file: string, text: string) => {
			mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			writeFileSync(path.join(dir, file), text);
		};
		write(".gitignore", "out/\n");
		write("src/hub.ts", "export const hub = 1;\n");
		write("src/static.test.ts", 'import { hub } from "./hub";\n');
		write("src/lazy.test.ts", 'const hub = await import("./hub");\n');
		write("src/mocked.test.ts", "vi.mock('./hub', () => ({}));\n");
		write("src/multiline.test.ts", 'import {\n\thub,\n} from "./hub";\n');
		write("out/built.test.ts", 'import { hub } from "../src/hub";\n');
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-q", "-m", "chore: base");
		write("src/new.test.ts", 'import "./hub";\n');

		expect(reach(["src/hub.ts"], sourceImports(dir)).direct).toEqual([
			"src/lazy.test.ts",
			"src/mocked.test.ts",
			"src/multiline.test.ts",
			"src/new.test.ts",
			"src/static.test.ts",
		]);
	});
});
