import { Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
	AutopilotChildReport,
	AutopilotCycleRecord,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { formatAutopilotLog } from "../../../shared/autopilot-log";
import { formatCost, formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useAutopilotStore } from "../../stores/autopilot";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, ConfirmDialog, CopyButton, LinkButton } from "../common";
import { BoardSection, CappedRows, Dot } from "../layout/work-board/board-parts";
import { AreaIcon } from "./AreaIcon";
import { useAutopilotActions } from "./use-autopilot-actions";

/** Cycles the board lists before the older ones fold into one "+N more" row. */
const SHOWN_CYCLES = 5;

const VERIFY_TONE: Record<AutopilotCycleRecord["verify"], "success" | "danger" | "muted" | "warning"> = {
	green: "success",
	red: "danger",
	skipped: "muted",
	unreported: "warning",
};

/** A commit in the Changes panel's commits view (it opens the commit and scrolls to it). */
function showCommit(sha: string): void {
	const ui = useUiStore.getState();
	ui.setChangesMode("commits");
	ui.setChangesFocusCommit(sha);
	ui.setPanelTab("diff");
}

function ShaLink({ sha }: { sha: string }) {
	return (
		<LinkButton className="font-mono text-sc-xs" data-autopilot-sha={sha} onClick={() => showCommit(sha)} title={sha}>
			{sha.slice(0, 7)}
		</LinkButton>
	);
}

function ChildReport({ child }: { child: AutopilotChildReport }) {
	const t = useT();
	return (
		<span className="flex min-w-0 items-center gap-1.5" data-autopilot-child-report>
			<span aria-hidden className="text-(--sc-text-subtle)">
				└
			</span>
			<span className="min-w-0 flex-1 truncate font-mono" title={child.branch}>
				{child.branch}
			</span>
			<span className="shrink-0">{t(`autopilot.outcome.${child.outcome}`)}</span>
			{child.sha && <ShaLink sha={child.sha} />}
		</span>
	);
}

/**
 * One cycle: one line (area, title, verify dot); a tap opens its details in place under it (commit, time, tokens,
 * cost, what it changed, why a reported green was not taken, its children and the revert). The row expands in place
 * (`data-board-expands`), so the phone's strip stays open.
 */
function CycleRow({
	cycle,
	onRevert,
}: {
	cycle: AutopilotCycleRecord;
	onRevert: (cycle: AutopilotCycleRecord) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const verify = t(`autopilot.verify.${cycle.verify}`);
	const title = cycle.title.trim() || t("autopilot.untitled");
	return (
		<li className="omp-work-board-item" data-autopilot-cycle={cycle.n} data-verify={cycle.verify}>
			<button
				aria-expanded={open}
				className="omp-work-board-row"
				data-board-expands=""
				onClick={() => setOpen(!open)}
				title={[`${t("autopilot.cycleN", { n: cycle.n })} · ${verify}`, cycle.summary || title].join("\n")}
				type="button"
			>
				<span className="omp-work-board-lead">
					<AreaIcon area={cycle.area} />
				</span>
				<span className="min-w-0 flex-1 truncate">{title}</span>
				<span className="omp-work-board-meta flex items-center gap-1.5">
					<span className="tabular-nums">{cycle.n}</span>
					<span aria-label={verify} className="inline-flex" data-autopilot-verify-dot role="img">
						<Dot tone={VERIFY_TONE[cycle.verify]} />
					</span>
				</span>
			</button>
			{open && (
				<div className="omp-work-board-detail" data-autopilot-cycle-detail>
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 tabular-nums">
						{cycle.commit && <ShaLink sha={cycle.commit} />}
						<span>{formatDuration(cycle.durationMs)}</span>
						<span>{t("autopilot.tokens", { tokens: formatTokens(cycle.tokens) })}</span>
						{cycle.usd > 0 && <span>{formatCost(cycle.usd, 2)}</span>}
						{cycle.change && (
							<span data-autopilot-change>
								{t("autopilot.change", {
									files: cycle.change.files,
									added: cycle.change.added,
									removed: cycle.change.removed,
								})}
							</span>
						)}
						{cycle.change?.docOnly && <Badge variant="muted">{t("autopilot.docOnly")}</Badge>}
						{cycle.reverted && <Badge variant="muted">{t("autopilot.reverted")}</Badge>}
					</span>
					{cycle.verifyNote && (
						<span className="text-(--sc-warning)" data-autopilot-verify-note={cycle.verifyNote.kind}>
							{t(`autopilot.verifyNote.${cycle.verifyNote.kind}`, { command: cycle.verifyNote.command ?? "" })}
						</span>
					)}
					{cycle.children.map(child => (
						<ChildReport child={child} key={child.session || child.branch} />
					))}
					{cycle.commit && !cycle.reverted && (
						<span>
							<Button
								data-autopilot-revert={cycle.n}
								icon={<Undo2 aria-hidden />}
								onClick={() => onRevert(cycle)}
								size="sm"
								variant="ghost"
							>
								{t("autopilot.revert")}
							</Button>
						</span>
					)}
				</div>
			)}
		</li>
	);
}

/**
 * The run's cycles on the work board, newest first: the newest {@link SHOWN_CYCLES}, the older ones behind one row, the
 * log to copy as Markdown in the header, and the red streak from two on.
 */
export function AutopilotCyclesSection() {
	const t = useT();
	const cycles = useAutopilotStore(s => s.status.cycles);
	const branch = useAutopilotStore(s => s.status.branch);
	const { run, pending } = useAutopilotActions();
	const [reverting, setReverting] = useState<AutopilotCycleRecord | null>(null);
	const newestFirst = useMemo(() => [...(cycles ?? [])].sort((a, b) => b.n - a.n), [cycles]);
	if (newestFirst.length === 0) return null;
	return (
		<BoardSection
			aside={
				<CopyButton
					data-autopilot-copy-log
					label={t("autopilot.copyLog")}
					text={() => formatAutopilotLog({ branch: branch ?? "autopilot", cycles: newestFirst })}
				/>
			}
			count={newestFirst.length}
			id="cycles"
			title={t("autopilot.timeline")}
		>
			<CappedRows cap={SHOWN_CYCLES} items={newestFirst}>
				{cycle => <CycleRow cycle={cycle} key={cycle.n} onRevert={setReverting} />}
			</CappedRows>
			<li className="contents">
				<ConfirmDialog
					busy={pending === "ship"}
					confirmLabel={t("autopilot.revert")}
					message={t("autopilot.revertConfirm.message", { n: reverting?.n ?? 0, title: reverting?.title ?? "" })}
					onCancel={() => setReverting(null)}
					onConfirm={() => {
						const target = reverting;
						setReverting(null);
						if (target) void run({ action: "ship", kind: "revert", cycle: target.n });
					}}
					open={reverting !== null}
					title={t("autopilot.revertConfirm.title")}
					warning={t("autopilot.revertConfirm.warning")}
				/>
			</li>
		</BoardSection>
	);
}
