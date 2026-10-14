import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** Names of the edit items in the UI language (Electron's role defaults are English only). */
export type EditLabels = Record<
	"undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "addToDictionary" | "copyImage",
	string
>;

interface EditableContextMenuActions {
	replaceMisspelling: (suggestion: string) => void;
	addToDictionary: (word: string) => void;
	/** Copies the image under the pointer (`webContents.copyImageAt`). */
	copyImageAt: (x: number, y: number) => void;
}

/** The native edit items, shared by the Edit menu and a text field's context menu. */
export function editRoleItems(labels: EditLabels): MenuItemConstructorOptions[] {
	return [
		{ role: "undo", label: labels.undo },
		{ role: "redo", label: labels.redo },
		{ type: "separator" },
		{ role: "cut", label: labels.cut },
		{ role: "copy", label: labels.copy },
		{ role: "paste", label: labels.paste },
		{ role: "selectAll", label: labels.selectAll },
	];
}

/**
 * Native edit menu with platform spellchecker suggestions for editable fields;
 * on an image (a reply's picture, an attachment preview) a "Copy image" item.
 * Anything else gets no native menu.
 */
export function editableContextMenuTemplate(
	params: ContextMenuParams,
	labels: EditLabels,
	actions: EditableContextMenuActions,
): MenuItemConstructorOptions[] {
	if (!params.isEditable) {
		if (params.mediaType !== "image" || !params.hasImageContents) return [];
		return [{ label: labels.copyImage, click: () => actions.copyImageAt(params.x, params.y) }];
	}
	const spelling: MenuItemConstructorOptions[] = [];
	for (const suggestion of [...new Set(params.dictionarySuggestions)].slice(0, 5)) {
		spelling.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
	}
	if (params.misspelledWord) {
		spelling.push({
			label: labels.addToDictionary,
			click: () => actions.addToDictionary(params.misspelledWord),
		});
	}
	return [
		...spelling,
		...(spelling.length > 0 ? ([{ type: "separator" }] as MenuItemConstructorOptions[]) : []),
		...editRoleItems(labels),
	];
}
