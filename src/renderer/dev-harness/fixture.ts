/**
 * The state the dev harness (`bun run harness`, e2e/mobile-shell.e2e.ts) shows: a few sessions in two projects, one
 * of them with a transcript that has prose, code, tool calls, a plan and an ask waiting. It stands in for what
 * the app's main process and omp would send, so the mobile layouts can be captured without either.
 */

import type { AdvisorUsage } from "../../../resources/gui-bridge/advisor-stats-contracts";
import type { IpcTabInfo, SessionInfo } from "../../shared/ipc-types";
import type {
	RpcContextInspectResult,
	RpcPrDetail,
	RpcPrListItem,
	RpcSessionState,
	SessionStats,
} from "../../shared/rpc-types";
import type { SidebarProjectsState } from "../../shared/sidebar-projects";
import { BOARD_BUSY, boardTurnMessages, CHILDREN_WAIT } from "./fixture-board";

const NOW = Date.parse("2026-10-17T09:30:00Z");
const MINUTE = 60_000;

export const PROJECT = "/Users/dev/projects/ompdesk";
const OTHER_PROJECT = "/Users/dev/projects/website";

interface Seed {
	tabId: string;
	sessionId: string;
	title: string;
	cwd: string;
	messageCount: number;
	status: SessionInfo["status"];
}

const SEEDS: Seed[] = [
	{
		tabId: "tab-1",
		sessionId: "sess-1",
		title: "Fix the flaky sidebar test",
		cwd: PROJECT,
		messageCount: 14,
		status: "complete",
	},
	{
		tabId: "tab-2",
		sessionId: "sess-2",
		title: "Add dark mode to the settings page",
		cwd: PROJECT,
		messageCount: 8,
		status: "complete",
	},
	{
		tabId: "tab-3",
		sessionId: "sess-3",
		title: "Migrate the blog to Astro",
		cwd: OTHER_PROJECT,
		messageCount: 22,
		status: "complete",
	},
];

export const sessionPath = (seed: Pick<Seed, "sessionId" | "cwd">) =>
	`${seed.cwd.replace(/\//g, "-")}/${seed.sessionId}.jsonl`;

export const tabsFixture = (): IpcTabInfo[] =>
	SEEDS.map((seed, index) => ({
		tabId: seed.tabId,
		cwd: seed.cwd,
		status: "ready",
		active: index === 0,
		visible: index === 0,
		kind: "agent" as IpcTabInfo["kind"],
		sessionId: seed.sessionId,
		sessionPath: sessionPath(seed),
		title: seed.title,
	}));

/** `?rows=N`: the sidebar holds N sessions (the three seeds, then saved ones in the project an hour apart). */
const ROWS = typeof location !== "undefined" ? Number(new URLSearchParams(location.search).get("rows") ?? 0) || 0 : 0;

export const sessionsFixture = (): SessionInfo[] => [
	...SEEDS.map((seed, index) => ({
		path: sessionPath(seed),
		id: seed.sessionId,
		title: seed.title,
		cwd: seed.cwd,
		created: new Date(NOW - (index + 1) * 60 * MINUTE).toISOString(),
		modified: new Date(NOW - index * 25 * MINUTE).toISOString(),
		messageCount: seed.messageCount,
		size: 4096 * (index + 2),
		status: seed.status,
		firstMessage: seed.title,
	})),
	...Array.from({ length: Math.max(0, ROWS - SEEDS.length) }, (_, index) => ({
		path: sessionPath({ sessionId: `sess-row-${index + 1}`, cwd: PROJECT }),
		id: `sess-row-${index + 1}`,
		title: `Saved session ${index + 1}`,
		cwd: PROJECT,
		created: new Date(NOW - (index + 2) * 60 * MINUTE).toISOString(),
		modified: new Date(NOW - (index + 1) * 60 * MINUTE).toISOString(),
		messageCount: 6,
		size: 4096,
		status: "complete" as const,
		firstMessage: `Saved session ${index + 1}`,
	})),
];

/**
 * This computer's project list (src/main/sidebar-projects.ts): the session folders, and with `?projects=1` an empty
 * project the person just opened and one whose folder is gone, as the sidebar shows them.
 */
export const projectsFixture = (): SidebarProjectsState => {
	const extra =
		typeof location !== "undefined" && new URLSearchParams(location.search).get("projects") === "1"
			? [
					{ path: "/Users/dev/projects/api", addedAt: NOW },
					{
						path: "/Users/dev/projects/old-prototype",
						addedAt: NOW - 30 * 24 * 60 * MINUTE,
						missing: true as const,
					},
				]
			: [];
	return {
		projects: [
			{ path: PROJECT, addedAt: NOW - 3 * 60 * MINUTE },
			{ path: OTHER_PROJECT, addedAt: NOW - 4 * 60 * MINUTE },
			...extra,
		],
		removed: [],
		worktrees: {},
	};
};

export const MODEL = {
	provider: "anthropic",
	id: "claude-sonnet-5-5",
	name: "Claude Sonnet 5.5",
	contextWindow: 1_000_000,
	maxTokens: 64_000,
};

/**
 * `?todos=mixed`: a plan whose agent finished some steps out of order (the user's report: done steps after the one in
 * progress), so the board's todo section shows how it folds finished steps wherever they sit.
 */
const MIXED_TODOS: Array<[string, "completed" | "in_progress" | "pending"]> | null =
	typeof location !== "undefined" && new URLSearchParams(location.search).get("todos") === "mixed"
		? [
				["Read the board's code", "completed"],
				["Reproduce the report", "completed"],
				["Write the failing test", "completed"],
				["Fold every finished step", "in_progress"],
				["Update the harness", "completed"],
				["Capture before and after", "completed"],
				["Run the checks", "pending"],
				["Update AGENTS.md", "completed"],
				["Commit the test", "completed"],
				["Commit the fix", "pending"],
				["Push to main", "pending"],
				["Report back", "pending"],
			]
		: null;

export function stateFixture(tabId: string): RpcSessionState {
	const seed = SEEDS.find(candidate => candidate.tabId === tabId) ?? SEEDS[0];
	return {
		model: MODEL,
		thinkingLevel: "medium",
		thinkingConfigured: "auto",
		availableThinkingLevels: ["low", "medium", "high"],
		isStreaming: false,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		interruptMode: "immediate",
		sessionFile: sessionPath(seed),
		cwd: seed.cwd,
		sessionId: seed.sessionId,
		sessionName: seed.title,
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond: null,
		autoCompactionEnabled: true,
		autoRetryEnabled: true,
		messageCount: seed.messageCount,
		queuedMessageCount: 0,
		todoPhases: MIXED_TODOS
			? [
					{
						name: "Ship the board",
						tasks: MIXED_TODOS.map(([content, status]) => ({ content, status })),
					},
				]
			: [
					{
						name: "Fix the test",
						tasks: [
							{ content: "Reproduce the flake", status: "completed" },
							{ content: "Wait for the row to mount before asserting", status: "in_progress" },
							{ content: "Run the sidebar suite ten times", status: "pending" },
						],
					},
				],
		contextUsage: { tokens: 38_400, contextWindow: 1_000_000, percent: 3.8 },
		planModeEnabled: false,
		agentsPaused: false,
	} as RpcSessionState;
}

interface Entry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: Record<string, unknown>;
}

/** The journal of the first session, in stock's entry shape (what `get_entries` returns). */
export function entriesFixture(tabId: string): Entry[] {
	const base = NOW - 40 * MINUTE;
	const messages: Record<string, unknown>[] = [
		{
			role: "user",
			content: "The sidebar session test fails about one run in five. Can you find out why and fix it?",
			timestamp: base,
		},
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: "I'll start by looking at the test and the component it renders, then run it a few times to see the failure.",
				},
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "src/renderer/components/layout/sidebar/Sidebar.test.tsx" },
				},
			],
			stopReason: "toolUse",
			model: MODEL.id,
			timestamp: base + 4_000,
		},
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [
				{
					type: "text",
					text: "describe('Sidebar', () => {\n  it('lists the sessions', async () => {\n    await mount(<Sidebar />);\n    expect(rowFor('Session /work/alpha/mine')).toBeTruthy();\n  });\n});",
				},
			],
			isError: false,
			timestamp: base + 6_000,
		},
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: 'The assertion runs right after `mount`, but the rows render on the next animation frame. That is the flake: when the frame lands first the test passes, otherwise it reads an empty list.\n\n```tsx\nawait mount(<Sidebar />);\nawait waitFor(() => expect(rowFor("Session /work/alpha/mine")).toBeTruthy());\n```\n\nI\'ll make that change and run the suite ten times.',
				},
				{
					type: "toolCall",
					id: "call-2",
					name: "bash",
					arguments: { command: "bunx vitest run src/renderer/components/layout/sidebar --repeat 10" },
				},
			],
			stopReason: "toolUse",
			model: MODEL.id,
			timestamp: base + 20_000,
		},
		{
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "bash",
			content: [
				{
					type: "text",
					text: " ✓ Sidebar.test.tsx (120 tests) 3.1s\n\n Test Files  1 passed (1)\n      Tests  1200 passed (1200)",
				},
			],
			isError: false,
			timestamp: base + 40_000,
		},
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Fixed. The test now waits for the row instead of assuming the first frame, and all 1200 repeats pass.\n\n- **Cause:** assertion ran before the rows' first paint\n- **Change:** `waitFor` around the row lookup\n- **Checked:** 10 repeats of the whole sidebar suite",
				},
			],
			stopReason: "stop",
			model: MODEL.id,
			timestamp: base + 44_000,
		},
		{ role: "user", content: "Nice. Does the same race exist in the settings page tests?", timestamp: base + 90_000 },
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Checking now — I'll search for tests that assert straight after `mount` and compare them with the ones that already wait.",
				},
			],
			stopReason: "stop",
			model: MODEL.id,
			timestamp: base + 96_000,
		},
	];
	return messages.map((message, index) => ({
		type: "message",
		id: `${tabId}-entry-${index + 1}`,
		parentId: index === 0 ? null : `${tabId}-entry-${index}`,
		timestamp: new Date(Number(message.timestamp)).toISOString(),
		message,
	}));
}

/**
 * `?stress=1` on the harness page appends turns that hold what overflows a narrow screen: an unbroken URL, a wide
 * table, a very long code line, a diff, a mermaid chart and tool calls with long paths and commands. The
 * responsive audit reads it; the default pages never carry it.
 */
function stressMessages(base: number): Record<string, unknown>[] {
	const longLine = `const result = await someVeryLongFunctionName(argumentNumberOne, argumentNumberTwo, argumentNumberThree, argumentNumberFour, argumentNumberFive);`;
	const text = [
		"Here is the unbroken link https://example.com/a/very/long/path/that/never/breaks/and/keeps/going/and/going/forever/index.html?query=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and an identifier `SomeExtremelyLongIdentifierNameThatHasNoSpacesAtAllAndKeepsGoingPastTheEdge`.",
		"",
		"| Name | Status | Duration | Owner | Notes |",
		"| --- | --- | --- | --- | --- |",
		"| Sidebar.test.tsx | passed | 3.1 s | frontend | The first paint is now awaited before asserting |",
		"| Composer.test.tsx | failed | 12.4 s | frontend | Flaky when the menu opens while the field is focused |",
		"| Settings.test.tsx | skipped | 0 s | platform | Waiting on the new section layout to land |",
		"",
		"```ts",
		longLine,
		"```",
		"",
		"```diff",
		"--- a/src/renderer/components/layout/sidebar/Sidebar.test.tsx",
		"+++ b/src/renderer/components/layout/sidebar/Sidebar.test.tsx",
		"@@ -1,3 +1,3 @@",
		"-const a = oldFunctionWithAVeryLongNameThatKeepsGoing(argumentNumberOne, argumentNumberTwo, argumentNumberThree);",
		"+const a = newFunctionWithAVeryLongNameThatKeepsGoing(argumentNumberOne, argumentNumberTwo, argumentNumberThree);",
		"```",
		"",
		"```mermaid",
		"graph TD; Start[Open the sidebar] --> Check{Rows painted yet?}; Check -->|yes| Assert[Assert the row]; Check -->|no| Wait[Wait for the next frame]; Wait --> Check;",
		"```",
		"",
		"1. A numbered item with a long explanation that must wrap inside the column rather than push the page sideways when it is read on a phone.",
		"> A quoted line that also runs long enough to wrap on a narrow screen, with `inline code` in the middle of it.",
	].join("\n");
	return [
		{ role: "user", content: "Show me everything that tends to overflow on a phone.", timestamp: base },
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-s1",
					name: "edit",
					arguments: {
						path: "src/renderer/components/layout/sidebar/some/deeply/nested/directory/structure/WithAVeryLongComponentFileName.tsx",
						edits: [{ old_text: "a", new_text: "b" }],
					},
				},
				{
					type: "toolCall",
					id: "call-s2",
					name: "bash",
					arguments: {
						command:
							"bunx vitest run src/renderer/components/layout/sidebar src/renderer/components/layout/composer --repeat 10 --reporter=verbose --coverage.enabled=true",
					},
				},
			],
			stopReason: "toolUse",
			model: MODEL.id,
			timestamp: base + 4_000,
		},
		{
			role: "toolResult",
			toolCallId: "call-s1",
			toolName: "edit",
			content: [{ type: "text", text: "Updated the file." }],
			isError: false,
			timestamp: base + 5_000,
		},
		{
			role: "toolResult",
			toolCallId: "call-s2",
			toolName: "bash",
			content: [{ type: "text", text: `${longLine}\n${"x".repeat(240)}` }],
			isError: false,
			timestamp: base + 6_000,
		},
		{
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			model: MODEL.id,
			timestamp: base + 10_000,
		},
	];
}
/** `?mail=1` appends three session reports (`ompdesk.mail`): a done, a progress and a question waiting here. */
function mailMessages(base: number): Record<string, unknown>[] {
	const report = (offset: number, details: Record<string, unknown>) => ({
		role: "custom",
		customType: "ompdesk.mail",
		content: "<ompdesk-mail …>",
		display: true,
		details: { from: "child-1", fromTitle: "Settings test race", ...details },
		timestamp: base + offset,
	});
	return [
		report(0, { id: "mail-progress", kind: "progress", text: "Found four tests that assert straight after mount." }),
		report(30_000, {
			id: "mail-done",
			kind: "done",
			text: "All four settings tests now wait for their rows. 20 repeats of the settings suite pass.",
			files: [
				"src/renderer/components/settings/SettingsPage.test.tsx",
				"src/renderer/components/settings/Rows.test.tsx",
			],
			checks: [
				{ command: "bunx vitest run src/renderer/components/settings --repeat 20", passed: true },
				{ command: "bun run check:types", passed: true },
			],
		}),
		report(60_000, {
			id: "mail-question",
			kind: "question",
			from: "child-2",
			fromTitle: "Composer flake",
			text: "The composer test also flakes, but fixing it changes a shared helper. Should I change the helper or only the test?",
		}),
	];
}

/** A second session's journal is short: enough for a pane that reads as a conversation. */
export function entriesFor(tabId: string): Entry[] {
	if (tabId !== "tab-1") return entriesFixture(tabId).slice(0, 4);
	const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
	if (!params.has("stress") && !params.has("mail") && !BOARD_BUSY) return entriesFixture(tabId);
	const all = [
		...entriesFixture(tabId).map(entry => entry.message),
		...(params.has("stress") ? stressMessages(NOW - 20 * MINUTE) : []),
		...(params.has("mail") ? mailMessages(NOW - 10 * MINUTE) : []),
		// The live wait (`&children=wait`) is the turn running now: its clock reads from real time, not the fixture's day.
		...(BOARD_BUSY ? boardTurnMessages(CHILDREN_WAIT ? Date.now() - 3 * MINUTE : NOW - 8 * MINUTE) : []),
	];
	return all.map((message, index) => ({
		type: "message",
		id: `${tabId}-entry-${index + 1}`,
		parentId: index === 0 ? null : `${tabId}-entry-${index}`,
		timestamp: new Date(Number(message.timestamp)).toISOString(),
		message,
	}));
}

export const MODELS = [
	MODEL,
	{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, maxTokens: 64_000 },
	{ provider: "openai", id: "gpt-6", name: "GPT-6", contextWindow: 800_000, maxTokens: 64_000 },
];

/** The messages `get_transcript_page` returns for a tab: the journal's messages, oldest first. */
export const transcriptFor = (tabId: string): Record<string, unknown>[] =>
	entriesFor(tabId).map(entry => entry.message);

export const PROVIDERS = [
	{ id: "anthropic", name: "Anthropic", authenticated: true, loginAvailable: true, disabled: false, modelCount: 2 },
	{ id: "openai", name: "OpenAI", authenticated: true, loginAvailable: true, disabled: false, modelCount: 1 },
];

/** What `get_git_changes` answers: a repository with three changed files. */
export const GIT_CHANGES = {
	isRepo: true,
	root: PROJECT,
	base: "HEAD",
	files: [
		{ path: "src/renderer/components/layout/sidebar/Sidebar.test.tsx", status: "M", added: 4, removed: 1 },
		{ path: "src/renderer/components/layout/sidebar/Sidebar.tsx", status: "M", added: 12, removed: 3 },
		{ path: "src/renderer/lib/wait-for.ts", status: "A", added: 21, removed: 0 },
	],
	truncated: false,
	head: {
		branch: "fix/sidebar-flake",
		upstream: "origin/main",
		ahead: 1,
		behind: 0,
		operation: null,
		stashes: 0,
		hasRemote: true,
	},
};

const SIDEBAR_TEST = "src/renderer/components/layout/sidebar/Sidebar.test.tsx";

/** What `get_git_diff` answers per changed file (unified diffs, as git prints them). */
export const GIT_DIFFS: Record<string, string> = {
	[SIDEBAR_TEST]: [
		`diff --git a/${SIDEBAR_TEST} b/${SIDEBAR_TEST}`,
		`--- a/${SIDEBAR_TEST}`,
		`+++ b/${SIDEBAR_TEST}`,
		"@@ -12,7 +12,10 @@ describe('Sidebar', () => {",
		"   it('lists the sessions', async () => {",
		"     await mount(<Sidebar />);",
		"-    expect(rowFor('Session /work/alpha/mine')).toBeTruthy();",
		"+    await waitFor(() => expect(rowFor('Session /work/alpha/mine')).toBeTruthy());",
		"   });",
		"+",
		"+  it('keeps the open session highlighted', async () => {",
		"+    await mount(<Sidebar active='mine' />);",
		"+    await waitFor(() => expect(rowFor('mine').dataset.active).toBe('true'));",
		"+  });",
		" });",
		"",
	].join("\n"),
};

/** The workspace tree `fs:list` answers: the three changed files and a folder around them. */
export const FILE_TREE = [
	{
		name: "src",
		path: "src",
		kind: "dir",
		children: [
			{
				name: "renderer",
				path: "src/renderer",
				kind: "dir",
				children: [
					{
						name: "lib",
						path: "src/renderer/lib",
						kind: "dir",
						children: [{ name: "wait-for.ts", path: "src/renderer/lib/wait-for.ts", kind: "file" }],
					},
				],
			},
		],
	},
	{ name: "package.json", path: "package.json", kind: "file" },
	{ name: "README.md", path: "README.md", kind: "file" },
];

/** What `fs:read` answers per path. */
export const FILE_CONTENTS: Record<string, string> = {
	"src/renderer/lib/wait-for.ts":
		"/** Poll `check` until it stops throwing, or fail with its last error after `timeoutMs`. */\nexport async function waitFor(check: () => void, timeoutMs = 1000): Promise<void> {\n\tconst end = Date.now() + timeoutMs;\n\tfor (;;) {\n\t\ttry {\n\t\t\treturn check();\n\t\t} catch (error) {\n\t\t\tif (Date.now() > end) throw error;\n\t\t\tawait new Promise(resolve => setTimeout(resolve, 20));\n\t\t}\n\t}\n}\n",
	"package.json": '{\n\t"name": "ompdesk",\n\t"private": true\n}\n',
	"README.md": "# OMPdesk\n\nA desktop for the omp agent.\n",
};

/** The first screen of the harness terminal. */
export const TERMINAL_OUTPUT =
	"\u001b[32mseuput@laptop\u001b[0m:\u001b[34m~/ompdesk\u001b[0m$ bun test\r\n 1200 passed\r\n$ ";

/** The repository and pull requests the PR center (Agents › Pull requests) shows. */
export const PR_REPO = { available: true as const, repo: "seuput/ompdesk", defaultBranch: "main" };

export const PR_LIST: RpcPrListItem[] = [
	{
		number: 412,
		title: "Stack settings rows above a full-width control on a phone",
		url: "https://github.com/seuput/ompdesk/pull/412",
		isDraft: false,
		authorLogin: "seuput",
		headRefName: "mobile/settings-master-detail",
		baseRefName: "main",
		additions: 214,
		deletions: 38,
		updatedAt: "2026-10-17T08:50:00Z",
		reviewDecision: null,
		checks: { success: 5, failure: 0, pending: 1 },
	},
	{
		number: 409,
		title: "Keep the model picker's search pinned while the list scrolls",
		url: "https://github.com/seuput/ompdesk/pull/409",
		isDraft: true,
		authorLogin: "mina",
		headRefName: "picker/pinned-search",
		baseRefName: "main",
		additions: 31,
		deletions: 4,
		updatedAt: "2026-10-16T21:10:00Z",
		reviewDecision: null,
		checks: { success: 2, failure: 1, pending: 0 },
	},
];

export const PR_DETAIL: RpcPrDetail = {
	number: 412,
	title: "Stack settings rows above a full-width control on a phone",
	url: "https://github.com/seuput/ompdesk/pull/412",
	isDraft: false,
	authorLogin: "seuput",
	body: "Settings opens as a list on a phone and each section is a pushed page.\n\n- rows stack label and control\n- the back gesture closes the page",
	baseRefName: "main",
	headRefName: "mobile/settings-master-detail",
	mergeStateStatus: "CLEAN",
	state: "OPEN",
	additions: 214,
	deletions: 38,
	reviewDecision: null,
	files: [
		{
			path: "src/renderer/components/settings/SettingsPage.tsx",
			changeType: "MODIFIED",
			additions: 120,
			deletions: 30,
		},
		{ path: "src/renderer/components/common/MasterDetail.tsx", changeType: "ADDED", additions: 94, deletions: 0 },
	],
	checks: [
		{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
		{ name: "e2e (mobile)", status: "IN_PROGRESS", conclusion: null },
	],
};

/** What `get_advisor_stats` answers: an advisor on another vendor's model, three notes delivered (Run popover, Insights). */
export const ADVISOR_USAGE: AdvisorUsage = {
	configured: true,
	active: true,
	subscription: false,
	cost: 0.454,
	calls: 18,
	tokens: { input: 96_400, output: 3_100, cacheRead: 71_000, total: 170_500 },
	advisories: { total: 3, blocker: 0, concern: 2, nit: 1, other: 0 },
	advisors: [{ name: "default", status: "running", model: "openai/gpt-6.1-sol", calls: 18, cost: 0.454 }],
};

/** What `get_session_stats` answers: the open session's figures (Insights › Activity › This session). */
export const SESSION_STATS: SessionStats = {
	sessionId: "sess-1-harness-fixture",
	userMessages: 7,
	assistantMessages: 7,
	toolCalls: 18,
	toolResults: 18,
	totalMessages: 14,
	tokens: { input: 48_200, output: 9_400, reasoning: 2_100, cacheRead: 310_000, cacheWrite: 12_000, total: 381_700 },
	premiumRequests: 0,
	cost: 1.84,
};

/** What `get_context_inspect` answers: category totals only. */
export const CONTEXT_INSPECT: RpcContextInspectResult = {
	model: "claude-sonnet-4-5",
	contextWindow: 200_000,
	usedTokens: 61_000,
	anchored: true,
	categories: {
		systemPrompt: 4_200,
		systemContext: 1_100,
		memoryFiles: 2_400,
		builtinTools: 9_800,
		mcpTools: 0,
		extensionTools: 1_500,
		skills: 3_000,
		messages: 39_000,
	},
	entries: [],
};
