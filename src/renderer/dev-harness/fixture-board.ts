/**
 * `?board=busy`: a session whose work board has everything at once, with long content (Korean under `?lang=ko`): four
 * running subagents with long titles, two background shells (one a dev server), sessions it opened on a paired device
 * in `omp/agent/…` worktrees, a subscription account with usage windows and an OpenRouter charge. The responsive
 * audit and the work board captures read it; `boardBusyStores` puts the turn, the waiting question and the goal into
 * the page's stores, which no transport answer carries.
 */
import type { AgentReviewItem } from "../../shared/agent-control";
import type { ExtensionUIRequest, RpcJobRow, SubagentSnapshot, UsageReport } from "../../shared/rpc-types";

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
		todo: { turnActive: true, turnStartedAt: now - 3 * MINUTE },
		session: {
			goal: {
				objective: text(
					"Ship a work board that reads at a glance on a phone, a tablet and a 4K monitor alike",
					"휴대폰, 태블릿, 4K 모니터 어디서든 한눈에 읽히는 작업현황을 출시하기",
				),
			},
			goalState: { status: "active" },
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
