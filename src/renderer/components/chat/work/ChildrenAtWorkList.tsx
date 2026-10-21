/**
 * The rows of `ChildrenAtWork` (ChildrenAtWork.tsx loads this lazily: it only shows once a session has opened children,
 * so it stays out of the phone's first-screen JavaScript).
 */
import { useLiveReview } from "../../../hooks/use-live-review";
import { cx, formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useTabsStore } from "../../../stores/tabs";
import { childActivity, type OpenedChildRow } from "../../layout/work-board/opened-children";
import { useChildrenAtWork } from "./ChildrenAtWork";

function ChildLine({ row, now }: { row: OpenedChildRow; now: number }) {
	const t = useT();
	const title = row.title || t("workBoard.review.untitled");
	const activity = childActivity(row) ?? (row.status === "waiting" ? t("workBoard.opened.status.waiting") : null);
	const clock = row.status === "running" && row.since ? formatElapsed(Math.max(0, now - row.since)) : "";
	return (
		<li>
			<button
				className="omp-children-at-work-row"
				data-child-at-work={row.key}
				data-status={row.status ?? "open"}
				onClick={() => {
					if (row.tabId) void useTabsStore.getState().applyAgentView({ tabId: row.tabId, how: "focus" });
				}}
				title={[title, activity].filter(Boolean).join("\n")}
				type="button"
			>
				<span aria-hidden className="omp-children-at-work-dot" data-status={row.status ?? "open"} />
				<span className="omp-children-at-work-title">{title}</span>
				{activity ? <span className="omp-children-at-work-step">{activity}</span> : null}
				{clock ? <span className="omp-children-at-work-clock">{clock}</span> : null}
			</button>
		</li>
	);
}

export function ChildrenAtWorkList({ className }: { className?: string }) {
	const t = useT();
	const { tabId, rows } = useChildrenAtWork();
	const running = rows.some(row => row.status === "running");
	useLiveReview(tabId, running);
	const now = useNowTick(running);
	if (rows.length === 0) return null;
	return (
		<section
			aria-label={t("workBoard.opened")}
			className={cx("omp-children-at-work", className)}
			data-children-at-work
		>
			<ul>
				{rows.map(row => (
					<ChildLine key={row.key} now={now} row={row} />
				))}
			</ul>
		</section>
	);
}
