/**
 * One-row update notice at the bottom of the sidebar: an icon, the version and
 * state in a few words, one icon action, and dismiss. The full sentence (and the
 * manual-install steps) lives in the tooltip and the accessible description.
 * Background modes (automatic, relaunch) download on their own and appear only
 * once the update is ready: restart to apply, or it installs on quit. The manual
 * macOS fallback (a read-only location) walks download → open installer here.
 * "Later" hides the row for that version. Failures stay in UpdateBanner.
 */
import { ArrowUpCircle, Download, ExternalLink, RotateCw, X } from "lucide-react";
import { type ReactElement, useId } from "react";
import { useT } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { IconButton } from "../common";

interface RowModel {
	label: string;
	description: string;
	action?: { label: string; icon: ReactElement; onClick: () => void; primary?: boolean };
	progress?: number;
}

export function SidebarUpdateCard() {
	const t = useT();
	const descriptionId = useId();
	const status = useUpdaterStore(s => s.status);
	const dismissedVersion = useUpdaterStore(s => s.dismissed.version);
	const dismiss = useUpdaterStore(s => s.dismiss);

	let row: RowModel;
	if (status.state === "downloaded") {
		const manual = status.mode === "manual";
		row = {
			label: t("updater.card.compactReady", { version: status.version }),
			description: `${t("updater.card.ready", { version: status.version })} ${t(manual ? "updater.manualInstructions" : "updater.card.readyHint")}`,
			action: manual
				? {
						label: t("updater.openInstaller"),
						icon: <ExternalLink />,
						onClick: () => void window.omp.updater.apply(),
					}
				: {
						label: t("updater.card.restart"),
						icon: <RotateCw />,
						onClick: () => void window.omp.updater.apply(),
						primary: true,
					},
		};
	} else if (status.state === "available" && status.mode === "manual") {
		row = {
			label: t("updater.card.compactAvailable", { version: status.version }),
			description: t("updater.available", { version: status.version }),
			action: {
				label: t("updater.downloadInstaller"),
				icon: <Download />,
				onClick: () => void window.omp.updater.download(),
				primary: true,
			},
		};
	} else if (status.state === "downloading" && status.mode === "manual") {
		row = {
			label: t("updater.card.compactDownloading", { percent: Math.round(status.percent) }),
			description: t("updater.downloadingInstaller"),
			progress: status.percent,
		};
	} else {
		return null;
	}
	if (dismissedVersion === status.version) return null;

	return (
		<section
			aria-describedby={descriptionId}
			aria-label={row.label}
			className="omp-update-card relative mx-2 mb-2 flex h-9 items-center gap-2 overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-elevated) pr-1 pl-2.5"
			data-sidebar-update
			title={row.description}
		>
			<ArrowUpCircle aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-accent)" />
			<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text)">{row.label}</span>
			<span className="sr-only" id={descriptionId}>
				{row.description}
			</span>
			{row.action && (
				<IconButton
					className="shrink-0"
					icon={row.action.icon}
					label={row.action.label}
					onClick={row.action.onClick}
					size="sm"
					variant={row.action.primary ? "primary" : "ghost"}
				/>
			)}
			<IconButton
				className="shrink-0"
				icon={<X />}
				label={t("updater.card.later")}
				onClick={() => dismiss(status.version)}
				size="sm"
			/>
			{row.progress !== undefined && (
				<span
					aria-hidden
					className="absolute bottom-0 left-0 h-0.5 bg-(--sc-accent) transition-[width] duration-(--sc-duration-fast)"
					data-update-progress
					style={{ width: `${Math.max(0, Math.min(100, row.progress))}%` }}
				/>
			)}
		</section>
	);
}
