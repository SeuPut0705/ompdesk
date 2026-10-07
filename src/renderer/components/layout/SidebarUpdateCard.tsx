/**
 * Update card at the bottom of the sidebar, the way Claude and Codex show it.
 * Background modes (automatic, relaunch) download on their own and appear only
 * once the update is ready: one "Restart to update" action, and quitting
 * installs it too. The manual macOS fallback (a read-only location) walks
 * download → open installer here. "Later" hides the card for that version.
 * Update failures stay in the session banner (UpdateBanner).
 */
import { ArrowUpCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { Button, IconButton, ProgressBar } from "../common";

export function SidebarUpdateCard() {
	const t = useT();
	const status = useUpdaterStore(s => s.status);
	const dismissedVersion = useUpdaterStore(s => s.dismissed.version);
	const dismiss = useUpdaterStore(s => s.dismiss);

	let title: string;
	let hint: string | null = null;
	let action: ReactNode = null;
	let progress: number | null = null;
	if (status.state === "downloaded") {
		title = t("updater.card.ready", { version: status.version });
		if (status.mode === "manual") {
			hint = t("updater.manualInstructions");
			action = (
				<Button className="w-full justify-center" onClick={() => void window.omp.updater.apply()} size="sm">
					{t("updater.openInstaller")}
				</Button>
			);
		} else {
			hint = t("updater.card.readyHint");
			action = (
				<Button
					className="w-full justify-center"
					onClick={() => void window.omp.updater.apply()}
					size="sm"
					variant="primary"
				>
					{t("updater.card.restart")}
				</Button>
			);
		}
	} else if (status.state === "available" && status.mode === "manual") {
		title = t("updater.available", { version: status.version });
		action = (
			<Button
				className="w-full justify-center"
				onClick={() => void window.omp.updater.download()}
				size="sm"
				variant="primary"
			>
				{t("updater.downloadInstaller")}
			</Button>
		);
	} else if (status.state === "downloading" && status.mode === "manual") {
		title = t("updater.downloadingInstaller");
		progress = status.percent;
	} else {
		return null;
	}
	if (dismissedVersion === status.version) return null;

	return (
		<section
			aria-label={title}
			className="omp-update-card mx-2 mb-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-3 shadow-(--sc-shadow-sm)"
			data-sidebar-update
		>
			<div className="flex items-start gap-2">
				<ArrowUpCircle aria-hidden className="mt-0.5 size-(--sc-icon-sm) shrink-0 text-(--sc-accent)" />
				<div className="min-w-0 flex-1">
					<p className="text-sc-sm font-medium break-keep text-(--sc-text)">{title}</p>
					{hint ? <p className="mt-0.5 text-sc-xs break-keep text-(--sc-text-muted)">{hint}</p> : null}
				</div>
				<IconButton
					className="-mt-1 -mr-1 shrink-0"
					icon={<X />}
					label={t("updater.card.later")}
					onClick={() => dismiss(status.version)}
					size="sm"
				/>
			</div>
			{progress !== null ? (
				<ProgressBar className="mt-2" color="var(--sc-accent)" height={4} value={progress / 100} />
			) : null}
			{action ? <div className="mt-2.5">{action}</div> : null}
		</section>
	);
}
