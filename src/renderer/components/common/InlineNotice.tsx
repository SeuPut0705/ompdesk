/**
 * InlineNotice — one quiet line about one part of a surface: a read that
 * failed (with its Retry), a degraded read, a pending one. It sits where the
 * content would be and never grows into a boxed alarm, so two parts failing
 * at once read as two small rows, not two stacked Banners. The cause is the
 * muted secondary line (ErrorDetail), clipped to two lines with the whole
 * text on hover; `copyLabel` adds a CopyButton for a cause the user may need
 * to paste into a report. Page-wide conditions stay Banners.
 */

import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { errorDetail } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { CopyButton } from "./CopyButton";
import { ErrorDetail } from "./ErrorDetail";
import { Spinner } from "./Spinner";

export type InlineNoticeTone = "danger" | "warning" | "info" | "pending";

const ICONS: Record<Exclude<InlineNoticeTone, "pending">, { Icon: typeof Info; className: string }> = {
	danger: { Icon: XCircle, className: "text-(--sc-danger)" },
	warning: { Icon: AlertTriangle, className: "text-(--sc-warning)" },
	info: { Icon: Info, className: "text-(--sc-text-muted)" },
};

export function InlineNotice({
	tone,
	title,
	detail,
	action,
	copyLabel,
	live = false,
	className,
}: {
	tone: InlineNoticeTone;
	title: ReactNode;
	/** Raw cause under the sentence (an Error, an RPC failure, a string). */
	detail?: unknown;
	/** One small Button (the fix, usually Retry). */
	action?: ReactNode;
	/** Accessible name of a copy control for the cause (or the title when there is none). */
	copyLabel?: string;
	/** Announce on appearance: the user is waiting on this read. */
	live?: boolean;
	className?: string;
}) {
	const icon = tone === "pending" ? null : ICONS[tone];
	return (
		<div
			className={cx("flex min-w-0 items-start gap-2 py-2 text-sc-sm", className)}
			data-inline-notice={tone}
			role={live ? (tone === "danger" ? "alert" : "status") : undefined}
		>
			<span className="flex h-5 shrink-0 items-center">
				{icon ? (
					<icon.Icon aria-hidden className={cx("size-(--sc-icon-sm)", icon.className)} />
				) : (
					<Spinner size="sm" />
				)}
			</span>
			<div className="min-w-0 flex-1 py-px">
				<p className="break-keep text-(--sc-text-secondary)">{title}</p>
				{detail !== undefined && (
					<span className="block" title={errorDetail(detail) || undefined}>
						<ErrorDetail className="mt-0.5 line-clamp-2" error={detail} />
					</span>
				)}
			</div>
			{(action || copyLabel) && (
				<div className="-my-0.5 flex shrink-0 items-center gap-1">
					{action}
					{copyLabel && (
						<CopyButton
							label={copyLabel}
							text={() =>
								detail === undefined ? (typeof title === "string" ? title : "") : errorDetail(detail)
							}
						/>
					)}
				</div>
			)}
		</div>
	);
}
