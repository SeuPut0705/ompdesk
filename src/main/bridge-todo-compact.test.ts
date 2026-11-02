import { describe, expect, it } from "vitest";
import { type TodoCompactPhase, todoCompaction } from "../../resources/gui-bridge/todo-compact-core";

function list(closed: number, open: number, blocked = 0): TodoCompactPhase[] {
	return [
		{
			name: "Work",
			tasks: [
				...Array.from({ length: closed }, (_, index) => ({
					content: `done ${index}`,
					status: index % 5 === 4 ? "abandoned" : "completed",
				})),
				...Array.from({ length: blocked }, (_, index) => ({ content: `blocked ${index}`, status: "blocked" })),
				...Array.from({ length: open }, (_, index) => ({ content: `open ${index}`, status: "pending" })),
			],
		},
	];
}

describe("todoCompaction", () => {
	it("asks for a fold when an append grows a list past 20 items with 10 finished", () => {
		expect(todoCompaction("append", list(12, 7, 2))).toEqual({ total: 21, closed: 12, open: 9 });
	});

	it("counts dropped items as finished and blocked ones as open", () => {
		expect(todoCompaction("append", list(10, 9, 2))).toMatchObject({ closed: 10, open: 11 });
	});

	it("leaves a list of 20 alone, and a long list with fewer than 10 finished", () => {
		expect(todoCompaction("append", list(12, 8))).toBeUndefined();
		expect(todoCompaction("append", list(9, 25))).toBeUndefined();
	});

	it("speaks only after an append: ticking, dropping or re-planning a long list says nothing", () => {
		for (const op of ["done", "drop", "block", "start", "init", "rm", "view", undefined])
			expect(todoCompaction(op, list(33, 3, 2))).toBeUndefined();
	});

	it("stays quiet once the owner's 38-item list is folded to a summary and its open items", () => {
		const grown = list(33, 3, 2);
		expect(todoCompaction("append", grown)).toEqual({ total: 38, closed: 33, open: 5 });
		const folded: TodoCompactPhase[] = [
			{ name: "Done", tasks: [{ content: "Done: 33 items", status: "completed" }] },
			{
				name: "Work",
				tasks: grown[0].tasks.filter(task => task.status !== "completed" && task.status !== "abandoned"),
			},
		];
		expect(todoCompaction("append", folded)).toBeUndefined();
	});
});
