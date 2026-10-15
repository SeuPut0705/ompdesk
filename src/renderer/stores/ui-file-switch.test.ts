/** C2: while the Files editor holds unsaved edits, a switch to another file waits for the user's answer. */

import { afterEach, expect, it } from "vitest";
import { useUiStore } from "./ui";

afterEach(() => {
	useUiStore.setState({
		filePreviewPath: null,
		filePreviewLine: null,
		filesRevealPath: null,
		fileEditDirty: false,
		pendingFileSwitch: null,
	});
});

it("holds back another file while dirty, applies it on proceed and drops it on cancel", () => {
	const ui = useUiStore.getState();
	ui.openFilePreview("notes.md");
	ui.setFileEditDirty(true);

	ui.openFilePreview("src/app.ts", { line: 4 });
	expect(useUiStore.getState()).toMatchObject({
		filePreviewPath: "notes.md",
		pendingFileSwitch: { filePreviewPath: "src/app.ts", filePreviewLine: 4 },
	});
	ui.resolveFileSwitch(false);
	expect(useUiStore.getState()).toMatchObject({ filePreviewPath: "notes.md", pendingFileSwitch: null });

	ui.revealInFiles("src/");
	ui.resolveFileSwitch(true);
	expect(useUiStore.getState()).toMatchObject({
		filePreviewPath: null,
		filesRevealPath: "src/",
		fileEditDirty: false,
		pendingFileSwitch: null,
	});
});

it("lets the same file (another line) and a clean editor through at once", () => {
	const ui = useUiStore.getState();
	ui.openFilePreview("notes.md");
	ui.setFileEditDirty(true);
	ui.openFilePreview("notes.md", { line: 9 });
	expect(useUiStore.getState()).toMatchObject({ filePreviewLine: 9, pendingFileSwitch: null });
	ui.setFileEditDirty(false);
	ui.openFilesSearch();
	expect(useUiStore.getState()).toMatchObject({ filePreviewPath: null, pendingFileSwitch: null });
});
