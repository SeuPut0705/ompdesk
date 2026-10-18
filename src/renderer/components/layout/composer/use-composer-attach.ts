/**
 * Attaching files to the composer: the + menu's file chooser, drops on the session pane and clipboard files all
 * go through {@link ComposerAttach.attachFiles} (composer-files.ts decides what each file becomes).
 */
import type { ChangeEvent, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { extractFileMentions } from "../../../../shared/file-mentions";
import { FILE_DRAG_TYPE, readFileDrag } from "../../../lib/file-drag";
import { trackFilePick } from "../../../lib/file-pick";
import { useT } from "../../../lib/i18n";
import { pasteMarkerText, storePaste } from "../../../lib/paste-blobs";
import type { ComposerImage } from "../../../stores/composer";
import { toast } from "../../../stores/toast";
import { fileTextAttachment, intakeComposerFiles } from "./composer-files";
import { fileToImage } from "./input-area-utils";

/** A file on its way to the computer (a web page's `pathForFile` upload), shown as a chip until it lands. */
export interface SendingFile {
	id: number;
	name: string;
}

export interface ComposerAttach {
	/** The hidden `<input type="file">` the chooser opens. */
	fileInputRef: RefObject<HTMLInputElement | null>;
	/** The hidden input's `onChange`: its pick goes in, and the tracked pick ends once it landed. */
	onFilesPicked: (event: ChangeEvent<HTMLInputElement>) => void;
	/** Open the browser's file chooser (`accept`: what it offers; none = any file), its pick tracked until it lands. */
	openFilePicker: (accept?: string) => void;
	attachFiles: (files: readonly File[], options?: { directories?: ReadonlySet<File> }) => Promise<void>;
	sendingFiles: readonly SendingFile[];
	/** Files are dragged over the session pane: the composer shows its drop overlay. */
	dragActive: boolean;
}

/** Whether a drag carries files (or a Files-tree row), not text or a link. */
const draggingFiles = (event: DragEvent): boolean => {
	const types = Array.from(event.dataTransfer?.types ?? []);
	return types.includes("Files") || types.includes(FILE_DRAG_TYPE);
};

/** A drag over a field that takes text keeps the browser's own drop. */
const overTextField = (event: DragEvent): boolean =>
	(event.target as Element | null)?.closest?.("textarea, input, [contenteditable]") != null;

export function useComposerAttach({
	cwd,
	historyDevice,
	runtimeTabId,
	mountedRef,
	insertAtCaret,
	setImages,
	textareaRef,
	regionRef,
}: {
	cwd: string;
	/** The paired device this tab runs on; undefined on this computer. */
	historyDevice: string | undefined;
	runtimeTabId: string | null;
	mountedRef: RefObject<boolean>;
	/** Splice text in at the caret, space-separated from its neighbours. */
	insertAtCaret: (insert: string) => void;
	setImages: (next: (current: ComposerImage[]) => ComposerImage[]) => void;
	/** The field: it takes focus when an attach is done, and says which mentions the draft already holds. */
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** The composer's own region: a drop anywhere in its session pane (the transcript included) lands here. */
	regionRef: RefObject<HTMLElement | null>;
}): ComposerAttach {
	const t = useT();
	const fileInputRef = useRef<HTMLInputElement>(null);
	/** Ends the file pick in flight (lib/file-pick.ts) once its files landed in the composer. */
	const endPickRef = useRef<(() => void) | null>(null);
	const [sendingFiles, setSendingFiles] = useState<SendingFile[]>([]);
	const sendingFileId = useRef(0);
	const [dragActive, setDragActive] = useState(false);

	/**
	 * Picker, drop and clipboard files (composer-files.ts): images attach, other
	 * files and folders become `@path` mentions stock reads at send time (PDF and
	 * Office through its read tool), and a file this tab's machine cannot reach by
	 * path goes in as its text; the rest are refused with a reason. A file that is
	 * already attached (the same path in the draft, the same picture bytes) is not
	 * added twice. On a web page the path is the file's upload on the computer: a
	 * chip shows each one on its way, and one that failed says why. Settles once
	 * everything has landed, with the field focused.
	 */
	const attachFiles = async (files: readonly File[], options?: { directories?: ReadonlySet<File> }): Promise<void> => {
		if (files.length === 0) return;
		try {
			const intake = await intakeComposerFiles(files, {
				cwd,
				pathFor: file => {
					const path = window.omp.fs.pathForFile(file);
					// This machine's own path answers at once; an upload shows its chip until it lands.
					if (typeof path === "string") return path;
					const id = ++sendingFileId.current;
					setSendingFiles(previous => [...previous, { id, name: file.name }]);
					return path.finally(() => {
						if (mountedRef.current) setSendingFiles(previous => previous.filter(entry => entry.id !== id));
					});
				},
				remote: historyDevice !== undefined,
				directories: options?.directories,
			});
			if (!mountedRef.current) return;
			// A mention the draft already holds is not typed in again.
			const held = new Set(extractFileMentions(textareaRef.current?.value ?? ""));
			const fresh = intake.mentions.filter(mention => !held.has(extractFileMentions(mention)[0] ?? mention));
			let duplicates = intake.duplicates + (intake.mentions.length - fresh.length);
			const pieces = [
				...fresh,
				...intake.texts.map(file => {
					const blob = storePaste(fileTextAttachment(file.name, file.content));
					return pasteMarkerText(blob.id, blob.content);
				}),
			];
			if (pieces.length > 0) insertAtCaret(pieces.join(" "));
			const reasons = {
				empty: "input.files.empty",
				tooLarge: "input.files.tooLarge",
				binary: historyDevice === undefined ? "input.files.noPath" : "input.files.remoteBinary",
				unreadable: "input.files.unreadable",
			} as const;
			for (const rejection of intake.rejected) {
				if (rejection.reason === "notSent")
					toast({ variant: "error", message: rejection.message ?? rejection.name });
				else toast({ variant: "warning", message: t(reasons[rejection.reason], { name: rejection.name }) });
			}
			if (intake.images.length > 0) {
				const read = await Promise.all(
					intake.images.map(file =>
						fileToImage(file).catch(() => {
							toast({ variant: "warning", message: t("input.files.unreadable", { name: file.name }) });
							return null;
						}),
					),
				);
				const added = read.filter(image => image !== null);
				if (mountedRef.current && added.length > 0)
					setImages(previous => {
						// The same picture twice (same bytes) is one attachment.
						const seen = new Set(previous.map(image => image.content.data));
						const next = added.filter(image => !seen.has(image.content.data) && seen.add(image.content.data));
						duplicates += added.length - next.length;
						return next.length > 0 ? [...previous, ...next] : previous;
					});
			}
			if (duplicates > 0) toast({ variant: "info", message: t("input.files.duplicates", { count: duplicates }) });
		} finally {
			// However the files went in, typing goes on in the field (the picker's button kept focus otherwise).
			if (mountedRef.current) textareaRef.current?.focus();
		}
	};

	const openFilePicker = useCallback((accept?: string) => {
		const input = fileInputRef.current;
		if (!input) return;
		if (accept) input.accept = accept;
		else input.removeAttribute("accept");
		endPickRef.current?.();
		endPickRef.current = trackFilePick(input);
		input.click();
	}, []);

	const onFilesPicked = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		const endPick = endPickRef.current;
		endPickRef.current = null;
		event.target.value = "";
		void attachFiles(files).finally(() => endPick?.());
	};

	// Files dropped on the session pane (the transcript, the composer's padding and the box alike) go through
	// attachFiles like a paste; a Files tree row becomes an @mention (C42); a folder becomes its path. Anything
	// that is not a file is refused outright over the pane (no drop effect, never the browser's "open it"), except
	// in a field that takes text, which keeps the browser's own drop.
	const attachRef = useRef(attachFiles);
	attachRef.current = attachFiles;
	useEffect(() => {
		const region = regionRef.current;
		if (!region) return;
		const pane = region.closest<HTMLElement>(".omp-session-pane") ?? region;
		/** dragenter/dragleave pairs fire for every child crossed: the overlay lives while any is open. */
		let depth = 0;
		const reset = () => {
			depth = 0;
			setDragActive(false);
		};
		const onEnter = (event: DragEvent) => {
			if (!draggingFiles(event)) return;
			depth++;
			setDragActive(true);
		};
		const onOver = (event: DragEvent) => {
			if (!event.dataTransfer) return;
			if (draggingFiles(event)) {
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			} else if (!overTextField(event)) {
				event.preventDefault();
				event.dataTransfer.dropEffect = "none";
			}
		};
		const onLeave = (event: DragEvent) => {
			if (!draggingFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragActive(false);
		};
		const onDrop = (event: DragEvent) => {
			reset();
			const transfer = event.dataTransfer;
			if (!transfer) return;
			if (!draggingFiles(event)) {
				if (!overTextField(event)) event.preventDefault();
				return;
			}
			event.preventDefault();
			const row = readFileDrag(transfer);
			if (row) {
				window.dispatchEvent(
					new CustomEvent("omp:insert-mention", { detail: { path: row.path, tabId: runtimeTabId } }),
				);
				return;
			}
			const files = Array.from(transfer.files);
			// A dropped folder reaches the page as a zero-byte file; only the drop's own entries tell it apart.
			const directories = new Set(
				files.filter((_, index) => transfer.items?.[index]?.webkitGetAsEntry?.()?.isDirectory === true),
			);
			void attachRef.current(files, { directories });
		};
		pane.addEventListener("dragenter", onEnter);
		pane.addEventListener("dragover", onOver);
		pane.addEventListener("dragleave", onLeave);
		pane.addEventListener("drop", onDrop);
		// A drag that ends elsewhere (Esc, dropped outside the window) sends no leave for the last element.
		window.addEventListener("dragend", reset);
		window.addEventListener("blur", reset);
		return () => {
			pane.removeEventListener("dragenter", onEnter);
			pane.removeEventListener("dragover", onOver);
			pane.removeEventListener("dragleave", onLeave);
			pane.removeEventListener("drop", onDrop);
			window.removeEventListener("dragend", reset);
			window.removeEventListener("blur", reset);
		};
	}, [regionRef, runtimeTabId]);

	return { fileInputRef, onFilesPicked, openFilePicker, attachFiles, sendingFiles, dragActive };
}
