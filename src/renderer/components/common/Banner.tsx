/**
 * Banner — a persistent, inline message about the state of the surface it
 * sits in (sidecar disconnected, update ready, omp too old, read-only
 * session). It stays until the condition changes or the user dismisses it.
 *
 * Rules: one sentence, plus at most two actions (Buttons size sm, the fix
 * first). `danger` for broken functionality, `warning` for degraded,
 * `info` for neutral news, `success` for a just-completed state change,
 * `neutral` for a quiet notice on the plain surface (an update failure the app works around, a new version's note).
 * Transient feedback ("Copied") is a Toast, not a Banner. Set `live` only
 * when the banner appears in response to something the user is waiting on.
 *
 * `icon` replaces the variant's glyph (a lucide icon is sized for the banner; another mark keeps its own size) and
 * draws in its own colour, the text's unless it sets one. `compact` is one quiet row over the content (the update
 * failure, What's new): smaller type and padding, items centred, nothing wrapping under the text; its actions and the
 * dismiss button are direct children of the row. `dismissLabel` names the ✕ when "Close" would not say what it closes.
 * Other DOM attributes (`data-*`, `role`, `aria-label`, `tabIndex`, key and pointer handlers, `ref`) reach the row,
 * for a banner that is itself focusable or opens something.
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";

export type BannerVariant = "info" | "success" | "warning" | "danger" | "neutral";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

const VARIANTS: Record<BannerVariant, { box: string; icon: string; Icon: typeof Info }> = {
	info: {
		box: "border-[color-mix(in_srgb,var(--sc-info)_28%,transparent)] bg-(--sc-info-soft)",
		icon: "text-(--sc-info)",
		Icon: Info,
	},
	success: {
		box: "border-[color-mix(in_srgb,var(--sc-success)_28%,transparent)] bg-(--sc-success-soft)",
		icon: "text-(--sc-success)",
		Icon: CheckCircle2,
	},
	warning: {
		box: "border-[color-mix(in_srgb,var(--sc-warning)_28%,transparent)] bg-(--sc-warning-soft)",
		icon: "text-(--sc-warning)",
		Icon: AlertTriangle,
	},
	danger: {
		box: "border-[color-mix(in_srgb,var(--sc-danger)_28%,transparent)] bg-(--sc-danger-soft)",
		icon: "text-(--sc-danger)",
		Icon: XCircle,
	},
	neutral: {
		box: "border-(--sc-border-subtle) bg-(--sc-surface-2)",
		icon: "text-(--sc-text-muted)",
		Icon: Info,
	},
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "children">, DataAttributes {
	variant?: BannerVariant;
	title?: ReactNode;
	children?: ReactNode;
	/** Buttons (size sm); the fixing action first. */
	actions?: ReactNode;
	onDismiss?: () => void;
	/** The dismiss button's name; "Close" when omitted. */
	dismissLabel?: string;
	/** Announce on appearance (role="status"; "alert" for danger). */
	live?: boolean;
	/** A glyph in place of the variant's; decorative. */
	icon?: ReactNode;
	/** One quiet row: smaller type and padding, centred, no wrapping. */
	compact?: boolean;
	className?: string;
}

export const Banner = forwardRef<HTMLDivElement, BannerProps>(function Banner(
	{
		variant = "info",
		title,
		children,
		actions,
		onDismiss,
		dismissLabel,
		live,
		icon,
		compact,
		className,
		role,
		...rest
	},
	ref,
) {
	const t = useT();
	const style = VARIANTS[variant];
	const Icon = style.Icon;
	const glyph =
		icon === undefined ? (
			<Icon
				aria-hidden
				className={cx("shrink-0", compact ? "size-(--sc-icon-sm)" : "mt-0.5 size-(--sc-icon-md)", style.icon)}
			/>
		) : (
			<span
				aria-hidden
				className={cx(
					"flex shrink-0",
					compact ? "[&>svg.lucide]:size-(--sc-icon-sm)" : "mt-0.5 [&>svg.lucide]:size-(--sc-icon-md)",
				)}
			>
				{icon}
			</span>
		);
	const dismiss = onDismiss && (
		<IconButton
			className={compact ? undefined : "-my-1 -mr-1.5"}
			icon={<X />}
			label={dismissLabel ?? t("common.close")}
			onClick={onDismiss}
			size="sm"
			tooltip={false}
		/>
	);
	return (
		<div
			{...rest}
			className={cx(
				"rounded-(--sc-radius-md) border text-(--sc-text)",
				compact
					? "flex items-center gap-2 py-1 pr-1 pl-2.5 text-sc-sm"
					: // `omp-banner`: the phone's own padding (mobile.css); a compact row keeps its own.
						"omp-banner flex flex-wrap items-start gap-3 px-3 py-2.5 text-sc-md",
				style.box,
				className,
			)}
			ref={ref}
			role={live ? (variant === "danger" ? "alert" : "status") : role}
		>
			{glyph}
			{compact ? (
				<>
					<div className="min-w-0 flex-1 text-(--sc-text-secondary)">
						{title && <div className="font-semibold text-(--sc-text)">{title}</div>}
						{children}
					</div>
					{actions}
					{dismiss}
				</>
			) : (
				<>
					<div className="min-w-0 flex-1 basis-40 break-words py-px">
						{title && <div className="font-semibold">{title}</div>}
						{children && (
							<div className={cx(title ? "mt-0.5" : undefined, "text-(--sc-text-secondary)")}>{children}</div>
						)}
					</div>
					{actions && (
						<div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 self-center">
							{actions}
						</div>
					)}
					{dismiss}
				</>
			)}
		</div>
	);
});
