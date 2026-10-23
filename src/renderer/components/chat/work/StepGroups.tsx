import { ChevronRight, ListChecks } from "lucide-react";
import { type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useMessagesStore } from "../../../stores/messages";
import { selectToolEntry, useToolsStore } from "../../../stores/tools";
import { ReadGroupCard } from "../../tools/renderers/ReadGroupCard";
import { TOOL_ROW_CLASS, ToolCard, ToolStatusIcon } from "../../tools/ToolCard";
import { MessageBubble } from "../MessageBubble";
import { UsageRow } from "../UsageRow";
import { type StepReveal, StepRevealContext } from "./reveal-step";
import { groupSteps, type StepGroup, type StepItem, type StepRow } from "./work-steps";

/** Messages an open card mounts per task (about 7 ms of render, style and layout). */
const MOUNT_SLICE = 60;

/**
 * How many of `total` rows are mounted: a big card's rows arrive a slice per task after the click's
 * frame (all 490 messages of a 245-step card in one commit made a 60 ms frame), and rows that come
 * later mount as they arrive.
 */
export function useMountedCount(total: number): number {
	const [limit, setLimit] = useState(() => (total <= MOUNT_SLICE ? Number.POSITIVE_INFINITY : MOUNT_SLICE));
	useEffect(() => {
		if (limit >= total) {
			if (limit !== Number.POSITIVE_INFINITY) setLimit(Number.POSITIVE_INFINITY);
			return;
		}
		const timer = setTimeout(() => setLimit(value => value + MOUNT_SLICE), 0);
		return () => clearTimeout(timer);
	}, [limit, total]);
	return Math.min(limit, total);
}

/** One tool row in the frame a message's own tool row sits in. */
function StepFrame({ children }: { children: ReactNode }) {
	return (
		<div className="omp-assistant-turn--compact group relative flex px-6 py-1.5" data-step-row="">
			<div className="omp-transcript-content min-w-0">{children}</div>
		</div>
	);
}

function StepItemView({ item }: { item: StepItem }) {
	switch (item.kind) {
		case "message":
			return <MessageBubble compact message={item.message} runningIndicator="dot" />;
		case "call":
			return (
				<StepFrame>
					<ToolCard
						args={item.call.arguments}
						runningIndicator="dot"
						toolCallId={item.key}
						toolName={item.call.name}
					/>
					{item.usage ? <UsageRow message={item.usage} /> : null}
				</StepFrame>
			);
		case "reads":
			return <ReadsRow item={item} />;
	}
}

/** How the calls under a line stand: one word each, joined, so only a change re-renders the line. */
function useStepOutcomes(keys: readonly string[]): string {
	return useToolsStore(state =>
		keys
			.map(key => {
				const entry = selectToolEntry(state, key);
				if (entry?.status === "pending" || entry?.status === "running") return "running";
				if (entry?.status === "aborted") return "interrupted";
				return entry?.status === "error" || entry?.isError ? "failed" : "done";
			})
			.join("|"),
	);
}

/** What makes a line open by itself: one of its calls failed, or a finding asked for one of them. */
function useOpensItself(keys: readonly string[], outcomes: string): boolean | StepReveal {
	const reveal = useContext(StepRevealContext);
	return (reveal !== null && keys.includes(reveal.key) ? reveal : null) ?? outcomes.includes("failed");
}

/** Folded reads: the transcript's read-group card, opened by a failed read. */
function ReadsRow({ item }: { item: Extract<StepItem, { kind: "reads" }> }) {
	const keys = useMemo(() => item.entries.map(entry => entry.toolKey), [item.entries]);
	const opens = useOpensItself(keys, useStepOutcomes(keys));
	return <ReadGroupCard entries={item.entries} forceOpen={opens} inset runningIndicator="dot" usage={item.usage} />;
}

/**
 * Calls of one intent under one line. A group holding a failed step opens by itself (and again when a
 * finding asks for one of its steps); the rest stay one line, whose count and mark say what is inside.
 */
function IntentGroup({ group }: { group: StepGroup }) {
	const t = useT();
	const outcomes = useStepOutcomes(group.callKeys);
	const failed = outcomes.includes("failed");
	const running = outcomes.includes("running");
	const opens = useOpensItself(group.callKeys, outcomes);
	const [open, setOpen] = useState(opens !== false);
	// A failure appearing or a new reveal opens it; closing it by hand holds until one of them changes.
	useEffect(() => {
		if (opens) setOpen(true);
	}, [opens]);
	const state = running ? "running" : failed ? "error" : outcomes.includes("interrupted") ? "aborted" : "done";
	return (
		<div className="omp-step-group" data-step-group="" data-open={open} data-state={state}>
			{/* controls-ok: the omp-step-group-header class draws the whole control */}
			<button
				aria-expanded={open}
				className={cx("omp-step-group-header", TOOL_ROW_CLASS)}
				onClick={() => setOpen(value => !value)}
				type="button"
			>
				<ToolStatusIcon kindIcon={<ListChecks />} runningIndicator="dot" state={state} />
				<span
					className={cx(
						"omp-step-group-label min-w-0 truncate font-medium",
						failed ? "text-(--sc-danger)" : "text-(--sc-text-secondary)",
					)}
					title={group.label}
				>
					{group.label}
				</span>
				<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-subtle)">
					{t("chat.work.group.steps", { count: group.callKeys.length })}
				</span>
				{failed ? (
					<span className="shrink-0 text-sc-xs font-medium text-(--sc-danger)">{t("tools.status.failed")}</span>
				) : null}
				<ChevronRight
					aria-hidden
					className={cx(
						"omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
						open && "rotate-90",
					)}
				/>
			</button>
			{open ? (
				<div className="omp-step-group-body">
					{group.items.map(item => (
						<StepItemView item={item} key={item.key} />
					))}
				</div>
			) : null}
		</div>
	);
}

/** A finished card's steps, grouped by intent (`groupSteps`). */
export function StepGroups({ messages }: { messages: readonly AgentMessage[] }) {
	const readTargets = useMessagesStore(state => state.readTargets);
	const rows = useMemo<StepRow[]>(() => groupSteps(messages, readTargets), [messages, readTargets]);
	const mounted = useMountedCount(rows.length);
	return rows
		.slice(0, mounted)
		.map(row =>
			row.kind === "intent" ? <IntentGroup group={row} key={row.key} /> : <StepItemView item={row} key={row.key} />,
		);
}
