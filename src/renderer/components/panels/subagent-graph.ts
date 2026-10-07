/**
 * Shared subagent model: status metadata, elapsed-time helpers, labels, and
 * the tool-call ownership registry used to recover parent→child spawn edges.
 *
 * The wire carries an explicit parent link for nested spawns
 * (`parentSubagentId`); frames that predate it fall back to attributing the
 * spawning `task` tool call (`parentToolCallId`) to its owning session —
 * the main session's messages for top-level spawns, the tool-call ownership
 * registry (filled in as transcripts load) for nested ones.
 */

import { useSubagentGraphStore } from "../../stores/subagent-graph";

export * from "../../stores/subagent-graph";

import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import type { BadgeVariant } from "../common";

/**
 * Status presentation for a subagent row. The wire's status is FREE-FORM
 * (lifecycle statuses plus arbitrary progress payloads: "started", "running",
 * "pending", "completed", "failed", "aborted", "cancelled", "idle", "parked",
 * and anything an agent emits). Never index a Record with it unchecked — a
 * missing key was the white-screen crash on the agents tab (meta.live of
 * undefined). Always go through statusMeta()/isLiveSubagentStatus().
 */
export interface StatusMeta {
	label: string;
	variant: BadgeVariant;
	live: boolean;
	labelKey: string;
}

const STATUS_META: Record<string, StatusMeta> = {
	started: { label: "running", variant: "info", live: true, labelKey: "subagent.status.started" },
	running: { label: "running", variant: "info", live: true, labelKey: "subagent.status.started" },
	pending: { label: "pending", variant: "muted", live: true, labelKey: "subagent.status.pending" },
	idle: { label: "idle", variant: "muted", live: true, labelKey: "subagent.status.idle" },
	parked: { label: "parked", variant: "muted", live: true, labelKey: "subagent.status.parked" },
	stale: { label: "stale", variant: "warning", live: false, labelKey: "subagent.status.stale" },
	completed: { label: "completed", variant: "success", live: false, labelKey: "subagent.status.completed" },
	failed: { label: "failed", variant: "error", live: false, labelKey: "subagent.status.failed" },
	aborted: { label: "cancelled", variant: "muted", live: false, labelKey: "subagent.status.cancelled" },
	cancelled: { label: "cancelled", variant: "muted", live: false, labelKey: "subagent.status.cancelled" },
};

/** Total lookup — unknown/future statuses degrade to a muted badge with the raw status text. */
export function statusMeta(status: string): StatusMeta {
	return STATUS_META[status] ?? { label: status, variant: "muted", live: false, labelKey: "subagent.status.unknown" };
}

/** True for non-terminal statuses (drives elapsed timers, pulse dots, running counts). */
export function isLiveSubagentStatus(status: string): boolean {
	return statusMeta(status).live;
}

/**
 * Elapsed runtime from the agent's own progress clock.
 *
 * `durationMs` is sampled by the sidecar when a progress frame is emitted;
 * `lastUpdate` is when the renderer received that frame. Advancing the sample
 * by the time since `lastUpdate` keeps a live row moving without inventing a
 * new start time when the panel happens to open. Terminal rows stay frozen at
 * their final duration. Bare live registry snapshots have no duration sample,
 * so their first lifecycle timestamp is the only honest fallback.
 */
export function subagentElapsedMs(agent: SubagentSnapshot, now: number): number | null {
	const live = isLiveSubagentStatus(agent.status);
	const sampled = agent.progress?.durationMs;
	if (typeof sampled === "number" && Number.isFinite(sampled)) {
		const sinceSample = live && Number.isFinite(agent.lastUpdate) ? Math.max(0, now - agent.lastUpdate) : 0;
		return Math.max(0, sampled + sinceSample);
	}
	if (live && Number.isFinite(agent.lastUpdate)) return Math.max(0, now - agent.lastUpdate);
	return null;
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Ids of `task` tool calls found in a message list (main session or a subagent transcript). */
export function extractTaskToolCallIds(messages: AgentMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "toolCall" && part.name === "task") ids.push(part.id);
		}
	}
	return ids;
}

/** Register every `task` tool call found in a loaded transcript page as owned by that subagent. */
export function registerTranscriptToolCalls(agentId: string, messages: AgentMessage[]): void {
	const ids = extractTaskToolCallIds(messages);
	if (ids.length > 0) useSubagentGraphStore.getState().registerToolCallOwners(agentId, ids);
}

/** The spawning subagent id, absent for root spawns from the main session. */
export function parentSubagentIdOf(agent: SubagentSnapshot): string | undefined {
	return agent.parentSubagentId;
}

/** Human task label used consistently by list, graph, and hub surfaces. */
export function subagentPrimaryLabel(agent: SubagentSnapshot, maxLength = 60): string {
	// `description` is the sidecar's tiny-model UI label. `assignment` is the
	// complete delegated prompt and may include markdown/system scaffolding, so
	// it belongs in the transcript rather than the compact row heading.
	const raw = agent.description ?? agent.assignment ?? agent.task ?? agent.agent;
	const text = raw.trim() || agent.agent;
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
