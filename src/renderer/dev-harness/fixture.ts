/**
 * The state the dev harness (`bun run harness`, e2e/mobile-shell.e2e.ts) shows: a few sessions in two projects, one
 * of them with a transcript that has prose, code, tool calls, a plan and an ask waiting. It stands in for what
 * the app's main process and omp would send, so the mobile layouts can be captured without either.
 */

import type { IpcTabInfo, SessionInfo } from "../../shared/ipc-types";
import type { RpcSessionState } from "../../shared/rpc-types";

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

export const sessionsFixture = (): SessionInfo[] =>
	SEEDS.map((seed, index) => ({
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
	}));

export const MODEL = {
	provider: "anthropic",
	id: "claude-sonnet-5-5",
	name: "Claude Sonnet 5.5",
	contextWindow: 1_000_000,
	maxTokens: 64_000,
};

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
		todoPhases: [
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

/** A second session's journal is short: enough for a pane that reads as a conversation. */
export function entriesFor(tabId: string): Entry[] {
	return tabId === "tab-1" ? entriesFixture(tabId) : entriesFixture(tabId).slice(0, 4);
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
