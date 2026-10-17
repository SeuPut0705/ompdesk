import { afterEach, describe, expect, it } from "vitest";
import { useComposerStore } from "../stores/composer";
import { useUiStore } from "../stores/ui";
import { useHostUiStore } from "./host-ui/host-ui-store";
import { pageSafeMoment } from "./safe-moment";
import { safeToReload } from "./sw-update";

afterEach(() => {
	useComposerStore.getState().reset();
	useUiStore.setState({ fileEditDirty: false, pendingFileSwitch: null });
	useHostUiStore.getState().reset();
});

describe("pageSafeMoment", () => {
	const moment = pageSafeMoment(() => true);

	it("is safe on a quiet page", () => {
		expect(safeToReload(moment)).toBe(true);
	});

	it("keeps the page while the Files editor holds unsaved changes, until they are saved or discarded", () => {
		useUiStore.getState().setFileEditDirty(true);
		expect(safeToReload(moment)).toBe(false);
		useUiStore.getState().setFileEditDirty(false); // saved
		expect(safeToReload(moment)).toBe(true);
		useUiStore.setState({ fileEditDirty: true, pendingFileSwitch: { filePreviewPath: "a.ts" } });
		expect(safeToReload(moment)).toBe(false);
		useUiStore.getState().resolveFileSwitch(true); // discarded
		expect(safeToReload(moment)).toBe(true);
	});

	it("keeps the page while a host sheet or dialog (editor, models config, confirm) is open", () => {
		useHostUiStore.getState().push({ kind: "quit", resolve: () => {} });
		expect(safeToReload(moment)).toBe(false);
		useHostUiStore.getState().shift();
		expect(safeToReload(moment)).toBe(true);
	});

	it("keeps the page for a composer draft", () => {
		useComposerStore.getState().setDraft("half a thought");
		expect(safeToReload(moment)).toBe(false);
	});

	it("never reloads a hidden page", () => {
		expect(safeToReload(pageSafeMoment(() => false))).toBe(false);
	});
});
