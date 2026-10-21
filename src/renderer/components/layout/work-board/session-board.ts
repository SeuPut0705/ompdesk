/**
 * What the work board's "Current work" rows and the failed-check row read, as plain data (WorkBoardSession.tsx draws
 * them): the files the turn's own edit tools and the sessions it opened changed, what the session's branch has not
 * landed yet, the session's newest check, the other sessions in the checkout, the memory the turn used and the dev
 * servers running. Everything here is a pure function of store snapshots and what the opened sessions answered.
 */
import type { CheckoutPeer, CheckoutPeers } from "../../../../../resources/gui-bridge/modes/checkout-peers-contracts";
import { memoryRecallDetails } from "../../../../../resources/gui-bridge/modes/memory-recall-contracts";
import type { AgentMessage, RpcAsyncJobItem, RpcGitUnlanded } from "../../../../shared/rpc-types";
import { resultDetails } from "../../../lib/format";
import { devServerUrl } from "../../../lib/panel-auto-open";
import type { ToolEntry } from "../../../stores/tools";
import type { BackgroundJobVerdict } from "../../chat/completion-events";
import { type CheckKind, checkKind, summarizeChecks } from "../../chat/work/work-checks";
import { workOutcomes } from "../../chat/work/work-view";
import { workFilePathKey } from "../../tools/edit-args";

/** A count of changed files and their lines. */
export interface ChangesSummary {
	files: number;
	added: number;
	removed: number;
	/** The list was cut (`truncated`): `files` is a floor ("1000+"), the lines unknown. */
	capped: boolean;
}

function summarize(files: readonly { added?: number; removed?: number }[], capped: boolean): ChangesSummary {
	return {
		files: files.length,
		added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
		removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
		capped,
	};
}

/** What the session's branch has not landed in its default branch (`get_git_unlanded`); null on main or when none. */
export interface UnlandedSummary extends ChangesSummary {
	branch: string;
	target: string;
}

export function summarizeUnlanded(unlanded: RpcGitUnlanded | null): UnlandedSummary | null {
	if (!unlanded || unlanded.files.length === 0) return null;
	return { ...summarize(unlanded.files, unlanded.truncated), branch: unlanded.branch, target: unlanded.target };
}

/**
 * One session's changed file, keyed by where it is (computer and absolute path), with its lines. Never git for a
 * session in a shared checkout: its own edit tools say what it changed, so another session's work never counts.
 */
export interface KeyedFileChange {
	key: string;
	added: number;
	removed: number;
}

/** A session's own changed files as the family count reads them: `cwd` resolves relative paths, `device` its computer. */
export function keyedFiles(
	files: readonly { path: string; added?: number; removed?: number }[],
	cwd: string,
	device?: string,
): KeyedFileChange[] {
	return files.map(file => ({
		key: `${device ?? ""}\0${workFilePathKey(file.path, cwd)}`,
		added: file.added ?? 0,
		removed: file.removed ?? 0,
	}));
}

/** One session's share of a family count: `title` null for the board's own session. */
export interface FamilyPart {
	title: string | null;
	files: readonly KeyedFileChange[];
	/** Its list was cut (an unlanded list past git's cap): its count is a floor. */
	capped?: boolean;
}

export interface FamilyChangesSummary extends ChangesSummary {
	/** Each session's own count, the board's own first; empty when no session it opened changed anything. */
	parts: { title: string | null; summary: ChangesSummary }[];
}

/**
 * The files the board's session and the sessions it opened changed: one file counts once however many of them
 * touched it (the same computer and path), its lines summed over every session's edits of it.
 */
export function familyChanges(parts: readonly FamilyPart[]): FamilyChangesSummary {
	const files = new Map<string, { added: number; removed: number }>();
	for (const part of parts)
		for (const file of part.files) {
			const known = files.get(file.key);
			files.set(file.key, {
				added: (known?.added ?? 0) + file.added,
				removed: (known?.removed ?? 0) + file.removed,
			});
		}
	const shown = parts.filter(part => part.files.length > 0);
	const children = shown.some(part => part.title !== null);
	return {
		...summarize(
			[...files.values()],
			parts.some(part => part.capped === true),
		),
		parts: children
			? shown.map(part => ({ title: part.title, summary: summarize(part.files, part.capped === true) }))
			: [],
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

/** One other session and where it works: this worktree, or another worktree of the repository. */
export type ScopedPeer = CheckoutPeer & { scope: "worktree" | "repo" };

/** The other sessions the row names: the same worktree's first, then the other worktrees' of the repository. */
export interface PeersSummary {
	worktree: number;
	repo: number;
	peers: ScopedPeer[];
}

/** `null` when the session works alone: the row never shows on a session by itself. */
export function summarizePeers(peers: CheckoutPeers | null): PeersSummary | null {
	if (!peers || peers.worktree.length + peers.repo.length === 0) return null;
	return {
		worktree: peers.worktree.length,
		repo: peers.repo.length,
		peers: [
			...peers.worktree.map(peer => ({ ...peer, scope: "worktree" as const })),
			...peers.repo.map(peer => ({ ...peer, scope: "repo" as const })),
		],
	};
}

/** How a tap on one peer opens it, from where the board's own session runs. */
export type PeerOpen =
	| { kind: "switch"; tabId: string }
	| { kind: "path"; sessionPath: string; device?: string }
	| null;

/**
 * A peer tab this window holds is switched to; any other with a session file opens by that file on the computer the
 * board's session runs on (`device`: a paired host's peers are that host's files; this computer's file goes through
 * its owner, another window or a paired device's tab). A session hidden from agents (no id, no file) does not open.
 */
export function peerOpen(
	peer: CheckoutPeer,
	here: { tabs: readonly { id: string; sessionPath?: string; device?: string }[]; device?: string },
): PeerOpen {
	const held = here.tabs.find(
		tab =>
			tab.device === here.device &&
			// A peer's id is a tab id on the computer that runs it: this window's only when that is this computer.
			((peer.id !== null && !here.device && tab.id === peer.id) ||
				(peer.sessionPath !== undefined && tab.sessionPath === peer.sessionPath)),
	);
	if (held) return { kind: "switch", tabId: held.id };
	if (!peer.sessionPath) return null;
	return { kind: "path", sessionPath: peer.sessionPath, ...(here.device ? { device: here.device } : {}) };
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
