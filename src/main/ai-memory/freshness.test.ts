import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AiMemoryPage, AiMemoryPageRef } from "../../shared/ai-memory";
import { checkFreshness, type FreshnessClient, type FreshnessLogDetails, namedItems } from "./freshness";

const PROJECT = { workspace: "default", project: "demo" };
let root: string;
let main: string;
let worktree: string;

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

function put(path: string, text: string): void {
	mkdirSync(dirname(join(main, path)), { recursive: true });
	writeFileSync(join(main, path), text);
}

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "fresh-")));
	main = join(root, "main");
	worktree = join(root, "wt");
	mkdirSync(main);
	git(main, "init", "-q", "-b", "main");
	put("src/main/old-feature.ts", "export function legacyWidgetBuild() {}\n");
	put("src/main/old-twin.ts", "export const legacyTwinValue = 1;\n");
	put("src/main/keep.ts", "export function keepAlive() {}\n");
	put("src/main/moved-old.ts", "export const movedThing = 1;\n".repeat(5));
	put("scripts/gone.sh", "echo gone\n");
	git(main, "add", "-A");
	git(main, "commit", "-qm", "one");
	git(main, "rm", "-q", "src/main/old-feature.ts", "src/main/old-twin.ts", "scripts/gone.sh");
	mkdirSync(join(main, "src/lib"));
	git(main, "mv", "src/main/moved-old.ts", "src/lib/moved-new.ts");
	git(main, "commit", "-qm", "two");
	git(main, "worktree", "add", "-q", worktree, "-b", "feature");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Fake extends FreshnessClient {
	retired: { path: string; reason: string; expectedPageId?: string }[];
	flaggedPaths: string[];
}

function fake(pages: Record<string, { kind: string; markdown: string; pinned?: boolean }>, cwds = [worktree]): Fake {
	const client: Fake = {
		retired: [],
		flaggedPaths: [],
		async pages(): Promise<AiMemoryPageRef[]> {
			return Object.entries(pages).map(([path, page]) => ({
				...PROJECT,
				path,
				title: path,
				updatedAt: null,
				kind: page.kind,
			}));
		},
		async page(ref): Promise<AiMemoryPage> {
			const page = pages[ref.path];
			if (!page) throw new Error("no page");
			return {
				...PROJECT,
				path: ref.path,
				title: ref.path,
				updatedAt: null,
				kind: page.kind,
				markdown: page.markdown,
				id: `id-${ref.path}`,
				pinned: page.pinned === true,
				createdAt: null,
				tags: [],
			};
		},
		async sessions() {
			return cwds.map((cwd, index) => ({
				id: `s${index}`,
				cwd,
				agent: "omp",
				startedAt: null,
				endedAt: null,
				observations: 1,
				consolidation: null,
			}));
		},
		async retirePage(ref) {
			client.retired.push({ path: ref.path, reason: ref.reason, expectedPageId: ref.expectedPageId });
			return "retired";
		},
		async feedback(ref) {
			client.flaggedPaths.push(ref.path);
		},
	};
	return client;
}

describe("namedItems", () => {
	it("takes repo paths and code symbols, not URLs, home paths, globs, shell removal or lines about a removal", () => {
		const items = namedItems(
			[
				"Uses `src/main/a.ts` and src/main/b.ts:44 with `someCodeSymbol()`.",
				"See https://github.com/x/y/blob/main/src/main/url.ts and ~/work/src/main/home.ts.",
				"Globs src/main/*.ts and <src/main/tpl.ts>.",
				"We deleted `src/main/said-removed.ts` and `removedSymbolName` last week.",
				"```sh",
				"git rm src/main/in-fence.ts",
				"bun run scripts/run-me.ts",
				"```",
				"Generic words like `error` and `TypeScript` and `snake_case_name` and `a.b`.",
			].join("\n"),
		);
		expect(items.paths.sort()).toEqual(["scripts/run-me.ts", "src/main/a.ts", "src/main/b.ts"]);
		expect(items.symbols.sort()).toEqual(["snake_case_name", "someCodeSymbol"]);
	});
});

describe("checkFreshness", () => {
	let logs: { message: string; details: FreshnessLogDetails }[];
	const run = (client: Fake, extra: { dryRun?: boolean; flagged?: Record<string, string> } = {}) =>
		checkFreshness({
			client,
			project: PROJECT,
			flagged: extra.flagged ?? {},
			dryRun: extra.dryRun,
			now: () => new Date("2026-10-20T00:00:00Z"),
			log: (message, details) => logs.push({ message, details }),
		});
	beforeEach(() => {
		logs = [];
	});

	it("retires a page whose names are all deleted, with the reason, the page version and one log line", async () => {
		const client = fake({
			"decisions/0001.md": {
				kind: "decision",
				markdown: "Build widgets in `src/main/old-feature.ts` through `legacyWidgetBuild()`.",
			},
		});
		const report = await run(client);
		expect(report.checkout).toBe(main);
		expect(client.retired).toEqual([
			{
				path: "decisions/0001.md",
				reason: "names src/main/old-feature.ts, legacyWidgetBuild which no longer exist",
				expectedPageId: "id-decisions/0001.md",
			},
		]);
		expect(report.retired.map(change => change.path)).toEqual(["decisions/0001.md"]);
		expect(logs).toHaveLength(1);
		expect(logs[0]?.message).toBe("care-fresh");
		expect(logs[0]?.details).toMatchObject({ action: "retire", path: "decisions/0001.md" });
	});

	it("flags a page with some names gone once per page version and retires nothing", async () => {
		const client = fake({
			"gotchas/a.md": { kind: "gotcha", markdown: "`src/main/keep.ts` and `src/main/old-twin.ts` too." },
		});
		const flagged: Record<string, string> = {};
		const first = await run(client, { flagged });
		const second = await run(client, { flagged });
		expect(client.flaggedPaths).toEqual(["gotchas/a.md"]);
		expect(client.retired).toEqual([]);
		expect(first.flagged).toHaveLength(1);
		expect(second.flagged).toHaveLength(0);
		expect(logs).toHaveLength(1);
	});

	it("leaves pages that name existing files, nothing, or only traps", async () => {
		const client = fake({
			"decisions/keep.md": { kind: "decision", markdown: "See `src/main/keep.ts`, `keepAlive`." },
			"decisions/none.md": { kind: "decision", markdown: "Prefer small diffs." },
			"gotchas/trap.md": {
				kind: "gotcha",
				markdown: [
					"Docs at https://example.com/blob/main/src/main/old-feature.ts and ~/x/src/main/old-twin.ts.",
					"We removed `src/main/old-feature.ts` in favour of keep.ts.",
					"```sh",
					"rm src/main/old-twin.ts",
					"```",
				].join("\n"),
			},
			"notes/other.md": { kind: "note", markdown: "`src/main/old-feature.ts` gone" },
		});
		const report = await run(client);
		expect(client.retired).toEqual([]);
		expect(client.flaggedPaths).toEqual([]);
		expect(report.checked).toBe(3);
		expect(logs).toEqual([]);
	});

	it("flags a renamed file rather than retiring the page", async () => {
		const client = fake({
			"gotchas/moved.md": { kind: "gotcha", markdown: "The code lives in `src/main/moved-old.ts`." },
		});
		await run(client);
		expect(client.retired).toEqual([]);
		expect(client.flaggedPaths).toEqual(["gotchas/moved.md"]);
	});

	it("does not retire when a named path never existed, nor when another name still exists", async () => {
		const client = fake({
			"decisions/unseen.md": {
				kind: "decision",
				markdown: "`src/main/old-feature.ts` and `src/main/never-was.ts`.",
			},
			"decisions/mixed.md": { kind: "decision", markdown: "`src/main/old-twin.ts` and `keepAlive`." },
		});
		await run(client);
		expect(client.retired).toEqual([]);
		expect(client.flaggedPaths.sort()).toEqual(["decisions/mixed.md", "decisions/unseen.md"]);
	});

	it("only flags a pinned page that would be retired", async () => {
		const client = fake({
			"decisions/pinned.md": { kind: "decision", markdown: "`src/main/old-feature.ts`", pinned: true },
		});
		const report = await run(client);
		expect(client.retired).toEqual([]);
		expect(client.flaggedPaths).toEqual(["decisions/pinned.md"]);
		expect(report.flagged[0]?.pinned).toBe(true);
	});

	it("dry run reports and changes nothing", async () => {
		const client = fake({
			"decisions/a.md": { kind: "decision", markdown: "`src/main/old-feature.ts`" },
			"gotchas/b.md": { kind: "gotcha", markdown: "`src/main/old-twin.ts` `src/main/keep.ts`" },
		});
		const flagged: Record<string, string> = {};
		const report = await run(client, { dryRun: true, flagged });
		expect(report.retired).toHaveLength(1);
		expect(report.flagged).toHaveLength(1);
		expect(client.retired).toEqual([]);
		expect(client.flaggedPaths).toEqual([]);
		expect(flagged).toEqual({});
		expect(logs).toEqual([]);
	});

	it("stops at maxChanges", async () => {
		const client = fake({
			"decisions/a.md": { kind: "decision", markdown: "`src/main/old-feature.ts`" },
			"decisions/b.md": { kind: "decision", markdown: "`src/main/old-twin.ts`" },
		});
		const report = await checkFreshness({ client, project: PROJECT, flagged: {}, maxChanges: 1, log: () => {} });
		expect(report.retired).toHaveLength(1);
	});

	it("does nothing when no session folder is a live checkout", async () => {
		const client = fake({ "decisions/a.md": { kind: "decision", markdown: "`src/main/old-feature.ts`" } }, [
			join(root, "missing"),
		]);
		const report = await run(client);
		expect(report.checkout).toBeNull();
		expect(client.retired).toEqual([]);
	});
});
