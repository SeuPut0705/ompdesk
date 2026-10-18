/**
 * Window events other surfaces fill or drive the composer through, each for one tab (`tabId`, else the active tab):
 * `omp:insert-mention` appends an `@path` mention (the Files tree, a drop), `omp:fill-composer` places a text
 * and pictures (starter cards, history recall, a dequeue restore, the editor dialog), `omp:composer-action` runs
 * History / Expand / Attach (the command palette).
 */
import { type RefObject, useEffect } from "react";
import type { ImageContent } from "../../../../shared/rpc-types";
import {
	COMPOSER_ACTION_EVENT,
	type ComposerActionDetail,
	type ComposerWindowAction,
} from "../../../lib/composer-actions";
import { dropReferencedPastes } from "../../../lib/paste-blobs";
import { type ComposerImage, type ComposerStore, prependToDraft } from "../../../stores/composer";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { fileMentionFor } from "./composer-files";

export function useComposerEvents({
	runtimeTabId,
	textareaRef,
	setText,
	setImages,
	placeDraft,
}: {
	runtimeTabId: string | null;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	setText: (next: (current: string) => string) => void;
	setImages: (next: (current: ComposerImage[]) => ComposerImage[]) => void;
	placeDraft: (next: string, caret: number) => void;
}): void {
	useEffect(() => {
		const onInsertMention = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string; tabId?: string }>).detail;
			if ((detail?.tabId ?? useTabsStore.getState().activeTabId) !== runtimeTabId) return;
			const path = detail?.path;
			if (!path) return;
			const mention = fileMentionFor(path, "");
			setText(current => `${current}${current && !current.endsWith(" ") ? " " : ""}${mention} `);
			requestAnimationFrame(() => textareaRef.current?.focus());
		};
		window.addEventListener("omp:insert-mention", onInsertMention);
		return () => window.removeEventListener("omp:insert-mention", onInsertMention);
	}, [setText, runtimeTabId, textareaRef]);

	useEffect(() => {
		const fillComposer = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					text?: string;
					images?: ImageContent[];
					prepend?: boolean;
					clearPastes?: boolean;
					tabId?: string;
				}>
			).detail;
			if ((detail?.tabId ?? useTabsStore.getState().activeTabId) !== runtimeTabId) return;
			const next = detail?.text;
			const restoredImages = detail?.images ?? [];
			if (!next && restoredImages.length === 0) return;
			// The editor dialog writes back fully-inline text — consume the blobs.
			if (detail?.clearPastes)
				dropReferencedPastes(sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer")?.getState().draft ?? "");
			if (next) {
				// prepend (dequeue restore): queued text goes ahead of any draft, TUI-style;
				// otherwise replace (starter cards, history recall).
				const current =
					textareaRef.current?.value ??
					sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer")?.getState().draft ??
					"";
				placeDraft(detail?.prepend ? prependToDraft(next, current) : next, next.length);
			}
			if (restoredImages.length > 0) {
				setImages(current => [
					...current,
					...restoredImages.map(content => ({
						content,
						preview: `data:${content.mimeType};base64,${content.data}`,
					})),
				]);
			}
			// Focus waits a frame: the surface that sent the text (a dialog, a menu) may still
			// hand focus back as it closes. Focus keeps the caret placed above.
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) return;
				if (useTabsStore.getState().activeTabId !== runtimeTabId) return;
				el.focus();
			});
		};
		window.addEventListener("omp:fill-composer", fillComposer);
		return () => window.removeEventListener("omp:fill-composer", fillComposer);
	}, [placeDraft, setImages, runtimeTabId, textareaRef]);
}

/** The palette's History, Expand and Attach rows (`lib/composer-actions.ts`), answered by this tab's composer. */
export function useComposerActionEvents(
	runtimeTabId: string | null,
	onAction: (action: ComposerWindowAction) => void,
): void {
	useEffect(() => {
		const handle = (event: Event) => {
			const detail = (event as CustomEvent<ComposerActionDetail>).detail;
			if ((detail?.tabId ?? useTabsStore.getState().activeTabId) !== runtimeTabId) return;
			onAction(detail.action);
		};
		window.addEventListener(COMPOSER_ACTION_EVENT, handle);
		return () => window.removeEventListener(COMPOSER_ACTION_EVENT, handle);
	}, [runtimeTabId, onAction]);
}
