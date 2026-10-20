import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest, SubagentSnapshot, TodoTask } from "../../../../shared/rpc-types";
import { translate } from "../../../lib/i18n";
import {
	goalMeta,
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

	it("docks on a tablet held sideways beside a column narrowed to what still reads, never on a desktop", () => {
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
		// A desktop window (no shell) and a portrait tablet keep the full column: the strip.
		expect(workBoardDocks(1118, null)).toBe(false);
		expect(workBoardDocks(1118, "tablet-portrait")).toBe(false);
		expect(workBoardDocks(1137, null)).toBe(true);
	});

	it("shows the strip wherever it cannot dock, and nothing only with the pref off", () => {
		expect(workBoardForm({ enabled: true, panelOpen: false, fits: true })).toBe("docked");
		expect(workBoardForm({ enabled: true, panelOpen: false, fits: false })).toBe("strip");
		expect(workBoardForm({ enabled: true, panelOpen: true, fits: true })).toBe("strip");
		expect(workBoardForm({ enabled: false, panelOpen: false, fits: true })).toBe("off");
		expect(workBoardForm({ enabled: false, panelOpen: true, fits: false })).toBe("off");
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
		expect(board?.doneBefore).toBe(9);
		expect(board?.segments).toHaveLength(20);
	});

	it("shows the tail of a finished list", () => {
		const tasks = Array.from({ length: 10 }, (_, index) => task(`t${index}`, "completed"));
		const board = todoBoard([{ tasks }]);
		expect(board?.rows.at(-1)?.content).toBe("t9");
		expect(board?.hidden).toBe(0);
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
