/** What main answers on the Memory channels in the dev harness (the responsive audit's Settings › Memory surfaces). */
import type { AiMemoryObservations, AiMemoryPage, AiMemoryPageRef, AiMemoryState } from "../../shared/ai-memory";
import { IPC_COMMANDS } from "../../shared/ipc-types";

const PROJECT = { workspace: "default", project: "owner-ompdesk" };
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const STATE: AiMemoryState = {
	enabled: true,
	phase: "ready",
	step: null,
	source: "bundled",
	version: "3.1.1",
	binary: "/app/memory",
	dataDir: "/Users/me/Library/Application Support/memory",
	serverUrl: "http://127.0.0.1:49374",
	webUrl: "http://127.0.0.1:49374/web",
	wiring: { app: true, terminal: false },
	stats: { pages: 12, sessions: 23, observations: 3982, diskBytes: 6_844_416 },
	detail: null,
	unsupported: null,
};

const ref = (path: string, title: string, kind: string, tier: string, minutes: number): AiMemoryPageRef => ({
	...PROJECT,
	path,
	title,
	kind,
	tier,
	updatedAt: ago(minutes),
});

const PAGES = [
	ref("_rules/style.md", "Keep functions short", "rule", "semantic", 300),
	ref("decisions/0007-db.md", "Use SQLite for the cache", "decision", "semantic", 1500),
	ref("gotchas/ime.md", "Enter during IME composition sends the message", "gotcha", "semantic", 4000),
	ref("procedures/release.md", "Cut a release", "procedure", "procedural", 9000),
	ref("sessions/s1.md", "Complete assignment thoroughly:", "session", "episodic", 20),
	ref("notes/ideas.md", "Ideas", "note", "semantic", 700),
];

const SESSION = {
	id: "01a151d3-3923-757b-a428-c6d49b5dd2f6",
	cwd: "/Users/me/Desktop/GitHub/ompdesk",
	agent: "omp",
	startedAt: ago(40),
	endedAt: null,
	observations: 60,
	consolidation: null,
};

/** The answer for a Memory channel, or `undefined` when the channel is not one of them. */
export function memoryAnswer(channel: string, args: unknown[]): { value: unknown } | undefined {
	switch (channel) {
		case IPC_COMMANDS.AI_MEMORY_GET_STATE:
			return { value: STATE };
		case IPC_COMMANDS.AI_MEMORY_PROJECTS:
			return { value: [{ ...PROJECT, pages: PAGES.length, lastUpdated: ago(20) }] };
		case IPC_COMMANDS.AI_MEMORY_OVERVIEW:
			return {
				value: {
					pages: PAGES.length,
					sessions: 23,
					observations: 3982,
					lastCaptureAt: ago(3),
					openHandoffs: 2,
					activity7d: { sessions: 23, observations: 3982, pagesUpdated: 12 },
					health: { stale: 0, duplicates: 8, contradictions: 0, orphans: 10 },
				},
			};
		case IPC_COMMANDS.AI_MEMORY_PAGES:
		case IPC_COMMANDS.AI_MEMORY_RECENT:
			return { value: PAGES };
		case IPC_COMMANDS.AI_MEMORY_SEARCH:
			return {
				value: PAGES.slice(1, 3).map(page => ({
					...page,
					snippet: "We chose SQLite for the cache because it ships with Bun.",
				})),
			};
		case IPC_COMMANDS.AI_MEMORY_READ_PAGE: {
			const wanted = (args[0] as { path: string }).path;
			const page = PAGES.find(entry => entry.path === wanted) ?? PAGES[1];
			if (!page) return { value: undefined };
			const full: AiMemoryPage = {
				...page,
				markdown: `# ${page.title}\n\nWe chose SQLite for the cache because it ships with Bun.\n\n- fast to start\n- one file`,
				id: "v1",
				pinned: false,
				createdAt: ago(5000),
				tags: [],
			};
			return { value: full };
		}
		case IPC_COMMANDS.AI_MEMORY_HANDOFFS:
			return {
				value: [
					{
						...PROJECT,
						id: "h-1",
						agent: "omp",
						createdAt: ago(30),
						summary: "Cache fix half done; next: add the eviction test and wire the settings row.",
						openQuestions: ["Which eviction policy?"],
						nextSteps: ["Add the eviction test"],
						state: "open",
					},
					{
						...PROJECT,
						id: "h-0",
						agent: "omp",
						createdAt: ago(3000),
						summary: "Earlier work.",
						openQuestions: [],
						nextSteps: [],
						state: "accepted",
					},
				],
			};
		case IPC_COMMANDS.AI_MEMORY_SESSIONS:
			return {
				value: [SESSION, { ...SESSION, id: "s-2", startedAt: ago(900), endedAt: ago(800), observations: 12 }],
			};
		case IPC_COMMANDS.AI_MEMORY_OBSERVATIONS: {
			const offset = (args[2] as number | undefined) ?? 0;
			const value: AiMemoryObservations = {
				session: SESSION,
				observations: Array.from({ length: 5 }, (_, index) => ({
					id: `o-${offset + index}`,
					kind: index === 0 ? "user-prompt" : "post-tool-use",
					title: `Observation ${offset + index + 1}`,
					body: `body of observation ${offset + index + 1}`,
					createdAt: ago(40 - index),
				})),
				total: 60,
				offset,
			};
			return { value };
		}
		case IPC_COMMANDS.AI_MEMORY_PROFILE:
			return {
				value: {
					enabled: true,
					injected: true,
					digestBytes: 420,
					scope: { workspace: "default", project: "_global" },
					entries: [
						{
							path: "profile/tools/bun.md",
							category: "tools",
							statement: "Use Bun, not npm.",
							appliesTo: ["javascript"],
							enforcedBy: null,
						},
						{
							path: "profile/testing/layout.md",
							category: "testing",
							statement: "Keep integration tests in tests/suite.",
							appliesTo: [],
							enforcedBy: null,
						},
					],
				},
			};
		case IPC_COMMANDS.AI_MEMORY_LINT:
			return {
				value: [
					{
						kind: "duplicate",
						severity: "warning",
						message: "Multiple pages share the title “Complete assignment thoroughly:”",
						pages: ["sessions/s1.md"],
					},
				],
			};
		case IPC_COMMANDS.AI_MEMORY_SWEEP:
			return {
				value: {
					dryRun: true,
					evaluated: 12,
					evicted: 1,
					compacted: 0,
					merged: 0,
					expired: 0,
					observationsPruned: 0,
				},
			};
		case IPC_COMMANDS.AI_MEMORY_CARE:
			return {
				value: {
					at: "2026-10-20T06:00:00Z",
					retired: 2,
					flagged: 1,
					backfilled: 340,
					pages: [
						{ ...PROJECT, path: "decisions/pairing-code.md", title: "컴퓨터 간 공유는 페어링 코드로 연결" },
						{ ...PROJECT, path: "decisions/manual-update.md", title: "OMPdesk는 수동 업데이트" },
						{ ...PROJECT, path: "gotchas/review-buttons.md", title: "작업 보드의 검토 버튼" },
					],
				},
			};
		default:
			return undefined;
	}
}
