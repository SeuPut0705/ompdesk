import { describe, expect, it } from "vitest";
import type { AiMemoryPage, AiMemoryPageRef, AiMemoryProject, AiMemoryProjectRef } from "../../shared/ai-memory";
import { type CurateClient, type CurateLogDetails, curateMemory, projectRules } from "./curate";
import type { PagePair, PairJudge, Relation } from "./memory-judge";

interface Seed {
	project: string;
	path: string;
	title: string;
	body: string;
	at: string;
	pinned?: boolean;
	kind?: string;
}

const WS = "default";
const PROJECT = "demo";

/** An in-memory ai-memory: a retired page leaves `pages`, as the real list hides an expired page. */
class FakeMemory {
	readonly retired: { project: string; path: string; successor?: string; reason?: string; expectedPageId?: string }[] =
		[];
	readonly reads: string[] = [];
	readonly #pages = new Map<string, Seed & { id: string; gone: boolean }>();
	/** What the next retire answers instead of retiring (a page that changed or is pinned meanwhile). */
	retireAnswer: "pinned" | "changed" | null = null;

	constructor(seeds: Seed[]) {
		seeds.forEach((seed, index) => {
			this.#pages.set(`${seed.project}/${seed.path}`, { ...seed, id: `id-${index}`, gone: false });
		});
	}

	client(): CurateClient {
		return {
			projects: async (): Promise<AiMemoryProject[]> =>
				[...new Set([...this.#pages.values()].map(page => page.project))].map(project => ({
					workspace: WS,
					project,
					pages: 0,
					lastUpdated: null,
				})),
			pages: async (project: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> =>
				[...this.#pages.values()]
					.filter(page => page.project === project.project && !page.gone)
					.map(page => ({
						...project,
						path: page.path,
						title: page.title,
						kind: page.kind,
						tier: "semantic",
						updatedAt: page.at,
					})),
			page: async (ref): Promise<AiMemoryPage> => {
				this.reads.push(`${ref.project}/${ref.path}`);
				const page = this.#pages.get(`${ref.project}/${ref.path}`);
				if (!page) throw new Error("not found");
				return {
					workspace: WS,
					project: page.project,
					path: page.path,
					title: page.title,
					kind: page.kind,
					tier: "semantic",
					updatedAt: page.at,
					markdown: `# ${page.title}\n\n${page.body}\n`,
					id: page.id,
					pinned: page.pinned === true,
					createdAt: page.at,
					tags: [],
				};
			},
			retirePage: async ref => {
				const page = this.#pages.get(`${ref.project}/${ref.path}`);
				if (!page) throw new Error("not found");
				if (this.retireAnswer) return this.retireAnswer;
				if (page.pinned) return "pinned";
				if (ref.expectedPageId && ref.expectedPageId !== page.id) return "changed";
				page.gone = true;
				this.retired.push({
					project: ref.project,
					path: ref.path,
					successor: ref.successor,
					reason: ref.reason,
					expectedPageId: ref.expectedPageId,
				});
				return "retired";
			},
		};
	}
}

const OLD_CODE: Seed = {
	project: PROJECT,
	path: "decisions/pairing-code.md",
	title: "Phones pair with an eight digit pairing code",
	body: "A phone connects by typing the eight digit pairing code the computer shows. The code expires after one use.",
	at: "2026-10-18T09:00:00Z",
};
const NEW_TAILSCALE: Seed = {
	project: PROJECT,
	path: "decisions/tailscale-identity.md",
	title: "Phones connect by Tailscale identity, no pairing code",
	body: "Pairing code removed: a phone signed in to the same Tailscale account connects with no pairing code step at all.",
	at: "2026-10-19T09:00:00Z",
};
const PUSH: Seed = {
	project: PROJECT,
	path: "procedures/check-before-push.md",
	title: "Run the changed-file checks before pushing",
	body: "Before you push, run bun run check:changed and make sure lint, types and tests pass.",
	at: "2026-10-19T05:00:00Z",
};
const MERGE: Seed = {
	project: PROJECT,
	path: "procedures/ci-before-merge.md",
	title: "Check that CI is green before merging",
	body: "Before you merge a pull request, make sure every CI job is green; fix the cause of any failure first.",
	at: "2026-10-19T05:10:00Z",
};

const says =
	(relation: Relation | ((pair: PagePair) => Relation), by: "jev" | "smol" = "jev"): PairJudge =>
	async pairs => ({
		by,
		verdicts: pairs.map(pair => ({
			relation: typeof relation === "function" ? relation(pair) : relation,
			confidence: 0.9,
		})),
		model: "fake",
		costUsd: 0.001,
		ms: 5,
	});

function setup(seeds: Seed[]) {
	const memory = new FakeMemory(seeds);
	const logs: { message: string; details: CurateLogDetails }[] = [];
	const run = (extra: Partial<Parameters<typeof curateMemory>[0]> = {}) =>
		curateMemory({
			client: memory.client(),
			log: (message, details) => logs.push({ message, details }),
			now: () => new Date("2026-10-20T00:00:00Z"),
			...extra,
		});
	return { memory, logs, run };
}

describe("curateMemory", () => {
	it("retires the older page the newer one contradicts, naming its successor, and keeps the newer", async () => {
		const { memory, run } = setup([OLD_CODE, NEW_TAILSCALE]);
		const report = await run({ judge: says("a_outdated") });
		expect(memory.retired).toEqual([
			{
				project: PROJECT,
				path: OLD_CODE.path,
				successor: NEW_TAILSCALE.path,
				reason: undefined,
				expectedPageId: "id-0",
			},
		]);
		expect(report.retirements.map(item => [item.path, item.result, item.by])).toEqual([
			[OLD_CODE.path, "retired", "jev"],
		]);
		expect(report.costUsd).toBeCloseTo(0.001);
	});

	it("retires the newer page when the judge says the older one is the current truth", async () => {
		const { memory, run } = setup([OLD_CODE, NEW_TAILSCALE]);
		await run({ judge: says("b_outdated") });
		expect(memory.retired.map(item => [item.path, item.successor])).toEqual([[NEW_TAILSCALE.path, OLD_CODE.path]]);
	});

	it("is idempotent: a retired page is not listed, judged or retired again", async () => {
		const { memory, run } = setup([OLD_CODE, NEW_TAILSCALE]);
		await run({ judge: says("a_outdated") });
		let asked = 0;
		const second = await run({
			judge: async pairs => {
				asked += pairs.length;
				return null;
			},
		});
		expect(asked).toBe(0);
		expect(second.retirements).toEqual([]);
		expect(memory.retired).toHaveLength(1);
	});

	it("retires nothing for an unrelated verdict and reports the pair so a caller can skip it next time", async () => {
		const { memory, run } = setup([PUSH, MERGE]);
		const first = await run({ judge: says("unrelated") });
		expect(memory.retired).toEqual([]);
		expect(first.unrelated).toHaveLength(1);
		let asked = 0;
		await run({
			skip: new Set(first.unrelated),
			judge: async pairs => {
				asked += pairs.length;
				return null;
			},
		});
		expect(asked).toBe(0);
	});

	it("without a judge only a near-identical copy retires, and a look-alike stays", async () => {
		const copy: Seed = { ...PUSH, path: "procedures/check-before-push-copy.md", at: "2026-10-18T05:00:00Z" };
		const { memory, run } = setup([PUSH, copy, MERGE, OLD_CODE, NEW_TAILSCALE]);
		const report = await run({ judge: null });
		expect(memory.retired.map(item => item.path)).toEqual([copy.path]);
		expect(report.by).toEqual({ jev: 0, smol: 0, code: 1 });
		expect(report.undecided).toBeGreaterThan(0);
	});

	it("falls back to the code rule when the judge answers nothing", async () => {
		const copy: Seed = { ...PUSH, path: "procedures/check-before-push-copy.md", at: "2026-10-18T05:00:00Z" };
		const { memory, run } = setup([PUSH, copy]);
		await run({ judge: async () => null });
		expect(memory.retired.map(item => item.path)).toEqual([copy.path]);
	});

	it("never calls two long pages one because their first 600 characters match", async () => {
		const opening = `${"Release steps for the desktop app, checked every time before a tag. ".repeat(10)}`;
		const mac: Seed = {
			project: PROJECT,
			path: "procedures/release-mac.md",
			title: "Release steps",
			body: `${opening}Then sign the DMG with the pinned certificate and verify the designated requirement.`,
			at: "2026-10-18T05:00:00Z",
		};
		const windows: Seed = {
			...mac,
			path: "procedures/release-windows.md",
			body: `${opening}Then build the NSIS setup on the Windows runner and never sign with the Mac certificate.`,
			at: "2026-10-19T05:00:00Z",
		};
		const code = setup([mac, windows]);
		await code.run({ judge: null });
		expect(code.memory.retired).toEqual([]);
		const judged = setup([mac, windows]);
		const report = await judged.run({ judge: says("duplicate") });
		expect(judged.memory.retired).toEqual([]);
		expect(report.undecided).toBe(1);
	});

	it("still lets a judge retire when both pages fit in what it read", async () => {
		const { memory, run } = setup([OLD_CODE, NEW_TAILSCALE]);
		await run({ judge: says("duplicate") });
		expect(memory.retired.map(item => item.path)).toEqual([OLD_CODE.path]);
	});

	it("never retires a pinned page, whether the list says so or the server answers pinned", async () => {
		const pinned = setup([{ ...OLD_CODE, pinned: true }, NEW_TAILSCALE]);
		const first = await pinned.run({ judge: says("a_outdated") });
		expect(pinned.memory.retired).toEqual([]);
		expect(first.retirements).toEqual([]);

		const raced = setup([OLD_CODE, NEW_TAILSCALE]);
		raced.memory.retireAnswer = "pinned";
		const second = await raced.run({ judge: says("a_outdated") });
		expect(second.retirements.map(item => item.result)).toEqual(["pinned"]);
		expect(raced.logs.filter(entry => entry.details.event === "retire")).toEqual([]);
	});

	it("leaves a page that changed after it was judged", async () => {
		const { memory, run } = setup([OLD_CODE, NEW_TAILSCALE]);
		memory.retireAnswer = "changed";
		const report = await run({ judge: says("a_outdated") });
		expect(report.retirements.map(item => item.result)).toEqual(["changed"]);
		expect(memory.retired).toEqual([]);
	});

	it("keeps a project's page that differs from a general preference, but drops a project copy of one", async () => {
		const general: Seed = {
			project: "_global",
			path: "preferences/indent.md",
			title: "Indent code with two spaces",
			body: "Where a project sets no rule, indent code with two spaces.",
			at: "2026-10-19T06:00:00Z",
		};
		const override: Seed = {
			project: PROJECT,
			path: "decisions/tabs.md",
			title: "This project indents with tabs",
			body: "Source files in this repository are indented with tabs, as the formatter configuration says.",
			at: "2026-10-19T07:00:00Z",
		};
		const a = setup([general, override]);
		await a.run({ judge: says("a_outdated") });
		expect(a.memory.retired).toEqual([]);

		const b = setup([general, override]);
		await b.run({ judge: says("duplicate") });
		expect(b.memory.retired.map(item => [item.project, item.path, item.successor])).toEqual([
			[PROJECT, override.path, general.path],
		]);
	});

	it("does not compare pages of two projects, and never reads a session page", async () => {
		const other: Seed = { ...NEW_TAILSCALE, project: "elsewhere" };
		const session: Seed = { ...NEW_TAILSCALE, path: "sessions/abc.md" };
		const { memory, run } = setup([OLD_CODE, other, session]);
		const report = await run({ judge: says("a_outdated") });
		expect(report.candidates).toBe(0);
		expect(memory.retired).toEqual([]);
		expect(memory.reads).not.toContain(`${PROJECT}/sessions/abc.md`);
	});

	it("dryRun reports the plan and changes and logs nothing", async () => {
		const { memory, logs, run } = setup([OLD_CODE, NEW_TAILSCALE]);
		const report = await run({ judge: says("a_outdated"), dryRun: true });
		expect(report.retirements.map(item => item.result)).toEqual(["planned"]);
		expect(memory.retired).toEqual([]);
		expect(logs).toEqual([]);
	});

	it("asks about at most maxPairs pairs and says how many were found", async () => {
		const seeds: Seed[] = Array.from({ length: 6 }, (_, index) => ({
			project: PROJECT,
			path: `decisions/theme-${index}.md`,
			title: `Theme palette rule ${index}`,
			body: "Every theme palette keeps its accent colour apart from the other themes in the same scheme.",
			at: `2026-10-1${index}T00:00:00Z`,
		}));
		const { run } = setup(seeds);
		let asked = 0;
		const report = await run({
			maxPairs: 2,
			judge: async pairs => {
				asked = pairs.length;
				return null;
			},
		});
		expect(asked).toBe(2);
		expect(report.judged).toBe(2);
		expect(report.candidates).toBeGreaterThan(2);
	});

	it("logs one care-curate line per retire and one summary line for the run", async () => {
		const { logs, run } = setup([OLD_CODE, NEW_TAILSCALE]);
		await run({ judge: says("a_outdated") });
		expect(logs.map(entry => [entry.message, entry.details.event])).toEqual([
			["care-curate", "retire"],
			["care-curate", "run"],
		]);
		expect(logs[0]?.details).toMatchObject({
			path: OLD_CODE.path,
			successor: `${PROJECT}/${NEW_TAILSCALE.path}`,
			by: "jev",
		});
		expect(logs[1]?.details).toMatchObject({ retired: 1, judged: 1, jev: 1 });
	});

	it("never retires one page for two pairs, nor a page another retire named as its successor", async () => {
		const mid: Seed = { ...OLD_CODE, path: "decisions/pairing-code-v2.md", at: "2026-10-18T20:00:00Z" };
		const { memory, run } = setup([OLD_CODE, mid, NEW_TAILSCALE]);
		await run({ judge: says("a_outdated") });
		const retired = memory.retired.map(item => item.path);
		const successors = memory.retired.map(item => item.successor);
		expect(retired.filter(path => successors.includes(path))).toEqual([]);
		expect(new Set(retired).size).toBe(retired.length);
	});
});

describe("projectRules", () => {
	it("reads the rules outline of the folder the project's newest session ran in", async () => {
		const asked: string[] = [];
		const rules = projectRules(
			{
				sessions: async () => [
					{
						id: "s2",
						cwd: "",
						agent: "omp",
						startedAt: null,
						endedAt: null,
						observations: 0,
						consolidation: null,
					},
					{
						id: "s1",
						cwd: "/work/demo",
						agent: "omp",
						startedAt: null,
						endedAt: null,
						observations: 0,
						consolidation: null,
					},
				],
			},
			async cwd => {
				asked.push(cwd);
				return "## Tailscale\n- **No pairing code**: identity only";
			},
		);
		expect(await rules({ workspace: WS, project: PROJECT })).toContain("No pairing code");
		expect(asked).toEqual(["/work/demo"]);
	});
});
