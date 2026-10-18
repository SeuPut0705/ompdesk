/**
 * What goes along with the draft, above the field: the attached pictures, the files still uploading, the folded
 * pastes (each opens "Edit pasted text") and the cards of the draft's `@path` mentions. The picture strip, the
 * upload chips and the paste chips are memoised: a keystroke re-renders none of them unless what they show
 * changed.
 */
import { ClipboardPaste, X } from "lucide-react";
import { memo, type RefObject, useCallback, useMemo, useState } from "react";
import { removeFileMention } from "../../../../shared/file-mentions";
import { useT } from "../../../lib/i18n";
import { editPaste, getPaste, referencedPasteIds } from "../../../lib/paste-blobs";
import type { ComposerImage } from "../../../stores/composer";
import { IconButton, Spinner } from "../../common";
import { ComposerThumbnail } from "./ComposerThumbnail";
import { DraftFileCards } from "./DraftFileCards";
import { PastedTextDialog } from "./PastedTextDialog";
import type { SendingFile } from "./use-composer-attach";

type SetImages = (next: (current: ComposerImage[]) => ComposerImage[]) => void;

export function ComposerAttachments({
	text,
	images,
	setImages,
	setText,
	sendingFiles,
	textareaRef,
	placeDraft,
}: {
	text: string;
	images: readonly ComposerImage[];
	setImages: SetImages;
	setText: (next: (current: string) => string) => void;
	sendingFiles: readonly SendingFile[];
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeDraft: (next: string, caret: number) => void;
}) {
	/** The folded paste open in "Edit pasted text". */
	const [editingPaste, setEditingPaste] = useState<number | null>(null);
	const closePaste = useCallback(() => setEditingPaste(null), []);
	const savePaste = useCallback(
		(id: number, content: string) => {
			setText(current => editPaste(current, id, content));
			setEditingPaste(null);
		},
		[setText],
	);
	return (
		<>
			{images.length > 0 && <ImageStrip images={images} setImages={setImages} textareaRef={textareaRef} />}
			{sendingFiles.length > 0 && <UploadChips files={sendingFiles} />}
			<PasteChips
				chips={referencedPasteIds(text).map(id => ({ id, lines: getPaste(id)?.lineCount ?? 0 }))}
				onEdit={setEditingPaste}
			/>
			<DraftFileCards
				onRemove={path => {
					// The card leaves with its mention: one native edit in the focused field (⌘Z puts it back).
					const el = textareaRef.current;
					el?.focus();
					const next = removeFileMention(el?.value ?? text, path);
					placeDraft(next, next.length);
				}}
				text={text}
			/>
			<PastedTextDialog onClose={closePaste} onSave={savePaste} pasteId={editingPaste} />
		</>
	);
}

const ImageStrip = memo(function ImageStrip({
	images,
	setImages,
	textareaRef,
}: {
	images: readonly ComposerImage[];
	setImages: SetImages;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
	const t = useT();
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
			textareaRef.current?.focus();
		},
		[remove, textareaRef],
	);
	return (
		<ul aria-label={t("input.attachments")} className="flex flex-wrap gap-2.5 px-3 pt-3">
			{images.map((image, index) => (
				<AttachedImage
					key={index}
					gallery={gallery}
					image={image}
					index={index}
					onRemove={remove}
					onRemoveButton={removeFromButton}
				/>
			))}
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
	return (
		<li className="relative">
			<ComposerThumbnail
				data={image.content.data}
				mimeType={image.content.mimeType}
				src={image.preview}
				alt={t("input.attachmentAlt", { index: index + 1 })}
				className="size-14 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) object-cover"
				gallery={gallery}
				onRemove={() => onRemove(index)}
			/>
			<IconButton
				className="omp-composer-attachment-remove absolute -top-1.5 -right-1.5"
				icon={<X />}
				label={t("input.removeAttachment", { index: index + 1 })}
				onClick={() => onRemoveButton(index)}
				size="sm"
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

/** The draft's folded pastes; re-rendered only when a marker or its size changes, not on every keystroke. */
const PasteChips = memo(
	function PasteChips({
		chips,
		onEdit,
	}: {
		chips: readonly { id: number; lines: number }[];
		onEdit: (id: number) => void;
	}) {
		const t = useT();
		if (chips.length === 0) return null;
		return (
			<ul aria-label={t("input.paste.listLabel")} className="flex flex-wrap gap-1.5 px-3 pt-3">
				{chips.map(({ id, lines }) => (
					<li key={id}>
						<button
							className="flex h-7 items-center gap-1.5 rounded-(--sc-radius-full) border border-(--sc-border-subtle) px-2.5 text-sc-xs text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
							data-paste-chip={id}
							onClick={() => onEdit(id)}
							title={t("input.paste.edit")}
							type="button"
						>
							<ClipboardPaste aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-muted)" />
							<span className="tabular-nums">{t("input.paste.chip", { id, lines })}</span>
						</button>
					</li>
				))}
			</ul>
		);
	},
	(previous, next) =>
		previous.onEdit === next.onEdit &&
		previous.chips.length === next.chips.length &&
		previous.chips.every(
			(chip, index) => chip.id === next.chips[index]?.id && chip.lines === next.chips[index]?.lines,
		),
);
