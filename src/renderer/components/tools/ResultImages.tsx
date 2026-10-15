import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ZoomableImage } from "../common/ZoomableImage";

export function ResultImages({ images, livePreview }: { images: readonly string[]; livePreview?: boolean }) {
	const t = useT();
	if (images.length === 0) return null;
	const gallery = images.map((src, index) => ({ src, alt: `${t("tools.image.alt")} ${index + 1}` }));
	return (
		<div className={cx("grid gap-2", livePreview && "omp-tool-images", images.length > 1 && "sm:grid-cols-2")}>
			{gallery.map(image => (
				<ZoomableImage
					alt={image.alt}
					className="max-h-72 w-full rounded-md border border-[var(--omp-border-muted)] object-contain"
					gallery={gallery}
					key={image.src}
					src={image.src}
				/>
			))}
		</div>
	);
}
