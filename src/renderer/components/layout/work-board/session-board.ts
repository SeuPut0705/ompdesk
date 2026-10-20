/**
 * What the work board's "This session" rows and the failed-check row read, as plain data (WorkBoardSession.tsx draws
 * them): the checkout's uncommitted changes, the session's newest check, the other sessions in the checkout, the
 * memory the turn used and the dev servers running. Everything here is a pure function of store snapshots.
 */
import type { CheckoutPeer, CheckoutPeers } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import { memoryRecallDetails } from "../../../../../resources/gui-bridge/modes/memory-recall-contracts";
import type { AgentMessage, RpcAsyncJobItem, RpcGitChanges } from "../../../../shared/rpc-types";
import { resultDetails } from "../../../lib/format";
import { devServerUrl } from "../../../lib/panel-auto-open";
import type { ToolEntry } from "../../../stores/tools";
import type { BackgroundJobVerdict } from "../../chat/completion-events";
import { type CheckKind, checkKind, summarizeChecks } from "../../chat/work/work-checks";
import { workOutcomes } from "../../chat/work/work-view";

/** What the checkout changed since the session started (`get_git_session_changes`). */
export interface ChangesSummary {
	files: number;
	added: number;
	removed: number;
}

/** `null`: not a repository, or nothing changed. */
export function summarizeChanges(changes: RpcGitChanges | null): ChangesSummary | null {
	if (!changes?.isRepo || changes.files.length === 0) return null;
	return {
		files: changes.files.length,
		added: changes.files.reduce((sum, file) => sum + (file.added ?? 0), 0),
		removed: changes.files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
	};
}

/** The session's newest test, typecheck, lint or build command, as the work card reads it. */
export interface LastCheck {
	state: "passed" | "failed" | "running";
	kind: CheckKind;
	command: string;
	/** The tests the runner counted: passed ones for a pass, failed ones for a failure. */
	count?: number;
	startedAt: number;
	durationMs?: number;
	/** The call's entry key, for the card in the transcript. */
	key: string;
}

/**
 * The newest check among `entries` (key and call, live and finished). One that never reported (a backgrounded job
 * whose verdict has not arrived, a call still running) is `running`, never passed; a stopped one is skipped, as the
 * work card skips it.
 */
export function lastCheck(
	entries: Iterable<readonly [string, ToolEntry]>,
	cwd: string,
	verdicts: ReadonlyMap<string, BackgroundJobVerdict>,
): LastCheck | null {
	const candidates: { key: string; entry: ToolEntry; command: string; kind: CheckKind }[] = [];
	for (const [key, entry] of entries) {
		const command = entry.args.command;
		if (entry.toolName !== "bash" || typeof command !== "string" || entry.status === "aborted") continue;
		const kind = checkKind(command);
		if (kind) candidates.push({ key, entry, command, kind });
	}
	candidates.sort((a, b) => b.entry.startTime - a.entry.startTime);
	for (const { key, entry, command, kind } of candidates) {
		const base = { kind, command, startedAt: entry.startTime, key };
		if (entry.status === "pending" || entry.status === "running") return { ...base, state: "running" };
		const [outcome] = workOutcomes([{ entry, toolCallId: key }], undefined, cwd, verdicts).commands;
		if (!outcome || outcome.interrupted) continue;
		if (outcome.unknown) return { ...base, state: "running" };
		const [summary] = summarizeChecks([outcome]);
		if (!summary) continue;
		const durationMs = outcome.durationMs ?? (entry.endTime === null ? undefined : entry.endTime - entry.startTime);
		const count = summary.passed ? summary.tests?.passed : summary.tests?.failed;
		return {
			...base,
			state: summary.passed ? "passed" : "failed",
			...(count !== undefined ? { count } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
		};
	}
	return null;
}

/** The other sessions the row names: the same worktree's, else (only the repository's) the other worktrees'. */
export interface PeersSummary {
	scope: "worktree" | "repo";
	peers: CheckoutPeer[];
}

/** `null` when the session works alone: the row never shows on a session by itself. */
export function summarizePeers(peers: CheckoutPeers | null): PeersSummary | null {
	if (!peers) return null;
	if (peers.worktree.length > 0) return { scope: "worktree", peers: peers.worktree };
	if (peers.repo.length > 0) return { scope: "repo", peers: peers.repo };
	return null;
}

/**
 * The titles of the memory the bridge handed the model for the turn in progress (or the last one): the newest recall
 * message after the last prompt. Empty when that prompt recalled nothing.
 */
export function recallTitles(messages: readonly AgentMessage[]): string[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role === "user") return [];
		if (message.role !== "custom" || message.customType !== "ompdesk-memory-recall") continue;
		return memoryRecallDetails(resultDetails(message))?.items.map(item => item.title) ?? [];
	}
	return [];
}

/** A running background job that serves a loopback address. */
export interface DevServer {
	url: string;
	host: string;
	command: string;
}

export function devServers(jobs: readonly RpcAsyncJobItem[]): DevServer[] {
	const servers = new Map<string, DevServer>();
	for (const job of jobs) {
		const url = devServerUrl({ toolName: "bash", command: job.label, text: job.resultPreview ?? "" });
		if (url && !servers.has(url)) servers.set(url, { url, host: new URL(url).host, command: job.label });
	}
	return [...servers.values()];
}
