import { afterEach, describe, expect, it } from "vitest";
import { trackFilePick } from "../lib/file-pick";
import { useComposerStore } from "../stores/composer";
import { useUiStore } from "../stores/ui";
import { useHostUiStore } from "./host-ui/host-ui-store";
import { pageSafeMoment } from "./safe-moment";
import { reloadLosesNothing, safeToReload } from "./sw-update";

const picture = { content: { type: "image" as const, data: "AA==", mimeType: "image/png" }, preview: "" };

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

	it("keeps the page through a file pick: the files arrive just after the page comes back from the picker", () => {
		const view = Object.assign(new EventTarget(), {
			document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
		}) as unknown as Window;
		const done = trackFilePick(new EventTarget() as unknown as HTMLInputElement, view);
		expect(safeToReload(moment)).toBe(false);
		expect(reloadLosesNothing(pageSafeMoment(() => false))).toBe(false);
		done();
		expect(safeToReload(moment)).toBe(true);
	});
});

describe("reloadLosesNothing (the reload after missed events)", () => {
	const hidden = pageSafeMoment(() => false);

	it("reloads a hidden page or one with typed text: the text outlives the reload", () => {
		useComposerStore.getState().setDraft("half a thought");
		expect(reloadLosesNothing(hidden)).toBe(true);
	});

	it("waits while the composer holds a picture, which lives only in this page", () => {
		useComposerStore.getState().setImages([picture]);
		expect(reloadLosesNothing(hidden)).toBe(false);
		useComposerStore.getState().setImages([]);
		expect(reloadLosesNothing(hidden)).toBe(true);
	});

	it("waits for unsaved edits", () => {
		useUiStore.getState().setFileEditDirty(true);
		expect(reloadLosesNothing(hidden)).toBe(false);
	});
});
