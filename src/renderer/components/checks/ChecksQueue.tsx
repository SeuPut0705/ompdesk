/**
 * Merge queue of the Checks page (docs/design/check-control.md §8): the pull requests agents batch and land, with the
 * runs that land them. Watch-only: nothing here acts on the queue. `QueueCard` is also the Now tab's right-hand card,
 * so it carries its own head row. Entries of one batch share a rule down their left edge; a batch is explained in one
 * muted sentence under the rows. Every figure comes from `lib/checks/view`; the page passes the frame.
 */

import { GitMerge } from "lucide-react";
import type { QueueEntry, Run } from "../../../shared/checks-contract";
import type { ChecksFrame } from "../../../shared/checks-frame";
import {
	jobsDone,
	type OriginView,
	originView,
	type RunState,
	repoName,
	runState,
	shortSha,
} from "../../lib/checks/view";
import { useT } from "../../lib/i18n";
import { Badge, type BadgeVariant, Card, EmptyState, SectionLabel } from "../common";

type QueueRow = QueueEntry;

const RUN_BADGE: Record<RunState, BadgeVariant> = {
	running: "info",
	queued: "default",
	held: "default",
	passed: "success",
	failed: "error",
	cancelled: "muted",
	reused: "success",
	superseded: "muted",
};

const ENTRY_BADGE: Record<QueueEntry["state"], BadgeVariant> = {
	testing: "info",
	ready: "success",
	landing: "success",
	failed: "error",
	waiting: "default",
	removed: "muted",
};

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Who started something, in words: the session's title, else what kind of caller it was. */
export function originText(t: Translate, view: OriginView): string {
	if (view.kind === "session") return view.title ?? t("checks.queue.origin.session");
	return t(`checks.queue.origin.${view.kind}`);
}

interface QueueGroup {
	repo: string;
	base: string;
	entries: QueueRow[];
}

function queueGroups(queue: readonly QueueRow[]): QueueGroup[] {
	const groups = new Map<string, QueueGroup>();
	for (const entry of queue) {
		const key = `${entry.repo}\u0000${entry.base}`;
		const group = groups.get(key) ?? { repo: entry.repo, base: entry.base, entries: [] };
		group.entries.push(entry);
		groups.set(key, group);
	}
	for (const group of groups.values()) group.entries.sort((a, b) => a.position - b.position);
	return [...groups.values()];
}

function batchCounts(entries: readonly QueueRow[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const entry of entries) if (entry.batch) counts.set(entry.batch, (counts.get(entry.batch) ?? 0) + 1);
	return [...counts];
}

function QueueRowView({ entry, previous, anyBatch }: { entry: QueueRow; previous?: QueueRow; anyBatch: boolean }) {
	const t = useT();
	const stateWord =
		entry.state === "waiting" && !entry.batch && anyBatch
			? t("checks.queue.state.nextBatch")
			: t(`checks.queue.state.${entry.state}`);
	const startsBatch = previous !== undefined && previous.batch !== entry.batch;
	return (
		<li
			className={`flex items-center gap-3 border-l-2 py-2 pr-1 pl-3 ${startsBatch ? "mt-2" : ""} ${
				entry.batch ? "border-(--sc-info)" : "border-transparent"
			}`}
			data-queue-entry={entry.id}
		>
			<span className="flex size-5 shrink-0 items-center justify-center rounded-(--sc-radius-sm) bg-(--sc-surface-3) text-sc-xs text-(--sc-text-secondary) tabular-nums">
				{entry.position}
			</span>
			<span className="min-w-0 flex-1 text-sc-sm text-(--sc-text)">
				{entry.pr === undefined ? (
					<span className="font-mono text-sc-xs">{entry.branch}</span>
				) : (
					<span>#{entry.pr}</span>
				)}{" "}
				<span className="break-words">{entry.title}</span>{" "}
				<span className="font-mono text-sc-xs text-(--sc-text-muted)">{shortSha(entry.sha)}</span>
			</span>
			<Badge className="shrink-0" variant={ENTRY_BADGE[entry.state]}>
				{stateWord}
			</Badge>
		</li>
	);
}

function QueueGroupCard({ group }: { group: QueueGroup }) {
	const t = useT();
	const anyBatch = group.entries.some(entry => entry.batch);
	return (
		<Card className="flex flex-col" padding="none" radius="lg">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2">
				<GitMerge aria-hidden className="size-4 shrink-0 text-(--sc-text-muted)" />
				<SectionLabel as="h3" className="min-w-0 flex-1" size="label">
					{t("checks.queue.title", { repo: repoName(group.repo), base: group.base })}
				</SectionLabel>
				<span className="text-sc-xs text-(--sc-text-muted)">{t("checks.queue.aside")}</span>
			</div>
			<ul className="px-4 pb-2">
				{group.entries.map((entry, index) => (
					<QueueRowView anyBatch={anyBatch} entry={entry} key={entry.id} previous={group.entries[index - 1]} />
				))}
			</ul>
			{batchCounts(group.entries).map(([batch, count]) => (
				<p className="px-4 pb-3 text-sc-xs text-(--sc-text-muted)" key={batch}>
					{t(count === 1 ? "checks.queue.batchOne" : "checks.queue.batch", { batch, count })}
				</p>
			))}
		</Card>
	);
}

export function QueueCard({ frame }: { frame: ChecksFrame }) {
	const { queue } = frame.snapshot;
	if (queue.length === 0) return null;
	return (
		<>
			{queueGroups(queue).map(group => (
				<QueueGroupCard group={group} key={`${group.repo}\u0000${group.base}`} />
			))}
		</>
	);
}

function LandingRun({ run, frame }: { run: Run; frame: ChecksFrame }) {
	const t = useT();
	const { done, total } = jobsDone(run.jobs);
	const state = runState(run);
	const who = originText(t, originView(run.origin, frame.names));
	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3" data-land-run={run.id}>
			<span className="text-sc-sm font-medium text-(--sc-text)">{repoName(run.repo)}</span>
			<span className="min-w-0 font-mono text-sc-xs break-all text-(--sc-text-muted)">{run.ref}</span>
			<span className="font-mono text-sc-xs text-(--sc-text-muted)">{shortSha(run.sha)}</span>
			<span className="min-w-0 flex-1 text-sc-xs text-(--sc-text-muted) tabular-nums">
				{t("checks.queue.jobsDone", { done, total })} · {t("checks.queue.startedBy", { who })}
			</span>
			<Badge className="shrink-0" dot pulse={state === "running"} variant={RUN_BADGE[state]}>
				{t(`checks.queue.run.${state}`)}
			</Badge>
		</li>
	);
}

export function ChecksQueue({ frame }: { frame: ChecksFrame }) {
	const t = useT();
	const { snapshot } = frame;
	const landRuns = snapshot.runs.filter(run => run.lane === "land");
	if (snapshot.queue.length === 0 && landRuns.length === 0) {
		return (
			<EmptyState
				description={t("checks.queue.empty.description")}
				icon={<GitMerge aria-hidden className="size-5" />}
				size="md"
				title={t("checks.queue.empty.title")}
			/>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<QueueCard frame={frame} />
			{landRuns.length > 0 ? (
				<section className={snapshot.queue.length > 0 ? "mt-2" : ""}>
					<SectionLabel className="mb-2" size="label">
						{t("checks.queue.landing")}
					</SectionLabel>
					<Card as="ul" className="divide-y divide-(--sc-border-subtle)" padding="none" radius="lg">
						{landRuns.map(run => (
							<LandingRun frame={frame} key={run.id} run={run} />
						))}
					</Card>
				</section>
			) : null}
		</div>
	);
}
