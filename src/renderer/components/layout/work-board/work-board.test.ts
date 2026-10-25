import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest, SubagentSnapshot, TodoTask } from "../../../../shared/rpc-types";
import type { AskKind } from "../../../lib/attention";
import { translate } from "../../../lib/i18n";
import {
	boardCounts,
	goalMeta,
	isWaitingSubagent,
	liveSubagents,
	READING_COLUMN_PX,
	requestLabel,
	TODO_BOARD_ROWS,
	todoBoard,
	transcriptColumnWidth,
	WORK_BOARD_GAP,
	WORK_BOARD_MIN_SPARE,
	WORK_BOARD_MIN_TRANSCRIPT,
	WORK_BOARD_WIDE_SPARE,
	WORK_BOARD_WIDE_WIDTH,
	WORK_BOARD_WIDTH,
	workBoardDocks,
	workBoardFits,
	workBoardForm,
	workBoardWidth,
	workingSubagents,
} from "./work-board";

const stylesheet = readFileSync(new URL("../../../styles/components.css", import.meta.url), "utf8");

describe("work board breakpoint", () => {
	it("mirrors the transcript column and the board's width in components.css", () => {
		expect(stylesheet).toContain(`--omp-column-reading: ${READING_COLUMN_PX / 16}rem;`);
		expect(stylesheet).toContain("--omp-column-pad: clamp(var(--sc-space-4), 3cqw, var(--sc-space-10));");
		expect(stylesheet).toContain(`--omp-board-width: ${WORK_BOARD_WIDTH}px;`);
		expect(stylesheet).toContain(`--omp-board-gap: ${WORK_BOARD_GAP}px;`);
	});

	it("needs the transcript's max width plus 300px of spare margin", () => {
		// 3cqw clamps at 40px from 1334px up: the column is 768 + 80.
		expect(transcriptColumnWidth(1600)).toBe(848);
		expect(workBoardFits(1600)).toBe(true);
		// The smallest pane that fits: its margin beside the column (which grows with the pane until 1334px) is 300px.
		let narrowest = 0;
		while (!workBoardFits(narrowest)) narrowest++;
		expect(narrowest).toBe(1137);
		expect(narrowest - transcriptColumnWidth(narrowest)).toBeGreaterThanOrEqual(WORK_BOARD_MIN_SPARE);
		expect(narrowest - 1 - transcriptColumnWidth(narrowest - 1)).toBeLessThan(WORK_BOARD_MIN_SPARE);
	});

	it("is too narrow for a split pane or a narrow window", () => {
		for (const width of [0, 480, 800, 1000, 1135]) expect(workBoardFits(width)).toBe(false);
	});

	it("widens only where the margin holds the wide board with room to spare", () => {
		// A 1440 px window beside the sidebar (pane 1196): 356 px of margin, the standard width.
		expect(workBoardWidth(1196)).toBe(WORK_BOARD_WIDTH);
		// A 1920 px window beside the sidebar (pane 1676): 828 px of margin, the wide board.
		expect(workBoardWidth(1676)).toBe(WORK_BOARD_WIDE_WIDTH);
		let first = 0;
		while (workBoardWidth(first) === WORK_BOARD_WIDTH) first++;
		expect(first - transcriptColumnWidth(first)).toBeGreaterThanOrEqual(WORK_BOARD_WIDE_SPARE);
		// The wide board and its gap still leave the transcript column all of its width.
		expect(first - WORK_BOARD_WIDE_WIDTH - WORK_BOARD_GAP).toBeGreaterThanOrEqual(transcriptColumnWidth(first));
	});

	it("docks in a desktop window and on a tablet held sideways beside a column narrowed to what still reads", () => {
		// Measured panes, web build, sidebar at its default 248 px: iPad Pro 12.9" (1366 → 1118), iPad Air (1180 → 932)
		// and iPad mini (1133 → 885) sideways, all docked; a 1024 px tablet (776) keeps the strip until its sidebar
		// folds (1024).
		expect(workBoardFits(1118)).toBe(false);
		expect(workBoardDocks(1118, "tablet-landscape")).toBe(true);
		expect(workBoardWidth(1118)).toBe(WORK_BOARD_WIDTH);
		expect(workBoardDocks(932, "tablet-landscape")).toBe(true);
		expect(workBoardDocks(885, "tablet-landscape")).toBe(true);
		expect(workBoardDocks(776, "tablet-landscape")).toBe(false);
		expect(workBoardDocks(1024, "tablet-landscape")).toBe(true);
		// The floor is the composer toolbar's label fold: the toolbar (the box less its 2 px border) must stay wider
		// than components.css's `omp-toolbar` 500 px rule, or the model chip loses its name.
		const fold = Number(
			/@container omp-toolbar \(max-width: (\d+)px\)\s*\{[^}]*\}\s*\.omp-composer-fold-4 :is\(\.omp-composer-model-label/.exec(
				stylesheet,
			)?.[1],
		);
		expect(fold).toBe(500);
		expect(WORK_BOARD_MIN_TRANSCRIPT - 2).toBe(fold + 1);
		// The rule is a measurement: the narrowest pane that docks keeps at least the floor of text.
		let narrowest = 0;
		while (!workBoardDocks(narrowest, "tablet-landscape")) narrowest++;
		const text = (pane: number) =>
			pane - WORK_BOARD_WIDTH - WORK_BOARD_GAP - 2 * Math.min(40, Math.max(16, pane * 0.03));
		expect(text(narrowest)).toBeGreaterThanOrEqual(WORK_BOARD_MIN_TRANSCRIPT);
		expect(text(narrowest - 1)).toBeLessThan(WORK_BOARD_MIN_TRANSCRIPT);
		// A desktop window (no shell) docks the same way: a 1280 px window beside the sidebar (a Windows laptop at 150 %
		// scaling) has a 1032 px pane. A portrait tablet and a phone keep the strip.
		expect(workBoardDocks(1032, null)).toBe(true);
		expect(workBoardDocks(776, null)).toBe(false);
		expect(workBoardDocks(1118, "tablet-portrait")).toBe(false);
		expect(workBoardDocks(1118, "phone")).toBe(false);
	});

	it("shows the strip wherever it cannot dock, and nothing only with the pref off", () => {
		expect(workBoardForm({ panelOpen: false, fits: true })).toBe("docked");
		expect(workBoardForm({ panelOpen: false, fits: false })).toBe("strip");
		expect(workBoardForm({ panelOpen: true, fits: true })).toBe("strip");
	});
});

describe("goal row figure", () => {
	it("names the larger share used of the budget and the time, else the time run", () => {
		expect(goalMeta(null)).toBeUndefined();
		expect(goalMeta({ enabled: true, tokenBudget: 200_000, tokensUsed: 50_000 } as never)).toBe("25%");
		expect(
			goalMeta({
				enabled: true,
				tokenBudget: 200_000,
				tokensUsed: 50_000,
				timeLimitSeconds: 100,
				timeUsedSeconds: 90,
			} as never),
		).toBe("90%");
		expect(goalMeta({ enabled: true, tokenBudget: 100, tokensUsed: 250 } as never)).toBe("100%");
		expect(goalMeta({ enabled: true, timeUsedSeconds: 90 } as never)).toBe("1m 30s");
		expect(goalMeta({ enabled: true } as never)).toBeUndefined();
	});

	it("never squeezes the transcript column: reserve and scrollbar fit inside the spare margin", () => {
		expect(WORK_BOARD_WIDTH + WORK_BOARD_GAP + 9).toBeLessThanOrEqual(WORK_BOARD_MIN_SPARE);
	});
});

describe("todoBoard", () => {
	const task = (content: string, status: TodoTask["status"]): TodoTask => ({ content, status });

	it("counts done over total and names the active task, leaving abandoned ones out", () => {
		const board = todoBoard([
			{ tasks: [task("a", "completed"), task("b", "in_progress")] },
			{ tasks: [task("c", "pending"), task("d", "abandoned")] },
		]);
		expect(board).toMatchObject({ done: 1, total: 3, active: "b", hidden: 0 });
		expect(board?.rows.map(row => row.content)).toEqual(["b", "c"]);
	});

	it("has no board for an empty or fully abandoned list", () => {
		expect(todoBoard([])).toBeNull();
		expect(todoBoard([{ tasks: [task("x", "abandoned")] }])).toBeNull();
	});

	it("shows a window around the first open task and counts the rest", () => {
		const tasks = Array.from({ length: 20 }, (_, index) => task(`t${index}`, index < 9 ? "completed" : "pending"));
		const board = todoBoard([{ tasks }]);
		expect(board?.rows).toHaveLength(TODO_BOARD_ROWS);
		expect(board?.rows[0]?.content).toBe("t9");
		expect(board?.hidden).toBe(20 - 9 - TODO_BOARD_ROWS);
		expect(board?.active).toBeNull();
		expect(board?.done).toBe(9);
		expect(board?.segments).toHaveLength(20);
	});

	it("folds a finished list whole: no struck-through rows, short or long", () => {
		for (const length of [3, 10]) {
			const tasks = Array.from({ length }, (_, index) => task(`t${index}`, "completed"));
			expect(todoBoard([{ tasks }])).toMatchObject({ rows: [], hidden: 0, done: length });
		}
	});

	it("folds every finished task into one count wherever it sits, and lists the unfinished ones in order", () => {
		// The user's report: three done before the task in progress folded, two done after it stayed listed.
		const board = todoBoard([
			{
				tasks: [
					task("a", "completed"),
					task("b", "completed"),
					task("c", "completed"),
					task("d", "in_progress"),
					task("e", "completed"),
					task("f", "completed"),
					task("g", "pending"),
				],
			},
			{ tasks: [task("h", "completed"), task("i", "pending")] },
		]);
		expect(board?.rows.map(row => row.content)).toEqual(["d", "g", "i"]);
		expect(board?.rows.every(row => row.status !== "completed")).toBe(true);
		expect(board).toMatchObject({ hidden: 0, done: 6, total: 9 });
	});

	it("counts the unfinished tasks past the row cap, never a finished one", () => {
		const statuses = ["pending", "completed", "pending", "pending", "completed", "pending", "pending", "pending"];
		const board = todoBoard([
			{ tasks: statuses.map((status, index) => task(`t${index}`, status as TodoTask["status"])) },
		]);
		expect(board?.rows.map(row => row.content)).toEqual(["t0", "t2", "t3", "t5", "t6"]);
		expect(board).toMatchObject({ done: 2, hidden: 1 });
	});
});

describe("liveSubagents", () => {
	const agent = (id: string, status: string, index: number): SubagentSnapshot => ({
		id,
		index,
		agent: "task",
		status,
		lastUpdate: 0,
	});

	it("keeps working and waiting agents in spawn order and drops settled ones", () => {
		const rows = liveSubagents(
			new Map([
				["c", agent("c", "running", 2)],
				["a", agent("a", "parked", 0)],
				["b", agent("b", "completed", 1)],
				["d", agent("d", "failed", 3)],
			]),
		);
		expect(rows.map(row => row.id)).toEqual(["a", "c"]);
	});
});

describe("requestLabel", () => {
	const base = { type: "extension_ui_request" } as const;
	const label = (request: ExtensionUIRequest) => requestLabel(request, translate);

	it("names the tool of an approval", () => {
		expect(
			label({
				...base,
				id: "1",
				method: "select",
				title: "Allow tool: bash\nrm -rf build",
				options: ["Approve", "Deny"],
			}),
		).toBe("Allow bash?");
	});

	it("uses a prompt's title and an ask's first question", () => {
		expect(label({ ...base, id: "2", method: "confirm", title: "Overwrite?", message: "" })).toBe("Overwrite?");
		expect(
			label({ ...base, id: "3", method: "ask", questions: [{ id: "q", question: "Which branch?", options: [] }] }),
		).toBe("Which branch?");
	});
});

describe("boardCounts", () => {
	const idle = {
		asks: [] as AskKind[],
		childrenWaiting: 0,
		childrenRunning: 0,
		checkFailed: false,
		agents: 0,
		agentsWorking: 0,
		jobs: 0,
		turnWorking: false,
	};

	it("counts what needs the person once: asks, waiting children and a failed check", () => {
		const counts = boardCounts({ ...idle, asks: ["question", "approval"], childrenWaiting: 1, checkFailed: true });
		expect(counts).toMatchObject({ asks: 2, children: 1, failed: 1, needs: 4, pulse: "waiting" });
		expect(counts.attention).toEqual({ kind: "question", count: 4 });
	});

	it("turns the pulse to waiting for a question or a waiting child, and to failed for a failed check alone", () => {
		expect(boardCounts({ ...idle, checkFailed: true })).toMatchObject({ needs: 1, pulse: "failed" });
		expect(boardCounts({ ...idle, childrenWaiting: 1, turnWorking: true })).toMatchObject({ pulse: "waiting" });
		expect(boardCounts({ ...idle, asks: ["question"], checkFailed: true })).toMatchObject({ pulse: "waiting" });
		// A failed check never overrides work going on: the agent may be fixing it.
		expect(boardCounts({ ...idle, checkFailed: true, turnWorking: true })).toMatchObject({
			needs: 1,
			pulse: "working",
		});
	});

	it("counts subagents and jobs as running and children at work apart, a parked subagent not as working", () => {
		const counts = boardCounts({ ...idle, agents: 3, agentsWorking: 1, jobs: 2, childrenRunning: 1 });
		expect(counts).toMatchObject({ running: 5, childrenRunning: 1, working: 4, pulse: "working" });
	});

	it("reads a lone running child, or a turn, as working", () => {
		expect(boardCounts({ ...idle, childrenRunning: 1 })).toMatchObject({ running: 0, working: 1, pulse: "working" });
		expect(boardCounts({ ...idle, turnWorking: true })).toMatchObject({ running: 0, working: 1, pulse: "working" });
		expect(boardCounts(idle)).toMatchObject({ needs: 0, working: 0, pulse: "idle" });
	});
});

describe("workingSubagents", () => {
	it("leaves out a parked or idle subagent, which is live but not at work", () => {
		const agent = (id: string, status: SubagentSnapshot["status"]) => ({ id, status }) as SubagentSnapshot;
		expect(
			workingSubagents([agent("a", "running"), agent("b", "parked"), agent("c", "idle")]).map(a => a.id),
		).toEqual(["a"]);
		expect(isWaitingSubagent("parked")).toBe(true);
		expect(isWaitingSubagent("running")).toBe(false);
	});
});

describe("the board's quota gauges beside the sidebar's", () => {
	const css = readFileSync(new URL("../../../styles/work-board.css", import.meta.url), "utf8");

	it("hides only while the sidebar's usage block is expanded and shows every provider", () => {
		expect(css).toContain(
			'.omp-shell[data-sidebar="docked"]:has(.omp-sidebar-usage:not([data-collapsed], [data-capped])) .omp-work-board-account',
		);
	});
});
