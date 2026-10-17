/**
 * One-row update notice at the bottom of the sidebar: an icon, the version and
 * state in a few words, one icon action, and dismiss. The full sentence (and the
 * manual-install steps) lives in the tooltip and the accessible description.
 * Background modes (automatic, relaunch) download on their own and appear only
 * once the update is ready: restart to apply, or it installs on quit. The manual
 * macOS fallback (a read-only location) walks download → open installer here.
 * "Later" hides the row for that version.
 *
 * A check the user asked for (app menu › Check for Updates…) runs here too,
 * Claude-style, instead of opening Settings: "Checking…", then "up to date"
 * (fades after a few seconds), the background download's progress, a failure
 * with retry, or — only when GitHub access is missing — a link to the Updates
 * settings where the token lives. Background polls stay silent; their
 * failures stay in UpdateBanner.
 */
import { AlertCircle, ArrowUpCircle, CheckCircle2, Download, ExternalLink, RotateCw, Settings, X } from "lucide-react";
import { type ReactElement, useEffect, useId } from "react";
import type { UpdateStatus } from "../../../../shared/ipc-types";
import { useT } from "../../../lib/i18n";
import { useSecondsUntil } from "../../../lib/use-seconds-until";
import { useUiStore } from "../../../stores/ui";
import { checkForUpdatesInPlace, useUpdaterStore } from "../../../stores/updater";
import { IconButton, Spinner } from "../../common";

/** How long "up to date" stays before the row goes away on its own. */
export const UP_TO_DATE_MS = 4000;

type RowTone = "update" | "busy" | "ok" | "error";

interface RowModel {
	label: string;
	description: string;
	tone: RowTone;
	action?: { label: string; icon: ReactElement; onClick: () => void; primary?: boolean };
	progress?: number;
	/** Close: hide this version ("Later"), or end a manual check's report. */
	onClose: () => void;
	closeLabel: string;
}

function manualRow(
	status: UpdateStatus,
	t: (key: string, params?: Record<string, string | number>) => string,
	end: () => void,
): RowModel | null {
	const close = { onClose: end, closeLabel: t("common.close") };
	switch (status.state) {
		case "idle":
		case "checking":
			return {
				label: t("updater.card.checking"),
				description: t("updater.card.checking"),
				tone: "busy",
				...close,
			};
		case "not-available":
			return {
				label: t("updater.card.upToDate", { version: status.version }),
				description: t("updater.card.upToDate", { version: status.version }),
				tone: "ok",
				...close,
			};
		case "error":
			return {
				label: t("updater.card.failed"),
				description: status.detail ? `${status.message}\n${status.detail}` : status.message,
				tone: "error",
				action: { label: t("updater.retry"), icon: <RotateCw />, onClick: () => void checkForUpdatesInPlace() },
				...close,
			};
		case "auth-required":
			return {
				label: t("updater.card.authRequired"),
				description: t("updater.card.authRequired"),
				tone: "error",
				action: {
					label: t("updater.card.openSettings"),
					icon: <Settings />,
					onClick: () => {
						end();
						useUiStore.getState().openSettings("updates");
					},
				},
				...close,
			};
		case "available":
			// Background modes start downloading on their own; manual mode keeps its own row below.
			if (status.mode === "manual") return null;
			return {
				label: t("updater.card.compactAvailable", { version: status.version }),
				description: t("updater.card.downloadingHint"),
				tone: "busy",
				progress: 0,
				...close,
			};
		case "downloading":
			if (status.mode === "manual") return null;
			return {
				label: t("updater.card.compactDownloading", { percent: Math.round(status.percent) }),
				description: t("updater.card.downloadingHint"),
				tone: "busy",
				progress: status.percent,
				...close,
			};
		default:
			return null;
	}
}

export function SidebarUpdateCard() {
	const t = useT();
	const descriptionId = useId();
	const status = useUpdaterStore(s => s.status);
	const dismissedVersion = useUpdaterStore(s => s.dismissed.version);
	const dismiss = useUpdaterStore(s => s.dismiss);
	const manualCheck = useUpdaterStore(s => s.manualCheck);
	const endManualCheck = useUpdaterStore(s => s.endManualCheck);
	const secondsLeft = useSecondsUntil(status.state === "downloaded" ? status.restartAt : undefined);

	// "Up to date" is news, not a state to keep on screen.
	const upToDate = manualCheck && status.state === "not-available";
	useEffect(() => {
		if (!upToDate) return;
		const timer = setTimeout(endManualCheck, UP_TO_DATE_MS);
		return () => clearTimeout(timer);
	}, [upToDate, endManualCheck]);

	let row: RowModel | null = manualCheck ? manualRow(status, t, endManualCheck) : null;
	// The automatic install's notice (Settings › Updates & about › Install updates automatically): never dismissed away, "Later" postpones.
	const countingDown = status.state === "downloaded" && status.restartAt !== undefined;
	if (!row && status.state === "downloaded" && countingDown) {
		row = {
			label: t("updater.card.autoRestart", { seconds: secondsLeft ?? 0 }),
			description: t("updater.card.autoRestartHint", { seconds: secondsLeft ?? 0 }),
			tone: "update",
			action: {
				label: t("updater.card.restartNow"),
				icon: <RotateCw />,
				onClick: () => void window.omp.updater.apply(),
				primary: true,
			},
			onClose: () => void window.omp.updater.postpone(),
			closeLabel: t("updater.card.later"),
		};
	} else if (!row && status.state === "downloaded") {
		const manual = status.mode === "manual";
		row = {
			label: t("updater.card.compactReady", { version: status.version }),
			description: `${t("updater.card.ready", { version: status.version })} ${t(manual ? "updater.manualInstructions" : "updater.card.readyHint")}`,
			tone: "update",
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
			onClose: () => {
				dismiss(status.version);
				endManualCheck();
			},
			closeLabel: t("updater.card.later"),
		};
	} else if (!row && status.state === "available" && status.mode === "manual") {
		row = {
			label: t("updater.card.compactAvailable", { version: status.version }),
			description: t("updater.available", { version: status.version }),
			tone: "update",
			action: {
				label: t("updater.downloadInstaller"),
				icon: <Download />,
				onClick: () => void window.omp.updater.download(),
				primary: true,
			},
			onClose: () => {
				dismiss(status.version);
				endManualCheck();
			},
			closeLabel: t("updater.card.later"),
		};
	} else if (!row && status.state === "downloading" && status.mode === "manual") {
		row = {
			label: t("updater.card.compactDownloading", { percent: Math.round(status.percent) }),
			description: t("updater.downloadingInstaller"),
			tone: "busy",
			progress: status.percent,
			onClose: () => {
				dismiss(status.version);
				endManualCheck();
			},
			closeLabel: t("updater.card.later"),
		};
	}
	if (!row) return null;
	// A version the user put off stays hidden, unless they just asked to check.
	if (!countingDown && !manualCheck && "version" in status && dismissedVersion === status.version) return null;

	const icon =
		row.tone === "busy" && row.progress === undefined ? (
			<Spinner size="sm" />
		) : row.tone === "ok" ? (
			<CheckCircle2 aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-success)" />
		) : row.tone === "error" ? (
			<AlertCircle aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-danger)" />
		) : (
			<ArrowUpCircle aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-accent)" />
		);

	return (
		<section
			aria-describedby={descriptionId}
			aria-label={row.label}
			aria-live="polite"
			className="omp-update-card relative mx-2 mb-2 flex min-h-(--sc-control-lg) items-center gap-2 overflow-hidden rounded-(--sc-radius-md) bg-(--sc-hover) pr-1 pl-2.5"
			data-sidebar-update
			data-update-tone={row.tone}
			title={row.description}
		>
			<span className="flex size-(--sc-icon-sm) shrink-0 items-center justify-center">{icon}</span>
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
			<IconButton className="shrink-0" icon={<X />} label={row.closeLabel} onClick={row.onClose} size="sm" />
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
