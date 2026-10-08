/**
 * InlineNotice — one quiet line inside a Settings section about that part
 * only: a read that failed (with its Retry), a degraded read, a pending one.
 * It sits where the content would be and never grows into a boxed alarm, so
 * two parts failing at once read as two small rows, not two stacked Banners.
 * The cause is the muted secondary line (ErrorDetail), clipped to two lines
 * with the whole text on hover. Page-wide conditions stay Banners.
 */

import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { errorDetail } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { ErrorDetail, Spinner } from "../common";

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
	live = false,
	className,
}: {
	tone: InlineNoticeTone;
	title: ReactNode;
	/** Raw cause under the sentence (an Error, an RPC failure, a string). */
	detail?: unknown;
	/** One small Button (the fix, usually Retry). */
	action?: ReactNode;
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
			{action && <div className="-my-0.5 flex shrink-0 items-center">{action}</div>}
		</div>
	);
}
