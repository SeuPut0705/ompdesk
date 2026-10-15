/** C2: while the Files editor holds unsaved edits, a switch to another file waits for the user's answer. */

import { afterEach, expect, it } from "vitest";
import { useUiStore } from "./ui";

afterEach(() => {
	useUiStore.setState({
		filePreviewPath: null,
		fileTabs: [],
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

it("holds back a switch to another panel view, subagent or preview, and closing the panel, while the editor is dirty", () => {
	const ui = useUiStore.getState();
	ui.openFilePreview("notes.md");
	ui.setFileEditDirty(true);

	ui.setPanelTab("diff");
	expect(useUiStore.getState()).toMatchObject({
		panelTab: "files",
		pendingFileSwitch: { panelTab: "diff", panelVisible: true },
	});
	ui.resolveFileSwitch(false);
	ui.openPreview("http://localhost:3000");
	expect(useUiStore.getState()).toMatchObject({
		panelTab: "files",
		previewUrl: null,
		pendingFileSwitch: { panelTab: "preview", previewUrl: "http://localhost:3000" },
	});
	ui.resolveFileSwitch(false);
	ui.openSubagentPanel({ tabId: "t", agentId: "a" });
	expect(useUiStore.getState()).toMatchObject({ panelTab: "files", pendingFileSwitch: { panelTab: "subagent" } });
	ui.resolveFileSwitch(false);
	ui.togglePanel();
	expect(useUiStore.getState()).toMatchObject({ panelVisible: true, pendingFileSwitch: { panelVisible: false } });
	ui.resolveFileSwitch(true);
	expect(useUiStore.getState()).toMatchObject({ panelVisible: false, fileEditDirty: false, pendingFileSwitch: null });

	// Staying on Files, or a clean editor, never asks.
	useUiStore.setState({ panelVisible: true, panelTab: "files" });
	ui.setFileEditDirty(true);
	ui.setPanelTab("files");
	expect(useUiStore.getState().pendingFileSwitch).toBeNull();
	ui.setFileEditDirty(false);
	ui.setPanelTab("diff");
	expect(useUiStore.getState()).toMatchObject({ panelTab: "diff", pendingFileSwitch: null });
});

it("keeps the Files view while the editor holds unsaved edits when another session takes the focus, and closes it once clean", () => {
	const ui = useUiStore.getState();
	ui.openFilePreview("notes.md");
	ui.setFileEditDirty(true);
	ui.closeSessionOverlays();
	expect(useUiStore.getState()).toMatchObject({ filePreviewPath: "notes.md", fileTabs: [{ path: "notes.md" }] });

	ui.setFileEditDirty(false);
	ui.closeSessionOverlays();
	expect(useUiStore.getState()).toMatchObject({ filePreviewPath: null, fileTabs: [] });
});
