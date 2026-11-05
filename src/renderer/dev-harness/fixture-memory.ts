/** What main answers on the Memory channels in the dev harness (the responsive audit's Settings › Memory surfaces). */
import type { AiMemoryObservations, AiMemoryPage, AiMemoryPageRef, AiMemoryState } from "../../shared/ai-memory";
import { IPC_COMMANDS } from "../../shared/ipc-types";

const PROJECT = { workspace: "default", project: "owner-ompdesk" };
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const STATE: AiMemoryState = {
	phase: "ready",
	step: null,
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
	ref("_rules/no-comments.md", "Comment only the non-obvious why", "rule", "semantic", 2100),
	ref("decisions/0007-db.md", "Use SQLite for the cache", "decision", "semantic", 1500),
	ref("decisions/0011-updates.md", "Updates stay manual, never automatic", "decision", "semantic", 6200),
	ref("gotchas/ime.md", "Enter during IME composition sends the message", "gotcha", "semantic", 4000),
	ref("gotchas/sidebar-flake.md", "Sidebar tests assert before the row mounts", "gotcha", "semantic", 12_500),
	ref("procedures/release.md", "Cut a release", "procedure", "procedural", 9000),
	ref("procedures/harness.md", "Run the dev harness for layout audits", "procedure", "procedural", 21_000),
	ref("sessions/s1.md", "Complete assignment thoroughly:", "session", "episodic", 20),
	ref("sessions/s2.md", "Fill the harness fixtures for the density audit", "session", "episodic", 190),
	ref("notes/ideas.md", "Ideas", "note", "semantic", 700),
	ref("notes/phone-layout.md", "Phone settings use master-detail", "note", "semantic", 31_000),
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

const SESSION_ROWS: [
	id: string,
	cwd: string,
	startedMinutesAgo: number,
	lengthMinutes: number,
	observations: number,
	consolidation: string | null,
][] = [
	["s-2", "/Users/me/Desktop/GitHub/ompdesk", 900, 100, 12, "pending"],
	["s-3", "/Users/me/Desktop/GitHub/ompdesk", 1600, 240, 184, "completed"],
	["s-4", "/Users/me/Desktop/GitHub/ompdesk-web", 2900, 75, 96, "failed"],
	["s-5", "/Users/me/Desktop/GitHub/infra", 4300, 38, 41, "completed"],
	["s-6", "/Users/me/Desktop/GitHub/ompdesk", 7200, 310, 402, "running"],
	["s-7", "/Users/me/scratch/stats-probe", 11_000, 22, 18, null],
];
const SESSIONS = [
	SESSION,
	...SESSION_ROWS.map(([id, cwd, started, length, observations, consolidation]) => ({
		...SESSION,
		id,
		cwd,
		startedAt: ago(started),
		endedAt: ago(started - length),
		observations,
		consolidation,
	})),
];

const handoff = (
	id: string,
	minutes: number,
	state: "open" | "accepted",
	summary: string,
	openQuestions: string[],
	nextSteps: string[],
) => ({ ...PROJECT, id, agent: "omp", createdAt: ago(minutes), summary, openQuestions, nextSteps, state });

const HANDOFFS = [
	handoff(
		"h-1",
		30,
		"open",
		"Cache fix half done; next: add the eviction test and wire the settings row.",
		["Which eviction policy?"],
		["Add the eviction test"],
	),
	handoff(
		"h-2",
		260,
		"open",
		"Settings search ranks by label only; descriptions still need to count, and the phone list needs a pass.",
		[],
		["Rank descriptions below labels", "Compare the phone and desktop results"],
	),
	handoff(
		"h-3",
		1700,
		"open",
		"Update flow reads the release feed; the install timing still needs a decision.",
		["Install on quit or on next launch?"],
		["Write the quit-time install test"],
	),
	handoff("h-0", 3000, "accepted", "Earlier work.", [], []),
	handoff(
		"h-00",
		8200,
		"accepted",
		"Sidebar flake traced to a row asserted before it mounts.",
		[],
		["Wait for the row in every sidebar spec"],
	),
];

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
					openHandoffs: HANDOFFS.filter(handoff => handoff.state === "open").length,
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
			return { value: HANDOFFS };
		case IPC_COMMANDS.AI_MEMORY_SESSIONS:
			return { value: SESSIONS };
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
