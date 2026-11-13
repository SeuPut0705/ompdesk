/**
 * Checks destination (docs/design/check-control.md §8): what agents run, for the person to watch. Tabs Now, Merge
 * queue, Tests and cost over the hub's one frame (`useChecksStore`); the tab and the run it was opened on live in
 * the ui store (`checksTab`, `checksRun`, `openChecks(tab, run)`) so the sidebar block, the palette and the work
 * board's row land on the right view.
 *
 * Watch-only: the page's one control is Pause admission. Nothing else on it is a button, and no row acts on a run.
 * A frame the poller has not refreshed inside its window is said to be old above everything (`freshness`), because
 * nothing old may read as current. A phone gets the same page in one column with the tabs as a segmented bar.
 */

import "../../styles/checks.css";
import { Eye, ListChecks, Pause, Play } from "lucide-react";
import { useState } from "react";
import { useShellMode } from "../../hooks/use-shell-mode";
import { freshness } from "../../lib/checks/view";
import { useT } from "../../lib/i18n";
import { useChecksStore } from "../../stores/checks";
import { toastError } from "../../stores/toast";
import { type ChecksTab, useUiStore } from "../../stores/ui";
import { Banner, Button, EmptyState, PageLayout, Tabs, Tooltip } from "../common";
import { ChecksNow } from "./ChecksNow";
import { ChecksQueue } from "./ChecksQueue";
import { ChecksTests } from "./ChecksTests";

const TABS: readonly ChecksTab[] = ["now", "queue", "tests"];

function PauseButton({ paused, short }: { paused: boolean; short: boolean }) {
	const t = useT();
	const [saving, setSaving] = useState(false);
	const toggle = () => {
		setSaving(true);
		window.omp.checks
			.setPaused(!paused)
			.catch(error => toastError({ title: t("checks.pause.failed"), error }))
			.finally(() => setSaving(false));
	};
	const label = t(paused ? "checks.resume" : "checks.pause");
	return (
		<Tooltip content={t("checks.pause.hint")}>
			<Button
				aria-label={short ? label : undefined}
				data-checks-pause={paused ? "paused" : "admitting"}
				icon={paused ? <Play /> : <Pause />}
				loading={saving}
				onClick={toggle}
				size="sm"
			>
				{short ? t(paused ? "checks.resumeShort" : "checks.pauseShort") : label}
			</Button>
		</Tooltip>
	);
}

export function ChecksPage() {
	const t = useT();
	const tab = useUiStore(state => state.checksTab);
	const openChecks = useUiStore(state => state.openChecks);
	const frame = useChecksStore(state => state.frame);
	// Last run's frame, painted until main answers: a quiet note, shown only if the answer takes a moment.
	const remembered = useChecksStore(state => state.remembered);
	const fresh = frame ? freshness(frame) : "live";
	const phone = useShellMode() === "phone";

	return (
		<PageLayout
			actions={
				frame && (
					<>
						{remembered && (
							<span
								className="omp-updating-hint text-sc-xs text-(--sc-text-muted)"
								data-checks-remembered
								role="status"
							>
								{t("checks.updating")}
							</span>
						)}
						{!phone && (
							<span className="flex items-center gap-1.5 text-sc-sm text-(--sc-text-muted)">
								<Eye aria-hidden className="size-3.5" />
								{t("checks.watchOnly")}
							</span>
						)}
						<PauseButton paused={frame.snapshot.paused} short={phone} />
					</>
				)
			}
			className="omp-checks"
			panelLabel={t(`checks.tabs.${tab}`)}
			tabs={
				<Tabs
					activeId={tab}
					ariaLabel={t("checks.title")}
					onChange={id => openChecks(id as ChecksTab)}
					tabs={TABS.map(id => ({
						id,
						label: t(phone && id === "tests" ? "checks.tabs.testsShort" : `checks.tabs.${id}`),
					}))}
					variant={phone ? "segmented" : "underline"}
				/>
			}
			title={t("checks.title")}
		>
			{frame ? (
				<>
					{fresh !== "live" && (
						<Banner className="mb-4" data-checks-stale={fresh} variant="warning">
							{t(fresh === "lost" ? "checks.lost" : "checks.stale")}
						</Banner>
					)}
					{frame.snapshot.paused && (
						<Banner className="mb-4" data-checks-paused variant="warning">
							{t("checks.paused")}
						</Banner>
					)}
					<div data-checks-tab={tab}>
						{tab === "now" ? (
							<ChecksNow frame={frame} />
						) : tab === "queue" ? (
							<ChecksQueue frame={frame} />
						) : (
							<ChecksTests frame={frame} />
						)}
					</div>
				</>
			) : (
				<EmptyState
					data-checks-empty
					description={t("checks.empty.desc")}
					icon={<ListChecks />}
					title={t("checks.empty.title")}
				/>
			)}
		</PageLayout>
	);
}
