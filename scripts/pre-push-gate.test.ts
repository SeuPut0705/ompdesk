import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "../src/main/local/git/test-repos";
import { isGated, parsePushRefs, planGate, rangeBase, syncTree, withMutex, worktreeHolds } from "./pre-push-gate";

const SHA_A = "a".repeat(40);
const ZERO = "0".repeat(40);

describe("parsePushRefs", () => {
	it("reads git's four-field lines and skips deletions and tags", () => {
		const refs = parsePushRefs(
			`refs/heads/main ${SHA_A} refs/heads/main ${ZERO}\n(delete) ${ZERO} refs/heads/old ${SHA_A}\nrefs/tags/v1 ${SHA_A} refs/tags/v1 ${ZERO}\n`,
		);
		expect(refs.map(ref => ref.localRef)).toEqual(["refs/heads/main", "(delete)", "refs/tags/v1"]);
		expect(refs.filter(isGated).map(ref => ref.localRef)).toEqual(["refs/heads/main"]);
	});
});

describe("planGate", () => {
	it("runs nothing but the fix-commit rule for docs, native Rust and workflows", () => {
		const plan = planGate([
			"README.md",
			"docs/a.md",
			"native/ompdesk/crates/core/src/lib.rs",
			".github/workflows/ci.yml",
		]);
		expect(plan).toEqual({ biome: [], surfaces: false, types: false, budget: false });
	});

	it("runs every static check for a renderer source and the budget for it", () => {
		expect(planGate(["src/renderer/components/Row.tsx", "docs/a.md"])).toEqual({
			biome: ["src/renderer/components/Row.tsx"],
			surfaces: true,
			types: true,
			budget: true,
		});
	});

	it("skips the typecheck for a script that is not TypeScript and the budget for main-process code", () => {
		expect(planGate(["scripts/lint-x.mjs"])).toEqual({
			biome: ["scripts/lint-x.mjs"],
			surfaces: true,
			types: false,
			budget: false,
		});
		expect(planGate(["src/main/a.ts"]).budget).toBe(false);
		expect(planGate(["src/shared/a.ts"]).budget).toBe(true);
	});

	it("types a root configuration change and leaves a stylesheet to the surface policy", () => {
		expect(planGate(["tsconfig.json"]).types).toBe(true);
		expect(planGate(["src/renderer/styles/global.css"])).toMatchObject({
			types: false,
			surfaces: true,
			budget: true,
		});
	});
});

describe("the gate's copy of a pushed commit", () => {
	let repo = "";
	let tree = "";
	const commit = (message: string) => {
		gitSync(repo, "add", "-A");
		gitSync(repo, "commit", "-q", "-m", message);
		return gitSync(repo, "rev-parse", "HEAD");
	};
	const write = (file: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		fs.writeFileSync(path.join(repo, file), text);
	};
	beforeEach(async () => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-repo-"));
		tree = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-tree-"));
		await initRepo(repo);
	});
	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(tree, { recursive: true, force: true });
	});

	it("holds the folders the checks read, the top-level files and native's JSON, never native code or docs", () => {
		write("src/a.ts", "export const a = 1;\n");
		write("native/x.rs", "fn main() {}\n");
		write("native/crates/core/table.json", "{}\n");
		write("docs/d.md", "d\n");
		write("package.json", "{}\n");
		const sha = commit("first");
		syncTree(repo, tree, sha);
		expect(fs.readFileSync(path.join(tree, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
		expect(fs.existsSync(path.join(tree, "package.json"))).toBe(true);
		expect(fs.existsSync(path.join(tree, "native/crates/core/table.json"))).toBe(true);
		expect(fs.existsSync(path.join(tree, "native/x.rs"))).toBe(false);
		expect(fs.existsSync(path.join(tree, "docs"))).toBe(false);
		write("native/crates/core/table.json", '{"a":1}\n');
		syncTree(repo, tree, commit("second"));
		expect(fs.readFileSync(path.join(tree, "native/crates/core/table.json"), "utf8")).toBe('{"a":1}\n');
	});

	it("runs in place only while the working tree holds the pushed commit's files", () => {
		write("src/a.ts", "a\n");
		const sha = commit("first");
		expect(worktreeHolds(repo, sha)).toBe(true);
		write("docs/notes.md", "someone's notes\n");
		expect(worktreeHolds(repo, sha)).toBe(true);
		write("src/a.ts", "a, edited\n");
		expect(worktreeHolds(repo, sha)).toBe(false);
		fs.writeFileSync(path.join(repo, "src/a.ts"), "a\n");
		write("src/untracked.ts", "x\n");
		expect(worktreeHolds(repo, sha)).toBe(false);
	});

	it("moves to the next commit by its differences and keeps the cache and the module link", () => {
		write("src/a.ts", "a1\n");
		write("src/gone.ts", "gone\n");
		const first = commit("first");
		syncTree(repo, tree, first);
		fs.writeFileSync(path.join(tree, ".gate.tsbuildinfo"), "cache");
		fs.symlinkSync(repo, path.join(tree, "node_modules"), "junction");
		write("src/a.ts", "a2\n");
		write("src/new.ts", "new\n");
		fs.rmSync(path.join(repo, "src/gone.ts"));
		const second = commit("second");
		syncTree(repo, tree, second);
		expect(fs.readFileSync(path.join(tree, "src/a.ts"), "utf8")).toBe("a2\n");
		expect(fs.existsSync(path.join(tree, "src/new.ts"))).toBe(true);
		expect(fs.existsSync(path.join(tree, "src/gone.ts"))).toBe(false);
		expect(fs.readFileSync(path.join(tree, ".gate.tsbuildinfo"), "utf8")).toBe("cache");
		expect(fs.lstatSync(path.join(tree, "node_modules")).isSymbolicLink()).toBe(true);
	});

	it("rebuilds from scratch when the commit it held is unknown", () => {
		write("src/a.ts", "a\n");
		const sha = commit("first");
		fs.mkdirSync(path.join(tree, "src"), { recursive: true });
		fs.writeFileSync(path.join(tree, "src/stale.ts"), "stale\n");
		fs.writeFileSync(path.join(tree, ".gate-sha"), `${SHA_A}\n`);
		syncTree(repo, tree, sha);
		expect(fs.existsSync(path.join(tree, "src/stale.ts"))).toBe(false);
		expect(fs.existsSync(path.join(tree, "src/a.ts"))).toBe(true);
	});

	it("measures a pushed range from the remote's tip when it is known, else from origin/main", () => {
		const base = gitSync(repo, "rev-parse", "HEAD");
		write("src/a.ts", "a\n");
		const head = commit("next");
		const ref = { localRef: "refs/heads/x", localSha: head, remoteRef: "refs/heads/x", remoteSha: base };
		expect(rangeBase(repo, ref)).toBe(base);
		gitSync(repo, "update-ref", "refs/remotes/origin/main", base);
		expect(rangeBase(repo, { ...ref, remoteSha: ZERO })).toBe(base);
		expect(rangeBase(repo, { ...ref, remoteSha: SHA_A })).toBe(base);
	});
});

describe("withMutex", () => {
	it("takes over a lock whose holder is gone and frees it afterwards", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-lock-"));
		const lock = path.join(dir, "lock");
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, "pid"), "2147483646");
		let waited = false;
		const result = await withMutex(
			lock,
			async () => fs.existsSync(lock),
			() => {
				waited = true;
			},
		);
		expect(result).toBe(true);
		expect(waited).toBe(false);
		expect(fs.existsSync(lock)).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
