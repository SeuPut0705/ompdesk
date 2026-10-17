import { Moon, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { IconButton } from "../../common";
import type { OvernightSummary } from "./autopilot-view";

/** The window must have been hidden this long before the card says what happened meanwhile. */
export const AWAY_MS = 60 * 60_000;

/** The time the window came back in view after at least {@link AWAY_MS} hidden, until the user dismisses it. */
export function useAwaySince(): [number | null, () => void] {
	const [since, setSince] = useState<number | null>(null);
	useEffect(() => {
		if (typeof document === "undefined") return;
		let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
		const onChange = () => {
			if (document.visibilityState === "hidden") {
				hiddenAt = Date.now();
				return;
			}
			if (hiddenAt !== null && Date.now() - hiddenAt >= AWAY_MS) setSince(hiddenAt);
			hiddenAt = null;
		};
		document.addEventListener("visibilitychange", onChange);
		return () => document.removeEventListener("visibilitychange", onChange);
	}, []);
	return [since, () => setSince(null)];
}

/** "While you were away": counted from the journal alone, no model call. Closable. */
export function OvernightCard({ summary, onDismiss }: { summary: OvernightSummary; onDismiss: () => void }) {
	const t = useT();
	const lines = [
		t("autopilot.away.cycles", { cycles: summary.cycles, commits: summary.commits, red: summary.red }),
		summary.pushes > 0 ? t("autopilot.away.pushes", { count: summary.pushes }) : null,
		summary.releases.length > 0 ? t("autopilot.away.releases", { versions: summary.releases.join(", ") }) : null,
		summary.failedShips > 0 ? t("autopilot.away.failed", { count: summary.failedShips }) : null,
	].filter(Boolean);
	return (
		<aside
			aria-label={t("autopilot.away.title")}
			className="mx-3 mt-3 flex items-start gap-2 rounded-(--sc-radius-md) border border-(--sc-border) bg-(--sc-surface-2) p-2.5"
			data-autopilot-away
		>
			<Moon aria-hidden className="mt-0.5 size-(--sc-icon-sm) shrink-0 text-(--sc-accent)" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sc-sm">
				<strong className="font-medium">{t("autopilot.away.title")}</strong>
				{lines.map(line => (
					<span className="text-(--sc-text-secondary)" key={line}>
						{line}
					</span>
				))}
			</div>
			<IconButton icon={<X />} label={t("common.close")} onClick={onDismiss} size="sm" />
		</aside>
	);
}
