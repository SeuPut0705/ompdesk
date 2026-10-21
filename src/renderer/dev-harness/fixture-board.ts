/**
 * `?board=busy`: a session whose work board has everything at once, with long content (Korean under `?lang=ko`): four
 * running subagents with long titles, two background shells (one a dev server), sessions it opened on a paired device
 * in `omp/agent/…` worktrees, a subscription account with usage windows and an OpenRouter charge. The responsive
 * audit and the work board captures read it; `boardBusyStores` puts the turn, the waiting question and the goal into
 * the page's stores, which no transport answer carries.
 */

import type { CheckoutPeers } from "../../../resources/gui-bridge/modes/checkout-peers-contracts";
import type { AgentReviewItem } from "../../shared/agent-control";
import type { ExtensionUIRequest, RpcJobRow, SubagentSnapshot, UsageReport } from "../../shared/rpc-types";
import type { FamilyEdits, RpcTurnEdits } from "../../shared/turn-edits";

const MINUTE = 60_000;
const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
export const BOARD_BUSY = query.get("board") === "busy";
const ko = query.get("lang") === "ko";

const text = (en: string, korean: string) => (ko ? korean : en);

export function boardSubagents(): SubagentSnapshot[] {
	const now = Date.now();
	const agent = (id: string, index: number, description: string, step: string, ago: number): SubagentSnapshot => ({
		id,
		index,
		agent: "task",
		description,
		status: "running",
		live: true,
		lastUpdate: now,
		progress: {
			index,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: description,
			description,
			currentToolIntent: step,
			recentTools: [],
			recentOutput: [],
			toolCount: 3 + index,
			requests: 4 + index,
			tokens: 18_400 + index * 9_100,
			cost: 0.21 * (index + 1),
			durationMs: ago,
			resolvedModel: "anthropic/claude-sonnet-5-5",
			modelRole: "task",
		},
	});
	return [
		agent(
			"sa-1",
			0,
			text(
				"Rework the settings page's provider rows so every account fits on one line",
				"설정 화면의 프로바이더 행을 계정마다 한 줄에 들어가도록 다시 만들기",
			),
			text("Reading src/renderer/components/settings/providers/ProviderRow.tsx", "ProviderRow.tsx 읽는 중"),
			4 * MINUTE,
		),
		agent(
			"sa-2",
			1,
			text("Audit the phone composer at 360 px", "360 px 휴대폰 입력창 레이아웃 전체 점검"),
			text("Running bun run check:changed", "bun run check:changed 실행 중"),
			3 * MINUTE,
		),
		agent(
			"sa-3",
			2,
			text("Find every caller of the old fold store", "예전 접기 저장소를 부르는 곳을 모두 찾기"),
			text("Searching src for useSidebarFolds", "useSidebarFolds 검색 중"),
			2 * MINUTE,
		),
		agent(
			"sa-4",
			3,
			text("Write the regression test for the steer race", "조종 메시지 경쟁 조건 회귀 테스트 작성"),
			text("Editing src/renderer/stores/messages.test.ts", "messages.test.ts 편집 중"),
			40_000,
		),
	];
}

export function boardJobs(): RpcJobRow[] {
	const now = Date.now();
	return [
		{
			kind: "job",
			depth: 0,
			cancellable: true,
			job: {
				id: "bg_1",
				type: "bash",
				status: "running",
				label: "bun run dev -- --host 127.0.0.1 --port 5173 --strictPort",
				startTime: now - 6 * MINUTE,
				resultPreview: "  VITE v7.1.2  ready in 412 ms\n\n  ➜  Local:   http://127.0.0.1:5173/\n",
			},
		},
		{
			kind: "job",
			depth: 0,
			cancellable: true,
			job: {
				id: "bg_2",
				type: "bash",
				status: "running",
				label: "bunx vitest run src/renderer/components/layout/work-board --reporter=dot",
				startTime: now - 50_000,
			},
		},
	];
}

/** What `get_checkout_peers` answers under `?board=busy`: two sessions in this worktree, one with a very long title. */
export function boardPeers(): { peers: CheckoutPeers } {
	return {
		peers: {
			toplevel: "/Users/dev/projects/ompdesk",
			commonDir: "/Users/dev/projects/ompdesk/.git",
			canMessage: true,
			worktree: [
				{
					id: "tab-2",
					title: text("Settings test race", "설정 화면 테스트가 가끔 실패하는 문제"),
					sessionPath: "-Users-dev-projects-ompdesk/sess-2.jsonl",
				},
				{
					// A session this computer runs for a paired device: no id here, opened by its file.
					id: null,
					title: text(
						"Move the checkout peers row into the work board and measure how it reads on a phone",
						"같은 체크아웃의 다른 세션 줄을 작업 보드로 옮기고 휴대폰에서 읽히는지 길이를 재서 확인하기",
					),
					device: text("Seuput's iPhone", "스풋의 아이폰"),
					sessionPath: "-Users-dev-projects-ompdesk/sess-phone.jsonl",
				},
			],
			repo: [],
		},
	};
}

/** `?board=busy&children=wait`: the parent's turn runs and its last call waits on its children. */
export const CHILDREN_WAIT = BOARD_BUSY && query.get("children") === "wait";
/** That call's id; boot.ts marks its entry running (a transcript's unanswered call loads as stopped). */
export const CHILDREN_WAIT_CALL = "call-children-wait";

/**
 * The busy session's last turn, after its last prompt: three memories the bridge recalled (one with a long Korean
 * title) and a failed `bun test`, so the memory row and the failed-check section show.
 */
export function boardTurnMessages(base: number): Record<string, unknown>[] {
	const item = (title: string, kind: string, path: string) => ({ title, kind, path });
	return [
		{
			role: "custom",
			customType: "ompdesk-memory-recall",
			content: "<memory-recall>\nNotes from earlier sessions…\n</memory-recall>",
			display: true,
			details: {
				v: 1,
				judged: true,
				items: [
					item(
						text("Run tests with bun test, never npm", "테스트는 npm이 아니라 bun test로 돌린다"),
						"rule",
						"rules/tests.md",
					),
					item(
						text("Sidebar rows paint a frame late", "사이드바 행은 한 프레임 늦게 그려진다"),
						"gotcha",
						"gotchas/sidebar.md",
					),
					item(
						text(
							"Why the work board waits for the first paint before it reads the checkout's changes",
							"작업 보드가 첫 화면을 그린 뒤에야 체크아웃의 변경 사항을 읽는 이유와 그렇게 정한 배경 설명",
						),
						"decision",
						"decisions/work-board.md",
					),
				],
			},
			timestamp: base,
		},
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-board-test",
					name: "bash",
					arguments: { command: "bun test src/renderer/components/layout/work-board" },
				},
			],
			stopReason: "toolUse",
			timestamp: base + 2_000,
		},
		{
			role: "toolResult",
			toolCallId: "call-board-test",
			toolName: "bash",
			content: [
				{
					type: "text",
					text: "(fail) WorkBoard > shows the last check [3.20ms]\n 12 pass\n 2 fail\nCommand exited with code 1",
				},
			],
			details: { exitCode: 1, wallTimeMs: 4200 },
			isError: true,
			timestamp: base + 6_000,
		},
		// `&children=wait`: the parent's agent then waits on the sessions it opened (stock's `xd://` device call).
		...(CHILDREN_WAIT
			? [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: CHILDREN_WAIT_CALL,
								name: "write",
								arguments: {
									path: "xd://ompdesk_session_result",
									content: '{"sessions":["child-1","child-2"],"wait":true,"until":"any"}',
								},
								intent: text("Waiting for the child sessions", "하위 세션 기다리는 중"),
							},
						],
						stopReason: "toolUse",
						timestamp: base + 8_000,
					},
				]
			: []),
	];
}

export function boardReview(): { items: AgentReviewItem[] } {
	const now = Date.now();
	const item = (over: Partial<AgentReviewItem> & Pick<AgentReviewItem, "tabId" | "title">): AgentReviewItem => ({
		state: "running",
		commitsAhead: 2,
		files: 6,
		added: 214,
		removed: 37,
		uncommitted: 0,
		answer: "",
		...over,
	});
	return {
		items: [
			item({
				tabId: "child-1",
				title: text(
					"Make the work board compact on every screen size and theme",
					"작업현황을 모든 화면 크기와 테마에서 컴팩트하고 잘 보이게 정리",
				),
				branch: "omp/agent/work-board-compact-every-screen-size-and-theme-2026-10-20",
				baseBranch: "main",
				step: text("Measuring row heights at 390 px", "390 px에서 행 높이 재는 중"),
				runningSince: now - 7 * MINUTE,
			}),
			item({
				tabId: "child-2",
				title: text("Skill packs bump themselves daily", "스킬 묶음 매일 자동 업데이트"),
				branch: "omp/agent/skills-bump-daily",
				baseBranch: "main",
				state: "needs-review",
				waiting: true,
				report: {
					kind: "question",
					text: text(
						"Should a failed bump open an issue or only log it?",
						"업데이트가 실패하면 이슈를 열까요, 기록만 할까요?",
					),
					at: now - MINUTE,
				},
			}),
			item({
				tabId: "child-3",
				title: text("Keep the sidebar's folds across a relaunch", "다시 실행해도 사이드바 접힘 상태 유지"),
				state: "needs-review",
				report: {
					kind: "done",
					text: text(
						"Folds survive a relaunch; sidebar-memory tests pass.",
						"다시 실행해도 접힘이 유지돼요. sidebar-memory 테스트 통과.",
					),
					at: now - 2 * MINUTE,
				},
			}),
		],
	};
}

export function boardUsage(): { reports: UsageReport[] } {
	const now = Date.now();
	return {
		reports: [
			{
				provider: "anthropic",
				fetchedAt: now,
				account: "someone.with.a.long.address@example-company.com",
				active: true,
				lastUsedAt: now,
				limits: [
					{ id: "5h", label: "5h", windowId: "5h", usedFraction: 0.82, resetsAt: now + 74 * MINUTE },
					{ id: "7d", label: "7d", windowId: "7d", usedFraction: 0.46, resetsAt: now + 3 * 24 * 60 * MINUTE },
				],
			},
		],
	};
}

/** Store state no transport answer carries: a running turn, a waiting question and a goal. */
export function boardBusyStores(): {
	todo: Record<string, unknown>;
	session: Record<string, unknown>;
	request: ExtensionUIRequest;
} {
	const now = Date.now();
	return {
		// `&family=1`: the orchestrator of the user's report, idle after its turn while the sessions it opened work.
		todo: BOARD_FAMILY
			? { turnActive: false, turnStartedAt: null, lastTurn: { start: now - 3 * MINUTE, end: now - 2 * MINUTE } }
			: { turnActive: true, turnStartedAt: now - 3 * MINUTE },
		session: {
			goal: {
				objective: text(
					"Ship a work board that reads at a glance on a phone, a tablet and a 4K monitor alike",
					"휴대폰, 태블릿, 4K 모니터 어디서든 한눈에 읽히는 작업현황을 출시하기",
				),
			},
			goalState: { status: "active" },
			...(CHILDREN_WAIT ? { isStreaming: true } : {}),
		},
		request: {
			type: "extension_ui_request",
			id: "board-ask",
			method: "select",
			title: text(
				"Which breakpoint should the tablet board use when the side panel is open?",
				"사이드 패널이 열려 있을 때 태블릿에서는 어떤 기준으로 작업현황을 보여 줄까요?",
			),
			options: ["768", "1024"],
		},
	};
}

/**
 * `?board=busy&family=1`: the orchestrator of the user's report, idle after its turn while the sessions it opened
 * work. Main's `agent_control_family_edits` answer: `child-1` in its own worktree (what its branch has not landed),
 * `child-3` in the parent's checkout and closed after its work landed (its turn's own edits).
 */
export const BOARD_FAMILY = BOARD_BUSY && query.get("family") === "1";

const FAMILY_PROJECT = "/Users/dev/projects/ompdesk";
const FAMILY_WORKTREE = "/Users/dev/.omp/wt/gui-work-board-compact-1a2b3c4";

function familyTurn(
	key: string,
	cwd: string,
	endedAt: number,
	edits: Array<[path: string, diff: string]>,
): RpcTurnEdits {
	return {
		cwd,
		startedAt: endedAt - 4 * MINUTE,
		endedAt,
		messages: edits.flatMap(([path, diff], index) => [
			{
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: `${key}-${index}`, name: "edit", arguments: { path } }],
				timestamp: endedAt - 60_000 + index,
			},
			{
				role: "toolResult" as const,
				toolCallId: `${key}-${index}`,
				toolName: "edit",
				content: [{ type: "text" as const, text: "ok" }],
				details: { diff },
				timestamp: endedAt - 59_000 + index,
			},
		]),
	};
}

export function familyEdits(): FamilyEdits {
	if (!BOARD_FAMILY) return { members: [] };
	const now = Date.now();
	return {
		members: [
			{
				key: "child-1",
				title: text(
					"Make the work board compact on every screen size and theme",
					"작업현황을 모든 화면 크기와 테마에서 컴팩트하고 잘 보이게 정리",
				),
				live: true,
				edits: familyTurn("child-1", FAMILY_WORKTREE, now, [
					["src/renderer/styles/work-board.css", "+1 a\n+2 b\n-3 c"],
				]),
				unlanded: {
					branch: "omp/agent/work-board-compact-every-screen-size-and-theme-2026-10-20",
					target: "main",
					truncated: false,
					files: [
						{ path: "src/renderer/styles/work-board.css", status: "M", added: 48, removed: 21 },
						{
							path: "src/renderer/components/layout/work-board/board-parts.tsx",
							status: "M",
							added: 17,
							removed: 9,
						},
						{
							path: "src/renderer/components/layout/work-board/WorkBoard.tsx",
							status: "M",
							added: 6,
							removed: 2,
						},
						{ path: "e2e/work-board.e2e.ts", status: "M", added: 31, removed: 4 },
					],
				},
			},
			{
				key: "child-3",
				title: text("Keep the sidebar's folds across a relaunch", "다시 실행해도 사이드바 접힘 상태 유지"),
				live: false,
				edits: familyTurn("child-3", FAMILY_PROJECT, now - MINUTE, [
					["src/renderer/stores/sidebar-folds.ts", "+1 a\n+2 b\n+3 c\n-4 d"],
					["src/renderer/lib/sidebar-memory.ts", "+1 a\n+2 b"],
					["src/renderer/stores/sidebar-folds.test.ts", "+1 a\n+2 b\n+3 c\n+4 d\n+5 e"],
				]),
				unlanded: null,
			},
		],
	};
}
