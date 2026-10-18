/**
 * Attaching files to the composer: the + menu's file chooser, drops on the composer box and clipboard files all
 * go through {@link ComposerAttach.attachFiles} (composer-files.ts decides what each file becomes).
 */
import type { ChangeEvent, DragEvent, RefObject } from "react";
import { useCallback, useRef, useState } from "react";
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

export interface ComposerDropProps {
	onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
	onDragOver: (event: DragEvent<HTMLDivElement>) => void;
	onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
	onDrop: (event: DragEvent<HTMLDivElement>) => void;
}

export interface ComposerAttach {
	/** The hidden `<input type="file">` the chooser opens. */
	fileInputRef: RefObject<HTMLInputElement | null>;
	/** The hidden input's `onChange`: its pick goes in, and the tracked pick ends once it landed. */
	onFilesPicked: (event: ChangeEvent<HTMLInputElement>) => void;
	/** Open the browser's file chooser (`accept`: what it offers; none = any file), its pick tracked until it lands. */
	openFilePicker: (accept?: string) => void;
	attachFiles: (files: readonly File[]) => Promise<void>;
	sendingFiles: readonly SendingFile[];
	/** Files are dragged over the composer box. */
	dragActive: boolean;
	dropProps: ComposerDropProps;
}

const draggingFiles = (event: DragEvent<HTMLElement>) => {
	const types = Array.from(event.dataTransfer.types);
	return types.includes("Files") || types.includes(FILE_DRAG_TYPE);
};

export function useComposerAttach({
	cwd,
	historyDevice,
	runtimeTabId,
	mountedRef,
	insertAtCaret,
	setImages,
}: {
	cwd: string;
	/** The paired device this tab runs on; undefined on this computer. */
	historyDevice: string | undefined;
	runtimeTabId: string | null;
	mountedRef: RefObject<boolean>;
	/** Splice text in at the caret, space-separated from its neighbours. */
	insertAtCaret: (insert: string) => void;
	setImages: (next: (current: ComposerImage[]) => ComposerImage[]) => void;
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
	 * path goes in as its text; the rest are refused with a reason. On a web page
	 * the path is the file's upload on the computer: a chip shows each one on its
	 * way, and one that failed says why. Settles once everything has landed.
	 */
	const attachFiles = async (files: readonly File[]): Promise<void> => {
		if (files.length === 0) return;
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
		});
		if (!mountedRef.current) return;
		const pieces = [
			...intake.mentions,
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
			if (rejection.reason === "notSent") toast({ variant: "error", message: rejection.message ?? rejection.name });
			else toast({ variant: "warning", message: t(reasons[rejection.reason], { name: rejection.name }) });
		}
		if (intake.images.length === 0) return;
		const read = await Promise.all(
			intake.images.map(file =>
				fileToImage(file).catch(() => {
					toast({ variant: "warning", message: t("input.files.unreadable", { name: file.name }) });
					return null;
				}),
			),
		);
		const added = read.filter(image => image !== null);
		if (mountedRef.current && added.length > 0) setImages(previous => [...previous, ...added]);
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

	// Files dropped on the composer go through attachFiles like a paste; a Files
	// tree row becomes an @mention (C42); anything else keeps the browser
	// default (text drops insert into the field).
	const dropProps: ComposerDropProps = {
		onDragEnter: event => {
			if (draggingFiles(event)) setDragActive(true);
		},
		onDragOver: event => {
			if (!draggingFiles(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		},
		onDragLeave: event => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
		},
		onDrop: event => {
			setDragActive(false);
			if (!draggingFiles(event)) return;
			event.preventDefault();
			const row = readFileDrag(event.dataTransfer);
			if (row) {
				window.dispatchEvent(
					new CustomEvent("omp:insert-mention", { detail: { path: row.path, tabId: runtimeTabId } }),
				);
				return;
			}
			void attachFiles(Array.from(event.dataTransfer.files));
		},
	};

	return { fileInputRef, onFilesPicked, openFilePicker, attachFiles, sendingFiles, dragActive, dropProps };
}
