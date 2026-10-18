/**
 * One attached picture in the composer's strip. A picture this browser cannot draw (a phone's HEIC in Chromium:
 * the computer converts it for the model, the page cannot show it) is a compact photo chip — an image icon, its
 * format and size — instead of a broken image.
 */
import { ImageIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { useT } from "../../../lib/i18n";
import { ZoomableImage } from "../../common/ZoomableImage";

/** "HEIC" for `image/heic`; the subtype in capitals. */
function formatName(mimeType: string): string {
	return (/^image\/([a-z0-9.+-]+)/i.exec(mimeType)?.[1] ?? "image").replace(/-sequence$/i, "").toUpperCase();
}

/** Bytes of a base64 payload, as "1.2 MB" / "840 KB". */
function sizeLabel(base64: string): string {
	const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "PNG · 1.2 MB": what a thumbnail's tooltip says before the picture's dimensions. */
export function imageSummary(mimeType: string, base64: string): string {
	return `${formatName(mimeType)} · ${sizeLabel(base64)}`;
}

export function ComposerThumbnail({
	mimeType,
	data,
	...image
}: ComponentProps<typeof ZoomableImage> & { mimeType: string; data: string }) {
	const t = useT();
	const [failed, setFailed] = useState<string | null>(null);
	if (failed === image.src) {
		return (
			<span
				className="flex size-14 flex-col items-center justify-center gap-0.5 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-surface-2) text-center text-sc-xs text-(--sc-text-muted)"
				data-composer-photo-chip=""
				role="img"
				data-strip-stop=""
				tabIndex={0}
				aria-label={t("input.attachmentPhoto", { format: formatName(mimeType) })}
			>
				<ImageIcon aria-hidden className="size-4" />
				<span className="leading-tight">{t("input.attachmentPhoto", { format: formatName(mimeType) })}</span>
				<span className="leading-tight">{sizeLabel(data)}</span>
			</span>
		);
	}
	return <ZoomableImage {...image} onError={() => setFailed(image.src)} />;
}
