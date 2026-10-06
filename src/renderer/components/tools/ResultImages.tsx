import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

export function ResultImages({ images }: { images: readonly string[] }) {
	const t = useT();
	if (images.length === 0) return null;
	return (
		<div className={cx("grid gap-2", images.length > 1 && "sm:grid-cols-2")}>
			{images.map((src, index) => (
				<img
					alt={`${t("tools.image.alt")} ${index + 1}`}
					className="max-h-72 w-full rounded-md border border-[var(--omp-border-muted)] object-contain"
					key={src}
					src={src}
				/>
			))}
		</div>
	);
}
