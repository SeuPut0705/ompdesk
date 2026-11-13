/**
 * Sidebar footer Checks block (docs/design/check-control.md §8): what the check pools are doing, at a glance. A head
 * line (the glyph, "Checks", and at its end the jobs waiting in the warning badge), a `Gauge` per pool that has work
 * (GitHub's macOS limit, this computer, a paired one: slots in use over its limit, the oldest wait or the free disk
 * under it) and the first release's gate line. At most four pools; the rest fold into one "+2 more pools" line. A
 * full pool is the warning fill, never danger: it is busy, not broken.
 *
 * Draws nothing while main has sent no frame or no pool has work. Not a pin and has no setting. The whole block is
 * ONE button that opens the Checks page (watch only: nothing in it acts on a run), so its accessible name says the
 * block in a sentence, because a button's children are presentational to a screen reader. Nothing old reads as
 * current: while the hub reads no pool as live the badge gives way to a muted "not read lately", and while main
 * cannot reach the hub to "offline"; a paused hub says "Paused" in place of the count.
 */

import { ListChecks, Rocket } from "lucide-react";
import type { Pool } from "../../../../shared/checks-contract";
import type { ChecksFrame } from "../../../../shared/checks-frame";
import {
	freshness,
	gateProgress,
	poolFill,
	poolKind,
	poolLoad,
	poolName,
	poolsWithWork,
	releases,
	releaseWaits,
	waitingJobs,
} from "../../../lib/checks/view";
import { formatSpanCompact, uiLocale } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useChecksStore } from "../../../stores/checks";
import { useUiStore } from "../../../stores/ui";
import { Badge, Gauge } from "../../common";

/** Pools drawn as gauges; the rest fold into one line. */
const MAX_POOLS = 4;

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The line under a pool's gauge: why its figure is old, how long the queue has waited, or what disk is left. */
function poolCaption(pool: Pool, frame: ChecksFrame, t: Translate): string | undefined {
	if (pool.state === "stale") return t("sidebar.checks.notRead");
	const kind = poolKind(pool, frame.names);
	if ((kind === "github" || kind === "runner") && pool.queued > 0) {
		return t("sidebar.checks.oldestWait", { time: formatSpanCompact(pool.oldestWaitMs) });
	}
	if ((kind === "here" || kind === "paired") && pool.foreign.length > 0) {
		return t("sidebar.checks.foreign", { count: pool.foreign.length });
	}
	if ((kind === "here" || kind === "paired") && pool.diskFreeGb !== undefined) {
		return t("sidebar.checks.disk", { size: Math.round(pool.diskFreeGb).toLocaleString(uiLocale()) });
	}
	return undefined;
}

/** "6 of 10 gates green", or "all gates green" once every gate is. */
function gatesText(green: number, total: number, t: Translate): string {
	return green === total && total > 0 ? t("sidebar.checks.gatesAll") : t("sidebar.checks.gates", { green, total });
}

export function SidebarChecks() {
	const t = useT();
	const frame = useChecksStore(s => s.frame);
	const current = useUiStore(s => s.destination === "checks");
	const pools = frame ? poolsWithWork(frame) : [];
	if (!frame || pools.length === 0) return null;

	const { snapshot, names } = frame;
	const fresh = freshness(frame);
	const waiting = waitingJobs(snapshot);
	// What the head says in place of a count when the count cannot be trusted, or the hub is paused.
	const quiet =
		fresh === "lost" ? t("sidebar.checks.offline") : fresh === "stale" ? t("sidebar.checks.notRead") : null;
	const paused = quiet === null && snapshot.paused ? t("sidebar.checks.paused") : null;
	const waitingText =
		quiet === null && paused === null && waiting > 0 ? t("sidebar.checks.waiting", { count: waiting }) : null;
	const status = quiet ?? paused ?? waitingText;

	const shown = pools.slice(0, MAX_POOLS);
	const hidden = pools.length - shown.length;
	const release = releases(snapshot)[0];
	const progress = release ? gateProgress(release) : null;
	const waitsAt = release ? releaseWaits(release, snapshot)[0]?.pool : undefined;
	const gates = progress ? gatesText(progress.green, progress.total, t) : null;
	const releaseLine = release
		? [release.id, gates, waitsAt ? t("sidebar.checks.waitsOn", { pool: poolName(waitsAt, names) }) : null]
				.filter(Boolean)
				.join(" · ")
		: null;

	const poolsSentence = pools
		.map(pool =>
			t("sidebar.checks.poolSummary", { name: poolName(pool, names), running: poolLoad(pool), limit: pool.limit }),
		)
		.join(", ");
	const label = [
		status ? t("sidebar.checks.nameHead", { status }) : `${t("sidebar.checks.title")}.`,
		`${poolsSentence}.`,
		release && gates ? t("sidebar.checks.nameRelease", { name: release.id, progress: gates }) : null,
		t("sidebar.checks.open"),
	]
		.filter(Boolean)
		.join(" ");

	return (
		// controls-ok: the omp-sidebar-checks class draws the whole block; this button is its one click target
		<button
			aria-current={current ? "page" : undefined}
			aria-label={label}
			className="omp-sidebar-checks"
			data-destination="checks"
			data-freshness={fresh}
			data-sidebar-checks
			onClick={() => useUiStore.getState().openChecks()}
			type="button"
		>
			<span className="omp-sidebar-checks-head">
				<ListChecks aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="min-w-0 flex-1 truncate">{t("sidebar.checks.title")}</span>
				{quiet ? (
					<span className="omp-sidebar-checks-quiet" data-checks-quiet>
						{quiet}
					</span>
				) : paused ? (
					<Badge size="xs">{paused}</Badge>
				) : waitingText ? (
					<Badge size="xs" variant="warning">
						{waitingText}
					</Badge>
				) : null}
			</span>
			<span className="omp-sidebar-checks-pools">
				{shown.map(pool => {
					const name = poolName(pool, names);
					const fill = poolFill(pool);
					return (
						<Gauge
							ariaLabel={
								pool.limit === 1
									? t("sidebar.checks.slotsOne", { name, running: poolLoad(pool) })
									: t("sidebar.checks.slots", { name, running: poolLoad(pool), limit: pool.limit })
							}
							caption={poolCaption(pool, frame, t)}
							data-pool={pool.id}
							fraction={fill.fraction}
							key={pool.id}
							label={name}
							state={fill.tone === "full" ? "near" : "ok"}
							valueText={`${poolLoad(pool)}/${pool.limit}`}
						/>
					);
				})}
				{hidden > 0 && (
					<span className="omp-sidebar-checks-more">
						{hidden === 1 ? t("sidebar.checks.morePoolsOne") : t("sidebar.checks.morePools", { count: hidden })}
					</span>
				)}
			</span>
			{releaseLine && (
				<span className="omp-sidebar-checks-release" data-checks-release>
					<Rocket aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="omp-sidebar-checks-release-text">{releaseLine}</span>
				</span>
			)}
		</button>
	);
}
