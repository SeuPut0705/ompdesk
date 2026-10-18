/**
 * Banner — a persistent, inline message about the state of the surface it
 * sits in (sidecar disconnected, update ready, omp too old, read-only
 * session). It stays until the condition changes or the user dismisses it.
 *
 * Rules: one sentence, plus at most two actions (Buttons size sm, the fix
 * first). `danger` for broken functionality, `warning` for degraded,
 * `info` for neutral news, `success` for a just-completed state change.
 * Transient feedback ("Copied") is a Toast, not a Banner. Set `live` only
 * when the banner appears in response to something the user is waiting on.
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IconButton } from "./IconButton";

export type BannerVariant = "info" | "success" | "warning" | "danger";

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
};

export interface BannerProps {
	variant?: BannerVariant;
	title?: ReactNode;
	children?: ReactNode;
	/** Buttons (size sm); the fixing action first. */
	actions?: ReactNode;
	onDismiss?: () => void;
	/** Announce on appearance (role="status"; "alert" for danger). */
	live?: boolean;
	className?: string;
}

export function Banner({ variant = "info", title, children, actions, onDismiss, live, className }: BannerProps) {
	const t = useT();
	const style = VARIANTS[variant];
	const Icon = style.Icon;
	return (
		<div
			className={cx(
				"omp-banner flex flex-wrap items-start gap-3 rounded-(--sc-radius-md) border px-3 py-2.5 text-sc-md text-(--sc-text)",
				style.box,
				className,
			)}
			role={live ? (variant === "danger" ? "alert" : "status") : undefined}
		>
			<Icon aria-hidden className={cx("mt-0.5 size-(--sc-icon-md) shrink-0", style.icon)} />
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
			{onDismiss && (
				<IconButton
					className="-my-1 -mr-1.5"
					icon={<X />}
					label={t("common.close")}
					onClick={onDismiss}
					size="sm"
					tooltip={false}
				/>
			)}
		</div>
	);
}
