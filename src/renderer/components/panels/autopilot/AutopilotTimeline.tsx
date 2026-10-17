import { Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
	AutopilotChildReport,
	AutopilotCycleRecord,
} from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import { formatAutopilotLog } from "../../../../shared/autopilot-log";
import { formatCost, formatDuration, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useUiStore } from "../../../stores/ui";
import { Badge, type BadgeVariant, Button, ConfirmDialog, CopyButton } from "../../common";
import { AreaIcon } from "./AreaIcon";
import { useAutopilotActions } from "./use-autopilot-actions";

/** Cycles the timeline lists before it folds the older ones behind "Show all". */
const SHOWN_CYCLES = 30;

const VERIFY_BADGE: Record<AutopilotCycleRecord["verify"], BadgeVariant> = {
	green: "success",
	red: "error",
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
		<button
			className="font-mono text-sc-xs text-(--sc-accent) hover:underline"
			data-autopilot-sha={sha}
			onClick={() => showCommit(sha)}
			title={sha}
			type="button"
		>
			{sha.slice(0, 7)}
		</button>
	);
}

function ChildReport({ child }: { child: AutopilotChildReport }) {
	const t = useT();
	return (
		<li
			className="flex min-w-0 items-center gap-1.5 pl-5 text-sc-xs text-(--sc-text-secondary)"
			data-autopilot-child-report
		>
			<span aria-hidden className="text-(--sc-text-subtle)">
				└
			</span>
			<span className="min-w-0 flex-1 truncate font-mono" title={child.branch}>
				{child.branch}
			</span>
			<span className="shrink-0 text-(--sc-text-muted)">{t(`autopilot.outcome.${child.outcome}`)}</span>
			{child.sha && <ShaLink sha={child.sha} />}
		</li>
	);
}

function CycleRow({
	cycle,
	onRevert,
}: {
	cycle: AutopilotCycleRecord;
	onRevert: (cycle: AutopilotCycleRecord) => void;
}) {
	const t = useT();
	const verify = cycle.verify;
	return (
		<li className="flex flex-col gap-0.5 py-1.5" data-autopilot-cycle={cycle.n} data-verify={verify}>
			<div className="flex min-w-0 items-center gap-2">
				<span className="w-5 shrink-0 text-right text-sc-xs text-(--sc-text-muted) tabular-nums">{cycle.n}</span>
				<AreaIcon area={cycle.area} />
				<span className="min-w-0 flex-1 truncate text-sc-sm" title={cycle.summary || cycle.title}>
					{cycle.title.trim() || t("autopilot.untitled")}
				</span>
				<Badge dot variant={VERIFY_BADGE[verify]}>
					{t(`autopilot.verify.${verify}`)}
				</Badge>
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 pl-7 text-sc-xs text-(--sc-text-muted) tabular-nums">
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
				{cycle.commit && !cycle.reverted && (
					<Button
						data-autopilot-revert={cycle.n}
						icon={<Undo2 aria-hidden />}
						onClick={() => onRevert(cycle)}
						size="sm"
						variant="ghost"
					>
						{t("autopilot.revert")}
					</Button>
				)}
			</div>
			{cycle.verifyNote && (
				<p className="pl-7 text-sc-xs text-(--sc-warning)" data-autopilot-verify-note={cycle.verifyNote.kind}>
					{t(`autopilot.verifyNote.${cycle.verifyNote.kind}`, { command: cycle.verifyNote.command ?? "" })}
				</p>
			)}
			{cycle.children.length > 0 && (
				<ul className="flex flex-col gap-0.5">
					{cycle.children.map(child => (
						<ChildReport child={child} key={child.session || child.branch} />
					))}
				</ul>
			)}
		</li>
	);
}

/** Every cycle of the run, newest first: area, title, verify result, commit, time and tokens, with a one-click revert. */
export function AutopilotTimeline() {
	const t = useT();
	const cycles = useAutopilotStore(s => s.status.cycles);
	const now = useAutopilotStore(s => s.status.now);
	const branch = useAutopilotStore(s => s.status.branch);
	const { run, pending } = useAutopilotActions();
	const [all, setAll] = useState(false);
	const [reverting, setReverting] = useState<AutopilotCycleRecord | null>(null);
	const newestFirst = useMemo(() => [...(cycles ?? [])].sort((a, b) => b.n - a.n), [cycles]);
	const shown = all ? newestFirst : newestFirst.slice(0, SHOWN_CYCLES);
	return (
		<section className="flex flex-col gap-1 border-t border-(--sc-divider) px-3 py-3" data-autopilot-timeline>
			<h3 className="flex items-center justify-between gap-2 text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
				{t("autopilot.timeline")}
				{newestFirst.length > 0 && (
					<CopyButton
						data-autopilot-copy-log
						label={t("autopilot.copyLog")}
						text={() => formatAutopilotLog({ branch: branch ?? "autopilot", cycles: newestFirst })}
					/>
				)}
			</h3>
			{now && (
				<div className="flex min-w-0 items-center gap-2 py-1.5 text-sc-sm" data-autopilot-cycle-live={now.n}>
					<span className="w-5 shrink-0 text-right text-sc-xs text-(--sc-text-muted) tabular-nums">{now.n}</span>
					{now.area && <AreaIcon area={now.area} />}
					<span className="min-w-0 flex-1 truncate">
						{now.title ?? (now.area ? t(`autopilot.area.${now.area}`) : t("autopilot.picking"))}
					</span>
					<Badge dot pulse variant="info">
						{t("autopilot.inProgress")}
					</Badge>
				</div>
			)}
			{shown.length === 0 && !now ? (
				<p className="text-sc-sm text-(--sc-text-muted)">{t("autopilot.timelineEmpty")}</p>
			) : (
				<ul className="flex flex-col divide-y divide-(--sc-divider)">
					{shown.map(cycle => (
						<CycleRow cycle={cycle} key={cycle.n} onRevert={setReverting} />
					))}
				</ul>
			)}
			{!all && newestFirst.length > SHOWN_CYCLES && (
				<Button onClick={() => setAll(true)} size="sm" variant="ghost">
					{t("autopilot.showAll", { count: newestFirst.length })}
				</Button>
			)}
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
		</section>
	);
}
