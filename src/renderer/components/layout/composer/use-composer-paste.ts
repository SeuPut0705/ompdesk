/**
 * Pasting into the composer: clipboard files attach, text past the marker size folds into a `[Paste #N]` marker,
 * and text past the paste-menu threshold first offers the large-paste choice (PasteMenu). The menu's four actions
 * are reachable from the keyboard while the field keeps the caret, and a click elsewhere keeps the paste.
 */
import type { ClipboardEvent, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { useT } from "../../../lib/i18n";
import {
	isMarkerSized,
	type PasteBlob,
	pasteMarkerText,
	releasePaste,
	shouldOfferPasteMenu,
	storePaste,
	wrapPasteInAttachmentBlock,
} from "../../../lib/paste-blobs";
import { useTabRpc } from "../../../lib/tab-rpc";
import type { SessionStore } from "../../../stores/session";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { toast, toastError } from "../../../stores/toast";

/** A large paste waiting for its form: the paste already happened, the menu only picks how it goes in. */
export interface PendingPaste {
	content: string;
	lineCount: number;
}

/** The menu's actions in order: inline, wrapped block, saved file, cancel. */
export const PASTE_ACTIONS = 4;

export interface ComposerPaste {
	/** The pending large-paste choice, or null. */
	pending: PendingPaste | null;
	/** The menu's root: a pointer down outside it keeps the paste (inline). */
	menuRef: RefObject<HTMLDivElement | null>;
	/** The action the keyboard is on (0 inline, 1 wrapped, 2 file, 3 cancel). */
	active: number;
	/** Move the keyboard's action by `by` (wraps). */
	moveActive: (by: number) => void;
	/** Run the action the keyboard is on. */
	activate: () => void;
	/** Drop the pending choice (nothing goes in). */
	cancel: () => void;
	chooseInline: () => void;
	chooseWrapped: () => void;
	chooseSaveFile: () => void;
	/** The field's `onPaste`. */
	onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
}

export function useComposerPaste({
	text,
	textareaRef,
	placeDraft,
	attachFiles,
	runtimeTabId,
}: {
	text: string;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeDraft: (next: string, caret: number) => void;
	attachFiles: (files: readonly File[]) => Promise<void>;
	runtimeTabId: string | null;
}): ComposerPaste {
	const t = useT();
	const rpc = useTabRpc();
	/** Agent `paste.largeMenuThreshold` setting: line count that triggers the paste menu. */
	const pasteMenuThreshold = useDisplayPreference("pasteMenuThreshold");
	const [pending, setPending] = useState<PendingPaste | null>(null);
	const [active, setActive] = useState(0);
	const menuRef = useRef<HTMLDivElement>(null);
	const cancel = useCallback(() => setPending(null), []);
	const moveActive = useCallback(
		(by: number) => setActive(current => (current + by + PASTE_ACTIONS) % PASTE_ACTIONS),
		[],
	);
	// A fresh choice starts on its first action.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new pending paste resets the action
	useEffect(() => {
		setActive(0);
	}, [pending]);

	// Collapse a large paste into a `[Paste #N]` marker with the blob held in
	// memory; the marker expands back to full content at submit time (TUI
	// editor.ts parity). Inserted at the caret, replacing any selection.
	const insertPasteBlob = useCallback(
		(content: string): PasteBlob => {
			const blob = storePaste(content);
			const marker = pasteMarkerText(blob.id, blob.content);
			const el = textareaRef.current;
			const current = el?.value ?? text;
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			el?.focus();
			placeDraft(`${current.slice(0, start)}${marker}${current.slice(end)}`, start + marker.length);
			return blob;
		},
		[text, placeDraft, textareaRef],
	);

	// A click elsewhere is not a choice, but it is no reason to lose what was pasted: the paste goes in inline
	// and a toast offers to take it back (the menu used to close and throw the paste away).
	const keepInline = useCallback(
		(paste: PendingPaste) => {
			const before = textareaRef.current?.value ?? text;
			const caret = textareaRef.current?.selectionStart ?? before.length;
			const blob = insertPasteBlob(paste.content);
			setPending(null);
			toast({
				variant: "info",
				message: t("input.paste.keptInline", { lines: paste.lineCount }),
				action: {
					label: t("input.paste.undo"),
					run: () => {
						const field = textareaRef.current;
						const current = field?.value ?? "";
						const marker = pasteMarkerText(blob.id, blob.content);
						const at = current.indexOf(marker);
						releasePaste(blob.id);
						field?.focus();
						// Only the marker goes if the draft moved on since; else the draft is as it was before the paste.
						if (at >= 0) placeDraft(`${current.slice(0, at)}${current.slice(at + marker.length)}`, at);
						else placeDraft(before, caret);
					},
				},
			});
		},
		[insertPasteBlob, placeDraft, t, text, textareaRef],
	);
	useEffect(() => {
		if (!pending) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			keepInline(pending);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [pending, keepInline]);

	// Paste menu actions — the paste always inserts something; the menu only
	// picks the form. Keep side effects outside state updaters: React may replay
	// updater functions, which must never duplicate a paste or an RPC write.
	const chooseInline = useCallback(() => {
		if (!pending) return;
		insertPasteBlob(pending.content);
		setPending(null);
	}, [insertPasteBlob, pending]);

	const chooseWrapped = useCallback(() => {
		if (!pending) return;
		insertPasteBlob(wrapPasteInAttachmentBlock(pending.content));
		setPending(null);
	}, [insertPasteBlob, pending]);

	// Save-as-file: the agent writes the blob into the session's local:// store
	// (counter allocated agent-side so two windows can never collide) and the
	// composer gets the returned literal reference. Any protocol or transport
	// failure falls back to the inline marker, so clipboard content is not lost.
	const chooseSaveFile = useCallback(() => {
		if (!pending) return;
		const pendingPaste = pending;
		setPending(null);
		// The menu's button leaves with it: typing goes on in the field while the file is written.
		textareaRef.current?.focus();
		// Capture tab AND session at click time: after the RPC resolves,
		// `setText` may belong to a different tab's draft (tab switch) or a
		// different session's draft (in-place session replace). Both success
		// and fallback paths are gated — a cross-session paste corrupts both.
		const origin = {
			tabId: runtimeTabId,
			sessionId: sessionRuntimeStore<SessionStore>(runtimeTabId, "session")?.getState().sessionId,
		};
		const stillOrigin = () =>
			origin.tabId !== null &&
			sessionRuntimeStore<SessionStore>(origin.tabId, "session")?.getState().sessionId === origin.sessionId;
		void (async () => {
			try {
				const response = await rpc.writeLocalPaste(pendingPaste.content);
				if (!stillOrigin()) return;
				if (!response.success) throw new Error(response.error);
				const data = response.data as { url?: string } | undefined;
				if (!data?.url) throw new Error("write_local_paste returned no URL");
				const el = textareaRef.current;
				const current = el?.value ?? text;
				const start = el?.selectionStart ?? current.length;
				const end = el?.selectionEnd ?? start;
				const insert = `${data.url} `;
				el?.focus();
				placeDraft(`${current.slice(0, start)}${insert}${current.slice(end)}`, start + insert.length);
			} catch (cause) {
				// The RPC threw (transport/permission): without the origin gate the
				// inline fallback would splice clipboard content into whichever
				// composer is now foreground.
				if (!stillOrigin()) return;
				toastError({ title: t("input.paste.saveFailed"), error: cause });
				insertPasteBlob(pendingPaste.content);
			}
		})();
	}, [insertPasteBlob, pending, text, t, placeDraft, runtimeTabId, rpc, textareaRef]);

	/** Run the action the keyboard is on. */
	const activate = useCallback(() => {
		if (active === 0) chooseInline();
		else if (active === 1) chooseWrapped();
		else if (active === 2) chooseSaveFile();
		else cancel();
	}, [active, cancel, chooseInline, chooseSaveFile, chooseWrapped]);

	/**
	 * A clipboard's text. Large TEXT paste (TUI editor.ts:1996-2044 parity): sanitize, then collapse to a
	 * `[Paste #N]` marker past the marker threshold; past the (separate, line-count-only) menu threshold,
	 * offer the inline/wrapped choice first. A small paste is the field's own default unless `own` (the
	 * default was cancelled for a file beside it): then it goes in at the caret here. False when the
	 * field's default paste should run.
	 */
	const pasteText = (pasted: string, own: boolean): boolean => {
		const content = pasted
			.replace(/\r\n?/g, "\n")
			.normalize("NFC")
			.replace(/\t/g, "   ")
			.replace(/[\x00-\x08\x0B-\x1F]/g, "");
		if (!isMarkerSized(content)) {
			if (!own) return false;
			const el = textareaRef.current;
			const current = el?.value ?? text;
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			placeDraft(`${current.slice(0, start)}${content}${current.slice(end)}`, start + content.length);
			return true;
		}
		const lineCount = content.split("\n").length;
		if (shouldOfferPasteMenu(lineCount, pasteMenuThreshold)) setPending({ content, lineCount });
		else insertPasteBlob(content);
		return true;
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(e.clipboardData.files);
		const pasted = e.clipboardData.getData("text/plain");
		if (files.length > 0) {
			e.preventDefault();
			// A clipboard may hold files and text together (a picture copied with its caption): the text
			// goes in too. A file manager's copy also carries the files' names as text: that text is the
			// files themselves, already attached.
			const names = new Set(files.map(file => file.name));
			const lines = pasted
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(line => line !== "");
			if (lines.some(line => !names.has(line) && !names.has(line.split(/[\\/]/).at(-1) ?? "")))
				pasteText(pasted, true);
			void attachFiles(files);
			return;
		}
		if (pasted && pasteText(pasted, false)) e.preventDefault();
	};

	return {
		pending,
		menuRef,
		active,
		moveActive,
		activate,
		cancel,
		chooseInline,
		chooseWrapped,
		chooseSaveFile,
		onPaste,
	};
}
