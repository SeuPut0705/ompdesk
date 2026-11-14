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
import type {
	Decision,
	GateStatus,
	Note,
	POLICY_ACTIONS,
	Pool,
	Run,
	RunResult,
	TestRecord,
} from "../../../shared/checks-contract";
import type { ChecksFrame } from "../../../shared/checks-frame";
import {
	decisionFor,
	gateJobs,
	gateName,
	gateProgress,
	jobTally,
	type Lane,
	type LaneGroup,
	lastAnswer,
	OS_NAME,
	originView,
	type PoolKind,
	poolFill,
	poolKind,
	poolLoad,
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
import { cx, formatClock, formatSpanCompact } from "../../lib/format";
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
	const load = poolLoad(pool);
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
		if (pool.foreign.length > 0)
			parts.push(
				t("checks.pool.foreign", {
					count: pool.foreign.length,
					kinds: [...new Set(pool.foreign.map(work => work.kind))].join(", "),
				}),
			);
		if (pool.diskFreeGb !== undefined) parts.push(t("checks.pool.disk", { gb: Math.round(pool.diskFreeGb) }));
		if (parts.length === 0 && load === 0) parts.push(t("checks.pool.idle"));
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
				<span className="text-sc-xl font-semibold text-(--sc-text)">{offline ? 0 : load}</span>{" "}
				{t("checks.pool.ofSlots", { limit: pool.limit, plural: plural(pool.limit) })}
			</div>
			<ProgressBar
				ariaLabel={t("checks.pool.aria", { name, running: load, limit: pool.limit })}
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

/**
 * Where a gate stands, from the jobs it selects: where they run and how long they took, how many wait, else its
 * state in a word.
 */
function gateAside(status: GateStatus, frame: ChecksFrame, t: Translate): string {
	const jobs = gateJobs(status, frame.snapshot);
	const state = t(`checks.gate.state.${status.state}`);
	if (jobs.length === 0) return state;
	const pools = [...new Set(jobs.map(job => job.pool))].flatMap(id => {
		const pool = frame.snapshot.pools.find(entry => entry.id === id);
		return pool ? [poolName(pool, frame.names)] : [];
	});
	const waiting = jobs.filter(job => job.state === "held" || job.state === "queued").length;
	const starts = jobs.flatMap(job => job.startedAt ?? []);
	const ends = jobs.flatMap(job => job.endedAt ?? []);
	const parts = [pools.join(", ")];
	if (waiting > 0) parts.push(t("checks.gate.waitingJobs", { count: waiting }));
	else if (starts.length > 0 && ends.length === jobs.length)
		parts.push(formatSpanCompact(Math.max(...ends) - Math.min(...starts)));
	else parts.push(state);
	return parts.filter(Boolean).join(" · ");
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
							<span className="shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums">
								{gateAside(status, frame, t)}
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
									running: poolLoad(wait.pool),
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
				: ((state === "held" && decision ? whyText(decision, frame, t) : null) ?? tallyText(run, t));
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

/** A test's record from its numbers (`FailedTest.record`); `history` is the core's English and never shown. */
function recordText(record: TestRecord | null, t: Translate): string {
	if (!record) return t("checks.answer.unavailable");
	const parts = [t("checks.record.week", { os: OS_NAME[record.os], fails: record.fails7d, runs: record.runs7d })];
	if (record.state === "quarantined")
		parts.push(t("checks.record.quarantined", { clean: record.cleanRuns, of: record.clearAfter }));
	if (record.state === "cleared") parts.push(t("checks.record.cleared"));
	return parts.join(" · ");
}

/** One note of an answer from its code (`Answer.said`); `notes` is the core's English and never shown. */
function noteText(note: Note, frame: ChecksFrame, t: Translate): string {
	switch (note.code) {
		case "branch-moved":
			return t("checks.note.branch-moved", {
				commit: shortSha(note.commit),
				branch: note.branch,
				asked: shortSha(note.asked),
			});
		case "ran-on":
			return t("checks.note.ran-on", {
				device:
					note.device === "local"
						? t("checks.note.thisComputer")
						: (frame.names.devices[note.device]?.name ?? note.device),
				job: note.job,
			});
		case "report-expired":
		case "job-outside-tests":
			return t(`checks.note.${note.code}`, { job: note.job });
		case "report-unreadable":
			return t("checks.note.report-unreadable", { job: note.job, error: note.error });
		case "quarantine-entered":
		case "quarantine-left":
			return t(`checks.note.${note.code}`, { test: note.test });
		case "quarantined-pass":
			return t("checks.note.quarantined-pass", { count: note.count, plural: plural(note.count) });
		case "reruns-used":
			return t("checks.note.reruns-used", { used: note.used, cap: note.cap });
		case "reused":
		case "reuse-lost":
		case "run-unknown":
			return t(`checks.note.${note.code}`, { run: runName(frame, note.run) });
		case "landed":
			return t("checks.note.landed", { base: note.base, commit: shortSha(note.commit) });
		case "not-landed":
			return t("checks.note.not-landed", { base: note.base, error: note.error });
		case "facts-stale":
			return t("checks.note.facts-stale", {
				at: formatClock(note.at),
				why: note.error ?? t("checks.note.facts-stale-quiet"),
			});
		case "results-unreadable":
			return t("checks.note.results-unreadable", { error: note.error });
		case "dispatch-unconfirmed":
			return t("checks.note.dispatch-unconfirmed", { error: note.error });
		case "dispatch-failed":
		case "refused":
			return note.error === undefined
				? t(`checks.note.${note.code}`)
				: t(`checks.note.${note.code}-why`, { error: note.error });
		case "wait-timed-out":
			return t("checks.note.wait-timed-out", { seconds: note.seconds });
		case "run-cancelled":
		case "release-blocked":
		case "lease-lapsed":
		case "no-answer-kept":
		case "judged-before-restart":
		case "replaced":
		case "run-changed":
			return t(`checks.note.${note.code}`);
	}
}

function AnswerCard({ result, frame }: { result: RunResult; frame: ChecksFrame }) {
	const t = useT();
	const { answer } = result;
	const to = originView(result.origin, frame.names);
	const run = frame.snapshot.runs.find(entry => entry.id === result.runId);
	const yesNo = (value: boolean) => t(value ? "checks.answer.yes" : "checks.answer.no");
	const rows: [string, string][] = [];
	for (const failed of answer.failed) {
		rows.push([t("checks.answer.failed"), failed.test]);
		rows.push([t("checks.answer.firstError"), failed.firstError ?? t("checks.answer.unavailable")]);
		rows.push([t("checks.answer.flaky"), `${yesNo(failed.knownFlaky)} — ${recordText(failed.record, t)}`]);
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
	if (answer.said.length > 0)
		rows.push([t("checks.answer.notes"), answer.said.map(note => noteText(note, frame, t)).join(" ")]);
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

/** How many of the newest decisions the log shows; the hub keeps the rest. */
const DECISIONS_SHOWN = 8;

/** One sentence per policy action. */
function decisionText(decision: Decision, run: Run | undefined, t: Translate): string {
	const target = run ? `${repoName(run.repo)} · ${run.ref}` : decision.run;
	if (decision.action === "hold" && run) {
		const count = run.jobs.filter(job => job.state === "held").length;
		if (count > 0) return t("checks.decisions.holdJobs", { count, plural: plural(count), target });
	}
	return t(`checks.decisions.${decision.action}`, { target });
}

/** A run as a sentence names it: its repository and ref, else its id. */
function runName(frame: ChecksFrame, id: string): string {
	const found = frame.snapshot.runs.find(entry => entry.id === id);
	return found ? `${repoName(found.repo)} · ${found.ref}` : id;
}

/**
 * Why the hub decided, from its code (`Decision.why`); `reason` is the hub's English for agents and never shown.
 * Null for a code the hub has no words for (`other`): the action's sentence then stands alone.
 */
function whyText(decision: Decision, frame: ChecksFrame, t: Translate): string | null {
	const { why } = decision;
	const pool = (id: string) => {
		const found = frame.snapshot.pools.find(entry => entry.id === id);
		return found ? poolName(found, frame.names) : id;
	};
	switch (why.code) {
		case "newer-run":
		case "green-on-same-inputs":
			return t(`checks.why.${why.code}`, { run: runName(frame, why.run) });
		case "pool-full":
		case "release-ahead":
			return t(`checks.why.${why.code}`, { pool: pool(why.pool), running: why.running, limit: why.limit });
		case "placed-on":
		case "local-unavailable":
			return t(`checks.why.${why.code}`, { pool: pool(why.pool) });
		case "batched":
			return t("checks.why.batched", { batch: why.batch });
		case "flaky":
			return t("checks.why.flaky", { fails: why.fails, runs: why.runs });
		case "failed-jobs":
			return t("checks.why.failed-jobs", { count: why.count, plural: plural(why.count) });
		case "paused":
			return t("checks.why.paused");
		case "other":
			return null;
	}
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
						const Icon = DECISION_ICON[decision.action];
						const why = whyText(decision, frame, t);
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
									{why && <p className="text-sc-xs text-(--sc-text-muted)">{why}</p>}
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
