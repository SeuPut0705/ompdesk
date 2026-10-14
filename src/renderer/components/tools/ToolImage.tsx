import { ImageOff } from "lucide-react";
import { useState } from "react";
import { basename } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ZoomableImage, type ZoomableImageProps } from "../common/ZoomableImage";
import { FileChip } from "./ToolMedia";

/**
 * A picture a tool read or made that cannot be drawn — its bytes are gone (the
 * blob behind stock's reference was collected) or do not decode — shown as its
 * file: the basename, opening the file the way every tool path does.
 */
export function ImageFileChip({ path, label }: { path: string; label?: string }) {
	const t = useT();
	return (
		<FileChip
			data-image-unavailable
			icon={<ImageOff aria-hidden className="omp-file-chip-icon" />}
			label={label || basename(path) || t("tools.image.alt")}
			note={t("tools.image.unavailable")}
			path={path}
		/>
	);
}

/**
 * A tool result's picture (`src` from `extractResultImage(s)`), named by `label`
 * (default: the file's basename), never by a raw path. Falls back to
 * {@link ImageFileChip} when `src` is null or the image fails to load, so a
 * transcript never shows a broken-image icon.
 */
export function ToolImage({
	src,
	path,
	label,
	...imgProps
}: Omit<ZoomableImageProps, "src" | "alt" | "onError"> & { src: string | null; path: string; label?: string }) {
	const t = useT();
	const [failed, setFailed] = useState<string | null>(null);
	if (src === null || failed === src) return <ImageFileChip label={label} path={path} />;
	return (
		<ZoomableImage
			{...imgProps}
			alt={label || basename(path) || t("tools.image.alt")}
			onError={() => setFailed(src)}
			src={src}
		/>
	);
}
