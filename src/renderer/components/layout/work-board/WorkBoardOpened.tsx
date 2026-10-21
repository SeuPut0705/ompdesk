/**
 * The work board's rows for the sessions an agent opened: status only (working, waiting, failed), no buttons. The
 * opener's agent reviews and lands its children with its tools; a click on a row focuses the child. Loaded on demand
 * by `WorkBoard.tsx` (the phone's first screen never needs them).
 */
import { Check, X } from "lucide-react";
import { useLiveReview } from "../../../hooks/use-live-review";
import { useSessionSpend } from "../../../hooks/use-session-spend";
import { formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useProjectNames } from "../../../lib/project-origin";
import { costKinds, costWords } from "../../../lib/spend";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { useClosedChildrenStore } from "../../../stores/closed-children";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { CostAmount, hasCost } from "../../common/CostAmount";
import { BoardRow, BoardSection, CappedRows, Dot, SECTION_CAP } from "./board-parts";
import { childActivity, type OpenedChildCounts, type OpenedChildRow } from "./opened-children";

/** A session this one's agent opened, as a child like a subagent: status, what it does now, how long, its branch. */
function OpenedRow({ row, now }: { row: OpenedChildRow; now: number }) {
	const t = useT();
	// What it runs on and has cost: main's push for an open one, else what main recorded when it closed it.
	const live = useAgentReviewStore(state => state.usage[row.sessionPath ?? row.tabId ?? ""]);
	const closed = useClosedChildrenStore(state => state.rows.find(entry => entry.path === row.sessionPath));
	const usage = live ?? closed;
	// Its own host's split (a mixed journal: the judge, a model switch), else its cost by its model's billing.
	const kinds = costKinds(usage, useSessionSpend()?.billing);
	const title = row.title || t("workBoard.review.untitled");
	const status = row.status;
	const statusLabel = status ? t(`workBoard.opened.status.${status}`) : t("workBoard.opened.status.open");
	const branch = row.branch ? t("workBoard.review.branch", { branch: row.branch, base: row.base ?? "—" }) : null;
	const mergeNote = row.merge ? t(`workBoard.opened.merge.${row.merge}`) : null;
	const report = row.report
		? t("workBoard.opened.report", { kind: t(`chat.custom.mail.kind.${row.report.kind}`), text: row.report.text })
		: null;
	const note =
		status === "running" && row.step && !row.report
			? row.step
			: report && status !== "done"
				? report
				: [status === "running" ? null : statusLabel, mergeNote].filter(Boolean).join(" · ");
	// A closed child whose folder is gone says so before the click (the open then offers Restore when it was saved).
	const storedCwd = !row.tabId && row.sessionPath ? row.cwd : undefined;
	const projectName = useProjectNames(storedCwd ? [storedCwd] : []);
	const gone = storedCwd !== undefined && projectName(storedCwd).gone;
	const activity = childActivity(row);
	const open = () => {
		if (row.tabId) void useTabsStore.getState().applyAgentView({ tabId: row.tabId, how: "focus" });
		else if (row.sessionPath)
			void useTabsStore.getState().openTab({ cwd: row.cwd, sessionPath: row.sessionPath, kind: "agent" });
	};
	return (
		<BoardRow
			data={{
				"data-board-opened": row.key,
				"data-status": status ?? "open",
				...(row.report ? { "data-board-report": row.report.kind } : {}),
			}}
			label={
				<>
					{title}
					{row.device ? (
						<span className="text-(--sc-text-subtle)">
							{" · "}
							<span data-board-device>{row.device}</span>
						</span>
					) : null}
					{gone ? (
						<span className="text-(--sc-warning)">
							{" · "}
							<span data-session-folder-gone>{t("sessionFolder.gone")}</span>
						</span>
					) : null}
				</>
			}
			lead={
				status === "done" ? (
					<Check aria-hidden className="size-3 text-(--sc-success)" />
				) : status === "problem" ? (
					<X aria-hidden className="size-3 text-(--sc-danger)" />
				) : (
					<Dot
						ring={status === null}
						tone={status === "waiting" ? "warning" : status === "running" ? "info" : "muted"}
					/>
				)
			}
			// Title first (and the device it runs on), then how long it has run or what it cost; under it, muted, what it
			// does now (its step), the question it waits on or its last report. Branch, model and cost in words are the
			// tooltip.
			meta={
				status === "running" && row.since ? (
					formatElapsed(Math.max(0, now - row.since))
				) : hasCost(kinds) ? (
					<CostAmount className="tabular-nums" data={{ "data-board-opened-cost": true }} kinds={kinds} />
				) : undefined
			}
			onClick={open}
			sub={
				activity ? (
					<span className="min-w-0 truncate" data-board-child-activity>
						{activity}
					</span>
				) : undefined
			}
			title={[
				`${title}${row.device ? ` · ${row.device}` : ""}`,
				note || statusLabel,
				gone ? t("sessionFolder.goneTip") : null,
				branch,
				[usage?.model, costWords(t, kinds)].filter(Boolean).join(" · "),
			]
				.filter(Boolean)
				.join("\n")}
		/>
	);
}

export function OpenedSection({
	rows,
	counts,
	now,
}: {
	rows: readonly OpenedChildRow[];
	counts: OpenedChildCounts;
	now: number;
}) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	useLiveReview(
		runtimeTabId ?? activeTabId,
		rows.some(row => row.status === "running"),
	);
	return (
		<BoardSection
			aside={counts.closed > 0 ? t("workBoard.opened.closed", { count: counts.closed }) : null}
			count={rows.length}
			id="opened"
			title={t("workBoard.opened")}
		>
			<CappedRows cap={SECTION_CAP.opened} items={rows}>
				{row => <OpenedRow key={row.key} now={now} row={row} />}
			</CappedRows>
		</BoardSection>
	);
}
