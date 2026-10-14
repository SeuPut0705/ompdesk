import type { ContextMenuParams } from "electron";
import { describe, expect, it, vi } from "vitest";
import { type EditLabels, editableContextMenuTemplate } from "./editable-context-menu";

const LABELS: EditLabels = {
	undo: "실행 취소",
	redo: "실행 복귀",
	cut: "오려두기",
	copy: "복사하기",
	paste: "붙여넣기",
	selectAll: "전체 선택",
	addToDictionary: "사전에 추가",
};

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
	return {
		isEditable: true,
		misspelledWord: "teh",
		dictionarySuggestions: ["the", "tech", "the"],
		...overrides,
	} as ContextMenuParams;
}

describe("editableContextMenuTemplate", () => {
	it("offers deduplicated spelling replacements and dictionary learning before native edit roles", () => {
		const replaceMisspelling = vi.fn();
		const addToDictionary = vi.fn();
		const menu = editableContextMenuTemplate(params(), LABELS, {
			replaceMisspelling,
			addToDictionary,
		});

		expect(menu.slice(0, 3).map(item => item.label)).toEqual(["the", "tech", "사전에 추가"]);
		menu[0]?.click?.(undefined as never, undefined as never, undefined as never);
		menu[2]?.click?.(undefined as never, undefined as never, undefined as never);
		expect(replaceMisspelling).toHaveBeenCalledWith("the");
		expect(addToDictionary).toHaveBeenCalledWith("teh");
		expect(menu.find(item => item.role === "paste")?.label).toBe("붙여넣기");
		// Every native edit item carries the UI language's name, never Electron's English default.
		expect(menu.filter(item => item.role !== undefined && item.label === undefined)).toEqual([]);
	});

	it("does not replace non-editable application context menus", () => {
		expect(
			editableContextMenuTemplate(params({ isEditable: false }), LABELS, {
				replaceMisspelling: vi.fn(),
				addToDictionary: vi.fn(),
			}),
		).toEqual([]);
	});
});
