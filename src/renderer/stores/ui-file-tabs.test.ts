/** D29: the Files viewer's strip — one preview tab the next file replaces, kept tabs that stay. */

import { afterEach, expect, it } from "vitest";
import { useUiStore, withFileTab } from "./ui";

afterEach(() => {
	useUiStore.setState({
		filePreviewPath: null,
		filePreviewLine: null,
		filePreviewExpanded: false,
		fileTabs: [],
		fileEditDirty: false,
		pendingFileSwitch: null,
	});
});

it("reuses an open tab, keeps it on request and otherwise replaces the preview tab", () => {
	const kept = { path: "a.ts", preview: false };
	expect(withFileTab([], "a.ts", false)).toEqual([{ path: "a.ts", preview: true }]);
	expect(withFileTab([kept, { path: "b.ts", preview: true }], "c.ts", false)).toEqual([
		kept,
		{ path: "c.ts", preview: true },
	]);
	expect(withFileTab([kept], "c.ts", true)).toEqual([kept, { path: "c.ts", preview: false }]);
	const tabs = [kept, { path: "b.ts", preview: true }];
	expect(withFileTab(tabs, "b.ts", false)).toBe(tabs);
	expect(withFileTab(tabs, "b.ts", true)).toEqual([kept, { path: "b.ts", preview: false }]);
});

it("opens files into the preview tab until one is kept, and Back drops only the preview tab", () => {
	const ui = useUiStore.getState();
	ui.openFilePreview("a.ts");
	ui.openFilePreview("b.ts");
	expect(useUiStore.getState().fileTabs).toEqual([{ path: "b.ts", preview: true }]);

	ui.keepFileOpen("b.ts");
	ui.openFilePreview("c.ts");
	ui.openFilePreview("d.ts", { keep: true });
	expect(useUiStore.getState().fileTabs).toEqual([
		{ path: "b.ts", preview: false },
		{ path: "c.ts", preview: true },
		{ path: "d.ts", preview: false },
	]);

	ui.openFilePreview("c.ts");
	ui.closeFilePreview();
	expect(useUiStore.getState()).toMatchObject({
		filePreviewPath: null,
		fileTabs: [
			{ path: "b.ts", preview: false },
			{ path: "d.ts", preview: false },
		],
	});
});

it("closes a tab onto its neighbour, back to the tree after the last, and waits on unsaved edits", () => {
	const ui = useUiStore.getState();
	for (const path of ["a.ts", "b.ts", "c.ts"]) ui.openFilePreview(path, { keep: true });
	ui.openFilePreview("b.ts");

	ui.closeFileTab("a.ts");
	expect(useUiStore.getState()).toMatchObject({
		filePreviewPath: "b.ts",
		fileTabs: [{ path: "b.ts" }, { path: "c.ts" }],
	});

	ui.setFileEditDirty(true);
	ui.closeFileTab("b.ts");
	expect(useUiStore.getState()).toMatchObject({
		filePreviewPath: "b.ts",
		pendingFileSwitch: { filePreviewPath: "c.ts", fileTabs: [{ path: "c.ts" }] },
	});
	ui.resolveFileSwitch(true);
	expect(useUiStore.getState()).toMatchObject({ filePreviewPath: "c.ts", fileTabs: [{ path: "c.ts" }] });

	ui.closeFileTab("c.ts");
	expect(useUiStore.getState()).toMatchObject({ filePreviewPath: null, fileTabs: [] });
});
