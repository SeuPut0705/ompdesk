/**
 * The drift audit's findings (covers, drift, verify-all, report, graph), each pinned by a case named after it.
 * Git cases use throwaway repositories with the user's git configuration switched off; the cases that run a real
 * model need the TLC toolchain and run with `OMP_GUI_REAL_FORMAL=1` (cache: `OMPDESK_FORMAL_CACHE`).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	findSymbolSpans,
	parseCover,
	rangeChanges,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/covers";
import {
	checkDrift,
	hasUncommitted,
	stampDigest,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/drift";
import {
	parseGraph,
	renderGraphSvg,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/graph-svg";
import { parseManifest } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/manifest";
import { renderReport } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/report-render";
import {
	type ModelResult,
	matrixForTier,
	stampModels,
	summarize,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/verify-all";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";
const CACHE = process.env.OMPDESK_FORMAL_CACHE ?? path.join(os.tmpdir(), "formal-cache");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-audit-drift-"));

const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => {
	// An empty file, not os.devNull: git on Windows cannot open `\\.\nul` as a config file.
	const emptyConfig = path.join(temp, "empty.gitconfig");
	fs.writeFileSync(emptyConfig, "");
	process.env.GIT_CONFIG_GLOBAL = emptyConfig;
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
	if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
	if (savedEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
	else process.env.GIT_CONFIG_NOSYSTEM = savedEnv.system;
	fs.rmSync(temp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const run = spawnSync(
		"git",
		[
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"protocol.file.allow=always",
			...args,
		],
		{ cwd, encoding: "utf8", env: process.env },
	);
	if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
	return run.stdout.trim();
}

let counter = 0;
function repoWith(files: Record<string, string>, subfolder = ""): { root: string; code: string; head: string } {
	const root = path.join(temp, `repo-${counter++}`);
	fs.mkdirSync(root, { recursive: true });
	git(root, "init", "-q");
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		fs.writeFileSync(path.join(root, name), text);
	}
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "first");
	return { root, code: path.join(root, subfolder), head: git(root, "rev-parse", "HEAD") };
}

function write(root: string, name: string, text: string): void {
	fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
	fs.writeFileSync(path.join(root, name), text);
}

const lines = (count: number, edit: Record<number, string> = {}): string =>
	`${Array.from({ length: count }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n")}\n`;

describe("finding 1: a type literal in a signature does not end the declaration", () => {
	const AFTER = "\nexport const after = 1;\n";
	const FORMS: Record<string, { source: string; symbol: string; end: number }> = {
		"return type literal": {
			source: "export function a(x: number): { ok: boolean } {\n  return { ok: x > 0 };\n}\n",
			symbol: "a",
			end: 3,
		},
		"Promise of a literal": {
			source: "export async function b(): Promise<{ id: string }> {\n  return { id: 'x' };\n}\n",
			symbol: "b",
			end: 3,
		},
		"generic constraint": {
			source: "export function c<T extends { id: string }>(item: T) {\n  return item.id;\n}\n",
			symbol: "c",
			end: 3,
		},
		"arrow function": {
			source: "export const d = (): { a: number } => {\n  return { a: 1 };\n};\n",
			symbol: "d",
			end: 3,
		},
		"multi-line literal": {
			source: "export function e(): {\n  ok: boolean;\n} {\n  return { ok: true };\n}\n",
			symbol: "e",
			end: 5,
		},
		"class method": {
			source: "class K {\n  get(): { ok: boolean } {\n    return { ok: true };\n  }\n}\n",
			symbol: "K.get",
			end: 4,
		},
		"annotated initializer": {
			source: "const f: { a: number } = {\n  a: 1,\n};\n",
			symbol: "f",
			end: 3,
		},
	};

	for (const [name, form] of Object.entries(FORMS)) {
		it(`${name}: the span runs to the end of the body`, () => {
			const spans = findSymbolSpans(form.source + AFTER, form.symbol);
			expect(spans).toEqual([{ start: form.symbol.includes(".") ? 2 : 1, end: form.end }]);
		});
	}

	it("keeps ordinary bodies and object literals as they were", () => {
		expect(findSymbolSpans("const o = { a: 1 };\nconst z = 2;\n", "o")).toEqual([{ start: 1, end: 1 }]);
		expect(findSymbolSpans("function f() {\n  return { a: 1 };\n}\nfunction g() {}\n", "f")).toEqual([
			{ start: 1, end: 3 },
		]);
		expect(findSymbolSpans("type T = { a: number };\ntype U = 1;\n", "T")).toEqual([{ start: 1, end: 1 }]);
	});

	it("a body edit inside such a function is drift", async () => {
		const source = "export function a(x: number): { ok: boolean } {\n  return { ok: x > 0 };\n}\n";
		const { code, head } = repoWith({ "src/a.ts": source });
		expect((await checkDrift(code, ["src/a.ts#a"], head)).status).toBe("ok");
		write(code, "src/a.ts", source.replace("x > 0", "x > 1"));
		expect(await checkDrift(code, ["src/a.ts#a"], head)).toMatchObject({ status: "drift", files: ["src/a.ts#a"] });
	});
});

describe("finding 2: a code root below the repository root", () => {
	const FN = "export function sync() {\n  return 1;\n}\nexport const other = 1;\n";

	it("symbol, range and file covers compare against the right files", async () => {
		const { code, head, root } = repoWith({ "pkg/src/a.ts": FN, "pkg/src/b.ts": "export const b = 1;\n" }, "pkg");
		const covers = ["src/a.ts#sync", "src/a.ts:1-3", "src/b.ts"];
		expect(await checkDrift(code, covers, head)).toMatchObject({ status: "ok", files: [] });
		expect(await hasUncommitted(code, covers)).toBe(false);
		write(root, "pkg/src/a.ts", FN.replace("return 1", "return 2"));
		write(root, "pkg/src/b.ts", "export const b = 2;\n");
		const drift = await checkDrift(code, covers, head);
		expect(drift.status).toBe("drift");
		expect(drift.files).toEqual(["src/a.ts#sync", "src/a.ts:1-3", "src/b.ts"]);
		expect(await hasUncommitted(code, covers)).toBe(true);
	});

	it("--stamp is not refused for committed covered code", async () => {
		const { code, root, head } = repoWith({ "pkg/src/a.ts": FN }, "pkg");
		write(root, "pkg/src/other.ts", "export const x = 1;\n");
		const manifest = path.join(code, "manifest.json");
		const entry = { id: "m", kind: "tla", dir: "m", spec: "M.tla", covers: ["src/a.ts#sync"], syncCommit: null };
		fs.writeFileSync(manifest, JSON.stringify({ version: 1, models: [entry] }));
		const models = parseManifest(JSON.parse(fs.readFileSync(manifest, "utf8"))).models;
		const results: ModelResult[] = [{ id: "m", checks: [{ name: "TLC matrix", verdict: "pass" }] }];
		await stampModels(code, manifest, models, results, false);
		expect(JSON.parse(fs.readFileSync(manifest, "utf8")).models[0].syncCommit).toBe(head);
	});
});

describe("finding 3: a configured external diff tool does not hide changes", () => {
	it("a range cover still sees an edit, and so does a file cover", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(20), "src/b.ts": "b\n" });
		git(root, "config", "diff.external", "true");
		write(root, "src/a.ts", lines(20, { 10: "edited" }));
		write(root, "src/b.ts", "b2\n");
		expect(await checkDrift(code, ["src/a.ts:9-11"], head)).toMatchObject({
			status: "drift",
			files: ["src/a.ts:9-11"],
		});
		expect(await checkDrift(code, ["src/b.ts"], head)).toMatchObject({ status: "drift", files: ["src/b.ts"] });
	});

	it("colored diff output is not a problem either", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(20) });
		git(root, "config", "color.ui", "always");
		git(root, "config", "color.diff", "always");
		write(root, "src/a.ts", lines(20, { 10: "edited" }));
		expect((await checkDrift(code, ["src/a.ts:10-10"], head)).files).toEqual(["src/a.ts:10-10"]);
	});
});

describe("finding 4: a range on a file the sync commit did not have", () => {
	it("is drift, 'new since the sync commit', and a stamp of HEAD is refused", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": "a\n" });
		write(root, "src/new.ts", lines(10));
		const drift = await checkDrift(code, ["src/new.ts:2-4"], head);
		expect(drift.status).toBe("drift");
		expect(drift.files[0]).toContain("new since the sync commit");
		expect(await hasUncommitted(code, ["src/new.ts:2-4"])).toBe(true);
	});
});

describe("finding 5: a cover that points at nothing is an error", () => {
	it("a path that exists neither now nor at the sync commit", async () => {
		const { code, head } = repoWith({ "src/a.ts": "a\n" });
		const result = await checkDrift(code, ["src/typo.ts"], head);
		expect(result.status).toBe("git-error");
		expect(result.message).toContain("src/typo.ts");
		expect((await checkDrift(code, ["src/typo.ts:1-2"], head)).status).toBe("git-error");
		expect((await checkDrift(code, ["src/typo.ts#f"], head)).status).toBe("git-error");
	});

	it("a range past the end of the file", async () => {
		const { code, head } = repoWith({ "src/a.ts": lines(10) });
		expect((await checkDrift(code, ["src/a.ts:8-10"], head)).status).toBe("ok");
		const result = await checkDrift(code, ["src/a.ts:8-12"], head);
		expect(result.status).toBe("git-error");
		expect(result.message).toMatch(/past the end|10 lines/);
	});

	it("--stamp refuses it, with --allow-dirty too", async () => {
		const { code, head } = repoWith({ "src/a.ts": lines(10) });
		const manifest = path.join(code, "manifest.json");
		const entry = { id: "m", kind: "tla", dir: "m", spec: "M.tla", covers: ["src/typo.ts"], syncCommit: null };
		fs.writeFileSync(manifest, JSON.stringify({ version: 1, models: [entry] }));
		const models = parseManifest(JSON.parse(fs.readFileSync(manifest, "utf8"))).models;
		const results: ModelResult[] = [{ id: "m", checks: [{ name: "TLC matrix", verdict: "pass" }] }];
		for (const allowDirty of [false, true]) {
			await stampModels(code, manifest, models, results, allowDirty);
			expect(JSON.parse(fs.readFileSync(manifest, "utf8")).models[0].syncCommit).toBeNull();
		}
		expect(head).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("finding 6: a sync commit that is not in this clone", () => {
	it("a shallow clone says to fetch with depth 0", async () => {
		const { root } = repoWith({ "src/a.ts": "a\n" });
		const first = git(root, "rev-parse", "HEAD");
		write(root, "src/a.ts", "b\n");
		git(root, "commit", "-q", "-am", "second");
		write(root, "src/a.ts", "c\n");
		git(root, "commit", "-q", "-am", "third");
		const clone = path.join(temp, `shallow-${counter++}`);
		git(temp, "clone", "-q", "--depth", "1", `file://${root}`, clone);
		const result = await checkDrift(clone, ["src/a.ts"], first);
		expect(result.status).toBe("bad-commit");
		expect(result.message).toContain("shallow clone: fetch with depth 0");
		expect(result.message).not.toContain("not a commit of this repository");
	});

	it("a full clone still says the commit is not part of this repository", async () => {
		const { code } = repoWith({ "src/a.ts": "a\n" });
		const result = await checkDrift(code, ["src/a.ts"], "0123456789abcdef0123456789abcdef01234567");
		expect(result.status).toBe("bad-commit");
		expect(result.message).toContain("not a commit of this repository");
	});

	it.skipIf(!REAL)(
		"verify-all --stamp restamps over a bad commit with a NOTE; without --stamp it fails",
		() => {
			const dir = realRepo({ syncCommit: "0123456789abcdef0123456789abcdef01234567" });
			const plain = verifyAll([dir.formal, "--skip-mutations"]);
			expect(plain.code).toBe(1);
			expect(plain.out).toContain("not a commit of this repository");
			const stamped = verifyAll([dir.formal, "--skip-mutations", "--stamp"]);
			expect(stamped.out).toContain("NOTE");
			expect(stamped.code).toBe(0);
			expect(JSON.parse(fs.readFileSync(path.join(dir.formal, "manifest.json"), "utf8")).models[0].syncCommit).toBe(
				dir.head,
			);
		},
		180_000,
	);
});

describe("finding 7: the dirty-stamp digest does not depend on git's output settings", () => {
	it("is the same under mnemonicPrefix, noprefix, abbrev and color", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(10), "src/b.ts": "b\n" });
		write(root, "src/a.ts", lines(10, { 5: "edited" }));
		const covers = ["src/a.ts", "src/b.ts"];
		const digest = await stampDigest(code, covers, head);
		expect((await checkDrift(code, covers, head, digest)).status).toBe("ok");
		for (const [key, value] of [
			["diff.mnemonicPrefix", "true"],
			["diff.noprefix", "true"],
			["core.abbrev", "12"],
			["color.diff", "always"],
			["diff.context", "9"],
		] as const) {
			git(root, "config", key, value);
			expect(await stampDigest(code, covers, head), key).toBe(digest);
			expect((await checkDrift(code, covers, head, digest)).status, key).toBe("ok");
			git(root, "config", "--unset", key);
		}
	});

	it("drift once the covered file's content changes, and a deleted file is part of the digest", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(10), "src/b.ts": "b\n" });
		write(root, "src/a.ts", lines(10, { 5: "edited" }));
		const digest = await stampDigest(code, ["src/a.ts", "src/b.ts"], head);
		write(root, "src/a.ts", lines(10, { 5: "edited again" }));
		expect((await checkDrift(code, ["src/a.ts", "src/b.ts"], head, digest)).status).toBe("drift");
		write(root, "src/a.ts", lines(10, { 5: "edited" }));
		fs.rmSync(path.join(root, "src/b.ts"));
		const withDeleted = await stampDigest(code, ["src/a.ts", "src/b.ts"], head);
		expect(withDeleted).not.toBe(digest);
		expect((await checkDrift(code, ["src/a.ts", "src/b.ts"], head, withDeleted)).status).toBe("ok");
	});

	it("an old-format stamp that no longer matches says to re-stamp", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(10) });
		write(root, "src/a.ts", lines(10, { 5: "edited" }));
		const old = "a".repeat(64);
		const result = await checkDrift(code, ["src/a.ts"], head, old);
		expect(result.status).toBe("drift");
		expect(result.message).toMatch(/re-?stamp/);
	});
});

describe("finding 9: an edit inside a range is never reported only as 'lines moved'", () => {
	it("an edit on the last covered line while lines were inserted above", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(30) });
		write(root, "src/a.ts", lines(30, { 1: "line 1\ninserted above", 20: "line 20 edited" }));
		const drift = await checkDrift(code, ["src/a.ts:10-20"], head);
		expect(drift.files).toEqual(["src/a.ts:10-20"]);
	});

	it("a deleted first line of the range", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(30) });
		write(root, "src/a.ts", lines(30, { 10: "" }).replace("\n\nline 11", "\nline 11"));
		const drift = await checkDrift(code, ["src/a.ts:10-20"], head);
		expect(drift.files).toEqual(["src/a.ts:10-20"]);
	});

	it("a deleted file says '(file deleted)'", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(30) });
		fs.rmSync(path.join(root, "src/a.ts"));
		const drift = await checkDrift(code, ["src/a.ts:10-20", "src/a.ts#f"], head);
		expect(drift.status === "drift" || drift.status === "git-error").toBe(true);
		const ranged = await checkDrift(code, ["src/a.ts:10-20"], head);
		expect(ranged.status).toBe("drift");
		expect(ranged.files[0]).toContain("(file deleted)");
	});

	it("lines only moved above the range stay 'lines moved'", async () => {
		const { code, head, root } = repoWith({ "src/a.ts": lines(30) });
		write(root, "src/a.ts", lines(30, { 1: "line 1\ninserted above" }));
		const drift = await checkDrift(code, ["src/a.ts:10-20"], head);
		expect(drift.files[0]).toContain("lines moved by +1");
	});

	it("judges hunks in the old file's numbering", () => {
		const hunks = [
			{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 },
			{ oldStart: 20, oldCount: 1, newStart: 21, newCount: 1 },
		];
		expect(rangeChanges(hunks, 10, 20)).toEqual({ touched: true, shifted: 1 });
		expect(rangeChanges([{ oldStart: 10, oldCount: 1, newStart: 10, newCount: 0 }], 10, 20).touched).toBe(true);
		expect(rangeChanges([{ oldStart: 9, oldCount: 0, newStart: 10, newCount: 2 }], 10, 20)).toEqual({
			touched: false,
			shifted: 2,
		});
		expect(rangeChanges([{ oldStart: 12, oldCount: 0, newStart: 13, newCount: 2 }], 10, 20).touched).toBe(true);
	});
});

describe("finding 12: a cover inside a git submodule", () => {
	it("is an error that says to use the submodule as the code root", async () => {
		const lib = repoWith({ "src/a.ts": "export const a = 1;\n" });
		const main = repoWith({ "readme.md": "x\n" });
		git(main.root, "submodule", "add", "-q", lib.root, "vendor/lib");
		git(main.root, "commit", "-q", "-m", "add submodule");
		const head = git(main.root, "rev-parse", "HEAD");
		const result = await checkDrift(main.root, ["vendor/lib/src/a.ts"], head);
		expect(result.status).toBe("git-error");
		expect(result.message).toContain("submodule");
		expect(result.message).toContain("codeRoot");
		expect((await checkDrift(main.root, ["vendor/lib/src/a.ts#a"], head)).status).toBe("git-error");
		// The submodule as the code root works.
		expect((await checkDrift(path.join(main.root, "vendor/lib"), ["src/a.ts#a"], lib.head)).status).toBe("ok");
	});
});

describe("finding 13: backslashes in a cover", () => {
	it("parseCover turns them into slashes", () => {
		expect(parseCover("src\\a.ts#f")).toMatchObject({ kind: "symbol", path: "src/a.ts", symbol: "f" });
		expect(parseCover("src\\a.ts:3-5")).toMatchObject({ kind: "range", path: "src/a.ts", start: 3, end: 5 });
		expect(parseCover("src\\dir\\")).toMatchObject({ kind: "path", path: "src/dir" });
	});

	it("a backslash cover is compared against the sync commit like a slash cover", async () => {
		const source = "export function f() {\n  return 1;\n}\n";
		const { code, head, root } = repoWith({ "src/a.ts": source });
		expect(await checkDrift(code, ["src\\a.ts#f", "src\\a.ts:1-3"], head)).toMatchObject({ status: "ok" });
		write(root, "src/a.ts", source.replace("1", "2"));
		expect((await checkDrift(code, ["src\\a.ts#f"], head)).status).toBe("drift");
	});
});

describe("finding 10: the summary counts only passes as ok", () => {
	const check = (name: string, verdict: ModelResult["checks"][number]["verdict"]): ModelResult["checks"][number] => ({
		name,
		verdict,
	});

	it("labels a drift DRIFT and counts it apart", () => {
		const lines = summarize([
			{
				id: "x",
				checks: [check("a", "pass"), check("b", "pass"), check("drift", "drift"), check("mutations", "skipped")],
			},
		]);
		expect(lines).toEqual(["DRIFT  x: 2 of 4 ok, 1 drift, 1 skipped"]);
	});

	it("keeps PASS, FAIL and NOT CHECKED", () => {
		expect(summarize([{ id: "x", checks: [check("a", "pass"), check("b", "pass")] }])).toEqual([
			"PASS  x: 2 of 2 ok",
		]);
		expect(summarize([{ id: "x", checks: [check("a", "pass"), check("b", "fail")] }])[0]).toMatch(
			/^FAIL {2}x: 1 of 2 ok.*\(b\)/,
		);
		expect(summarize([{ id: "x", checks: [check("a", "unavailable"), check("b", "drift")] }])[0]).toMatch(
			/^NOT CHECKED {2}x: 0 of 2 ok.*1 drift.*\(a\)/,
		);
	});
});

describe("finding 8: a report where nothing was checked is not green", () => {
	const base = {
		concern: "c",
		summary: "s",
		workflow: "bug-hunt",
		generated_at: "2026-10-28",
		findings: [],
		scope: {},
	};
	const property = (name: string, result: string): Record<string, string> => ({
		name,
		kind: "invariant",
		result,
		tool: "TLC",
	});

	it("all timeouts: warn verdict, 'not checked' pill, no 'No finding' claim, no good pill", () => {
		const html = renderReport({
			...base,
			properties: [property("A", "timeout"), property("B", "not-run"), property("C", "sorry")],
		});
		expect(html).toContain("3 of 3 properties not checked");
		expect(html).not.toContain("0 of 3 properties hold");
		expect(html).toContain('class="verdict warn"');
		expect(html).not.toMatch(/No finding: no counterexample/);
		expect(html).not.toMatch(/pill good">\d+ of \d+ properties/);
	});

	it("all holds stays green", () => {
		const html = renderReport({ ...base, properties: [property("A", "holds"), property("B", "proven")] });
		expect(html).toContain("2 of 2 properties hold");
		expect(html).toContain('class="verdict"');
		expect(html).toContain("No finding: no counterexample");
	});

	it("a violated property stays red, a partly checked report is warn", () => {
		expect(renderReport({ ...base, properties: [property("A", "holds"), property("B", "violated")] })).toContain(
			'class="verdict bad"',
		);
		const mixed = renderReport({ ...base, properties: [property("A", "holds"), property("B", "timeout")] });
		expect(mixed).toContain('class="verdict warn"');
		expect(mixed).toContain("1 of 2 properties not checked");
	});
});

describe("finding 11: graph edge labels do not run into badges or nodes", () => {
	const example = JSON.parse(fs.readFileSync(path.join(SKILL, "assets/templates/findings.example.json"), "utf8"));
	type Box = { x0: number; y0: number; x1: number; y1: number };
	const overlap = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

	function boxes(svg: string): { labels: Box[]; badges: Box[]; nodes: Box[] } {
		const labels = [
			...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" font-size="11" text-anchor="(\w+)"[^>]*>([^<]*)<\/text>/g),
		]
			.filter(match => !/^\d+$/.test(match[4] as string))
			.map(match => {
				const width = (match[4] as string).length * 6.1;
				const x = Number(match[1]);
				const anchor = match[3];
				const x0 = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
				return { x0, y0: Number(match[2]) - 9, x1: x0 + width, y1: Number(match[2]) + 3 };
			});
		const badges = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="10"/g)].map(match => ({
			x0: Number(match[1]) - 10,
			y0: Number(match[2]) - 10,
			x1: Number(match[1]) + 10,
			y1: Number(match[2]) + 10,
		}));
		const nodes = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(
			match => ({
				x0: Number(match[1]),
				y0: Number(match[2]),
				x1: Number(match[1]) + Number(match[3]),
				y1: Number(match[2]) + Number(match[4]),
			}),
		);
		return { labels, badges, nodes };
	}

	it("the job-lease example diagram", () => {
		const graph = parseGraph(example.findings[0].diagram);
		expect(graph).not.toBeNull();
		const svg = renderGraphSvg(graph as NonNullable<typeof graph>, "caption", "fv-f1");
		const found = boxes(svg);
		expect(found.labels).toHaveLength(2);
		expect(found.badges).toHaveLength(3);
		for (const label of found.labels) {
			for (const badge of found.badges) expect(overlap(label, badge), "label over a badge").toBe(false);
			for (const node of found.nodes) expect(overlap(label, node), "label over a node").toBe(false);
		}
		expect(svg).toContain('paint-order="stroke"');
	});

	it("a long label widens the gap instead of crossing the nodes", () => {
		const graph = parseGraph({
			nodes: ["a", "b"],
			edges: [["a", "b", "a very long edge label that needs room"]],
			steps: { a: 1, b: 2 },
		});
		const found = boxes(renderGraphSvg(graph as NonNullable<typeof graph>));
		for (const label of found.labels) {
			for (const badge of found.badges) expect(overlap(label, badge)).toBe(false);
			for (const node of found.nodes) expect(overlap(label, node)).toBe(false);
		}
	});
});

describe("finding 14: a matrix run can be deep", () => {
	it("--tier fast drops the deep runs from the matrix file TLC reads", () => {
		const dir = fs.mkdtempSync(path.join(temp, "matrix-"));
		const file = path.join(dir, "matrix.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				runs: [
					{ name: "quick", config: "MC.cfg" },
					{ name: "deep-all", config: "MC_deep.cfg", tier: "deep" },
				],
			}),
		);
		const fast = matrixForTier(file, "fast");
		const filtered = fast.file ?? "";
		expect(fast.skipped).toEqual(["deep-all"]);
		expect(filtered).not.toBe(file);
		expect(JSON.parse(fs.readFileSync(filtered, "utf8")).runs.map((run: { name: string }) => run.name)).toEqual([
			"quick",
		]);
		fast.cleanup();
		expect(fs.existsSync(filtered)).toBe(false);
		const deep = matrixForTier(file, "deep");
		expect(deep).toMatchObject({ file, skipped: [] });
		deep.cleanup();
		expect(fs.existsSync(file)).toBe(true);
	});

	it("a run's tier must be fast or deep, and a matrix of only deep runs is skipped whole", () => {
		const dir = fs.mkdtempSync(path.join(temp, "matrix-"));
		const file = path.join(dir, "matrix.json");
		fs.writeFileSync(file, JSON.stringify({ runs: [{ name: "x", tier: "slow" }] }));
		expect(() => matrixForTier(file, "fast")).toThrow(/tier/);
		fs.writeFileSync(file, JSON.stringify({ runs: [{ name: "x", tier: "deep" }] }));
		expect(matrixForTier(file, "fast")).toMatchObject({ file: null, skipped: ["x"] });
	});

	it.skipIf(!REAL)(
		"verify-all --tier fast skips the run, --tier deep runs it",
		() => {
			const dir = realRepo({});
			const matrix = path.join(dir.formal, "job-lease/tla/matrix.json");
			const parsed = JSON.parse(fs.readFileSync(matrix, "utf8"));
			parsed.runs.push({ name: "deep-extra-run", config: "MC.cfg", expect: "pass", tier: "deep" });
			fs.writeFileSync(matrix, JSON.stringify(parsed));
			const fast = verifyAll([dir.formal, "--skip-mutations", "--tier", "fast"]);
			expect(fast.code).toBe(0);
			expect(fast.out).not.toContain("deep-extra-run");
			expect(fast.out).toMatch(/1 deep run.*skipped/);
			const deep = verifyAll([dir.formal, "--skip-mutations", "--tier", "deep"]);
			expect(deep.code).toBe(0);
			expect(deep.out).toContain("deep-extra-run");
		},
		300_000,
	);

	it.skipIf(!REAL)(
		"the summary after a drift line does not say 'ok' for it",
		() => {
			const dir = realRepo({ syncCommit: "HEAD~0" });
			write(
				dir.root,
				"src/worker.ts",
				`${fs.readFileSync(path.join(dir.root, "src/worker.ts"), "utf8")}\n// edit\n`,
			);
			const run = verifyAll([dir.formal, "--skip-mutations"]);
			expect(run.code).toBe(0);
			expect(run.out).toMatch(/^DRIFT {2}job-lease: \d+ of \d+ ok, 1 drift/m);
		},
		180_000,
	);
});

describe("report.ts exits 2, not with a stack, when the schema cannot be read", () => {
	it("a skill folder without assets/findings.schema.json", () => {
		const copy = path.join(temp, "skill-copy");
		fs.mkdirSync(path.join(copy, "assets"), { recursive: true });
		fs.cpSync(path.join(SKILL, "scripts"), path.join(copy, "scripts"), { recursive: true });
		const findings = path.join(temp, "findings.json");
		fs.writeFileSync(findings, fs.readFileSync(path.join(SKILL, "assets/templates/findings.example.json")));
		const run = spawnSync(
			"bun",
			[path.join(copy, "scripts/report.ts"), findings, "--out-dir", path.join(temp, "out")],
			{
				encoding: "utf8",
			},
		);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain("findings.schema.json");
		expect(run.stderr).not.toMatch(/\n\s+at /);
	});
});

interface RealRepo {
	root: string;
	formal: string;
	head: string;
}

/** A git repository holding a copy of the job-lease example, its manifest with `extra` merged into the model. */
function realRepo(extra: Record<string, unknown>): RealRepo {
	const root = path.join(temp, `real-${counter++}`);
	fs.cpSync(path.join(SKILL, "examples/job-lease"), root, { recursive: true });
	git(root, "init", "-q");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "first");
	const head = git(root, "rev-parse", "HEAD");
	const manifest = path.join(root, "formal/manifest.json");
	const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
	const entry = { ...parsed.models[0], ...extra };
	if (entry.syncCommit === "HEAD~0") entry.syncCommit = head;
	parsed.models[0] = entry;
	fs.writeFileSync(manifest, JSON.stringify(parsed));
	return { root, formal: path.join(root, "formal"), head };
}

function verifyAll(args: string[]): { code: number | null; out: string } {
	const run = spawnSync("bun", [path.join(SKILL, "scripts/verify-all.ts"), ...args], {
		encoding: "utf8",
		env: { ...process.env, OMPDESK_FORMAL_CACHE: CACHE },
	});
	return { code: run.status, out: run.stdout + run.stderr };
}
