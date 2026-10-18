/**
 * What goes along with the draft, above the field: the attached pictures, the files still uploading, the folded
 * pastes (each opens "Edit pasted text") and the chips of the draft's `@path` mentions. Each strip has one tab stop
 * and its own arrow keys (strip-roving.ts); Delete removes the focused item and focus returns to the field.
 * The picture strip, the upload chips and the paste chips are memoised: a keystroke re-renders none of them unless
 * what they show changed.
 */
import { AlertTriangle, ClipboardPaste, TextCursorInput, X } from "lucide-react";
import { memo, type RefObject, useCallback, useDeferredValue, useMemo, useState } from "react";
import { removeFileMention } from "../../../../shared/file-mentions";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import {
	editPaste,
	expandPasteMarkerAsText,
	getPaste,
	pasteMarkerSpans,
	referencedPasteIds,
	releasePaste,
} from "../../../lib/paste-blobs";
import type { ComposerImage } from "../../../stores/composer";
import { Button, IconButton, Spinner } from "../../common";
import { ComposerThumbnail, imageSummary } from "./ComposerThumbnail";
import { MAX_COMPOSER_IMAGES } from "./composer-files";
import { DraftFileCards } from "./DraftFileCards";
import { PastedTextDialog } from "./PastedTextDialog";
import { useRovingStrip } from "./strip-roving";
import type { SendingFile } from "./use-composer-attach";

type SetImages = (next: (current: ComposerImage[]) => ComposerImage[]) => void;

/** Drafts past this many characters let the chip scan trail a render behind the keystroke. */
const LONG_DRAFT_CHARS = 4000;

export function ComposerAttachments({
	text,
	images,
	setImages,
	setText,
	sendingFiles,
	textareaRef,
	placeDraft,
	containerRef,
	touch,
}: {
	text: string;
	images: readonly ComposerImage[];
	setImages: SetImages;
	setText: (next: (current: string) => string) => void;
	sendingFiles: readonly SendingFile[];
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeDraft: (next: string, caret: number) => void;
	/** The element the field's Backspace-on-empty looks in for the last attachment. */
	containerRef: RefObject<HTMLDivElement | null>;
	/** A touch input: the pictures are one row that scrolls sideways. */
	touch: boolean;
}) {
	/** The folded paste open in "Edit pasted text". */
	const [editingPaste, setEditingPaste] = useState<number | null>(null);
	// Back to the field once a dialog or an item opened from a strip is gone (DI-22): a strip button that
	// vanished left typing nowhere.
	const focusField = useCallback(() => textareaRef.current?.focus(), [textareaRef]);
	const closePaste = useCallback(() => {
		setEditingPaste(null);
		// After the dialog's own focus restore (to the chip) has run.
		setTimeout(() => textareaRef.current?.focus(), 0);
	}, [textareaRef]);
	const savePaste = useCallback(
		(id: number, content: string) => {
			setText(current => editPaste(current, id, content));
			closePaste();
		},
		[setText, closePaste],
	);
	/** The field's own text: the draft a keystroke ago is what `text` can be on a long draft. */
	const fieldText = () => textareaRef.current?.value ?? text;
	const removePastes = useCallback(
		(ids: readonly number[]) => {
			const el = textareaRef.current;
			el?.focus();
			let next = el?.value ?? "";
			// Last marker first: the earlier spans keep their offsets.
			for (const span of pasteMarkerSpans(next).reverse()) {
				if (!ids.includes(span.id)) continue;
				const end = next[span.end] === " " ? span.end + 1 : span.end;
				next = next.slice(0, span.start) + next.slice(end);
				releasePaste(span.id);
			}
			placeDraft(next, Math.min(el?.selectionStart ?? next.length, next.length));
		},
		[placeDraft, textareaRef],
	);
	const pasteAsText = useCallback(
		(id: number) => {
			const el = textareaRef.current;
			el?.focus();
			const expanded = expandPasteMarkerAsText(el?.value ?? "", id);
			if (expanded) placeDraft(expanded.text, expanded.at + expanded.length);
		},
		[placeDraft, textareaRef],
	);
	const chipSource = useDeferredValue(text);
	const pasteIds = useMemo(
		() => referencedPasteIds(text.length > LONG_DRAFT_CHARS ? chipSource : text),
		[text, chipSource],
	);
	const chips = pasteIds.map(id => {
		const blob = getPaste(id);
		return { id, lines: blob?.lineCount ?? 0, chars: blob?.charCount ?? 0 };
	});
	return (
		<div className="contents" data-composer-attachments ref={containerRef}>
			{images.length > 0 && (
				<ImageStrip focusField={focusField} images={images} setImages={setImages} touch={touch} />
			)}
			{sendingFiles.length > 0 && <UploadChips files={sendingFiles} />}
			<PasteChips
				chips={chips}
				focusField={focusField}
				onAsText={pasteAsText}
				onEdit={setEditingPaste}
				onRemove={removePastes}
			/>
			<DraftFileCards
				focusField={focusField}
				onRemove={path => {
					// The chip leaves with its mention: one native edit in the focused field (⌘Z puts it back).
					const el = textareaRef.current;
					el?.focus();
					const next = removeFileMention(el?.value ?? fieldText(), path);
					placeDraft(next, next.length);
				}}
				onRemoveAll={paths => {
					const el = textareaRef.current;
					el?.focus();
					let next = el?.value ?? fieldText();
					for (const path of paths) next = removeFileMention(next, path);
					placeDraft(next, next.length);
				}}
				text={text}
			/>
			<PastedTextDialog onAsText={pasteAsText} onClose={closePaste} onSave={savePaste} pasteId={editingPaste} />
		</div>
	);
}

/** A picture's identity across renders (the strip's list key): previews are far too long to be keys themselves. */
const imageIds = new WeakMap<ComposerImage, number>();
let nextImageId = 0;
function imageKey(image: ComposerImage): number {
	let id = imageIds.get(image);
	if (id === undefined) {
		id = ++nextImageId;
		imageIds.set(image, id);
	}
	return id;
}

const ImageStrip = memo(function ImageStrip({
	images,
	setImages,
	focusField,
	touch,
}: {
	images: readonly ComposerImage[];
	setImages: SetImages;
	focusField: () => void;
	touch: boolean;
}) {
	const t = useT();
	const roving = useRovingStrip<HTMLUListElement>(focusField);
	// One gallery for every thumbnail, built once per change of the pictures.
	const gallery = useMemo(
		() => images.map((item, index) => ({ src: item.preview, alt: t("input.attachmentAlt", { index: index + 1 }) })),
		[images, t],
	);
	const remove = useCallback(
		(index: number) => setImages(previous => previous.filter((_, itemIndex) => itemIndex !== index)),
		[setImages],
	);
	const removeFromButton = useCallback(
		(index: number) => {
			remove(index);
			// The button leaves with its picture: typing goes on in the field, never on <body>.
			focusField();
		},
		[remove, focusField],
	);
	const removeAll = useCallback(() => {
		setImages(() => []);
		focusField();
	}, [setImages, focusField]);
	const over = images.length > MAX_COMPOSER_IMAGES;
	return (
		<ul
			aria-label={t("input.attachments")}
			className="omp-attach-strip flex flex-wrap items-center gap-2.5 px-3 pt-3"
			data-touch={touch || undefined}
			onFocus={roving.onFocus}
			onKeyDown={roving.onKeyDown}
			ref={roving.ref}
		>
			{images.map((image, index) => (
				<AttachedImage
					key={imageKey(image)}
					gallery={gallery}
					image={image}
					index={index}
					onRemove={remove}
					onRemoveButton={removeFromButton}
				/>
			))}
			<li
				className={cx(
					"flex min-h-7 shrink-0 items-center gap-1 text-sc-xs tabular-nums",
					over ? "text-(--sc-warning)" : "text-(--sc-text-muted)",
				)}
				data-attachment-count={over ? "over" : "ok"}
				// The count is read with the strip's name; only the warning interrupts.
				role={over ? "status" : undefined}
				title={over ? t("input.attachments.over", { count: images.length, max: MAX_COMPOSER_IMAGES }) : undefined}
			>
				{over && <AlertTriangle aria-hidden className="size-(--sc-icon-sm)" />}
				<span>{t("input.attachments.count", { count: images.length, max: MAX_COMPOSER_IMAGES })}</span>
				{over && <span>{t("input.attachments.overShort")}</span>}
			</li>
			{images.length > 1 && (
				<li className="shrink-0">
					<Button data-strip-stop="" onClick={removeAll} size="sm" variant="ghost">
						{t("input.attachments.removeAll")}
					</Button>
				</li>
			)}
		</ul>
	);
});

const AttachedImage = memo(function AttachedImage({
	image,
	index,
	gallery,
	onRemove,
	onRemoveButton,
}: {
	image: ComposerImage;
	index: number;
	gallery: readonly { src: string; alt: string }[];
	onRemove: (index: number) => void;
	onRemoveButton: (index: number) => void;
}) {
	const t = useT();
	/** The picture's size once it has decoded: the tooltip names it beside the format and bytes. */
	const [dimensions, setDimensions] = useState<string | null>(null);
	const summary = imageSummary(image.content.mimeType, image.content.data);
	return (
		<li className="relative shrink-0" data-strip-item="">
			<ComposerThumbnail
				data={image.content.data}
				mimeType={image.content.mimeType}
				src={image.preview}
				alt={t("input.attachmentAlt", { index: index + 1 })}
				className="size-14 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) object-cover"
				gallery={gallery}
				onLoad={event => {
					const { naturalWidth, naturalHeight } = event.currentTarget;
					setDimensions(naturalWidth > 0 ? `${naturalWidth}×${naturalHeight}` : null);
				}}
				onRemove={() => onRemove(index)}
				title={dimensions ? `${summary} · ${dimensions}` : summary}
			/>
			<IconButton
				className="omp-composer-attachment-remove absolute -top-2 -right-2"
				data-strip-remove=""
				icon={<X />}
				label={t("input.removeAttachment", { index: index + 1 })}
				onClick={() => onRemoveButton(index)}
				size="sm"
				tabIndex={-1}
				variant="secondary"
			/>
		</li>
	);
});

const UploadChips = memo(function UploadChips({ files }: { files: readonly SendingFile[] }) {
	const t = useT();
	return (
		<ul aria-label={t("input.files.sendingList")} className="flex flex-wrap gap-1.5 px-3 pt-3">
			{files.map(entry => (
				<li
					key={entry.id}
					className="flex h-7 max-w-full items-center gap-1.5 rounded-(--sc-radius-full) border border-(--sc-border-subtle) px-2.5 text-sc-xs text-(--sc-text-secondary)"
					data-upload-chip=""
				>
					<Spinner size="sm" />
					<span className="truncate">{t("input.files.sending", { name: entry.name })}</span>
				</li>
			))}
		</ul>
	);
});

interface PasteChipData {
	id: number;
	lines: number;
	chars: number;
}

/** The draft's folded pastes; re-rendered only when a marker or its size changes, not on every keystroke. */
const PasteChips = memo(
	function PasteChips({
		chips,
		onEdit,
		onAsText,
		onRemove,
		focusField,
	}: {
		chips: readonly PasteChipData[];
		onEdit: (id: number) => void;
		onAsText: (id: number) => void;
		onRemove: (ids: readonly number[]) => void;
		focusField: () => void;
	}) {
		const t = useT();
		const roving = useRovingStrip<HTMLUListElement>(focusField);
		if (chips.length === 0) return null;
		return (
			<ul
				aria-label={t("input.paste.listLabel")}
				className="omp-attach-row flex flex-wrap items-center gap-1.5 px-3 pt-3"
				onFocus={roving.onFocus}
				onKeyDown={roving.onKeyDown}
				ref={roving.ref}
			>
				{chips.map(({ id, lines, chars }) => (
					<li
						key={id}
						className="flex h-7 items-center rounded-(--sc-radius-full) border border-(--sc-border-subtle) text-sc-xs text-(--sc-text-secondary)"
						data-strip-item=""
					>
						<button
							className="flex h-full items-center gap-1.5 rounded-(--sc-radius-full) pr-1 pl-2.5 hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
							data-paste-chip={id}
							data-strip-stop=""
							onClick={() => onEdit(id)}
							title={t("input.paste.edit")}
							type="button"
						>
							<ClipboardPaste aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-muted)" />
							{/* The marker's own unit: lines past ten, else characters. */}
							<span className="tabular-nums">
								{lines > 10 ? t("input.paste.chip", { id, lines }) : t("input.paste.chipChars", { id, chars })}
							</span>
						</button>
						<IconButton
							className="omp-attachment-chip-remove shrink-0"
							icon={<TextCursorInput />}
							label={t("input.paste.asText", { id })}
							onClick={() => onAsText(id)}
							size="sm"
							tabIndex={-1}
						/>
						<IconButton
							className="omp-attachment-chip-remove shrink-0"
							data-strip-remove=""
							icon={<X />}
							label={t("input.paste.remove", { id })}
							onClick={() => onRemove([id])}
							size="sm"
							tabIndex={-1}
						/>
					</li>
				))}
				{chips.length > 1 && (
					<li className="shrink-0">
						<Button
							data-strip-stop=""
							onClick={() => onRemove(chips.map(chip => chip.id))}
							size="sm"
							variant="ghost"
						>
							{t("input.attachments.removeAll")}
						</Button>
					</li>
				)}
			</ul>
		);
	},
	(previous, next) =>
		previous.onEdit === next.onEdit &&
		previous.onAsText === next.onAsText &&
		previous.onRemove === next.onRemove &&
		previous.focusField === next.focusField &&
		previous.chips.length === next.chips.length &&
		previous.chips.every(
			(chip, index) =>
				chip.id === next.chips[index]?.id &&
				chip.lines === next.chips[index]?.lines &&
				chip.chars === next.chips[index]?.chars,
		),
);
