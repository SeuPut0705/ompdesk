import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { LinkButton } from "../../common";
import { ToolImage } from "../../tools/media/ToolImage";
import { ChatMedia } from "../../tools/media/ToolMedia";
import { useRunOutcome } from "./use-work-run";

const VISIBLE_IMAGES = 4;

/**
 * The pictures, audio and video a finished run made or looked at, always visible under its facts. Files and commands
 * live in the card's verdict blocks and chips; agent conclusions on their lanes.
 */
export function WorkMedia({ toolCallIds, stoppedAt }: { toolCallIds: readonly string[]; stoppedAt?: number }) {
	const t = useT();
	const { outcome } = useRunOutcome(toolCallIds, stoppedAt);
	const [showAll, setShowAll] = useState(false);
	if (!outcome.media.length && !outcome.images.length) return null;
	const images = showAll ? outcome.images : outcome.images.slice(0, VISIBLE_IMAGES);
	return (
		<div className="omp-work-images" aria-label={t("chat.work.images")}>
			{outcome.media.map(item => (
				<ChatMedia key={item.path} kind={item.kind} path={item.path} />
			))}
			{images.map(image => (
				<figure key={image.key} className="omp-work-image" title={image.label}>
					<ToolImage src={image.src} path={image.path} loading="lazy" decoding="async" />
					<figcaption className="font-mono">{image.caption}</figcaption>
				</figure>
			))}
			{outcome.images.length > VISIBLE_IMAGES ? (
				<LinkButton
					className="omp-work-images-more"
					aria-expanded={showAll}
					onClick={() => setShowAll(value => !value)}
				>
					{showAll
						? t("chat.work.fewer")
						: t("chat.work.moreImages", { count: outcome.images.length - VISIBLE_IMAGES })}
				</LinkButton>
			) : null}
		</div>
	);
}
