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
import {
	type CheckKind,
	checkKind,
	checkKinds,
	commandOperation,
	summarizeChecks,
	unresolvedFailures,
} from "../../chat/work/work-checks";
import { skillPromptName, type WorkCommandOutcome, workOutcomes } from "../../chat/work/work-view";
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

/** The check the board names, as the newest work card reads it. */
export interface LastCheck {
	state: "passed" | "failed" | "running";
	kind: CheckKind;
	command: string;
	/** The tests the runner counted: passed ones for a pass, failed ones for a failure. */
	count?: number;
	startedAt: number;
	durationMs?: number;
	/** The call's entry key, for the card in the transcript; none for a subagent's call. */
	key?: string;
}

function checkOf(outcome: WorkCommandOutcome): LastCheck | null {
	const [summary] = summarizeChecks([outcome]);
	if (!summary) return null;
	const { startTime, endTime } = outcome;
	const durationMs =
		outcome.durationMs ?? (startTime !== undefined && endTime !== undefined ? endTime - startTime : undefined);
	const count = summary.passed ? summary.tests?.passed : summary.tests?.failed;
	return {
		kind: summary.kind,
		command: outcome.command,
		startedAt: startTime ?? 0,
		state: summary.passed ? "passed" : "failed",
		...(outcome.toolCallId ? { key: outcome.toolCallId } : {}),
		...(count !== undefined ? { count } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

/**
 * The check the board names: the session's newest one while it has not reported (a backgrounded job whose verdict
 * has not arrived, a call still running: `running`, never passed); else the newest turn's last check failure no later
 * run of the same call fixed (`unresolvedFailures` over `turnCommands`, the ledger its work card reads, subagents'
 * calls included), as that card's verdict says; else the session's newest check run. A stopped one is skipped, as the
 * work card skips it. A run that mixes kinds (`biome; vitest`) is a check run of the kinds it proved passed, the
 * first of them named, and fixes a failure as the card reads it.
 */
export function lastCheck(
	entries: Iterable<readonly [string, ToolEntry]>,
	turnCommands: readonly WorkCommandOutcome[],
	cwd: string,
	verdicts: ReadonlyMap<string, BackgroundJobVerdict>,
): LastCheck | null {
	const candidates: { key: string; entry: ToolEntry; command: string; kind: CheckKind }[] = [];
	for (const [key, entry] of entries) {
		const command = entry.args.command;
		if (entry.toolName !== "bash" || typeof command !== "string" || entry.status === "aborted") continue;
		const [kind] = checkKinds(command, true);
		if (kind) candidates.push({ key, entry, command, kind: checkKind(command) ?? kind });
	}
	candidates.sort((a, b) => b.entry.startTime - a.entry.startTime);
	let newest: LastCheck | null = null;
	for (const { key, entry, command, kind } of candidates) {
		const base = { kind, command, startedAt: entry.startTime, key };
		if (entry.status === "pending" || entry.status === "running") return { ...base, state: "running" };
		const [outcome] = workOutcomes([{ entry, toolCallId: key }], undefined, cwd, verdicts).commands;
		if (!outcome || outcome.interrupted || outcome.refused) continue;
		if (outcome.unknown) return { ...base, state: "running" };
		newest = checkOf(outcome);
		if (newest) break;
	}
	const checks = turnCommands.filter(command => checkKinds(command.command, true).length > 0).map(commandOperation);
	const standing = unresolvedFailures(checks, cwd).findLast(call => checkKind(call.command));
	return (standing && checkOf(standing)) ?? newest;
}

/** One other session and where it works: this worktree, or another worktree of the repository. */
export type ScopedPeer = CheckoutPeer & { scope: "worktree" | "repo" };

/** The other sessions the row names: the same worktree's first, then the other worktrees' of the repository. */
export interface PeersSummary {
	worktree: number;
	repo: number;
	/** Distinct files that this session and a peer (same worktree or another one) both changed. */
	shared: number;
	peers: ScopedPeer[];
}

/** `null` when the session works alone: the row never shows on a session by itself. */
export function summarizePeers(peers: CheckoutPeers | null): PeersSummary | null {
	if (!peers || peers.worktree.length + peers.repo.length === 0) return null;
	return {
		worktree: peers.worktree.length,
		repo: peers.repo.length,
		shared: new Set([...peers.worktree, ...peers.repo].flatMap(peer => peer.shared ?? [])).size,
		peers: [
			...peers.worktree.map(peer => ({ ...peer, scope: "worktree" as const })),
			...peers.repo.map(peer => ({ ...peer, scope: "repo" as const })),
		],
	};
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

/**
 * The skills the newest turn was given by `skill-prompt` messages: those after the last user message, and, when a
 * `/skill:` prompt (attribution user) is itself the turn's prompt, from that prompt on. Oldest first, one per name.
 */
export function turnSkills(messages: readonly AgentMessage[]): string[] {
	const names: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role === "user") break;
		const name = skillPromptName(message);
		if (!name) continue;
		names.unshift(name);
		if (message.attribution === "user") break;
	}
	return [...new Set(names)];
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
