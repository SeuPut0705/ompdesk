/**
 * Checks › Now (docs/design/check-control.md §8): capacity as one pool (GitHub's limits, this computer, paired
 * computers, runners), each release's gates and what its runs wait on, runs under their lane with the session and
 * goal that started each, the last answer an agent received, the merge queue and the "Decided automatically" log.
 * Read-only: no row acts on a run. Every figure comes from `lib/checks/view.ts`.
 *
 * A run a session did not start (a person's, an outside caller's, another repository's) is listed and counted like
 * the rest and says so, because the pool's numbers are a lie without it; nothing governs it.
 */

import {
	Ban,
	Bot,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleX,
	Cloud,
	GitBranch,
	GitMerge,
	Globe,
	Hourglass,
	Laptop,
	type LucideIcon,
	MapPin,
	MessageSquare,
	Monitor,
	Recycle,
	Rocket,
	RotateCcw,
	Scale,
	Server,
	ShieldAlert,
	Target,
	User,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import {
	type Decision,
	type GateStatus,
	type Lane,
	POLICY_ACTIONS,
	type Pool,
	type Run,
	type RunResult,
} from "../../../shared/checks-contract";
import type { ChecksFrame } from "../../../shared/checks-frame";
import {
	decisionFor,
	gateName,
	gateProgress,
	jobTally,
	type LaneGroup,
	lastAnswer,
	OS_NAME,
	originView,
	type PoolKind,
	poolFill,
	poolKind,
	poolName,
	type ReleaseView,
	type RunState,
	releases,
	releaseWaits,
	repoName,
	runMovedAt,
	runQueuedAt,
	runState,
	runsByLane,
	shortSha,
} from "../../lib/checks/view";
import { cx, formatSpanCompact } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useShortAge } from "../../lib/now-tick";
import { useUiStore } from "../../stores/ui";
import { Badge, type BadgeVariant, Card, EmptyState, ProgressBar, SectionLabel, type StatusTone } from "../common";
import { QueueCard } from "./ChecksQueue";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type PolicyAction = (typeof POLICY_ACTIONS)[number];

const plural = (count: number) => (count === 1 ? "" : "s");

function Age({ at }: { at: number | null }) {
	const label = useShortAge(at);
	return label ? <span className="tabular-nums">{label}</span> : null;
}

// ─── Capacity ────────────────────────────────────────────────────────────────────────────────────────────────────

const POOL_ICON: Record<PoolKind, LucideIcon> = { github: Cloud, here: Laptop, paired: Server, runner: Server };

function PoolCard({ pool, frame }: { pool: Pool; frame: ChecksFrame }) {
	const t = useT();
	const kind = poolKind(pool, frame.names);
	const name = poolName(pool, frame.names);
	const { fraction, tone } = poolFill(pool);
	const offline = pool.state === "offline";
	const Icon = kind === "paired" && pool.os === "windows" ? Monitor : POOL_ICON[kind];
	const parts: ReactNode[] = [];
	if (offline) parts.push(t("checks.pool.offline"));
	else {
		if (pool.state === "stale") parts.push(t("checks.pool.stale"));
		if (pool.queued > 0) {
			parts.push(
				<span className="font-medium text-(--sc-warning-on-soft)">
					{t(kind === "github" || kind === "runner" ? "checks.pool.queued" : "checks.pool.waiting", {
						count: pool.queued,
					})}
				</span>,
			);
			if (pool.oldestWaitMs > 0) parts.push(t("checks.pool.oldest", { span: formatSpanCompact(pool.oldestWaitMs) }));
		}
		if (pool.diskFreeGb !== undefined) parts.push(t("checks.pool.disk", { gb: Math.round(pool.diskFreeGb) }));
		if (parts.length === 0 && pool.running === 0) parts.push(t("checks.pool.idle"));
	}
	return (
		<Card
			as="li"
			className="flex min-w-0 flex-col gap-2"
			data-check-pool={pool.id}
			data-pool-state={offline ? "offline" : tone}
			radius="lg"
		>
			<div className="flex min-w-0 items-center gap-2">
				<Icon aria-hidden className="size-4 shrink-0 text-(--sc-text-secondary)" />
				<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text)">{name}</span>
				<span className="omp-checks-pool-kind shrink-0 text-sc-xs text-(--sc-text-muted)">
					{t(`checks.pool.kind.${kind}`)}
				</span>
			</div>
			<div className="text-sc-sm text-(--sc-text-muted) tabular-nums">
				<span className="text-sc-xl font-semibold text-(--sc-text)">{offline ? 0 : pool.running}</span>{" "}
				{t("checks.pool.ofSlots", { limit: pool.limit, plural: plural(pool.limit) })}
			</div>
			<ProgressBar
				ariaLabel={t("checks.pool.aria", { name, running: pool.running, limit: pool.limit })}
				color={tone === "full" ? "var(--sc-warning)" : "var(--sc-text-muted)"}
				height={8}
				value={offline ? 0 : fraction}
				valueText=""
			/>
			<div className="min-h-4 text-sc-xs text-(--sc-text-muted)">
				{parts.map((part, index) => (
					<span key={index}>
						{index > 0 && " · "}
						{part}
					</span>
				))}
			</div>
		</Card>
	);
}

// ─── Release gates ───────────────────────────────────────────────────────────────────────────────────────────────

const GATE_LOOK: Record<GateStatus["state"], { icon: LucideIcon; color: string; tone?: StatusTone }> = {
	green: { icon: CircleCheck, color: "text-(--sc-success)", tone: "success" },
	running: { icon: CircleDot, color: "text-(--sc-info)", tone: "info" },
	waiting: { icon: CircleDashed, color: "text-(--sc-text-muted)" },
	red: { icon: CircleX, color: "text-(--sc-danger)", tone: "danger" },
};

/** "Started by goal “Ship 1.4” · Autopilot run on MacBook": who is behind a release's run, as far as main can name. */
function startedBy(run: Run, frame: ChecksFrame, t: Translate): string[] {
	const origin = originView(run.origin, frame.names);
	if (origin.kind === "person") return [t("checks.origin.person")];
	if (origin.kind !== "session") return [];
	const who = origin.goal
		? t("checks.release.startedGoal", { goal: origin.goal })
		: origin.title
			? t("checks.release.startedSession", { session: origin.title })
			: null;
	const where = origin.device
		? t(origin.autopilot ? "checks.release.autopilotOn" : "checks.release.on", { device: origin.device })
		: null;
	return [who, where].filter(part => part !== null);
}

function ReleaseCard({ release, frame }: { release: ReleaseView; frame: ChecksFrame }) {
	const t = useT();
	const run = release.runs[0];
	const { green, total } = gateProgress(release);
	const waits = releaseWaits(release, frame.snapshot);
	const started = run ? startedBy(run, frame, t) : [];
	return (
		<Card as="section" className="flex flex-col gap-3" data-check-release={release.id} padding="lg" radius="lg">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<Rocket aria-hidden className="size-4 shrink-0 text-(--sc-accent)" />
				<h3 className="text-sc-md font-semibold text-(--sc-text)">
					{t("checks.release.name", { id: release.id })}
				</h3>
				{run && (
					<span className="min-w-0 truncate text-sc-sm text-(--sc-text-muted)">
						{repoName(run.repo)} · <span className="font-mono text-sc-xs">{run.ref}</span>{" "}
						<span className="font-mono text-sc-xs">{shortSha(run.sha)}</span>
					</span>
				)}
				<Badge className="ml-auto" variant={green === total ? "success" : "info"}>
					{t("checks.release.progress", { green, total })}
				</Badge>
			</div>
			{run && started.length > 0 && (
				<p className="flex items-start gap-1.5 text-sc-sm text-(--sc-text-secondary)">
					<Target aria-hidden className="mt-0.5 size-3.5 shrink-0 text-(--sc-text-muted)" />
					<span className="min-w-0">
						{started.join(" · ")}
						{" · "}
						<Age at={runQueuedAt(run)} />
					</span>
				</p>
			)}
			<ProgressBar
				ariaLabel={t("checks.release.progress", { green, total })}
				height={6}
				segments={release.gates.map(status => {
					const label = `${gateName(status)}: ${t(`checks.gate.state.${status.state}`)}`;
					const tone = GATE_LOOK[status.state].tone;
					return tone ? { value: 1, label, tone } : { value: 1, label };
				})}
				value={total > 0 ? green / total : 0}
			/>
			<ul aria-label={t("checks.release.gates", { name: release.id })} className="omp-checks-gates">
				{release.gates.map(status => {
					const { icon: Icon, color } = GATE_LOOK[status.state];
					return (
						<li
							className="flex min-w-0 items-center gap-2 py-1"
							data-check-gate={status.gate.id}
							data-state={status.state}
							key={status.gate.id}
						>
							<Icon aria-hidden className={cx("size-4 shrink-0", color)} />
							<span className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text)">{gateName(status)}</span>
							<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
								{t(`checks.gate.state.${status.state}`)}
							</span>
						</li>
					);
				})}
			</ul>
			{waits.length > 0 && (
				<p
					className="flex gap-2 rounded-(--sc-radius-md) bg-(--sc-warning-soft) px-3 py-2 text-sc-sm text-(--sc-text)"
					data-check-waits
				>
					<Hourglass aria-hidden className="mt-0.5 size-4 shrink-0 text-(--sc-warning)" />
					<span className="min-w-0">
						{waits.map(wait => (
							<span className="block" key={wait.pool.id}>
								<strong className="font-semibold">
									{t("checks.release.waitsOn", { pool: poolName(wait.pool, frame.names) })}
								</strong>{" "}
								{t(wait.full ? "checks.release.waitsFull" : "checks.release.waitsQueued", {
									count: wait.jobs,
									plural: plural(wait.jobs),
									running: wait.pool.running,
									limit: wait.pool.limit,
								})}
							</span>
						))}
					</span>
				</p>
			)}
		</Card>
	);
}

// ─── Runs by lane ────────────────────────────────────────────────────────────────────────────────────────────────

const LANE_ICON: Record<Lane, LucideIcon> = { release: Rocket, land: GitMerge, branch: GitBranch, local: Laptop };

const RUN_LOOK: Record<RunState, { icon: LucideIcon; color: string; badge: BadgeVariant }> = {
	running: { icon: CircleDot, color: "text-(--sc-info)", badge: "info" },
	queued: { icon: Hourglass, color: "text-(--sc-warning)", badge: "warning" },
	held: { icon: Hourglass, color: "text-(--sc-warning)", badge: "warning" },
	passed: { icon: CircleCheck, color: "text-(--sc-success)", badge: "success" },
	failed: { icon: CircleX, color: "text-(--sc-danger)", badge: "error" },
	cancelled: { icon: Ban, color: "text-(--sc-text-muted)", badge: "default" },
	reused: { icon: Recycle, color: "text-(--sc-success)", badge: "success" },
	superseded: { icon: Ban, color: "text-(--sc-text-muted)", badge: "default" },
};

/** "macOS 2 running · 6 queued · Linux, Windows done": the OS with live work spelled out, the finished ones listed. */
function tallyText(run: Run, t: Translate): string {
	const tallies = jobTally(run.jobs);
	const live = tallies
		.filter(tally => !tally.done)
		.map(tally => {
			const counts = (["running", "queued", "held", "failed"] as const)
				.filter(state => tally[state] > 0)
				.map(state => t(`checks.run.tally.${state}`, { count: tally[state] }));
			return `${OS_NAME[tally.os]} ${counts.join(" · ")}`;
		});
	const done = tallies.filter(tally => tally.done).map(tally => OS_NAME[tally.os]);
	if (done.length > 0) live.push(t("checks.run.tally.done", { list: done.join(", ") }));
	return live.join(" · ");
}

function RunRow({ run, frame, current }: { run: Run; frame: ChecksFrame; current: boolean }) {
	const t = useT();
	const ref = useRef<HTMLLIElement>(null);
	const state = runState(run);
	const live = state === "running" || state === "held" || state === "queued";
	const { icon: Icon, color, badge } = RUN_LOOK[state];
	const origin = originView(run.origin, frame.names);
	const decision = decisionFor(run, frame.snapshot.decisions);
	const detail =
		state === "reused"
			? t("checks.run.reusedFrom")
			: state === "superseded"
				? t("checks.run.supersededBy")
				: state === "held" && decision
					? decision.reason
					: tallyText(run, t);
	useEffect(() => {
		if (current) ref.current?.scrollIntoView({ block: "center" });
	}, [current]);
	const OriginIcon =
		origin.kind === "session" ? (origin.autopilot ? Bot : MessageSquare) : origin.kind === "person" ? User : Globe;
	const originTitle =
		origin.kind === "session"
			? (origin.title ?? t("checks.origin.unknownSession"))
			: origin.kind === "person"
				? t("checks.origin.person")
				: origin.kind === "outside"
					? t("checks.origin.outside", { name: origin.title ?? "" })
					: t("checks.origin.foreign");
	const originSub = [
		origin.goal ? t("checks.origin.goal", { goal: origin.goal }) : null,
		origin.device ? t("checks.origin.device", { device: origin.device }) : null,
	].filter(part => part !== null);
	return (
		<li
			aria-current={current ? "true" : undefined}
			className="omp-checks-run"
			data-check-run={run.id}
			data-state={state}
			ref={ref}
		>
			<Icon aria-hidden className={cx("mt-0.5 size-4 shrink-0", color)} />
			<div className="min-w-0">
				<p className="flex min-w-0 items-baseline gap-2 text-sc-sm text-(--sc-text)">
					<span className="min-w-0 truncate font-medium">
						{repoName(run.repo)} · {run.ref}
					</span>
					<span className="shrink-0 font-mono text-sc-xs text-(--sc-text-muted)">{shortSha(run.sha)}</span>
				</p>
				{detail && <p className="truncate text-sc-xs text-(--sc-text-muted)">{detail}</p>}
				{current && <p className="sr-only">{t("checks.run.shown")}</p>}
			</div>
			<div className="omp-checks-run-origin min-w-0" data-origin={origin.kind}>
				<p className="flex min-w-0 items-center gap-1.5 text-sc-sm text-(--sc-text)">
					<OriginIcon aria-hidden className="size-3.5 shrink-0 text-(--sc-text-muted)" />
					<span className="min-w-0 truncate">{originTitle}</span>
				</p>
				{originSub.length > 0 && (
					<p className="truncate text-sc-xs text-(--sc-text-muted)">{originSub.join(" · ")}</p>
				)}
			</div>
			<div className="flex shrink-0 flex-col items-end gap-0.5">
				<Badge variant={badge}>{t(`checks.run.state.${state}`)}</Badge>
				<span className="text-sc-xs text-(--sc-text-muted)">
					<Age at={live ? runQueuedAt(run) : runMovedAt(run)} />
				</span>
			</div>
		</li>
	);
}

function LaneRuns({ group, frame, current }: { group: LaneGroup; frame: ChecksFrame; current: string | null }) {
	const t = useT();
	const Icon = LANE_ICON[group.lane];
	const count = group.runs.length;
	const aside = [
		...(group.lane === "release" ? [t("checks.lane.first")] : []),
		t("checks.lane.runs", { count, plural: plural(count) }),
		...(["held", "queued", "failed", "reused", "superseded", "cancelled"] as const).flatMap(state => {
			const states = group.states[state];
			return states ? [t(`checks.lane.count.${state}`, { count: states })] : [];
		}),
	];
	const headingId = `checks-lane-${group.lane}`;
	return (
		<section aria-labelledby={headingId} data-check-lane={group.lane}>
			<div className="flex items-center gap-2 border-b border-(--sc-border-subtle) bg-(--sc-surface-1) px-4 py-2">
				<Icon aria-hidden className="size-4 shrink-0 text-(--sc-text-secondary)" />
				<h3 className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text)" id={headingId}>
					{t(`checks.lane.${group.lane}`)}
				</h3>
				<span className="shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums">{aside.join(" · ")}</span>
			</div>
			<ul className="omp-checks-runs">
				{group.runs.map(run => (
					<RunRow current={run.id === current} frame={frame} key={run.id} run={run} />
				))}
			</ul>
		</section>
	);
}

// ─── What agents get, what was decided ───────────────────────────────────────────────────────────────────────────

const VERDICT_COLOR = { green: "text-(--sc-success)", red: "text-(--sc-danger)", unknown: "text-(--sc-warning)" };

function AnswerCard({ result, frame }: { result: RunResult; frame: ChecksFrame }) {
	const t = useT();
	const { answer } = result;
	const to = originView(result.origin, frame.names);
	const run = frame.snapshot.runs.find(entry => entry.id === result.runId);
	const yesNo = (value: boolean) => t(value ? "checks.answer.yes" : "checks.answer.no");
	const rows: [string, string][] = [];
	for (const failed of answer.failed) {
		rows.push([t("checks.answer.failed"), failed.test]);
		rows.push([t("checks.answer.firstError"), failed.firstError]);
		rows.push([t("checks.answer.flaky"), `${yesNo(failed.knownFlaky)} — ${failed.history}`]);
	}
	const blocking = answer.blocksRelease;
	const gate = blocking ? frame.snapshot.gates.find(status => status.gate.id === blocking.gate) : undefined;
	rows.push([
		t("checks.answer.blocks"),
		blocking
			? `${yesNo(true)} — ${t("checks.answer.gate", { gate: gate ? gateName(gate) : blocking.gate })}`
			: yesNo(false),
	]);
	if (answer.expectedWaitMin !== null)
		rows.push([t("checks.answer.wait"), t("checks.answer.waitMin", { count: answer.expectedWaitMin })]);
	if (answer.reused)
		rows.push([t("checks.answer.reusedLabel"), t("checks.answer.reused", { count: answer.reused.savedMin })]);
	rows.push([t("checks.answer.next"), t(`checks.answer.next.${answer.next}`)]);
	if (answer.notes.length > 0) rows.push([t("checks.answer.notes"), answer.notes.join(" ")]);
	const total = answer.counts.passed + answer.counts.failed;
	const toTitle =
		to.title ?? t(to.kind === "session" ? "checks.origin.unknownSession" : `checks.answer.to.${to.kind}`);
	return (
		<Card as="section" className="flex flex-col gap-3" data-check-answer={answer.verdict} padding="lg" radius="lg">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<SectionLabel as="h3" className="min-w-0 flex-1">
					{t("checks.answer.title")}
				</SectionLabel>
				<span className="min-w-0 truncate text-sc-xs text-(--sc-text-muted)">
					{toTitle} · <Age at={answer.asOf} />
				</span>
			</div>
			<Card className="font-mono text-sc-xs leading-5 text-(--sc-text-secondary)" surface="code">
				<p className="text-(--sc-text)">
					{run && `${repoName(run.repo)} ${shortSha(run.sha)} → `}
					<span className={cx("font-semibold", VERDICT_COLOR[answer.verdict])}>
						{t(`checks.answer.verdict.${answer.verdict}`)}
					</span>
					{total > 0 && ` (${t("checks.answer.counts", { failed: answer.counts.failed, total })})`}
				</p>
				<dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
					{rows.map(([label, value], index) => (
						<div className="contents" key={index}>
							<dt className="text-(--sc-text-muted)">{label}</dt>
							<dd className="min-w-0 break-words text-(--sc-text)">{value}</dd>
						</div>
					))}
				</dl>
			</Card>
		</Card>
	);
}

const DECISION_ICON: Record<PolicyAction, LucideIcon> = {
	"cancel-superseded": Ban,
	hold: Hourglass,
	reuse: Recycle,
	place: MapPin,
	batch: GitMerge,
	quarantine: ShieldAlert,
	"rerun-failed": RotateCcw,
};

const isPolicyAction = (action: string): action is PolicyAction =>
	(POLICY_ACTIONS as readonly string[]).includes(action);

/** How many of the newest decisions the log shows; the hub keeps the rest. */
const DECISIONS_SHOWN = 8;

/** One sentence per policy action; an action the contract's list does not name is shown as the hub wrote it. */
function decisionText(decision: Decision, run: Run | undefined, t: Translate): string {
	const target = run ? `${repoName(run.repo)} · ${run.ref}` : decision.run;
	if (!isPolicyAction(decision.action)) return t("checks.decisions.other", { action: decision.action, target });
	if (decision.action === "hold" && run) {
		const count = run.jobs.filter(job => job.state === "held").length;
		if (count > 0) return t("checks.decisions.holdJobs", { count, plural: plural(count), target });
	}
	return t(`checks.decisions.${decision.action}`, { target });
}

function DecisionsCard({ frame }: { frame: ChecksFrame }) {
	const t = useT();
	const { decisions, runs } = frame.snapshot;
	const newest = [...decisions].sort((a, b) => b.at - a.at).slice(0, DECISIONS_SHOWN);
	return (
		<Card as="section" className="flex flex-col gap-2" data-checks-section="decisions" padding="lg" radius="lg">
			<div className="flex items-center gap-2">
				<Scale aria-hidden className="size-4 shrink-0 text-(--sc-text-secondary)" />
				<SectionLabel as="h3">{t("checks.decisions.title")}</SectionLabel>
			</div>
			{newest.length === 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)">{t("checks.decisions.empty")}</p>
			) : (
				<ul className="flex flex-col gap-3">
					{newest.map(decision => {
						const Icon = isPolicyAction(decision.action) ? DECISION_ICON[decision.action] : Scale;
						return (
							<li
								className="flex min-w-0 gap-2"
								data-check-decision={decision.action}
								key={`${decision.run}:${decision.policy}:${decision.at}`}
							>
								<Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-(--sc-text-muted)" />
								<div className="min-w-0 flex-1">
									<p className="text-sc-sm text-(--sc-text)">
										{decisionText(
											decision,
											runs.find(entry => entry.id === decision.run),
											t,
										)}
									</p>
									<p className="text-sc-xs text-(--sc-text-muted)">
										{t("checks.decisions.policy", { reason: decision.reason })}
									</p>
								</div>
								<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
									<Age at={decision.at} />
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</Card>
	);
}

export function ChecksNow({ frame }: { frame: ChecksFrame }) {
	const t = useT();
	const current = useUiStore(state => state.checksRun);
	const { snapshot } = frame;
	const lanes = runsByLane(snapshot.runs);
	const answer = lastAnswer(snapshot);
	return (
		<div className="flex flex-col gap-6">
			<section data-checks-section="capacity">
				<SectionLabel className="mb-2">{t("checks.capacity.title")}</SectionLabel>
				<ul className="omp-checks-pools">
					{snapshot.pools.map(pool => (
						<PoolCard frame={frame} key={pool.id} pool={pool} />
					))}
				</ul>
			</section>
			<div className="omp-checks-split">
				<section className="flex min-w-0 flex-col gap-4" data-checks-section="runs">
					<SectionLabel className="-mb-2">{t("checks.runs.title")}</SectionLabel>
					{releases(snapshot).map(release => (
						<ReleaseCard frame={frame} key={release.id} release={release} />
					))}
					{lanes.length > 0 ? (
						<Card className="overflow-hidden" padding="none" radius="lg">
							{lanes.map(group => (
								<LaneRuns current={current} frame={frame} group={group} key={group.lane} />
							))}
						</Card>
					) : (
						<Card radius="lg">
							<EmptyState
								data-checks-no-runs
								description={t("checks.runs.emptyDesc")}
								size="sm"
								title={t("checks.runs.empty")}
							/>
						</Card>
					)}
				</section>
				<section className="flex min-w-0 flex-col gap-4" data-checks-section="side">
					<SectionLabel className="-mb-2">{t("checks.side.title")}</SectionLabel>
					{answer && <AnswerCard frame={frame} result={answer} />}
					<QueueCard frame={frame} />
					<DecisionsCard frame={frame} />
				</section>
			</div>
		</div>
	);
}
