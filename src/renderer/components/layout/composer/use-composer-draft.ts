/**
 * The unsent draft outlives a reload and a relaunch (draft-persistence.ts): the session's saved text comes back
 * into an empty field once the session is known, and every change is saved: after a typing pause, and at once when
 * the page is hidden or closing (`visibilitychange`, `pagehide`), so the last keystrokes survive a reload.
 * The saved text has its folded pastes expanded (their blobs live in memory); pictures are not kept, and a
 * restore that lost some says so. A draft past the size cap is not kept, which is said once.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { expandPasteMarkers } from "../../../lib/paste-blobs";
import { type ComposerStore, useComposerStore } from "../../../stores/composer";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { toast } from "../../../stores/toast";
import { draftImagesLost, draftKeys, loadDraft, saveDraft } from "./draft-persistence";

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
	imageCount,
	runtimeTabId,
	device,
	sessionFile,
	sessionId,
	cwd,
	empty,
}: Parameters<typeof draftKeys>[0] & {
	text: string;
	/** Pictures attached now: filed as a count only, so a restore can say they were not kept. */
	imageCount: number;
	runtimeTabId: string | null;
}): void {
	const t = useT();
	const draftStore = useMemo(
		() => draftKeys({ device, sessionFile, sessionId, cwd, empty }),
		[device, sessionFile, sessionId, cwd, empty],
	);
	/** The session key whose saved draft was read; saving waits for it so an empty first render never erases it. */
	const [draftLoadedFor, setDraftLoadedFor] = useState<string | null>(null);
	/** The latest draft and pictures, read by the flush listeners without re-binding them per keystroke. */
	const latest = useRef({ text, imageCount });
	latest.current = { text, imageCount };
	/** A session whose too-large draft was already announced. */
	const announcedLarge = useRef<string | null>(null);
	/** The latest draft's save: the composer leaving the screen (a crash at the root, a closed view) flushes it. */
	const flush = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (!draftStore || draftLoadedFor === draftStore.session || !browserStorage) return;
		const composer = sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer") ?? useComposerStore;
		if (composer.getState().draft === "") {
			const lost = draftImagesLost(browserStorage, draftStore);
			const saved = loadDraft(browserStorage, draftStore, performance.timeOrigin);
			if (saved !== undefined) composer.getState().setDraft(saved);
			// Pictures are not kept across a reload: say so instead of silently dropping them (PT-22).
			if (lost > 0 && composer.getState().images.length === 0)
				toast({ variant: "info", message: t("input.draft.imagesLost", { count: lost }) });
		}
		setDraftLoadedFor(draftStore.session);
	}, [draftStore, draftLoadedFor, runtimeTabId, t]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `imageCount` re-arms the pause; `save` reads the latest values
	useEffect(() => {
		if (!draftStore || draftLoadedFor !== draftStore.session || !browserStorage) {
			flush.current = null;
			return;
		}
		const storage = browserStorage;
		const save = () => {
			const { text: current, imageCount: pictures } = latest.current;
			const result = saveDraft(storage, draftStore, expandPasteMarkers(current), Date.now(), pictures);
			if (result === "tooLarge" && announcedLarge.current !== draftStore.session) {
				announcedLarge.current = draftStore.session;
				toast({ variant: "warning", message: t("input.draft.tooLarge") });
			}
		};
		flush.current = save;
		// A sent or cleared draft is dropped at once; typing is saved once it pauses, and before the page goes (a
		// reload for missed events or an update may come right after an upload put its path in the draft).
		const timer = setTimeout(save, text ? DRAFT_SAVE_MS : 0);
		const onHidden = () => {
			if (document.visibilityState === "hidden") save();
		};
		window.addEventListener("pagehide", save);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("pagehide", save);
			document.removeEventListener("visibilitychange", onHidden);
		};
	}, [text, imageCount, draftStore, draftLoadedFor, t]);
	// Unmounted with a save still pending (its timer and listeners just went): the text is kept now.
	useEffect(() => () => flush.current?.(), []);
}
