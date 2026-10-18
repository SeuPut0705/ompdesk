/**
 * The unsent draft outlives a reload and a relaunch (draft-persistence.ts): the session's saved text comes back
 * into an empty field once the session is known, and every change is saved.
 */
import { useEffect, useMemo, useState } from "react";
import { expandPasteMarkers } from "../../../lib/paste-blobs";
import { type ComposerStore, useComposerStore } from "../../../stores/composer";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { draftKeys, loadDraft, saveDraft } from "./draft-persistence";

/** Typing pause before the draft is saved for a reload or relaunch. */
const DRAFT_SAVE_MS = 300;
/** The window's localStorage; absent (tests, a locked-down page) the draft only lives in memory. */
const browserStorage: Storage | undefined = (() => {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
})();

export function useComposerDraft({
	text,
	runtimeTabId,
	device,
	sessionFile,
	sessionId,
	cwd,
	empty,
}: Parameters<typeof draftKeys>[0] & {
	text: string;
	runtimeTabId: string | null;
}): void {
	const draftStore = useMemo(
		() => draftKeys({ device, sessionFile, sessionId, cwd, empty }),
		[device, sessionFile, sessionId, cwd, empty],
	);
	/** The session key whose saved draft was read; saving waits for it so an empty first render never erases it. */
	const [draftLoadedFor, setDraftLoadedFor] = useState<string | null>(null);
	useEffect(() => {
		if (!draftStore || draftLoadedFor === draftStore.session || !browserStorage) return;
		const composer = sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer") ?? useComposerStore;
		if (composer.getState().draft === "") {
			const saved = loadDraft(browserStorage, draftStore, performance.timeOrigin);
			if (saved !== undefined) composer.getState().setDraft(saved);
		}
		setDraftLoadedFor(draftStore.session);
	}, [draftStore, draftLoadedFor, runtimeTabId]);
	useEffect(() => {
		if (!draftStore || draftLoadedFor !== draftStore.session || !browserStorage) return;
		const storage = browserStorage;
		// A sent or cleared draft is dropped at once; typing is saved once it pauses, and before the page goes (a
		// reload for missed events or an update may come right after an upload put its path in the draft).
		const save = () => saveDraft(storage, draftStore, expandPasteMarkers(text));
		const timer = setTimeout(save, text ? DRAFT_SAVE_MS : 0);
		window.addEventListener("pagehide", save);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("pagehide", save);
		};
	}, [text, draftStore, draftLoadedFor]);
}
