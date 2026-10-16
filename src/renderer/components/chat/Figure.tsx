/**
 * Figures in the transcript (a ```mermaid or ```svg fence, a written .svg or
 * .mmd file): ONE box whose top edge is ONE compact header row — the kind
 * ("Mermaid", "SVG", the file name) on the left, icon actions on the right
 * (Preview/Code switch, wrap in the code view, copy, download, enlarge). The
 * code view is the shared CodeBlock wearing the same header, so switching
 * views never moves the box or its buttons. Source that has no picture yet
 * (a fence still streaming, a broken file) is the plain code block.
 */
import { Code, Download, Eye, Maximize2 } from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { saveImage } from "../../lib/image-actions";
import { toastError } from "../../stores/toast";
import { CopyButton, IconButton } from "../common";
import type { ZoomableImageHandle } from "../common/ZoomableImage";
import { CodeBlock } from "./CodeBlock";
import { FigureHeader } from "./FigureHeader";

export type FigureMode = "preview" | "code";

/**
 * Preview / Code as two icon buttons; the one showing is pressed. A file
 * viewer names the views "Rendered" / "Source" through `previewLabel` / `codeLabel`.
 */
export function FigureModeToggle({
	mode,
	onChange,
	previewLabel,
	codeLabel,
	groupLabel,
}: {
	mode: FigureMode;
	onChange: (mode: FigureMode) => void;
	previewLabel?: string;
	codeLabel?: string;
	groupLabel?: string;
}) {
	const t = useT();
	return (
		<div
			aria-label={groupLabel ?? t("svgPreview.mode")}
			className="flex items-center gap-0.5"
			data-figure-mode
			role="group"
		>
			<IconButton
				data-figure-mode-button="preview"
				icon={<Eye />}
				label={previewLabel ?? t("svgPreview.preview")}
				onClick={() => onChange("preview")}
				pressed={mode === "preview"}
				size="sm"
			/>
			<IconButton
				data-figure-mode-button="code"
				icon={<Code />}
				label={codeLabel ?? t("svgPreview.code")}
				onClick={() => onChange("code")}
				pressed={mode === "code"}
				size="sm"
			/>
		</div>
	);
}

/** Save the picture as a file (the system's save dialog, as the image viewer's Save as). */
function DownloadButton({ src, name }: { src: string; name: string }) {
	const t = useT();
	return (
		<IconButton
			data-figure-download
			icon={<Download />}
			label={t("figure.download")}
			onClick={() =>
				void saveImage(src, name).then(
					result => {
						if (result.error) toastError({ title: t("image.saveFailed"), error: result.error });
					},
					cause => toastError({ title: t("image.saveFailed"), error: cause }),
				)
			}
			size="sm"
		/>
	);
}

export interface FigureProps {
	/** `data-figure` on the root: "mermaid" | "svg". */
	kind: string;
	/** Left of the header: "Mermaid", "SVG", a file name. */
	title: string;
	/** The source: what Copy takes and the code view shows. */
	code: string;
	/** Language of the code view. */
	language: string;
	/** The picture, given the handle that enlarges its zoomable image; null shows only the code. */
	preview: ((zoom: RefObject<ZoomableImageHandle | null>) => ReactNode) | null;
	/** The preview holds a ZoomableImage (shows the enlarge button). */
	zoomable?: boolean;
	/** A picture to save: a data: URL and the file name offered. */
	download?: { src: string; name: string } | null;
	/** Replaces the CodeBlock in the code view (a write's diff); shown inside the same box. */
	codeView?: ReactNode;
	showLineNumbers?: boolean;
	maxHeightClass?: string;
	className?: string;
	/** Controlled view (a file viewer that remembers it); the figure keeps its own when omitted. */
	mode?: FigureMode;
	onModeChange?: (mode: FigureMode) => void;
}

export function Figure({
	kind,
	title,
	code,
	language,
	preview,
	zoomable,
	download,
	codeView,
	showLineNumbers,
	maxHeightClass,
	className,
	mode: controlledMode,
	onModeChange,
}: FigureProps) {
	const t = useT();
	const [ownMode, setOwnMode] = useState<FigureMode>("preview");
	const mode = controlledMode ?? ownMode;
	const setMode = (next: FigureMode) => {
		setOwnMode(next);
		onModeChange?.(next);
	};
	const zoom = useRef<ZoomableImageHandle | null>(null);
	const shown: FigureMode = preview === null ? "code" : mode;
	const toggle = preview === null ? null : <FigureModeToggle mode={shown} onChange={setMode} />;
	const save = download ? <DownloadButton name={download.name} src={download.src} /> : null;

	if (shown === "code" && codeView === undefined) {
		return (
			<div className={className} data-figure={kind}>
				<CodeBlock
					code={code}
					endActions={save}
					headerActions={toggle}
					language={language}
					maxHeightClass={maxHeightClass}
					showLineNumbers={showLineNumbers}
					showWrap
					title={title}
				/>
			</div>
		);
	}
	return (
		<div className={className} data-figure={kind}>
			<div className="overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1) text-(--sc-text)">
				<FigureHeader title={title}>
					{toggle}
					<CopyButton label={t("chat.copyCode")} text={code} />
					{save}
					{shown === "preview" && zoomable && (
						<IconButton
							data-figure-expand
							icon={<Maximize2 />}
							label={t("figure.expand")}
							onClick={() => zoom.current?.open()}
							size="sm"
						/>
					)}
				</FigureHeader>
				<div className={cx(shown === "preview" ? "overflow-x-auto" : "overflow-auto")}>
					{shown === "preview" && preview ? preview(zoom) : codeView}
				</div>
			</div>
		</div>
	);
}
