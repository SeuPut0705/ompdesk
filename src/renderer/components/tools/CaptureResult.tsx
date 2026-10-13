import type { ReactNode } from "react";
import { ZoomableImage } from "../common/ZoomableImage";
import { ToolTextPreview } from "./ToolTextPreview";

/**
 * Shared frame for screen-capturing tools (browser, computer use): a caption
 * row with the action and target, the latest screenshot, and the text result
 * when there is no screenshot or the call failed.
 */
export function CaptureResult({
	livePreview,
	icon,
	action,
	children,
	screenshot,
	screenshotAlt,
	imageClass,
	text,
	isError,
	pendingLabel,
}: {
	livePreview?: boolean;
	/** Leading icon of the static card; the live surface shows none. */
	icon: ReactNode;
	action: string;
	/** Caption pieces after the action (url, coordinates, typed text). */
	children?: ReactNode;
	screenshot: string | undefined;
	screenshotAlt: string;
	/** Height ceiling of the screenshot thumbnail. */
	imageClass: string;
	text: string;
	isError?: boolean;
	/** Shown while the call runs and has produced nothing yet; null otherwise. */
	pendingLabel: string | null;
}) {
	return (
		<div className={livePreview ? "omp-tool-capture flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
			<div
				className={
					livePreview
						? "omp-tool-caption flex items-center gap-1.5 font-mono text-sc-xs"
						: "flex items-center gap-1.5 font-mono text-omp-sm"
				}
			>
				{!livePreview && icon}
				{action && (
					<span
						className={livePreview ? "truncate text-(--sc-text-muted)" : "font-semibold text-[var(--omp-text)]"}
						title={action}
					>
						{action}
					</span>
				)}
				{children}
			</div>
			{screenshot && (
				<ZoomableImage
					src={screenshot}
					alt={screenshotAlt}
					className={`${imageClass} rounded-md border border-[var(--omp-border-muted)] object-contain`}
				/>
			)}
			{text && (!screenshot || isError) && <ToolTextPreview text={text} isError={isError} />}
			{pendingLabel && !text && !screenshot && (
				<div className="text-omp-sm italic text-[var(--omp-accent)]">{pendingLabel}</div>
			)}
		</div>
	);
}
