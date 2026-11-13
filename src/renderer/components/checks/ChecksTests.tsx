/**
 * Tests and cost tab of the Checks page (docs/design/check-control.md §8): what the test history says (flaky tests the
 * agents quarantined, slowdowns against each test's own median) and what the checks cost (queue depth per pool, runner
 * minutes of the newest month, whether agents use the tool). Watch-only. Every part is drawn only when the snapshot
 * carries its data. Tables scroll inside their card on a narrow page, never the page; the two-column split is
 * `omp-checks-split`, which folds by the page's own width. Dots and bars are decoration, the words beside them carry
 * the value.
 */

import { FlaskConical, HardDrive } from "lucide-react";
import type { ReactNode } from "react";
import type { Snapshot, TestHistory } from "../../../shared/checks-contract";
import type { ChecksFrame } from "../../../shared/checks-frame";
import { OS_NAME, type Os, originView, poolName, shortSha } from "../../lib/checks/view";
import { formatAgo, formatBytes, formatDuration, formatSpanCompact, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Badge, type BadgeVariant, Card, EmptyState, ProgressBar, SectionLabel } from "../common";
import { originText } from "./ChecksQueue";

type Trends = Snapshot["trends"];
type Slowdown = Trends["slowdowns"][number];

const SLOWDOWN_PERCENT = 30;
const CLEAR_AFTER = 5;
const DOTS = [1, 2, 3, 4, 5];
const DIGEST_LENGTH = 12;
const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 24;

const STATE_BADGE: Record<TestHistory["state"], BadgeVariant> = {
	quarantined: "warning",
	active: "info",
	cleared: "success",
};

const TH = "px-3 py-2 text-left text-sc-xs font-medium whitespace-nowrap text-(--sc-text-muted)";
const TD = "px-3 py-2 align-top text-sc-sm";
const WARNING_TEXT = "text-(--sc-warning-on-soft)";

const count = (value: number) => value.toLocaleString(uiLocale());

const dollars = (value: number) =>
	value.toLocaleString(uiLocale(), { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** A test's duration: tenths of a second under ten, whole seconds up to two minutes, else `formatDuration`. */
function durationText(ms: number): string {
	if (ms < 10_000 || ms >= 120_000) return formatDuration(ms);
	return `${Math.round(ms / 1000)}s`;
}

type FigureTone = "plain" | "warning" | "success";

const FIGURE_TEXT: Record<FigureTone, string> = {
	plain: "text-(--sc-text)",
	warning: WARNING_TEXT,
	success: "text-(--sc-success-on-soft)",
};

function Figure({
	label,
	value,
	tone = "plain",
	sub,
}: {
	label: string;
	value: string;
	tone?: FigureTone;
	sub?: string;
}) {
	return (
		<Card className="flex flex-col gap-1" padding="lg" radius="lg">
			<div className="text-sc-sm text-(--sc-text-muted)">{label}</div>
			<div className={`text-sc-2xl font-semibold tabular-nums ${FIGURE_TEXT[tone]}`}>{value}</div>
			{sub ? <div className="text-sc-xs text-(--sc-text-muted)">{sub}</div> : null}
		</Card>
	);
}

function Figures({ trends }: { trends: Trends }) {
	const t = useT();
	const open = trends.tests.filter(entry => entry.state !== "cleared").length;
	const quarantined = trends.tests.filter(entry => entry.state === "quarantined").length;
	const fresh = trends.tests.filter(entry => entry.state === "active").length;
	const clearing = trends.tests.filter(entry => entry.state === "quarantined" && entry.cleanSince > 0).length;
	const { lostMs7d, lostMsPrev7d, savedByRerunMs7d, savedByReuseMs7d } = trends;
	let lostSub: string | undefined;
	if (lostMsPrev7d > 0 && lostMsPrev7d !== lostMs7d) {
		lostSub = t(lostMs7d < lostMsPrev7d ? "checks.tests.lost.down" : "checks.tests.lost.up", {
			span: formatSpanCompact(lostMsPrev7d),
		});
	}
	return (
		<div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))" }}>
			{trends.tests.length > 0 ? (
				<Figure
					label={t("checks.tests.flaky.label")}
					sub={t("checks.tests.flaky.sub", { quarantined, fresh, clearing })}
					value={count(open)}
				/>
			) : null}
			{lostMs7d > 0 ? (
				<Figure
					label={t("checks.tests.lost.label")}
					sub={lostSub}
					tone="warning"
					value={formatSpanCompact(lostMs7d)}
				/>
			) : null}
			{savedByRerunMs7d > 0 ? (
				<Figure
					label={t("checks.tests.saved.label")}
					sub={
						savedByReuseMs7d > 0
							? t("checks.tests.saved.reuse", { span: formatSpanCompact(savedByReuseMs7d) })
							: undefined
					}
					tone="success"
					value={formatSpanCompact(savedByRerunMs7d)}
				/>
			) : null}
			{trends.slowdowns.length > 0 ? (
				<Figure
					label={t("checks.tests.slowdowns.label")}
					sub={t("checks.tests.slowdowns.sub")}
					tone="warning"
					value={count(trends.slowdowns.length)}
				/>
			) : null}
		</div>
	);
}

function CleanDots({ clean }: { clean: number }) {
	const t = useT();
	const filled = Math.max(0, Math.min(CLEAR_AFTER, clean));
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
			<span aria-hidden className="inline-flex gap-0.5">
				{DOTS.map(dot => (
					<span
						className={`size-1.5 rounded-full ${dot <= filled ? "bg-(--sc-success)" : "bg-(--sc-surface-3)"}`}
						key={dot}
					/>
				))}
			</span>
			<span className="text-sc-xs text-(--sc-text-muted) tabular-nums">
				{t("checks.tests.cleanOf", { count: filled })}
			</span>
		</span>
	);
}

function OsWord({ os }: { os: Os }) {
	return <span className="font-sans text-sc-xs text-(--sc-text-muted)"> {OS_NAME[os]}</span>;
}

function FlakyRow({ entry, frame }: { entry: TestHistory; frame: ChecksFrame }) {
	const t = useT();
	let note: string | null = null;
	if (entry.state === "quarantined") {
		const ago = entry.quarantinedAt === undefined ? "" : formatAgo(entry.quarantinedAt, frame.snapshot.asOf);
		const who = entry.quarantinedBy
			? t("checks.tests.note.quarantinedBy", {
					who: originText(t, originView(entry.quarantinedBy, frame.names)),
				})
			: t("checks.tests.note.quarantined");
		note = ago ? `${who} · ${ago}` : who;
	} else if (entry.state === "cleared") {
		const ago = entry.clearedAt === undefined ? "" : formatAgo(entry.clearedAt, frame.snapshot.asOf);
		note = ago ? `${t("checks.tests.note.cleared")} · ${ago}` : t("checks.tests.note.cleared");
	}
	return (
		<tr className="border-t border-(--sc-border-subtle)" data-flaky-test={entry.test}>
			<td className={`${TD} max-w-[22rem] min-w-[12rem]`}>
				<div className="font-mono text-sc-xs break-words text-(--sc-text)">
					{entry.name}
					<OsWord os={entry.os} />
				</div>
				{note ? <div className="mt-0.5 text-sc-xs text-(--sc-text-muted)">{note}</div> : null}
			</td>
			<td className={TD}>
				<Badge variant={STATE_BADGE[entry.state]}>{t(`checks.tests.state.${entry.state}`)}</Badge>
			</td>
			<td className={`${TD} whitespace-nowrap tabular-nums`}>
				{t("checks.tests.failsOf", { fails: entry.fails7d, runs: entry.runs7d })}
			</td>
			<td className={TD}>
				{entry.flakedOn ? (
					<span className="font-mono text-sc-xs text-(--sc-text-secondary)">
						{t("checks.tests.sameInputs")}
						<span className="block text-(--sc-text-muted)">{entry.flakedOn.slice(0, DIGEST_LENGTH)}</span>
					</span>
				) : (
					<span className="text-(--sc-text-muted)">—</span>
				)}
			</td>
			<td className={TD}>
				<CleanDots clean={entry.cleanSince} />
			</td>
		</tr>
	);
}

function FlakyTable({ trends, frame }: { trends: Trends; frame: ChecksFrame }) {
	const t = useT();
	return (
		<section>
			<SectionLabel className="mb-2" size="label">
				{t("checks.tests.flakyTable.title")}
			</SectionLabel>
			<Card className="overflow-x-auto" padding="none" radius="lg">
				<table aria-label={t("checks.tests.flakyTable.title")} className="w-full min-w-[40rem] border-collapse">
					<thead>
						<tr>
							<th className={TH} scope="col">
								{t("checks.tests.col.test")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.state")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.fails")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.flakedOn")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.clearsAfter")}
							</th>
						</tr>
					</thead>
					<tbody>
						{trends.tests.map(entry => (
							<FlakyRow entry={entry} frame={frame} key={entry.test} />
						))}
					</tbody>
				</table>
			</Card>
		</section>
	);
}

function Sparkline({ values }: { values: readonly number[] }) {
	if (values.length < 2) return null;
	const low = Math.min(...values);
	const span = Math.max(...values) - low;
	const points = values
		.map((value, index) => {
			const x = (index / (values.length - 1)) * (SPARK_WIDTH - 2) + 1;
			const y = span === 0 ? SPARK_HEIGHT / 2 : SPARK_HEIGHT - 2 - ((value - low) / span) * (SPARK_HEIGHT - 4);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
	return (
		<svg
			aria-hidden
			className="text-(--sc-info)"
			fill="none"
			height={SPARK_HEIGHT}
			viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
			width={SPARK_WIDTH}
		>
			<polyline
				points={points}
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.5}
			/>
		</svg>
	);
}

function SlowdownRow({ entry }: { entry: Slowdown }) {
	const latest = entry.lastMs[entry.lastMs.length - 1];
	const over = latest !== undefined && entry.p50Ms30d > 0 ? Math.round((latest / entry.p50Ms30d - 1) * 100) : null;
	const slow = over !== null && over > SLOWDOWN_PERCENT;
	return (
		<tr className="border-t border-(--sc-border-subtle)" data-slowdown={entry.test}>
			<td className={`${TD} max-w-[22rem] min-w-[12rem] font-mono text-sc-xs break-words`}>
				{entry.name}
				<OsWord os={entry.os} />
			</td>
			<td className={`${TD} whitespace-nowrap tabular-nums`}>{durationText(entry.p50Ms30d)}</td>
			<td className={`${TD} whitespace-nowrap tabular-nums ${slow ? WARNING_TEXT : ""}`}>
				{latest === undefined ? (
					<span className="text-(--sc-text-muted)">—</span>
				) : (
					<>
						<span className={slow ? "font-semibold" : ""}>{durationText(latest)}</span>
						{over !== null ? ` ${over >= 0 ? "+" : "−"}${Math.abs(over)} %` : ""}
					</>
				)}
			</td>
			<td className={TD}>
				<Sparkline values={entry.lastMs} />
			</td>
			<td className={`${TD} font-mono text-sc-xs text-(--sc-text-secondary)`}>
				{entry.sinceSha ? shortSha(entry.sinceSha) : <span className="text-(--sc-text-muted)">—</span>}
			</td>
		</tr>
	);
}

function SlowdownTable({ trends }: { trends: Trends }) {
	const t = useT();
	return (
		<section>
			<SectionLabel className="mb-2" size="label">
				{t("checks.tests.slowTable.title")}
			</SectionLabel>
			<Card className="overflow-x-auto" padding="none" radius="lg">
				<table aria-label={t("checks.tests.slowTable.title")} className="w-full min-w-[36rem] border-collapse">
					<thead>
						<tr>
							<th className={TH} scope="col">
								{t("checks.tests.col.test")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.median")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.now")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.trend")}
							</th>
							<th className={TH} scope="col">
								{t("checks.tests.col.since")}
							</th>
						</tr>
					</thead>
					<tbody>
						{trends.slowdowns.map(entry => (
							<SlowdownRow entry={entry} key={entry.test} />
						))}
					</tbody>
				</table>
			</Card>
		</section>
	);
}

function SideCard({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
	return (
		<Card padding="lg" radius="lg">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-2">
				<SectionLabel size="label">{title}</SectionLabel>
				{aside ? <span className="text-sc-xs text-(--sc-text-muted)">{aside}</span> : null}
			</div>
			{children}
		</Card>
	);
}

const shortTime = (at: number) =>
	new Date(at).toLocaleString(uiLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function QueueDepth({ pool, points }: { pool: string; points: Trends["queueDepth"] }) {
	const t = useT();
	const peak = Math.max(...points.map(point => point.queued));
	const first = points[0];
	const latest = points[points.length - 1];
	return (
		<SideCard aside={t("checks.tests.depth.aside", { max: peak })} title={t("checks.tests.depth.title", { pool })}>
			<div
				aria-label={t("checks.tests.depth.label", { pool, max: peak, latest: latest?.queued ?? 0 })}
				className="flex h-16 items-end gap-1"
				role="img"
			>
				{points.map(point => (
					<div
						className="min-w-0 flex-1 rounded-t-sm bg-(--sc-info)"
						key={point.at}
						style={{ height: `${peak > 0 ? Math.max(4, (point.queued / peak) * 100) : 4}%` }}
					/>
				))}
			</div>
			<div aria-hidden className="mt-1 flex justify-between gap-2 text-sc-xs text-(--sc-text-muted)">
				<span>{first ? shortTime(first.at) : ""}</span>
				{points.length > 1 && latest ? <span>{shortTime(latest.at)}</span> : null}
			</div>
		</SideCard>
	);
}

function RunnerMinutes({ minutes }: { minutes: Trends["minutes"] }) {
	const t = useT();
	const newest = minutes.reduce((best, entry) => (entry.month > best ? entry.month : best), "");
	const rows = minutes.filter(entry => entry.month === newest);
	const largest = Math.max(...rows.map(entry => entry.minutes));
	const [year, month] = newest.split("-").map(Number);
	const monthText = new Date(year ?? 1970, (month ?? 1) - 1, 1).toLocaleDateString(uiLocale(), {
		month: "long",
		year: "numeric",
	});
	return (
		<SideCard aside={monthText} title={t("checks.tests.minutes.title")}>
			<ul className="flex flex-col gap-2">
				{rows.map(entry => {
					const amount = count(Math.round(entry.minutes));
					return (
						<li className="flex items-center gap-3 text-sc-sm" key={entry.os}>
							<ProgressBar
								ariaLabel={t("checks.tests.minutes.share", {
									os: OS_NAME[entry.os],
									minutes: amount,
									month: monthText,
								})}
								className="min-w-0 flex-1"
								color="var(--sc-text-muted)"
								label={OS_NAME[entry.os]}
								labelCase="keep"
								labelClassName="w-16 shrink-0 text-sc-sm text-(--sc-text)"
								value={largest > 0 ? entry.minutes / largest : 0}
								valueText=""
							/>
							<span className="shrink-0 text-right tabular-nums">
								{t("checks.tests.minutes.value", { minutes: amount })}
							</span>
							{entry.costUsd > 0 ? (
								<span className="w-14 shrink-0 text-right text-(--sc-text-muted) tabular-nums">
									≈ {dollars(entry.costUsd)}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
			<p className="mt-3 text-sc-xs text-(--sc-text-muted)">{t("checks.tests.minutes.estimate")}</p>
		</SideCard>
	);
}

function Adoption({ adoption }: { adoption: Snapshot["adoption"] }) {
	const t = useT();
	const row = (label: string, value: number) => (
		<div className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-(--sc-border-subtle) py-2 first:border-t-0 first:pt-0 last:pb-0">
			<dt className="min-w-0 text-sc-sm text-(--sc-text)">{label}</dt>
			<dd className="text-sc-sm font-semibold tabular-nums">{count(value)}</dd>
		</div>
	);
	return (
		<SideCard title={t("checks.tests.adoption.title")}>
			<dl>
				{row(t("checks.tests.adoption.viaTool"), adoption.started)}
				{row(t("checks.tests.adoption.refused"), adoption.refused)}
				{row(t("checks.tests.adoption.polls"), adoption.polls)}
				{row(t("checks.tests.adoption.wrongGreen"), adoption.wrongGreens)}
			</dl>
		</SideCard>
	);
}

function StoreLine({ bytes }: { bytes: number }) {
	const t = useT();
	return (
		<Card className="flex flex-wrap items-center gap-x-3 gap-y-1" padding="row" radius="lg">
			<HardDrive aria-hidden className="size-4 shrink-0 text-(--sc-text-muted)" />
			<span className="min-w-0 flex-1 text-sc-sm text-(--sc-text)">
				{t("checks.tests.store.text", { size: formatBytes(bytes) })}
			</span>
			<span className="text-sc-xs text-(--sc-text-muted)">{t("checks.tests.store.aside")}</span>
		</Card>
	);
}

/** Queue depth points grouped by pool id, each pool's points in time order. */
function depthByPool(points: Trends["queueDepth"]): [string, Trends["queueDepth"]][] {
	const groups = new Map<string, Trends["queueDepth"]>();
	for (const point of points) groups.set(point.pool, [...(groups.get(point.pool) ?? []), point]);
	return [...groups].map(([pool, list]) => [pool, list.sort((a, b) => a.at - b.at)]);
}

export function ChecksTests({ frame }: { frame: ChecksFrame }) {
	const t = useT();
	const { trends, adoption, pools } = frame.snapshot;
	const usage = adoption.started + adoption.refused + adoption.polls + adoption.wrongGreens > 0;
	const hasHistory = trends.tests.length > 0 || trends.slowdowns.length > 0;
	const hasFigures = trends.lostMs7d > 0 || trends.savedByRerunMs7d > 0;
	if (
		!hasHistory &&
		!hasFigures &&
		trends.minutes.length === 0 &&
		trends.queueDepth.length === 0 &&
		trends.storeBytes === undefined &&
		!usage
	) {
		return (
			<EmptyState
				description={t("checks.tests.empty.description")}
				icon={<FlaskConical aria-hidden className="size-5" />}
				size="md"
				title={t("checks.tests.empty.title")}
			/>
		);
	}
	const side = [
		...depthByPool(trends.queueDepth).map(([id, points]) => {
			const pool = pools.find(entry => entry.id === id);
			return <QueueDepth key={id} points={points} pool={pool ? poolName(pool, frame.names) : id} />;
		}),
		trends.minutes.length > 0 ? <RunnerMinutes key="minutes" minutes={trends.minutes} /> : null,
		<Adoption adoption={adoption} key="adoption" />,
		trends.storeBytes === undefined ? null : <StoreLine bytes={trends.storeBytes} key="store" />,
	];
	const main = hasHistory ? (
		<div className="flex min-w-0 flex-col gap-6">
			{trends.tests.length > 0 ? <FlakyTable frame={frame} trends={trends} /> : null}
			{trends.slowdowns.length > 0 ? <SlowdownTable trends={trends} /> : null}
		</div>
	) : null;
	const sideColumn = <div className="flex min-w-0 flex-col gap-4">{side}</div>;
	return (
		<div className="flex flex-col gap-6">
			{hasHistory || hasFigures ? <Figures trends={trends} /> : null}
			{main ? (
				<div className="omp-checks-split">
					{main}
					{sideColumn}
				</div>
			) : (
				sideColumn
			)}
		</div>
	);
}
